import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, child: () => childLogger };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", () => ({
  MAX_TABS: 10,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  registerNotebookTools,
  type NotebookToolDeps,
} from "../../../src/daemon/notebook-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockServer() {
  const tools = new Map<string, { options: unknown; handler: (...args: unknown[]) => unknown }>();
  return {
    registerTool: vi.fn(
      (name: string, options: unknown, handler: (...args: unknown[]) => unknown) => {
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

function makeState(notebooks: Record<string, unknown> = {}, defaultNotebook: string | null = null) {
  return {
    version: 1 as const,
    defaultNotebook,
    pid: 123,
    port: 19224,
    startedAt: "2026-01-01T00:00:00Z",
    notebooks,
  };
}

function makeEntry(alias: string, overrides?: Record<string, unknown>) {
  return {
    alias,
    url: `https://notebooklm.google.com/notebook/${alias}-id`,
    title: `${alias} title`,
    description: "",
    status: "ready",
    registeredAt: "2026-01-01T00:00:00Z",
    lastAccessedAt: "2026-01-01T00:00:00Z",
    sourceCount: 0,
    ...overrides,
  };
}

function createMockDeps(overrides?: Partial<NotebookToolDeps>): NotebookToolDeps {
  return {
    stateManager: {
      load: vi.fn().mockResolvedValue(makeState()),
      addNotebook: vi.fn().mockResolvedValue(undefined),
      updateNotebook: vi.fn().mockResolvedValue(undefined),
      removeNotebook: vi.fn().mockResolvedValue(undefined),
      setDefault: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotebookToolDeps["stateManager"],
    tabManager: {
      listTabs: vi.fn().mockReturnValue([]),
      closeTab: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotebookToolDeps["tabManager"],
    cacheManager: {} as unknown as NotebookToolDeps["cacheManager"],
    ...overrides,
  };
}

function parseResult(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerNotebookTools", () => {
  let server: ReturnType<typeof createMockServer>;
  let deps: NotebookToolDeps;

  beforeEach(() => {
    server = createMockServer();
    deps = createMockDeps();
    registerNotebookTools(server as never, deps);
  });

  it("registers all 6 notebook management tools", () => {
    expect(server.tools.has("add_notebook")).toBe(true);
    expect(server.tools.has("add_all_notebooks")).toBe(true);
    expect(server.tools.has("list_notebooks")).toBe(true);
    expect(server.tools.has("set_default")).toBe(true);
    expect(server.tools.has("rename_notebook")).toBe(true);
    expect(server.tools.has("remove_notebook")).toBe(true);
    expect(server.tools.has("open_notebook")).toBe(false);
    expect(server.tools.has("close_notebook")).toBe(false);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  // -----------------------------------------------------------------------
  // add_notebook
  // -----------------------------------------------------------------------

  describe("add_notebook", () => {
    it("creates a new notebook entry", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "research",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.alias).toBe("research");
      expect(result.url).toBe("https://notebooklm.google.com/notebook/abc123");
      expect(deps.stateManager.addNotebook).toHaveBeenCalledOnce();
    });

    it("rejects invalid URL", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({ url: "https://example.com", alias: "bad" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("URL");
    });

    it("rejects invalid alias format", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "UPPER_CASE",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("alias");
    });

    it("rejects alias with leading hyphen", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "-bad",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("alias");
    });

    it("rejects empty alias", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Alias");
    });

    it("rejects alias longer than 50 chars", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "a".repeat(51),
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Alias");
    });

    it("rejects duplicate alias", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/new-id",
          alias: "research",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });

    it("rejects duplicate URL", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({
          research: makeEntry("research", {
            url: "https://notebooklm.google.com/notebook/abc123",
          }),
        }),
      );

      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "new-alias",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("already registered");
    });

    it("accepts single character alias", async () => {
      const handler = server.getHandler("add_notebook");
      const result = parseResult(
        await handler({
          url: "https://notebooklm.google.com/notebook/abc123",
          alias: "a",
        }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // list_notebooks
  // -----------------------------------------------------------------------

  describe("list_notebooks", () => {
    it("returns empty array when no notebooks", async () => {
      const handler = server.getHandler("list_notebooks");
      const result = parseResult(await handler({})) as unknown[];

      expect(result).toEqual([]);
    });

    it("returns all registered notebooks", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({
          research: makeEntry("research"),
          archive: makeEntry("archive", { status: "stale" }),
        }),
      );

      const handler = server.getHandler("list_notebooks");
      const result = parseResult(await handler({})) as Array<Record<string, unknown>>;

      expect(result).toHaveLength(2);
      expect(result[0].alias).toBe("research");
      expect(result[1].alias).toBe("archive");
    });

    it("has readOnlyHint annotation", () => {
      const tool = server.tools.get("list_notebooks")!;
      const options = tool.options as { annotations?: { readOnlyHint?: boolean } };
      expect(options.annotations?.readOnlyHint).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // set_default
  // -----------------------------------------------------------------------

  describe("set_default", () => {
    it("sets the default notebook", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("set_default");
      const result = parseResult(
        await handler({ alias: "research" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.default).toBe("research");
      expect(deps.stateManager.setDefault).toHaveBeenCalledWith("research");
    });

    it("returns error for non-existent notebook", async () => {
      const handler = server.getHandler("set_default");
      const result = parseResult(
        await handler({ alias: "nonexistent" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });
  });

  // -----------------------------------------------------------------------
  // rename_notebook
  // -----------------------------------------------------------------------

  describe("rename_notebook", () => {
    it("renames notebook alias", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("rename_notebook");
      const result = parseResult(
        await handler({ oldAlias: "research", newAlias: "my-research" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.oldAlias).toBe("research");
      expect(result.newAlias).toBe("my-research");
    });

    it("rejects when old alias not found", async () => {
      const handler = server.getHandler("rename_notebook");
      const result = parseResult(
        await handler({ oldAlias: "nonexistent", newAlias: "new-name" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });

    it("rejects when new alias already in use", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({
          research: makeEntry("research"),
          archive: makeEntry("archive"),
        }),
      );

      const handler = server.getHandler("rename_notebook");
      const result = parseResult(
        await handler({ oldAlias: "research", newAlias: "archive" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });

    it("rejects invalid new alias format", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("rename_notebook");
      const result = parseResult(
        await handler({ oldAlias: "research", newAlias: "BAD_NAME" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("alias");
    });

    it("updates defaultNotebook when renaming the default", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }, "research"),
      );

      const handler = server.getHandler("rename_notebook");
      await handler({ oldAlias: "research", newAlias: "my-research" });

      // The rename handler should handle updating the default
      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith("research");
      expect(deps.stateManager.addNotebook).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // remove_notebook
  // -----------------------------------------------------------------------

  describe("remove_notebook", () => {
    it("removes the notebook", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("remove_notebook");
      const result = parseResult(
        await handler({ alias: "research" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.removed).toBe("research");
      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith("research");
    });

    it("closes tab before removing", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );
      (deps.tabManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
        { tabId: "tab-1", notebookAlias: "research" },
      ]);

      const handler = server.getHandler("remove_notebook");
      await handler({ alias: "research" });

      expect(deps.tabManager.closeTab).toHaveBeenCalledWith("tab-1");
    });

    it("returns error for non-existent notebook", async () => {
      const handler = server.getHandler("remove_notebook");
      const result = parseResult(
        await handler({ alias: "nonexistent" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });

    it("has destructiveHint annotation", () => {
      const tool = server.tools.get("remove_notebook")!;
      const options = tool.options as { annotations?: { destructiveHint?: boolean } };
      expect(options.annotations?.destructiveHint).toBe(true);
    });
  });
});
