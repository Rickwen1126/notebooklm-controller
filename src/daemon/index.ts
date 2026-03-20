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
import { runPipeline } from "../agent/session-runner.js";
import { runScanAllNotebooksTask } from "../agent/scan-notebooks-runner.js";
import { buildToolsForTab } from "../agent/tools/index.js";
import { MCP_PORT, NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { enforcePermissions } from "../shared/permissions.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import type { UIMap, AsyncTask, OperationActionType, OperationLogEntry } from "../shared/types.js";
import type { RunTaskDeps, TaskRunner } from "./types.js";
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
  locale: string;
  uiMap: UIMap;
  /** Mutable Google session state — updated by startup check and reauth. */
  googleSession: { valid: boolean };
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
// runPipelineTask — the default runner (G2 script-first pipeline)
// ---------------------------------------------------------------------------

const runPipelineTask: TaskRunner = async (
  task,
  tabHandle,
  deps,
) => {
  const log = logger.child({ module: "daemon:runPipelineTask" });

  // 1. Ensure tab is on the correct page (tab pool reuse may leave
  //    tab on a different URL, e.g. homepage after S12 deleteNotebook).
  const isHomepage = task.notebookAlias === "__homepage__";
  const currentUrl = tabHandle.page.url();
  const targetUrl = tabHandle.url;
  if (!isHomepage && !currentUrl.startsWith(targetUrl)) {
    await tabHandle.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2000));
    log.info("Tab navigated to correct URL", { from: currentUrl.slice(0, 60), to: targetUrl.slice(0, 60) });
  }

  // 2. Build tools for this tab (Recovery session uses these).
  const tools = buildToolsForTab(tabHandle, task.notebookAlias, {
    networkGate: deps.networkGate,
    cacheManager: deps.cacheManager,
  });

  // 3. Run dual session: Planner → Script → Recovery-on-fail.
  const result = await runPipeline(
    {
      client: deps.copilotClient,
      tools,
      cdpSession: tabHandle.cdpSession,
      page: tabHandle.page,
      uiMap: deps.uiMap,
      locale: deps.locale,
      notebookAlias: task.notebookAlias,
      taskId: task.taskId,
      networkGate: deps.networkGate,
    },
    task.command,
  );

  // 4. Map pipeline result to scheduler result.
  return {
    success: result.success,
    result: result.result as object | undefined,
    error: result.error
      ?? (result.rejected
        ? `Rejected (${result.rejectionCategory}): ${result.rejectionReason}`
        : undefined),
  };
}

// ---------------------------------------------------------------------------
// RUNNER_REGISTRY — maps runner name → TaskRunner function
// ---------------------------------------------------------------------------

export const RUNNER_REGISTRY: Readonly<Record<string, TaskRunner>> = Object.freeze({
  pipeline: runPipelineTask,
  scanAllNotebooks: runScanAllNotebooksTask,
});

// ---------------------------------------------------------------------------
// T068J: createRunTask — dispatcher (shared concerns + runner dispatch)
// (with T096: operation log recording)
// ---------------------------------------------------------------------------

function createRunTask(
  deps: RunTaskDeps,
): (task: AsyncTask) => Promise<SchedulerSessionResult> {
  const log = logger.child({ module: "daemon:runTask" });

  return async (task: AsyncTask): Promise<SchedulerSessionResult> => {
    const { tabManager, stateManager, cacheManager } = deps;
    const startTime = Date.now();

    // 0. Look up runner — fail fast if unknown.
    const runnerName = task.runner ?? "pipeline";
    const runner = RUNNER_REGISTRY[runnerName];
    if (!runner) {
      return {
        success: false,
        error: `Unknown runner: ${runnerName}`,
      };
    }

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
      // 3. Set viewport — MUST use Emulation.setDeviceMetricsOverride
      //    (not setViewport). 800x600 triggers mobile tab view.
      //    1920x1080: homepage list view's more_vert column needs > 1500px.
      await tabHandle.cdpSession.send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false,
      });

      // 4. Dispatch to runner.
      const result = await runner(task, tabHandle, deps);

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

      return result;
    } finally {
      // 5. Release tab back to pool.
      await tabManager.releaseTab(tabHandle.tabId);

      // 6. Cleanup temp files from content tools (T-SB13).
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
  const notifier = new Notifier(null); // mcpServer set below after start()

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
    const browserLang = await tabManager.withTempTab(
      "__locale-detect__",
      "about:blank",
      async (tab) => await tab.page.evaluate(() => navigator.language) as string,
    );
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

  // 5. Create MCP Server
  const mcpServer = new NbctlMcpServer();

  // 6. Create Scheduler with G2 script-first runTask wiring
  const scheduler = new Scheduler({
    taskStore,
    runTask: createRunTask({
      copilotClient, tabManager, stateManager, networkGate, cacheManager,
      locale, uiMap,
    }),
    onTaskComplete: (task) => notifier.notify(task),
  });

  // 7. Register MCP tools
  registerDaemonTools(mcpServer, {
    tabManager, scheduler, stateManager, networkGate, taskStore,
    googleSession,
  });
  registerNotebookTools(mcpServer, {
    stateManager, tabManager, cacheManager, scheduler, taskStore,
  });
  registerExecTools(mcpServer, {
    scheduler, stateManager, taskStore,
  });

  // 9. Start MCP Server
  await mcpServer.start();
  // Pass NbctlMcpServer to Notifier for best-effort broadcast.
  // NOTE: Notifications are expected to fail for stateless clients (Claude Code).
  // Async task results are retrieved via polling (get_status). See notifier.ts 待研究.
  notifier.setServer(mcpServer);

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
