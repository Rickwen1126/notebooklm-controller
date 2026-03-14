/**
 * T038: Reauth flow integration test
 *
 * Verifies the `reauth` MCP tool correctly interacts with TabManager's
 * switchMode() method. Tests the wiring from registerDaemonTools through
 * to the actual handler logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
// Mock: config
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", () => ({
  MAX_TABS: 10,
  NOTEBOOKLM_HOMEPAGE: "https://notebooklm.google.com",
}));

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

import {
  registerDaemonTools,
  type ToolRegistrationDeps,
} from "../../../src/daemon/mcp-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockServer() {
  const tools = new Map<
    string,
    { options: unknown; handler: (...args: unknown[]) => unknown }
  >();
  return {
    registerTool: vi.fn(
      (
        name: string,
        options: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        tools.set(name, { options, handler });
      },
    ),
    tools,
    getHandler(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" not registered`);
      return tool.handler;
    },
  };
}

function createMockDeps(
  overrides?: Partial<ToolRegistrationDeps>,
): ToolRegistrationDeps {
  return {
    tabManager: {
      listTabs: vi.fn().mockReturnValue([]),
      switchMode: vi.fn().mockResolvedValue(undefined),
      openTab: vi.fn().mockResolvedValue({
        tabId: "mock-tab",
        page: { url: () => "https://notebooklm.google.com/" },
      }),
      closeTab: vi.fn().mockResolvedValue(undefined),
    } as unknown as ToolRegistrationDeps["tabManager"],
    scheduler: {
      getQueueSize: vi.fn().mockReturnValue(0),
    } as unknown as ToolRegistrationDeps["scheduler"],
    stateManager: {
      load: vi.fn().mockResolvedValue({
        version: 1,
        defaultNotebook: null,
        pid: 123,
        port: 19224,
        startedAt: "2026-01-01T00:00:00Z",
        notebooks: {},
      }),
    } as unknown as ToolRegistrationDeps["stateManager"],
    networkGate: {
      getHealth: vi.fn().mockReturnValue({ status: "healthy" }),
    } as unknown as ToolRegistrationDeps["networkGate"],
    taskStore: {
      get: vi.fn().mockResolvedValue(null),
      getAll: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
    } as unknown as ToolRegistrationDeps["taskStore"],
    shutdownFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T038: Reauth flow integration", () => {
  let server: ReturnType<typeof createMockServer>;
  let deps: ToolRegistrationDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    deps = createMockDeps();
    registerDaemonTools(server as never, deps);
  });

  // -----------------------------------------------------------------------
  // 1. Reauth defaults to headed mode (headless=false)
  // -----------------------------------------------------------------------

  it("reauth defaults to headed mode (headless=false)", async () => {
    const handler = server.getHandler("reauth");
    const result = (await handler({})) as {
      content: Array<{ text: string }>;
    };

    // switchMode called with false (headed)
    expect(deps.tabManager.switchMode).toHaveBeenCalledWith(false);

    // Response indicates headed mode with login status
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.mode).toBe("headed");
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.message).toContain("reauth");
  });

  // -----------------------------------------------------------------------
  // 2. Reauth with headless=true switches back to headless
  // -----------------------------------------------------------------------

  it("reauth with headless=true switches back to headless", async () => {
    const handler = server.getHandler("reauth");
    const result = (await handler({ headless: true })) as {
      content: Array<{ text: string }>;
    };

    // switchMode called with true (headless)
    expect(deps.tabManager.switchMode).toHaveBeenCalledWith(true);

    // Response indicates headless mode
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.mode).toBe("headless");
    expect(parsed.message).toContain("headless mode");
    expect(parsed.message).toContain("resume");
  });

  // -----------------------------------------------------------------------
  // 3. Reauth returns error when tabs are open
  // -----------------------------------------------------------------------

  it("reauth returns error when tabs are open", async () => {
    // Simulate TabManager rejecting switchMode because tabs are open
    (
      deps.tabManager.switchMode as ReturnType<typeof vi.fn>
    ).mockRejectedValue(
      new Error("Cannot switch mode: 3 active tab(s). Close them first."),
    );

    const handler = server.getHandler("reauth");
    const result = (await handler({})) as {
      content: Array<{ text: string }>;
    };

    // switchMode was attempted
    expect(deps.tabManager.switchMode).toHaveBeenCalledWith(false);

    // Response indicates failure
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("active tab");
    expect(parsed.error).toContain("Close them first");
  });

  // -----------------------------------------------------------------------
  // Additional wiring checks
  // -----------------------------------------------------------------------

  it("reauth tool is registered with destructiveHint annotation", () => {
    const tool = server.tools.get("reauth")!;
    expect(tool).toBeDefined();

    const options = tool.options as {
      annotations?: { destructiveHint?: boolean };
    };
    expect(options.annotations?.destructiveHint).toBe(true);
  });

  it("reauth returns error for non-Error exceptions", async () => {
    // Simulate a non-Error throw (string, number, etc.)
    (
      deps.tabManager.switchMode as ReturnType<typeof vi.fn>
    ).mockRejectedValue("unexpected string error");

    const handler = server.getHandler("reauth");
    const result = (await handler({})) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("unexpected string error");
  });
});
