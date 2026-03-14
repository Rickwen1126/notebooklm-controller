/**
 * Daemon entry point — orchestrates startup and shutdown of all subsystems.
 *
 * T041:  startDaemon / stopDaemon lifecycle
 * T041.1: Chrome locale detection on startup
 */

import { TabManager } from "../tab-manager/tab-manager.js";
import { CopilotClientSingleton } from "../agent/client.js";
import { NbctlMcpServer } from "./mcp-server.js";
import { Scheduler } from "./scheduler.js";
import type { SessionResult as SchedulerSessionResult } from "./scheduler.js";
import { registerDaemonTools } from "./mcp-tools.js";
import { registerNotebookTools } from "./notebook-tools.js";
import { registerExecTools } from "./exec-tools.js";
import { StateManager } from "../state/state-manager.js";
import { TaskStore } from "../state/task-store.js";
import { CacheManager } from "../state/cache-manager.js";
import { Notifier } from "../notification/notifier.js";
import { NetworkGate } from "../network-gate/network-gate.js";
import { resolveLocale, loadUIMap } from "../shared/locale.js";
import { loadAllAgentConfigs } from "../agent/agent-loader.js";
import { runDualSession } from "../agent/session-runner.js";
import { buildToolsForTab } from "../agent/tools/index.js";
import { createSessionHooks } from "../agent/hooks.js";
import { MCP_PORT, AGENTS_DIR_USER, AGENTS_DIR_BUNDLED, NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { enforcePermissions } from "../shared/permissions.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import type { UIMap, AgentConfig, AsyncTask, OperationActionType, OperationLogEntry } from "../shared/types.js";
import { TMP_DIR } from "../shared/config.js";

// ---------------------------------------------------------------------------
// DaemonRuntime
// ---------------------------------------------------------------------------

export interface DaemonRuntime {
  tabManager: TabManager;
  copilotClient: CopilotClientSingleton;
  mcpServer: NbctlMcpServer;
  scheduler: Scheduler;
  stateManager: StateManager;
  taskStore: TaskStore;
  cacheManager: CacheManager;
  notifier: Notifier;
  networkGate: NetworkGate;
  agentConfigs: AgentConfig[];
  locale: string;
  uiMap: UIMap;
  /** Mutable Google session state — updated by startup check and reauth. */
  googleSession: { valid: boolean };
}

// ---------------------------------------------------------------------------
// T068J: runTask factory — wires dual session to scheduler
// ---------------------------------------------------------------------------

interface RunTaskDeps {
  copilotClient: CopilotClientSingleton;
  tabManager: TabManager;
  stateManager: StateManager;
  networkGate: NetworkGate;
  cacheManager: CacheManager;
  agentConfigs: AgentConfig[];
  locale: string;
}

// ---------------------------------------------------------------------------
// T096: inferActionType — map command text to OperationActionType
// ---------------------------------------------------------------------------

const ACTION_PATTERNS: Array<[RegExp, OperationActionType]> = [
  [/加入來源|add.?source|加來源|新增來源|餵入|repo|pdf|url/i, "add-source"],
  [/更新來源|update.?source/i, "update-source"],
  [/移除來源|刪除來源|remove.?source|delete.?source/i, "remove-source"],
  [/問|query|提問|查詢|ask|question/i, "query"],
  [/產生語音|generate.?audio|audio.?overview/i, "generate-audio"],
  [/下載語音|download.?audio/i, "download-audio"],
  [/截圖|screenshot/i, "screenshot"],
  [/改名來源|rename.?source|重新命名來源/i, "rename-source"],
  [/改標題|rename.?notebook|重新命名/i, "rename-notebook"],
  [/列出來源|list.?source|來源列表/i, "list-sources"],
  [/建立筆記本|create.?notebook|新筆記本/i, "create-notebook"],
  [/同步|sync/i, "sync"],
];

function inferActionType(command: string): OperationActionType {
  for (const [pattern, actionType] of ACTION_PATTERNS) {
    if (pattern.test(command)) {
      return actionType;
    }
  }
  return "other";
}

// ---------------------------------------------------------------------------
// T068J: runTask factory — wires dual session to scheduler
// (with T096: operation log recording)
// ---------------------------------------------------------------------------

function createRunTask(
  deps: RunTaskDeps,
): (task: AsyncTask) => Promise<SchedulerSessionResult> {
  const log = logger.child({ module: "daemon:runTask" });

  return async (task: AsyncTask): Promise<SchedulerSessionResult> => {
    const { copilotClient, tabManager, stateManager, networkGate, cacheManager, agentConfigs, locale } = deps;
    const startTime = Date.now();

    // 1. Resolve notebook URL from state (or homepage for __homepage__).
    const isHomepage = task.notebookAlias === "__homepage__";
    const targetUrl = isHomepage
      ? NOTEBOOKLM_HOMEPAGE
      : (await stateManager.getNotebook(task.notebookAlias))?.url;

    if (!targetUrl) {
      return {
        success: false,
        error: `Notebook not found: ${task.notebookAlias}`,
      };
    }

    // 2. Acquire tab from pool (affinity → idle reuse → new tab).
    let tabHandle;
    try {
      tabHandle = await tabManager.acquireTab({
        notebookAlias: task.notebookAlias,
        url: targetUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Tab pool at capacity", { taskId: task.taskId, error: msg });
      return { success: false, error: `Tab pool at capacity: ${msg}` };
    }

    try {
      // 3. Build tools for this tab.
      const tools = buildToolsForTab(tabHandle, task.notebookAlias, {
        networkGate,
        cacheManager,
      });

      // 4. Create session hooks.
      const hooks = createSessionHooks({
        networkGate,
        taskId: task.taskId,
        notebookAlias: task.notebookAlias,
      });

      // 5. Run dual session with canonical notebook context.
      const result = await runDualSession(
        {
          client: copilotClient,
          tools,
          agentConfigs,
          hooks,
          locale,
          notebookAlias: task.notebookAlias,
          tabUrl: tabHandle.page.url(),
        },
        task.command,
      );

      const durationMs = Date.now() - startTime;

      // T096: Record operation log entry after task completes.
      try {
        const now = new Date().toISOString();
        const entry: OperationLogEntry = {
          id: randomUUID(),
          taskId: task.taskId,
          notebookAlias: task.notebookAlias,
          command: task.command,
          actionType: inferActionType(task.command),
          status: result.success ? "success" : "failed",
          resultSummary: result.success
            ? (typeof result.result === "object" && result.result !== null
                ? JSON.stringify(result.result).slice(0, 200)
                : "completed")
            : (result.error ?? "unknown error"),
          startedAt: new Date(startTime).toISOString(),
          completedAt: now,
          durationMs,
        };
        await cacheManager.addOperation(entry);
        log.info("Operation log recorded", {
          taskId: task.taskId,
          actionType: entry.actionType,
          status: entry.status,
          durationMs,
        });
      } catch (logErr) {
        // Non-critical — don't fail the task for a logging error.
        log.warn("Failed to record operation log", {
          taskId: task.taskId,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }

      return {
        success: result.success,
        result: result.result as object | undefined,
        error: result.error,
      };
    } finally {
      // 6. Release tab back to pool.
      await tabManager.releaseTab(tabHandle.tabId);

      // 7. Cleanup temp files from content tools (T-SB13).
      try {
        if (existsSync(TMP_DIR)) {
          for (const f of readdirSync(TMP_DIR)) {
            unlinkSync(`${TMP_DIR}/${f}`);
          }
        }
      } catch {
        // Non-critical — temp files will be cleaned next run.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// startDaemon
// ---------------------------------------------------------------------------

export async function startDaemon(options?: {
  headless?: boolean;
  chromePath?: string;
  userDataDir?: string;
}): Promise<DaemonRuntime> {
  const log = logger.child({ module: "daemon" });

  // 1. Initialize components
  const tabManager = new TabManager();
  const copilotClient = CopilotClientSingleton.getInstance();
  const stateManager = new StateManager();
  const taskStore = new TaskStore();
  const cacheManager = new CacheManager();
  const networkGate = NetworkGate.getInstance();
  const notifier = new Notifier(null);

  // 2. Launch Chrome
  log.info("Launching Chrome...");
  await tabManager.launch({
    headless: options?.headless ?? true,
    chromePath: options?.chromePath,
    userDataDir: options?.userDataDir,
  });

  // 2.5. T104: Enforce file permissions on ~/.nbctl/
  await enforcePermissions();

  // 3. T041.1: Detect Chrome locale
  //    Open a temporary tab, evaluate navigator.language, close it
  let locale = "en";
  let uiMap: UIMap;
  try {
    const tempPage = await tabManager.openTab("__locale-detect__", "about:blank");
    const browserLang = await tempPage.page.evaluate(() => navigator.language) as string;
    await tabManager.closeTab(tempPage.tabId);
    locale = resolveLocale(browserLang);
    log.info("Chrome locale detected", { browserLang, resolvedLocale: locale });
  } catch (err) {
    log.warn("Failed to detect Chrome locale, defaulting to 'en'", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  uiMap = loadUIMap(locale);

  // 3.5. Verify Google session — navigate to NotebookLM and check login state.
  //      If not logged in, keep the tab open so the user can log in visually.
  const googleSession = { valid: false };
  try {
    const checkTab = await tabManager.openTab("__session-check__", NOTEBOOKLM_HOMEPAGE);
    // Wait for redirects to settle (Google login redirect takes a moment).
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const finalUrl = checkTab.page.url();

    googleSession.valid =
      finalUrl.startsWith(NOTEBOOKLM_HOMEPAGE) &&
      !finalUrl.includes("accounts.google.com");

    if (googleSession.valid) {
      // Logged in — close the check tab, no longer needed.
      await tabManager.closeTab(checkTab.tabId);
      log.info("Google session valid", { url: finalUrl });
    } else {
      // NOT logged in — keep the tab open so the user can see and complete login.
      // The tab stays in the pool; it will be cleaned up on next reauth or shutdown.
      log.warn(
        "Google session NOT valid — please log in to Google in the Chrome window. " +
          "After logging in, call the reauth tool (headless=true) to resume.",
        { redirectedTo: finalUrl },
      );
    }
  } catch (err) {
    log.warn("Failed to verify Google session", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Start Copilot CLI client
  log.info("Starting Copilot CLI client...");
  await copilotClient.start();

  // 5. Load agent configs
  const agentsDir = existsSync(AGENTS_DIR_USER)
    ? AGENTS_DIR_USER
    : AGENTS_DIR_BUNDLED;
  const agentConfigs = await loadAllAgentConfigs(agentsDir, locale);
  log.info("Agent configs loaded", {
    dir: agentsDir,
    count: agentConfigs.length,
    agents: agentConfigs.map((c) => c.name),
  });

  // 6. Create MCP Server
  const mcpServer = new NbctlMcpServer();

  // 7. Create Scheduler with dual-session runTask wiring
  const scheduler = new Scheduler({
    taskStore,
    runTask: createRunTask({
      copilotClient, tabManager, stateManager, networkGate, cacheManager,
      agentConfigs, locale,
    }),
    onTaskComplete: (task) => notifier.notify(task),
  });

  // 8. Register MCP tools
  registerDaemonTools(mcpServer, {
    tabManager, scheduler, stateManager, networkGate, taskStore,
    agentConfigs, googleSession,
  });
  registerNotebookTools(mcpServer, {
    stateManager, tabManager, cacheManager, scheduler, taskStore,
  });
  registerExecTools(mcpServer, {
    scheduler, stateManager, taskStore,
  });

  // 9. Start MCP Server
  await mcpServer.start();
  notifier.setServer(mcpServer.getServer().server);

  // 10. Update daemon state
  await stateManager.updateDaemon({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: MCP_PORT,
  });

  log.info("Daemon started", {
    pid: process.pid,
    port: MCP_PORT,
    locale,
  });

  return {
    tabManager,
    copilotClient,
    mcpServer,
    scheduler,
    stateManager,
    taskStore,
    cacheManager,
    notifier,
    networkGate,
    agentConfigs,
    locale,
    uiMap,
    googleSession,
  };
}

// ---------------------------------------------------------------------------
// stopDaemon
// ---------------------------------------------------------------------------

export async function stopDaemon(runtime: DaemonRuntime): Promise<void> {
  const log = logger.child({ module: "daemon" });
  log.info("Stopping daemon...");

  // 1. Stop scheduler (cancels queued tasks, waits for running)
  await runtime.scheduler.shutdown();

  // 2. Stop MCP Server
  await runtime.mcpServer.stop();

  // 3. Stop Copilot client
  await runtime.copilotClient.stop();

  // 4. Shutdown Chrome
  await runtime.tabManager.shutdown();

  // 5. Clear daemon state
  await runtime.stateManager.updateDaemon({
    pid: null,
    startedAt: null,
  });

  log.info("Daemon stopped");
}
