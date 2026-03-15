import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", () => ({
  MAX_TABS: 10,
}));

// ---------------------------------------------------------------------------
// Mock MCP Server
// ---------------------------------------------------------------------------

import { registerDaemonTools, type ToolRegistrationDeps } from "../../../src/daemon/mcp-tools.js";

function createMockServer() {
  const tools = new Map<string, { options: unknown; handler: (...args: unknown[]) => unknown }>();
  return {
    registerTool: vi.fn((name: string, options: unknown, handler: (...args: unknown[]) => unknown) => {
      tools.set(name, { options, handler });
    }),
    tools,
    getHandler(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" not registered`);
      return tool.handler;
    },
  };
}

function createMockDeps(overrides?: Partial<ToolRegistrationDeps>): ToolRegistrationDeps {
  return {
    tabManager: {
      listTabs: vi.fn().mockReturnValue([]),
      listIdleTabs: vi.fn().mockReturnValue([]),
      listActiveTabs: vi.fn().mockReturnValue([]),
      switchMode: vi.fn().mockResolvedValue(undefined),
    } as unknown as ToolRegistrationDeps["tabManager"],
    scheduler: {
      getQueueSize: vi.fn().mockReturnValue(0),
      getRunningCount: vi.fn().mockReturnValue(0),
      getHealth: vi.fn().mockReturnValue({
        healthy: true,
        consecutiveTimeouts: 0,
        degraded: false,
      }),
    } as unknown as ToolRegistrationDeps["scheduler"],
    stateManager: {
      load: vi.fn().mockResolvedValue({
        version: 1,
        defaultNotebook: "research",
        pid: 123,
        port: 19224,
        startedAt: "2026-01-01T00:00:00Z",
        notebooks: {
          research: { alias: "research" },
          archive: { alias: "archive" },
        },
      }),
    } as unknown as ToolRegistrationDeps["stateManager"],
    networkGate: {
      getHealth: vi.fn().mockReturnValue({
        status: "healthy",
        recentLatencyMs: null,
        backoffRemainingMs: null,
      }),
    } as unknown as ToolRegistrationDeps["networkGate"],
    taskStore: {
      get: vi.fn().mockResolvedValue(null),
      getAll: vi.fn().mockResolvedValue([]),
      getRecent: vi.fn().mockResolvedValue([]),
    } as unknown as ToolRegistrationDeps["taskStore"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDaemonTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let deps: ToolRegistrationDeps;

  beforeEach(() => {
    server = createMockServer();
    deps = createMockDeps();
    registerDaemonTools(server as never, deps);
  });

  it("registers get_status, reauth, and list_agents tools (no shutdown)", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(3);
    expect(server.tools.has("get_status")).toBe(true);
    expect(server.tools.has("shutdown")).toBe(false);
    expect(server.tools.has("reauth")).toBe(true);
    expect(server.tools.has("list_agents")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // get_status
  // -----------------------------------------------------------------------

  describe("get_status", () => {
    it("returns daemon status overview when no params", async () => {
      const handler = server.getHandler("get_status");
      const result = await handler({}) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.running).toBe(true);
      expect(parsed.tabPool).toEqual({ usedSlots: 0, maxSlots: 10, idleSlots: 0 });
      expect(parsed.network.status).toBe("healthy");
      expect(parsed.activeNotebooks).toEqual(["research", "archive"]);
      expect(parsed.defaultNotebook).toBe("research");
      expect(parsed.pendingTasks).toBe(0);
    });

    it("returns single task when taskId is provided", async () => {
      const mockTask = {
        taskId: "abc123",
        status: "completed",
        notebookAlias: "research",
        command: "test command",
      };
      (deps.taskStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockTask);

      const handler = server.getHandler("get_status");
      const result = await handler({ taskId: "abc123" }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskId).toBe("abc123");
      expect(parsed.status).toBe("completed");
    });

    it("returns error when taskId not found", async () => {
      const handler = server.getHandler("get_status");
      const result = await handler({ taskId: "nonexistent" }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("nonexistent");
    });

    it("returns all tasks when all=true", async () => {
      const tasks = [
        { taskId: "t1", status: "completed" },
        { taskId: "t2", status: "running" },
      ];
      (deps.taskStore.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      const handler = server.getHandler("get_status");
      const result = await handler({ all: true, limit: 10 }) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(deps.taskStore.getAll).toHaveBeenCalledWith({ notebook: undefined, limit: 10 });
    });

    it("returns recent tasks when recent=true", async () => {
      const handler = server.getHandler("get_status");
      await handler({ recent: true, notebook: "research" });

      expect(deps.taskStore.getRecent).toHaveBeenCalledWith({
        notebook: "research",
        limit: undefined,
      });
    });
  });

  // -----------------------------------------------------------------------
  // reauth
  // -----------------------------------------------------------------------

  describe("reauth", () => {
    it("switches to headed mode by default", async () => {
      const handler = server.getHandler("reauth");
      const result = await handler({}) as { content: Array<{ text: string }> };

      expect(deps.tabManager.switchMode).toHaveBeenCalledWith(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mode).toBe("headed");
    });

    it("switches to headless when headless=true", async () => {
      const handler = server.getHandler("reauth");
      const result = await handler({ headless: true }) as { content: Array<{ text: string }> };

      expect(deps.tabManager.switchMode).toHaveBeenCalledWith(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.mode).toBe("headless");
    });

    it("returns error when switchMode fails", async () => {
      (deps.tabManager.switchMode as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Cannot switch mode: 3 active tab(s)"),
      );

      const handler = server.getHandler("reauth");
      const result = await handler({}) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("active tab");
    });

    it("has destructiveHint annotation", () => {
      const tool = server.tools.get("reauth")!;
      const options = tool.options as { annotations?: { destructiveHint?: boolean } };
      expect(options.annotations?.destructiveHint).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // list_agents (T100)
  // -----------------------------------------------------------------------

  describe("list_agents", () => {
    it("returns empty array when no agent configs provided", async () => {
      const handler = server.getHandler("list_agents");
      const result = await handler({}) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it("returns agent configs with name, description, tools, and parameters", async () => {
      // Re-create server with agent configs in deps
      server = createMockServer();
      deps = createMockDeps({
        agentConfigs: [
          {
            name: "add-source",
            displayName: "Add Source",
            description: "Add content to a NotebookLM notebook as a source",
            tools: ["find", "click", "paste", "type", "read", "wait", "screenshot"],
            prompt: "test prompt",
            infer: true,
            startPage: "notebook",
            parameters: {
              sourceType: { type: "string", description: "Source type: text | url | repo | pdf", default: "text" },
              sourceContent: { type: "string", description: "Content to add", default: "" },
            },
          },
          {
            name: "query",
            displayName: "Query Notebook",
            description: "Ask a question to NotebookLM",
            tools: ["find", "click", "paste", "read", "wait", "screenshot"],
            prompt: "test prompt",
            infer: true,
            startPage: "notebook",
            parameters: {
              question: { type: "string", description: "The question to ask", default: "" },
            },
          },
        ] as unknown as ToolRegistrationDeps["agentConfigs"],
      });
      registerDaemonTools(server as never, deps);

      const handler = server.getHandler("list_agents");
      const result = await handler({}) as { content: Array<{ text: string }> };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("add-source");
      expect(parsed[0].displayName).toBe("Add Source");
      expect(parsed[0].description).toContain("Add content");
      expect(parsed[0].tools).toContain("find");
      expect(parsed[0].startPage).toBe("notebook");
      expect(parsed[0].parameters.sourceType.type).toBe("string");
      expect(parsed[1].name).toBe("query");
    });

    it("has readOnlyHint annotation", () => {
      const tool = server.tools.get("list_agents")!;
      const options = tool.options as { annotations?: { readOnlyHint?: boolean } };
      expect(options.annotations?.readOnlyHint).toBe(true);
    });
  });
});
