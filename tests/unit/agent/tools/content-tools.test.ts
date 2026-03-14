/**
 * T070 + T-SB10: Unit tests for content-tools (defineTool wrappers, file-based).
 *
 * Tests repoToText tool returns filePath + metrics (NOT text content).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @github/copilot-sdk before importing anything that uses it.
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({
    name,
    ...config,
  }),
}));

// Mock the underlying content module
vi.mock("../../../../src/content/repo-to-text.js", () => ({
  repoToText: vi.fn(),
}));

import {
  buildRepoToTextTool,
  buildUrlToTextTool,
  buildPdfToTextTool,
  buildContentTools,
} from "../../../../src/agent/tools/content-tools.js";

import { repoToText } from "../../../../src/content/repo-to-text.js";
const mockRepoToText = vi.mocked(repoToText);

// Helper to call a tool's handler
async function callToolHandler(tool: { handler?: unknown }, args: unknown) {
  const handler = (tool as { handler: (args: unknown) => Promise<unknown> }).handler;
  return handler(args);
}

describe("content-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("repoToText tool (file-based)", () => {
    it("returns filePath + metrics on success, NOT text content", async () => {
      mockRepoToText.mockResolvedValue({
        filePath: "/home/user/.nbctl/tmp/repo-123.txt",
        charCount: 11000,
        wordCount: 2000,
      });

      const tool = buildRepoToTextTool();
      const result = await callToolHandler(tool, { path: "/my/repo" }) as { textResultForLlm: string; resultType: string };

      expect(mockRepoToText).toHaveBeenCalledWith("/my/repo");
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("File: /home/user/.nbctl/tmp/repo-123.txt");
      expect(result.textResultForLlm).toContain("Characters: 11,000");
      expect(result.textResultForLlm).toContain("Words: 2,000");
      expect(result.textResultForLlm).toContain('paste(filePath=');

      // CRITICAL: text content must NOT be in the result
      expect(result.textResultForLlm).not.toContain("CONTENT START");
      expect(result.textResultForLlm).not.toContain("CONTENT END");
    });

    it("returns error result when repo conversion fails", async () => {
      mockRepoToText.mockRejectedValue(new Error("not a git repo"));

      const tool = buildRepoToTextTool();
      const result = await callToolHandler(tool, { path: "/bad/path" }) as { textResultForLlm: string; resultType: string };

      expect(result.resultType).toBe("error");
      expect(result.textResultForLlm).toContain("not a git repo");
    });
  });

  describe("urlToText tool (Phase 8 stub)", () => {
    it("returns not-yet-implemented error", async () => {
      const tool = buildUrlToTextTool();
      const result = await callToolHandler(tool, { url: "https://example.com" }) as { textResultForLlm: string; resultType: string };

      expect(result.resultType).toBe("error");
      expect(result.textResultForLlm).toContain("not yet implemented");
    });
  });

  describe("pdfToText tool (Phase 8 stub)", () => {
    it("returns not-yet-implemented error", async () => {
      const tool = buildPdfToTextTool();
      const result = await callToolHandler(tool, { path: "/doc.pdf" }) as { textResultForLlm: string; resultType: string };

      expect(result.resultType).toBe("error");
      expect(result.textResultForLlm).toContain("not yet implemented");
    });
  });

  describe("buildContentTools", () => {
    it("returns array of 3 content tools", () => {
      const tools = buildContentTools();
      expect(tools).toHaveLength(3);

      const names = tools.map((t) => (t as { name?: string }).name);
      expect(names).toContain("repoToText");
      expect(names).toContain("urlToText");
      expect(names).toContain("pdfToText");
    });
  });
});
