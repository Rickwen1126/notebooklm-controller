import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock content modules
vi.mock("../../../src/content/repo-to-text.js", () => ({
  repoToText: vi.fn(),
}));
vi.mock("../../../src/content/url-to-text.js", () => ({
  urlToText: vi.fn(),
}));
vi.mock("../../../src/content/pdf-to-text.js", () => ({
  pdfToText: vi.fn(),
}));
vi.mock("../../../src/scripts/operations.js", () => ({
  scriptedQuery: vi.fn(),
  scriptedAddSource: vi.fn().mockResolvedValue({
    operation: "addSource", status: "success", result: "added", log: [], totalMs: 100, failedAtStep: null, failedSelector: null,
  }),
  scriptedListSources: vi.fn(),
  scriptedRemoveSource: vi.fn(),
  scriptedRenameSource: vi.fn(),
  scriptedClearChat: vi.fn(),
  scriptedListNotebooks: vi.fn(),
  scriptedCreateNotebook: vi.fn(),
  scriptedRenameNotebook: vi.fn(),
  scriptedDeleteNotebook: vi.fn(),
}));
vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

// Mock fs.readFileSync for temp file reading
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, readFileSync: vi.fn().mockReturnValue("converted content from file") };
});

import { runScript, buildScriptCatalog, getAvailableOperations } from "../../../src/scripts/index.js";
import { repoToText } from "../../../src/content/repo-to-text.js";
import { urlToText } from "../../../src/content/url-to-text.js";
import { pdfToText } from "../../../src/content/pdf-to-text.js";
import { scriptedAddSource } from "../../../src/scripts/operations.js";
import { readFileSync } from "node:fs";
import type { ScriptContext } from "../../../src/scripts/types.js";

const mockCtx = {} as ScriptContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addSource preprocessing", () => {
  it("passes text content directly when sourceType is text or absent", async () => {
    await runScript("addSource", { content: "hello world" }, mockCtx);
    expect(scriptedAddSource).toHaveBeenCalledWith(mockCtx, "hello world");
  });

  it("converts repo via repoToText when sourceType=repo", async () => {
    vi.mocked(repoToText).mockResolvedValue({ filePath: "/tmp/repo.txt", charCount: 100, wordCount: 20 });
    await runScript("addSource", { sourceType: "repo", sourcePath: "/abs/path" }, mockCtx);
    expect(repoToText).toHaveBeenCalledWith("/abs/path");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/repo.txt", "utf-8");
    expect(scriptedAddSource).toHaveBeenCalledWith(mockCtx, "converted content from file");
  });

  it("converts URL via urlToText when sourceType=url", async () => {
    vi.mocked(urlToText).mockResolvedValue({ filePath: "/tmp/url.txt", charCount: 200, wordCount: 40 });
    await runScript("addSource", { sourceType: "url", sourceUrl: "https://example.com" }, mockCtx);
    expect(urlToText).toHaveBeenCalledWith("https://example.com");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/url.txt", "utf-8");
    expect(scriptedAddSource).toHaveBeenCalledWith(mockCtx, "converted content from file");
  });

  it("converts PDF via pdfToText when sourceType=pdf", async () => {
    vi.mocked(pdfToText).mockResolvedValue({ filePath: "/tmp/pdf.txt", charCount: 300, wordCount: 60, pageCount: 5 });
    await runScript("addSource", { sourceType: "pdf", sourcePath: "/abs/paper.pdf" }, mockCtx);
    expect(pdfToText).toHaveBeenCalledWith("/abs/paper.pdf");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/pdf.txt", "utf-8");
    expect(scriptedAddSource).toHaveBeenCalledWith(mockCtx, "converted content from file");
  });

  it("returns fail when sourcePath missing for repo", async () => {
    const result = await runScript("addSource", { sourceType: "repo" }, mockCtx);
    expect(result.status).toBe("fail");
    expect(result.log[0].detail).toContain("sourcePath is required");
  });

  it("returns fail for unknown sourceType", async () => {
    const result = await runScript("addSource", { sourceType: "unknown" }, mockCtx);
    expect(result.status).toBe("fail");
    expect(result.log[0].detail).toContain("Unknown sourceType");
  });
});

describe("chunked addSource", () => {
  it("single chunk: content under 100K passes through directly", async () => {
    const smallContent = "a".repeat(100);
    await runScript("addSource", { content: smallContent }, mockCtx);
    expect(scriptedAddSource).toHaveBeenCalledTimes(1);
    expect(scriptedAddSource).toHaveBeenCalledWith(mockCtx, smallContent);
  });

  it("multi chunk: content over 100K calls scriptedAddSource multiple times", async () => {
    vi.useFakeTimers();

    // Mock repoToText to return a large file (300K → 3 chunks at 100K each)
    vi.mocked(repoToText).mockResolvedValue({ filePath: "/tmp/big.txt", charCount: 300_000, wordCount: 50_000 });
    vi.mocked(readFileSync).mockReturnValue("x".repeat(300_000));

    const promise = runScript("addSource", { sourceType: "repo", sourcePath: "/abs/big-repo" }, mockCtx);

    // Advance past the 3s pauses between chunks (3 chunks × 3s = 9s)
    await vi.advanceTimersByTimeAsync(15_000);

    await promise;

    // Should call scriptedAddSource 3 times (300K / 100K = 3 chunks)
    expect(vi.mocked(scriptedAddSource).mock.calls.length).toBe(3);

    vi.useRealTimers();
  });
});

describe("buildScriptCatalog", () => {
  it("includes source type info in addSource description", () => {
    const catalog = buildScriptCatalog();
    expect(catalog).toContain("repo");
    expect(catalog).toContain("url");
    expect(catalog).toContain("pdf");
    expect(catalog).toContain("sourceType");
    expect(catalog).toContain("sourcePath");
    expect(catalog).toContain("sourceUrl");
  });
});

describe("getAvailableOperations", () => {
  it("returns 10 operations", () => {
    expect(getAvailableOperations()).toHaveLength(10);
    expect(getAvailableOperations()).toContain("addSource");
  });
});
