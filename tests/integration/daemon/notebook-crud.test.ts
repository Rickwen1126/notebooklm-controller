/**
 * T048: Notebook CRUD integration test
 *
 * Verifies the full notebook management flow through MCP tool handlers:
 * add_notebook -> list_notebooks -> open_notebook -> close_notebook ->
 * set_default -> rename_notebook -> remove_notebook.
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
}));

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
    },
    cacheManager: {},
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
      "add_notebook",
      "add_all_notebooks",
      "list_notebooks",
      "open_notebook",
      "close_notebook",
      "set_default",
      "rename_notebook",
      "remove_notebook",
    ];

    for (const name of expectedTools) {
      expect(server.tools.has(name), `Tool "${name}" should be registered`).toBe(true);
    }

    expect(server.registerTool).toHaveBeenCalledTimes(8);
  });

  // -----------------------------------------------------------------------
  // 2. Full CRUD flow
  // -----------------------------------------------------------------------

  describe("add -> list -> open -> close -> rename -> remove flow", () => {
    // -------------------------------------------------------------------
    // add_notebook
    // -------------------------------------------------------------------

    it("add_notebook creates a new notebook entry", async () => {
      const handler = server.getHandler("add_notebook");
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

    it("add_notebook rejects duplicate alias", async () => {
      const handler = server.getHandler("add_notebook");

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

    it("add_notebook rejects duplicate URL", async () => {
      const handler = server.getHandler("add_notebook");

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

    it("add_notebook rejects invalid URL", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://google.com/not-a-notebook",
          alias: "bad-url",
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid");
    });

    it("add_notebook rejects invalid alias format", async () => {
      const handler = server.getHandler("add_notebook");

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
      const addHandler = server.getHandler("add_notebook");
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
    // open_notebook
    // -------------------------------------------------------------------

    it("open_notebook marks notebook as active", async () => {
      const addHandler = server.getHandler("add_notebook");
      const openHandler = server.getHandler("open_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      const result = parseResult(
        await openHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(result.alias).toBe("research");

      // State was updated to active
      expect(deps.stateManager.updateNotebook).toHaveBeenCalledWith(
        "research",
        expect.objectContaining({ active: true }),
      );
      expect(deps._state.notebooks["research"].active).toBe(true);
    });

    it("open_notebook returns error for non-existent notebook", async () => {
      const handler = server.getHandler("open_notebook");
      const result = parseResult(
        await handler({ alias: "nonexistent" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });

    // -------------------------------------------------------------------
    // close_notebook
    // -------------------------------------------------------------------

    it("close_notebook marks notebook as closed and closes tab", async () => {
      const addHandler = server.getHandler("add_notebook");
      const openHandler = server.getHandler("open_notebook");
      const closeHandler = server.getHandler("close_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      await openHandler({ alias: "research" });

      // Simulate an open tab for this notebook
      (deps.tabManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          tabId: "tab-1",
          notebookAlias: "research",
          url: "https://notebooklm.google.com/notebook/abc123",
        },
      ]);

      const result = parseResult(
        await closeHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);

      // Tab should have been closed
      expect(deps.tabManager.closeTab).toHaveBeenCalledWith("tab-1");

      // State should be updated to inactive/closed
      expect(deps.stateManager.updateNotebook).toHaveBeenCalledWith(
        "research",
        expect.objectContaining({ active: false }),
      );
    });

    // -------------------------------------------------------------------
    // set_default
    // -------------------------------------------------------------------

    it("set_default sets the default notebook", async () => {
      const addHandler = server.getHandler("add_notebook");
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
      const addHandler = server.getHandler("add_notebook");
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
      const addHandler = server.getHandler("add_notebook");
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
    // remove_notebook
    // -------------------------------------------------------------------

    it("remove_notebook removes the notebook", async () => {
      const addHandler = server.getHandler("add_notebook");
      const removeHandler = server.getHandler("remove_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });

      const result = parseResult(
        await removeHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(result.removed).toBe("research");

      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith(
        "research",
      );
      expect(deps._state.notebooks["research"]).toBeUndefined();
    });

    it("remove_notebook closes tab if open", async () => {
      const addHandler = server.getHandler("add_notebook");
      const openHandler = server.getHandler("open_notebook");
      const removeHandler = server.getHandler("remove_notebook");

      await addHandler({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      await openHandler({ alias: "research" });

      // Simulate an open tab
      (deps.tabManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          tabId: "tab-1",
          notebookAlias: "research",
          url: "https://notebooklm.google.com/notebook/abc123",
        },
      ]);

      const result = parseResult(
        await removeHandler({ alias: "research" }),
      );

      expect(result.success).toBe(true);
      expect(deps.tabManager.closeTab).toHaveBeenCalledWith("tab-1");
      expect(deps._state.notebooks["research"]).toBeUndefined();
    });
  });
});
