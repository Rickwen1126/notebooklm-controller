/**
 * T048: Notebook CRUD integration test
 *
 * Verifies the full notebook management flow through MCP tool handlers:
 * register_notebook -> list_notebooks -> set_default -> rename_notebook -> unregister_notebook.
 *
 * Uses a mock server pattern (same as lifecycle.test.ts / reauth.test.ts)
 * with in-memory state for realistic state transition testing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop, debug: noop,
    error: noop,
    child: () => childLogger,
  };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock: config
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, MAX_TABS: 10 };
});

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------

import { registerNotebookTools } from "../../../src/daemon/notebook-tools.js";
import type { NotebookEntry } from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock MCP server that captures tool registrations. */
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

/** In-memory mock deps that simulate real state transitions. */
function createMockDeps() {
  const inMemoryState = {
    version: 1 as const,
    defaultNotebook: null as string | null,
    pid: 123,
    port: 19224,
    startedAt: "2026-01-01T00:00:00Z",
    notebooks: {} as Record<string, NotebookEntry>,
  };

  return {
    stateManager: {
      load: vi.fn().mockImplementation(async () => ({
        ...inMemoryState,
        notebooks: { ...inMemoryState.notebooks },
      })),
      addNotebook: vi.fn().mockImplementation(async (entry: NotebookEntry) => {
        inMemoryState.notebooks[entry.alias] = entry;
      }),
      updateNotebook: vi
        .fn()
        .mockImplementation(
          async (alias: string, updates: Partial<NotebookEntry>) => {
            if (!inMemoryState.notebooks[alias])
              throw new Error(`Notebook not found: ${alias}`);
            inMemoryState.notebooks[alias] = {
              ...inMemoryState.notebooks[alias],
              ...updates,
            };
          },
        ),
      removeNotebook: vi.fn().mockImplementation(async (alias: string) => {
        if (!inMemoryState.notebooks[alias])
          throw new Error(`Notebook not found: ${alias}`);
        delete inMemoryState.notebooks[alias];
        if (inMemoryState.defaultNotebook === alias) {
          inMemoryState.defaultNotebook = null;
        }
      }),
      setDefault: vi
        .fn()
        .mockImplementation(async (alias: string | null) => {
          if (alias !== null && !inMemoryState.notebooks[alias])
            throw new Error(`Notebook not found: ${alias}`);
          inMemoryState.defaultNotebook = alias;
        }),
      getNotebook: vi
        .fn()
        .mockImplementation(
          async (alias: string) =>
            inMemoryState.notebooks[alias] ?? undefined,
        ),
    },
    tabManager: {
      listTabs: vi.fn().mockReturnValue([]),
      closeTab: vi.fn().mockResolvedValue(undefined),
      acquireTab: vi.fn(),
      releaseTab: vi.fn(),
    },
    cacheManager: {
      clearNotebook: vi.fn().mockResolvedValue(undefined),
    },
    scheduler: {
      submit: vi.fn().mockResolvedValue({
        taskId: "task-create-001",
        notebookAlias: "__homepage__",
        runner: "createNotebook",
        runnerInput: { title: "My Research", alias: "my-research" },
        command: "create_notebook",
        context: null,
        status: "queued",
        result: null,
        error: null,
        errorScreenshot: null,
        history: [],
        createdAt: "2026-01-01T00:00:00Z",
      }),
      waitForTask: vi.fn().mockResolvedValue(undefined),
    },
    taskStore: {
      get: vi.fn().mockResolvedValue({
        taskId: "task-create-001",
        notebookAlias: "__homepage__",
        runner: "createNotebook",
        runnerInput: { title: "My Research", alias: "my-research" },
        command: "create_notebook",
        context: null,
        status: "completed",
        result: {
          success: true,
          alias: "my-research",
          url: "https://notebooklm.google.com/notebook/new123",
          title: "My Research",
        },
        error: null,
        errorScreenshot: null,
        history: [],
        createdAt: "2026-01-01T00:00:00Z",
      }),
    },
    _state: inMemoryState, // expose for assertions
  };
}

type MockDeps = ReturnType<typeof createMockDeps>;
type MockServer = ReturnType<typeof createMockServer>;

/** Parse the JSON text from a tool handler result. */
function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T048: Notebook CRUD integration", () => {
  let server: MockServer;
  let deps: MockDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    deps = createMockDeps();
    registerNotebookTools(server as never, deps as never);
  });

  // -----------------------------------------------------------------------
  // 1. All 7 notebook management tools are registered
  // -----------------------------------------------------------------------

  it("registers all 8 notebook management tools", () => {
    const expectedTools = [
      "create_notebook",
      "register_notebook",
      "register_all_notebooks",
      "list_notebooks",
      "list_notebook_index",
      "set_default",
      "rename_notebook",
      "unregister_notebook",
    ];

    for (const name of expectedTools) {
      expect(server.tools.has(name), `Tool "${name}" should be registered`).toBe(true);
    }

    expect(server.tools.has("open_notebook")).toBe(false);
    expect(server.tools.has("close_notebook")).toBe(false);
    expect(server.registerTool).toHaveBeenCalledTimes(8);
  });

  // -----------------------------------------------------------------------
  // 2. Full CRUD flow
  // -----------------------------------------------------------------------

  describe("add -> list -> set_default -> rename -> unregister flow", () => {
    it("create_notebook submits the createNotebook runner and returns its result", async () => {
      const createHandler = server.getHandler("create_notebook");
      const result = parseResult(
        await createHandler({ title: "My Research" }),
      );

      expect(result).toEqual({
        success: true,
        alias: "my-research",
        url: "https://notebooklm.google.com/notebook/new123",
        title: "My Research",
      });
      expect(deps.scheduler.submit).toHaveBeenCalledWith({
        notebookAlias: "__homepage__",
        command: "create_notebook",
        runner: "createNotebook",
        runnerInput: { title: "My Research", alias: "my-research" },
      });
      expect(deps.tabManager.acquireTab).not.toHaveBeenCalled();
      expect(deps.stateManager.addNotebook).not.toHaveBeenCalled();
    });

    it("register_all_notebooks supports async mode for large scans", async () => {
      const handler = server.getHandler("register_all_notebooks");
      const result = parseResult(await handler({ async: true }));

      expect(result).toEqual({
        taskId: "task-create-001",
        status: "queued",
        notebook: "__homepage__",
        next_action: "Call get_status(taskId='task-create-001') every 15-20 seconds. Stop when status is 'completed' or 'failed'.",
      });
      expect(deps.scheduler.submit).toHaveBeenCalledWith({
        notebookAlias: "__homepage__",
        command: "register_all_notebooks",
        runner: "scanAllNotebooks",
      });
      expect(deps.tabManager.acquireTab).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // register_notebook
    // -------------------------------------------------------------------

    it("register_notebook creates a new notebook entry", async () => {
      const handler = server.getHandler("register_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "research",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.alias).toBe("research");
      expect(result.url).toBe(
        "https://notebooklm.google.com/notebook/abc123",
      );

      // State was updated
      expect(deps.stateManager.addNotebook).toHaveBeenCalledOnce();
      expect(deps._state.notebooks["research"]).toBeDefined();
      expect(deps._state.notebooks["research"].alias).toBe("research");
      expect(deps._state.notebooks["research"].url).toBe(
        "https://notebooklm.google.com/notebook/abc123",
      );
    });

    it("register_notebook rejects duplicate alias", async () => {
      const handler = server.getHandler("register_notebook");

      // First add succeeds
      await handler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      // Second add with same alias fails
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/def456",
          alias: "research",
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });

    it("register_notebook rejects duplicate URL", async () => {
      const handler = server.getHandler("register_notebook");

      // First add succeeds
      await handler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      // Second add with same URL fails
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "other-name",
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already registered");
    });

    it("register_notebook rejects invalid URL", async () => {
      const handler = server.getHandler("register_notebook");
      const result = parseResult(
        await handler({
          url: "https://google.com/not-a-notebook",
          alias: "bad-url",
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid");
    });

    it("register_notebook rejects invalid alias format", async () => {
      const handler = server.getHandler("register_notebook");

      // Uppercase not allowed
      const result1 = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "MyResearch",
        }),
      );
      expect(result1.success).toBe(false);
      expect(result1.error).toBeDefined();

      // Special characters not allowed (except hyphens)
      const result2 = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "my_research!",
        }),
      );
      expect(result2.success).toBe(false);

      // Empty alias not allowed
      const result3 = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "",
        }),
      );
      expect(result3.success).toBe(false);

      // Too long (>50 chars) not allowed
      const result4 = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "a".repeat(51),
        }),
      );
      expect(result4.success).toBe(false);
    });

    // -------------------------------------------------------------------
    // list_notebooks
    // -------------------------------------------------------------------

    it("list_notebooks returns added notebooks", async () => {
      const addHandler = server.getHandler("register_notebook");
      const listHandler = server.getHandler("list_notebooks");

      // Add two notebooks
      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      await addHandler({
        url: "https://notebooklm.google.com/notebook/def456",
        alias: "ml-papers",
      });

      // list_notebooks returns an array directly (not wrapped in an object)
      const r = await listHandler({});
      const content = (r as { content: Array<{ text: string }> }).content[0].text;
      const notebooks = JSON.parse(content) as Array<Record<string, unknown>>;

      expect(notebooks).toHaveLength(2);

      const aliases = notebooks.map((n) => n.alias);
      expect(aliases).toContain("research");
      expect(aliases).toContain("ml-papers");
    });

    // -------------------------------------------------------------------
    // list_notebook_index
    // -------------------------------------------------------------------

    it("list_notebook_index returns grouped topics and canonical aliases", async () => {
      const addHandler = server.getHandler("register_notebook");
      const renameHandler = server.getHandler("rename_notebook");
      const indexHandler = server.getHandler("list_notebook_index");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "go-a",
      });
      await addHandler({
        url: "https://notebooklm.google.com/notebook/def456",
        alias: "go-b",
      });

      await renameHandler({
        oldAlias: "go-a",
        newAlias: "go-concurrency-canonical",
      });
      await renameHandler({
        oldAlias: "go-b",
        newAlias: "go-concurrency-reference",
      });

      const r = await indexHandler({});
      const content = (r as { content: Array<{ text: string }> }).content[0].text;
      const index = JSON.parse(content) as {
        mode: string;
        domains: Array<{
          domain: string;
          topics: Array<{ topic: string; canonicalAlias: string | null }>;
        }>;
      };

      expect(index.mode).toBe("grouped");
      const goDomain = index.domains.find((d) => d.domain === "go");
      expect(goDomain).toBeDefined();
      expect(goDomain?.topics[0].topic).toBe("concurrency");
      expect(goDomain?.topics[0].canonicalAlias).toBe("go-concurrency-canonical");
    });

    // -------------------------------------------------------------------
    // set_default
    // -------------------------------------------------------------------

    it("set_default sets the default notebook", async () => {
      const addHandler = server.getHandler("register_notebook");
      const setDefaultHandler = server.getHandler("set_default");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      const result = parseResult(
        await setDefaultHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(result.default).toBe("research");

      expect(deps.stateManager.setDefault).toHaveBeenCalledWith("research");
      expect(deps._state.defaultNotebook).toBe("research");
    });

    // -------------------------------------------------------------------
    // rename_notebook
    // -------------------------------------------------------------------

    it("rename_notebook changes the alias", async () => {
      const addHandler = server.getHandler("register_notebook");
      const renameHandler = server.getHandler("rename_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      const result = parseResult(
        await renameHandler({
          oldAlias: "research",
          newAlias: "my-research",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.oldAlias).toBe("research");
      expect(result.newAlias).toBe("my-research");

      // Old alias should be gone, new alias should exist
      expect(deps._state.notebooks["research"]).toBeUndefined();
      expect(deps._state.notebooks["my-research"]).toBeDefined();
      expect(deps._state.notebooks["my-research"].url).toBe(
        "https://notebooklm.google.com/notebook/abc123",
      );
    });

    it("rename_notebook rejects duplicate new alias", async () => {
      const addHandler = server.getHandler("register_notebook");
      const renameHandler = server.getHandler("rename_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      await addHandler({
        url: "https://notebooklm.google.com/notebook/def456",
        alias: "ml-papers",
      });

      const result = parseResult(
        await renameHandler({
          oldAlias: "research",
          newAlias: "ml-papers",
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });

    // -------------------------------------------------------------------
    // unregister_notebook
    // -------------------------------------------------------------------

    it("unregister_notebook removes the notebook and cleans cache", async () => {
      const addHandler = server.getHandler("register_notebook");
      const unregisterHandler = server.getHandler("unregister_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      const result = parseResult(
        await unregisterHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(result.unregistered).toBe("research");

      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith(
        "research",
      );
      expect(deps.cacheManager.clearNotebook).toHaveBeenCalledWith(
        "research",
      );
      expect(deps._state.notebooks["research"]).toBeUndefined();
    });

    it("unregister_notebook does NOT close tab even if one is open", async () => {
      const addHandler = server.getHandler("register_notebook");
      const unregisterHandler = server.getHandler("unregister_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      // Simulate an open tab
      (deps.tabManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          tabId: "tab-1",
          notebookAlias: "research",
          url: "https://notebooklm.google.com/notebook/abc123",
        },
      ]);

      const result = parseResult(
        await unregisterHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(deps.tabManager.closeTab).not.toHaveBeenCalled();
      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith("research");
      expect(deps.cacheManager.clearNotebook).toHaveBeenCalledWith("research");
      expect(deps._state.notebooks["research"]).toBeUndefined();
    });
  });
});
