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
import { MCP_PORT, AGENTS_DIR_USER, AGENTS_DIR_BUNDLED } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { existsSync } from "node:fs";
import type { UIMap, AgentConfig, AsyncTask } from "../shared/types.js";

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

function createRunTask(
  deps: RunTaskDeps,
): (task: AsyncTask) => Promise<SchedulerSessionResult> {
  const log = logger.child({ module: "daemon:runTask" });

  return async (task: AsyncTask): Promise<SchedulerSessionResult> => {
    const { copilotClient, tabManager, stateManager, networkGate, cacheManager, agentConfigs, locale } = deps;

    // 1. Resolve notebook URL from state.
    const notebook = await stateManager.getNotebook(task.notebookAlias);
    if (!notebook) {
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
        url: notebook.url,
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
          tabUrl: tabHandle.url,
        },
        task.command,
      );

      return {
        success: result.success,
        result: result.result as object | undefined,
        error: result.error,
      };
    } finally {
      // 6. Release tab back to pool.
      await tabManager.releaseTab(tabHandle.tabId);
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
  const shutdownFn = async () => {
    await stopDaemon({
      tabManager, copilotClient, mcpServer, scheduler,
      stateManager, taskStore, cacheManager, notifier, networkGate,
      agentConfigs, locale, uiMap,
    });
  };
  registerDaemonTools(mcpServer, {
    tabManager, scheduler, stateManager, networkGate, taskStore,
    shutdownFn,
  });
  registerNotebookTools(mcpServer, {
    stateManager, tabManager, cacheManager,
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
