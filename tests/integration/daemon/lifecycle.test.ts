/**
 * T037: Daemon lifecycle integration test
 *
 * Verifies the full daemon startup → operation → shutdown flow with all
 * external dependencies mocked (Chrome, Copilot SDK, MCP SDK, filesystem).
 *
 * Focus: wiring correctness — that modules call each other in the right
 * order and the returned DaemonRuntime is properly assembled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DaemonRuntime } from "../../../src/daemon/index.js";
import type { UIMap } from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock: TabManager
// ---------------------------------------------------------------------------

const mockTabManagerInstance = {
  launch: vi.fn().mockResolvedValue(undefined),
  openTab: vi.fn(),
  closeTab: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  listTabs: vi.fn().mockReturnValue([]),
  switchMode: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock("../../../src/tab-manager/tab-manager.js", () => {
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
  getServer: vi.fn().mockReturnValue({
    server: { notification: vi.fn().mockResolvedValue(undefined) },
  }),
};

vi.mock("../../../src/daemon/mcp-server.js", () => {
  const NbctlMcpServer = vi.fn(function (
    this: typeof mockMcpServerInstance,
  ) {
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
  const StateManager = vi.fn(function (
    this: typeof mockStateManagerInstance,
  ) {
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
  getRecent: vi.fn(),
};

vi.mock("../../../src/state/task-store.js", () => {
  const TaskStore = vi.fn(function (this: typeof mockTaskStoreInstance) {
    return Object.assign(this, mockTaskStoreInstance);
  });
  return { TaskStore };
});

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
  BACKOFF_INITIAL_MS: 5000,
  BACKOFF_MAX_MS: 300000,
  MAX_TABS: 10,
  findChromePath: vi.fn().mockReturnValue("/usr/bin/google-chrome"),
}));

// ---------------------------------------------------------------------------
// Import SUT (after all mocks)
// ---------------------------------------------------------------------------

const { startDaemon, stopDaemon } = await import(
  "../../../src/daemon/index.js"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T037: Daemon lifecycle integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: locale detection returns "en-US"
    mockTabManagerInstance.openTab.mockResolvedValue({
      tabId: "locale-tab",
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
  // 1. startDaemon creates runtime with all subsystems
  // -----------------------------------------------------------------------

  describe("startDaemon creates runtime with all subsystems", () => {
    it("returns DaemonRuntime containing every subsystem", async () => {
      const runtime = await startDaemon({
        headless: true,
        chromePath: "/usr/bin/chrome",
        userDataDir: "/tmp/chrome-profile",
      });

      // Every subsystem must be present and non-null
      expect(runtime.tabManager).toBeDefined();
      expect(runtime.copilotClient).toBeDefined();
      expect(runtime.mcpServer).toBeDefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.stateManager).toBeDefined();
      expect(runtime.taskStore).toBeDefined();
      expect(runtime.notifier).toBeDefined();
      expect(runtime.networkGate).toBeDefined();
      expect(runtime.locale).toBeDefined();
      expect(runtime.uiMap).toBeDefined();
    });

    it("TabManager was launched with the provided options", async () => {
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

    it("CopilotClient.start() was called", async () => {
      await startDaemon();
      expect(mockCopilotClient.start).toHaveBeenCalledOnce();
    });

    it("MCP Server was started and Notifier was wired", async () => {
      await startDaemon();

      expect(mockMcpServerInstance.start).toHaveBeenCalledOnce();
      expect(mockNotifierInstance.setServer).toHaveBeenCalledOnce();

      // Notifier gets the low-level Server from mcpServer.getServer().server
      const serverArg = mockNotifierInstance.setServer.mock.calls[0][0];
      expect(serverArg).toHaveProperty("notification");
    });

    it("daemon state is persisted with pid, startedAt, port", async () => {
      await startDaemon();

      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: process.pid,
          startedAt: expect.any(String),
          port: 19224,
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 2. Startup launches Chrome before starting Copilot client
  // -----------------------------------------------------------------------

  it("startup launches Chrome before starting Copilot client", async () => {
    const callOrder: string[] = [];

    mockTabManagerInstance.launch.mockImplementation(async () => {
      callOrder.push("chrome-launch");
    });
    mockTabManagerInstance.openTab.mockImplementation(async () => {
      callOrder.push("locale-detect");
      return {
        tabId: "t",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: {
          evaluate: vi.fn().mockResolvedValue("en-US"),
          close: vi.fn(),
        },
      };
    });
    mockTabManagerInstance.closeTab.mockImplementation(async () => {
      callOrder.push("locale-close");
    });
    mockCopilotClient.start.mockImplementation(async () => {
      callOrder.push("copilot-start");
    });
    mockMcpServerInstance.start.mockImplementation(async () => {
      callOrder.push("mcp-start");
    });

    await startDaemon();

    // Chrome launch must come before Copilot start
    const chromeIdx = callOrder.indexOf("chrome-launch");
    const copilotIdx = callOrder.indexOf("copilot-start");
    expect(chromeIdx).toBeLessThan(copilotIdx);

    // Full expected order
    expect(callOrder).toEqual([
      "chrome-launch",
      "locale-detect",
      "locale-close",
      "copilot-start",
      "mcp-start",
    ]);
  });

  // -----------------------------------------------------------------------
  // 3. Startup detects locale via temp tab
  // -----------------------------------------------------------------------

  describe("startup detects locale via temp tab", () => {
    it("opens about:blank, evaluates navigator.language, and closes tab", async () => {
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue("zh-TW"),
        close: vi.fn(),
      };

      mockTabManagerInstance.openTab.mockResolvedValue({
        tabId: "locale-tab-tw",
        notebookAlias: "__locale-detect__",
        url: "about:blank",
        acquiredAt: "",
        timeoutAt: "",
        cdpSession: {},
        page: mockPage,
      });

      const runtime = await startDaemon();

      // Tab was opened for locale detection
      expect(mockTabManagerInstance.openTab).toHaveBeenCalledWith(
        "__locale-detect__",
        "about:blank",
      );

      // Tab was closed after detection
      expect(mockTabManagerInstance.closeTab).toHaveBeenCalledWith(
        "locale-tab-tw",
      );

      // Locale was correctly resolved
      expect(runtime.locale).toBe("zh-TW");
    });

    it("falls back to en when locale detection throws", async () => {
      mockTabManagerInstance.openTab.mockRejectedValue(
        new Error("Chrome not ready"),
      );

      const runtime = await startDaemon();

      // Should not crash — just fall back
      expect(runtime.locale).toBe("en");
      expect(runtime.uiMap).toBe(mockUIMap);
    });
  });

  // -----------------------------------------------------------------------
  // 4. stopDaemon shuts down subsystems in correct order
  // -----------------------------------------------------------------------

  describe("stopDaemon shuts down subsystems in correct order", () => {
    let runtime: DaemonRuntime;

    beforeEach(async () => {
      runtime = await startDaemon();
      vi.clearAllMocks();
    });

    it("calls shutdown on all subsystems", async () => {
      await stopDaemon(runtime);

      expect(mockSchedulerInstance.shutdown).toHaveBeenCalledOnce();
      expect(mockMcpServerInstance.stop).toHaveBeenCalledOnce();
      expect(mockCopilotClient.stop).toHaveBeenCalledOnce();
      expect(mockTabManagerInstance.shutdown).toHaveBeenCalledOnce();
      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledOnce();
    });

    it("shuts down in order: scheduler → MCP → Copilot → Chrome → state", async () => {
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
  // 5. stopDaemon clears PID from state
  // -----------------------------------------------------------------------

  describe("stopDaemon clears PID from state", () => {
    it("sets pid=null and startedAt=null in daemon state", async () => {
      const runtime = await startDaemon();
      vi.clearAllMocks();

      await stopDaemon(runtime);

      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith({
        pid: null,
        startedAt: null,
      });
    });

    it("state is cleared even after full lifecycle (start then stop)", async () => {
      // Start: pid is set
      const runtime = await startDaemon();
      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: process.pid,
          startedAt: expect.any(String),
        }),
      );

      vi.clearAllMocks();

      // Stop: pid is cleared
      await stopDaemon(runtime);
      expect(mockStateManagerInstance.updateDaemon).toHaveBeenCalledWith({
        pid: null,
        startedAt: null,
      });
    });
  });
});
