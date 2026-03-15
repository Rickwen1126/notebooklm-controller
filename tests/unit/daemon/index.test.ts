import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DaemonRuntime } from "../../../src/daemon/index.js";
import type { UIMap } from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock: TabManager
// ---------------------------------------------------------------------------

const mockTabManagerInstance = {
  launch: vi.fn().mockResolvedValue(undefined),
  openTab: vi.fn(),
  closeTab: vi.fn().mockResolvedValue(undefined),
  withTempTab: vi.fn(async (_alias: string, _url: string, fn: (tab: any) => Promise<any>) => {
    const tab = await mockTabManagerInstance.openTab(_alias, _url);
    try { return await fn(tab); } finally { await mockTabManagerInstance.closeTab(tab.tabId); }
  }),
  shutdown: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  on: vi.fn(),
};

vi.mock("../../../src/tab-manager/tab-manager.js", () => {
  // Must use `function` (not arrow) to support `new TabManager()`
  const TabManager = vi.fn(function (this: typeof mockTabManagerInstance) {
    return Object.assign(this, mockTabManagerInstance);
  });
  return { TabManager };
});

// ---------------------------------------------------------------------------
// Mock: CopilotClientSingleton
// ---------------------------------------------------------------------------

const mockCopilotClient = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isRunning: vi.fn().mockReturnValue(true),
  getClient: vi.fn(),
};

vi.mock("../../../src/agent/client.js", () => ({
  CopilotClientSingleton: {
    getInstance: vi.fn(() => mockCopilotClient),
    resetInstance: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock: NbctlMcpServer
// ---------------------------------------------------------------------------

const mockMcpServerInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  registerTool: vi.fn(),
  getSessionServers: vi.fn(() => [][Symbol.iterator]()),
};

vi.mock("../../../src/daemon/mcp-server.js", () => {
  const NbctlMcpServer = vi.fn(function (this: typeof mockMcpServerInstance) {
    return Object.assign(this, mockMcpServerInstance);
  });
  return { NbctlMcpServer };
});

// ---------------------------------------------------------------------------
// Mock: Scheduler
// ---------------------------------------------------------------------------

const mockSchedulerInstance = {
  submit: vi.fn(),
  cancel: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getQueueSize: vi.fn().mockReturnValue(0),
};

vi.mock("../../../src/daemon/scheduler.js", () => {
  const Scheduler = vi.fn(function (this: typeof mockSchedulerInstance) {
    return Object.assign(this, mockSchedulerInstance);
  });
  return { Scheduler };
});

// ---------------------------------------------------------------------------
// Mock: StateManager
// ---------------------------------------------------------------------------

const mockStateManagerInstance = {
  load: vi.fn().mockResolvedValue({
    version: 1,
    defaultNotebook: null,
    pid: null,
    port: 19224,
    startedAt: null,
    notebooks: {},
  }),
  save: vi.fn().mockResolvedValue(undefined),
  updateDaemon: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../../src/state/state-manager.js", () => {
  const StateManager = vi.fn(function (this: typeof mockStateManagerInstance) {
    return Object.assign(this, mockStateManagerInstance);
  });
  return { StateManager };
});

// ---------------------------------------------------------------------------
// Mock: TaskStore
// ---------------------------------------------------------------------------

const mockTaskStoreInstance = {
  create: vi.fn(),
  get: vi.fn(),
  getAll: vi.fn(),
};

vi.mock("../../../src/state/task-store.js", () => {
  const TaskStore = vi.fn(function (this: typeof mockTaskStoreInstance) {
    return Object.assign(this, mockTaskStoreInstance);
  });
  return { TaskStore };
});

// ---------------------------------------------------------------------------
// Mock: CacheManager
// ---------------------------------------------------------------------------

const mockCacheManagerInstance = {};

vi.mock("../../../src/state/cache-manager.js", () => {
  const CacheManager = vi.fn(function (this: typeof mockCacheManagerInstance) {
    return Object.assign(this, mockCacheManagerInstance);
  });
  return { CacheManager };
});

// ---------------------------------------------------------------------------
// Mock: mcp-tools (registerDaemonTools)
// ---------------------------------------------------------------------------

vi.mock("../../../src/daemon/mcp-tools.js", () => ({
  registerDaemonTools: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: notebook-tools (registerNotebookTools)
// ---------------------------------------------------------------------------

vi.mock("../../../src/daemon/notebook-tools.js", () => ({
  registerNotebookTools: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: exec-tools (registerExecTools)
// ---------------------------------------------------------------------------

vi.mock("../../../src/daemon/exec-tools.js", () => ({
  registerExecTools: vi.fn(),
}));

vi.mock("../../../src/shared/permissions.js", () => ({
  enforcePermissions: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock: Notifier
// ---------------------------------------------------------------------------

const mockNotifierInstance = {
  setServer: vi.fn(),
  notify: vi.fn(),
};

vi.mock("../../../src/notification/notifier.js", () => {
  const Notifier = vi.fn(function (this: typeof mockNotifierInstance) {
    return Object.assign(this, mockNotifierInstance);
  });
  return { Notifier };
});

// ---------------------------------------------------------------------------
// Mock: NetworkGate
// ---------------------------------------------------------------------------

const mockNetworkGateInstance = {
  acquirePermit: vi.fn().mockResolvedValue(undefined),
  reportAnomaly: vi.fn(),
  getHealth: vi.fn().mockReturnValue({ status: "healthy" }),
  reset: vi.fn(),
};

vi.mock("../../../src/network-gate/network-gate.js", () => ({
  NetworkGate: {
    getInstance: vi.fn(() => mockNetworkGateInstance),
    resetInstance: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock: locale
// ---------------------------------------------------------------------------

const mockUIMap: UIMap = {
  locale: "en",
  verified: false,
  elements: {},
  selectors: {},
};

vi.mock("../../../src/shared/locale.js", () => ({
  resolveLocale: vi.fn((lang: string) => {
    if (lang.startsWith("zh-TW")) return "zh-TW";
    if (lang.startsWith("zh")) return "zh-CN";
    return "en";
  }),
  loadUIMap: vi.fn(() => mockUIMap),
}));

// ---------------------------------------------------------------------------
// Mock: config
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", () => ({
  MCP_PORT: 19224,
  MCP_HOST: "127.0.0.1",
  STATE_FILE: "/tmp/test-state.json",
  TASKS_DIR: "/tmp/test-tasks",
  CACHE_DIR: "/tmp/test-cache",
  BACKOFF_INITIAL_MS: 5000,
  BACKOFF_MAX_MS: 300000,
  MAX_TABS: 10,
  AGENTS_DIR_USER: "/tmp/test-agents-user",
  AGENTS_DIR_BUNDLED: "/tmp/test-agents-bundled",
  findChromePath: vi.fn().mockReturnValue("/usr/bin/google-chrome"),
}));

// ---------------------------------------------------------------------------
// Mock: node:fs (existsSync for agent dir check)
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Mock: agent-loader (loadAllAgentConfigs)
// ---------------------------------------------------------------------------

vi.mock("../../../src/agent/agent-loader.js", () => ({
  loadAllAgentConfigs: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock: session-runner (runDualSession)
// ---------------------------------------------------------------------------

vi.mock("../../../src/agent/session-runner.js", () => ({
  runDualSession: vi.fn().mockResolvedValue({ success: true, durationMs: 100 }),
}));

// ---------------------------------------------------------------------------
// Mock: agent/tools/index (buildToolsForTab)
// ---------------------------------------------------------------------------

vi.mock("../../../src/agent/tools/index.js", () => ({
  buildToolsForTab: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Mock: agent/hooks (createSessionHooks)
// ---------------------------------------------------------------------------

vi.mock("../../../src/agent/hooks.js", () => ({
  createSessionHooks: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Import SUT (after all mocks)
// ---------------------------------------------------------------------------

const { startDaemon, stopDaemon } = await import("../../../src/daemon/index.js");
const { resolveLocale, loadUIMap } = await import("../../../src/shared/locale.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Daemon entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: locale detection returns "en-US"
    mockTabManagerInstance.openTab.mockResolvedValue({
      tabId: "temp-tab-id",
      notebookAlias: "__locale-detect__",
      url: "about:blank",
      acquiredAt: new Date().toISOString(),
      timeoutAt: new Date().toISOString(),
      cdpSession: {},
      page: {
        evaluate: vi.fn().mockResolvedValue("en-US"),
        close: vi.fn(),
      },
    });
  });

  // -----------------------------------------------------------------------
  // startDaemon
  // -----------------------------------------------------------------------

  describe("startDaemon", () => {
    it("creates all components and returns DaemonRuntime", async () => {
      const runtime = await startDaemon({
        headless: true,
        chromePath: "/usr/bin/chrome",
        userDataDir: "/tmp/chrome-profile",
      });

      // Verify runtime shape
      expect(runtime).toHaveProperty("tabManager");
      expect(runtime).toHaveProperty("copilotClient");
      expect(runtime).toHaveProperty("mcpServer");
      expect(runtime).toHaveProperty("scheduler");
      expect(runtime).toHaveProperty("stateManager");
      expect(runtime).toHaveProperty("taskStore");
      expect(runtime).toHaveProperty("cacheManager");
      expect(runtime).toHaveProperty("notifier");
      expect(runtime).toHaveProperty("networkGate");
      expect(runtime).toHaveProperty("agentConfigs");
      expect(runtime).toHaveProperty("locale");
      expect(runtime).toHaveProperty("uiMap");

      // Verify locale defaults
      expect(runtime.locale).toBe("en");
      expect(runtime.uiMap).toBe(mockUIMap);
    });

    it("launches Chrome with provided options", async () => {
      await startDaemon({
        headless: false,
        chromePath: "/opt/chrome",
        userDataDir: "/data/profile",
      });

      expect(mockTabManagerInstance.launch).toHaveBeenCalledWith({
        headless: false,
        chromePath: "/opt/chrome",
        userDataDir: "/data/profile",
      });
    });

    it("defaults headless to true when not specified", async () => {
      await startDaemon();

      expect(mockTabManagerInstance.launch).toHaveBeenCalledWith({
        headless: true,
        chromePath: undefined,
        userDataDir: undefined,
      });
    });

    it("starts Copilot CLI client", async () => {
      await startDaemon();
      expect(mockCopilotClient.start).toHaveBeenCalledOnce();
    });

    it("starts MCP server and wires notifier", async () => {
      await startDaemon();

      expect(mockMcpServerInstance.start).toHaveBeenCalledOnce();
      expect(mockNotifierInstance.setServer).toHaveBeenCalledOnce();

      // Notifier should receive the NbctlMcpServer (has getSessionServers for broadcast)
      const serverArg = mockNotifierInstance.setServer.mock.calls[0][0];
      expect(serverArg).toHaveProperty("getSessionServers");
    });

    it("updates daemon state with pid, startedAt, and port", async () => {
      await startDaemon();

      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: process.pid,
          startedAt: expect.any(String),
          port: 19224,
        }),
      );
    });

    it("startup order: Chrome first, then locale, then Copilot, then MCP", async () => {
      const callOrder: string[] = [];

      mockTabManagerInstance.launch.mockImplementation(async () => {
        callOrder.push("chrome-launch");
      });
      mockTabManagerInstance.openTab.mockImplementation(async () => {
        callOrder.push("locale-detect-open");
        return {
          tabId: "t",
          notebookAlias: "__locale-detect__",
          url: "about:blank",
          acquiredAt: "",
          timeoutAt: "",
          cdpSession: {},
          page: { evaluate: vi.fn().mockResolvedValue("en-US"), close: vi.fn() },
        };
      });
      mockTabManagerInstance.closeTab.mockImplementation(async () => {
        callOrder.push("locale-detect-close");
      });
      mockCopilotClient.start.mockImplementation(async () => {
        callOrder.push("copilot-start");
      });
      mockMcpServerInstance.start.mockImplementation(async () => {
        callOrder.push("mcp-start");
      });

      await startDaemon();

      expect(callOrder).toEqual([
        "chrome-launch",
        "locale-detect-open",
        "locale-detect-close",
        "copilot-start",
        "mcp-start",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // stopDaemon
  // -----------------------------------------------------------------------

  describe("stopDaemon", () => {
    let runtime: DaemonRuntime;

    beforeEach(async () => {
      runtime = await startDaemon();
      vi.clearAllMocks();
    });

    it("shuts everything down", async () => {
      await stopDaemon(runtime);

      expect(mockSchedulerInstance.shutdown).toHaveBeenCalledOnce();
      expect(mockMcpServerInstance.stop).toHaveBeenCalledOnce();
      expect(mockCopilotClient.stop).toHaveBeenCalledOnce();
      expect(mockTabManagerInstance.shutdown).toHaveBeenCalledOnce();
    });

    it("clears daemon state (pid=null, startedAt=null)", async () => {
      await stopDaemon(runtime);

      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith({
        pid: null,
        startedAt: null,
      });
    });

    it("shutdown order: scheduler, MCP, Copilot, Chrome, state", async () => {
      const callOrder: string[] = [];

      mockSchedulerInstance.shutdown.mockImplementation(async () => {
        callOrder.push("scheduler-shutdown");
      });
      mockMcpServerInstance.stop.mockImplementation(async () => {
        callOrder.push("mcp-stop");
      });
      mockCopilotClient.stop.mockImplementation(async () => {
        callOrder.push("copilot-stop");
      });
      mockTabManagerInstance.shutdown.mockImplementation(async () => {
        callOrder.push("chrome-shutdown");
      });
      mockStateManagerInstance.updateDaemon.mockImplementation(async () => {
        callOrder.push("state-clear");
      });

      await stopDaemon(runtime);

      expect(callOrder).toEqual([
        "scheduler-shutdown",
        "mcp-stop",
        "copilot-stop",
        "chrome-shutdown",
        "state-clear",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Locale detection (T041.1)
  // -----------------------------------------------------------------------

  describe("locale detection (T041.1)", () => {
    it("detects zh-TW locale from browser", async () => {
      mockTabManagerInstance.openTab.mockResolvedValue({
        tabId: "locale-tab",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: {
          evaluate: vi.fn().mockResolvedValue("zh-TW"),
          close: vi.fn(),
        },
      });

      const runtime = await startDaemon();

      expect(runtime.locale).toBe("zh-TW");
      expect(resolveLocale).toHaveBeenCalledWith("zh-TW");
      expect(loadUIMap).toHaveBeenCalledWith("zh-TW");
    });

    it("detects zh-CN locale from browser", async () => {
      mockTabManagerInstance.openTab.mockResolvedValue({
        tabId: "locale-tab",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: {
          evaluate: vi.fn().mockResolvedValue("zh-CN"),
          close: vi.fn(),
        },
      });

      const runtime = await startDaemon();

      expect(runtime.locale).toBe("zh-CN");
      expect(resolveLocale).toHaveBeenCalledWith("zh-CN");
      expect(loadUIMap).toHaveBeenCalledWith("zh-CN");
    });

    it("opens a temp tab on about:blank for locale detection", async () => {
      await startDaemon();

      expect(mockTabManagerInstance.openTab).toHaveBeenCalledWith(
        "__locale-detect__",
        "about:blank",
      );
    });

    it("closes the temp tab after detection", async () => {
      mockTabManagerInstance.openTab.mockResolvedValue({
        tabId: "temp-123",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: {
          evaluate: vi.fn().mockResolvedValue("en-US"),
          close: vi.fn(),
        },
      });

      await startDaemon();

      expect(mockTabManagerInstance.closeTab).toHaveBeenCalledWith("temp-123");
    });

    it("falls back to 'en' if locale detection fails", async () => {
      mockTabManagerInstance.openTab.mockRejectedValue(
        new Error("tab open failed"),
      );

      const runtime = await startDaemon();

      expect(runtime.locale).toBe("en");
      expect(loadUIMap).toHaveBeenCalledWith("en");
    });

    it("falls back to 'en' if page.evaluate throws", async () => {
      mockTabManagerInstance.openTab.mockResolvedValue({
        tabId: "broken-tab",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: {
          evaluate: vi.fn().mockRejectedValue(new Error("evaluate failed")),
          close: vi.fn(),
        },
      });

      const runtime = await startDaemon();

      expect(runtime.locale).toBe("en");
      expect(loadUIMap).toHaveBeenCalledWith("en");
    });
  });
});
