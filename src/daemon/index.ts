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
import { StateManager } from "../state/state-manager.js";
import { TaskStore } from "../state/task-store.js";
import { Notifier } from "../notification/notifier.js";
import { NetworkGate } from "../network-gate/network-gate.js";
import { resolveLocale, loadUIMap } from "../shared/locale.js";
import { MCP_PORT } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { UIMap } from "../shared/types.js";

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
  notifier: Notifier;
  networkGate: NetworkGate;
  locale: string;
  uiMap: UIMap;
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

  // 5. Create MCP Server
  const mcpServer = new NbctlMcpServer();

  // 6. Create Scheduler (runTask will be wired after MCP tools are registered)
  const scheduler = new Scheduler({
    taskStore,
    runTask: async (_task) => {
      // Placeholder — will be wired to session-runner during tool registration
      throw new Error("runTask not yet wired");
    },
    onTaskComplete: (task) => notifier.notify(task),
  });

  // 7. Start MCP Server
  await mcpServer.start();
  notifier.setServer(mcpServer.getServer().server);

  // 8. Update daemon state
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
    notifier,
    networkGate,
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
