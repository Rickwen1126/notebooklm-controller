/**
 * T070 + T-SB10 + T084/T085: Unit tests for content-tools (defineTool wrappers, file-based).
 *
 * Tests repoToText, urlToText, pdfToText tools return filePath + metrics (NOT text content).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @github/copilot-sdk before importing anything that uses it.
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: Record<string, unknown>) => ({
    name,
    ...config,
  }),
}));

// Mock the underlying content modules
vi.mock("../../../../src/content/repo-to-text.js", () => ({
  repoToText: vi.fn(),
}));

vi.mock("../../../../src/content/url-to-text.js", () => ({
  urlToText: vi.fn(),
}));

vi.mock("../../../../src/content/pdf-to-text.js", () => ({
  pdfToText: vi.fn(),
}));

import {
  buildRepoToTextTool,
  buildUrlToTextTool,
  buildPdfToTextTool,
  buildContentTools,
} from "../../../../src/agent/tools/content-tools.js";

import { repoToText } from "../../../../src/content/repo-to-text.js";
import { urlToText } from "../../../../src/content/url-to-text.js";
import { pdfToText } from "../../../../src/content/pdf-to-text.js";

const mockRepoToText = vi.mocked(repoToText);
const mockUrlToText = vi.mocked(urlToText);
const mockPdfToText = vi.mocked(pdfToText);

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

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("not a git repo");
    });
  });

  describe("urlToText tool (file-based)", () => {
    it("returns filePath + metrics on success, NOT text content", async () => {
      mockUrlToText.mockResolvedValue({
        filePath: "/home/user/.nbctl/tmp/url-456.txt",
        charCount: 5000,
        wordCount: 800,
      });

      const tool = buildUrlToTextTool();
      const result = await callToolHandler(tool, { url: "https://example.com/article" }) as { textResultForLlm: string; resultType: string };

      expect(mockUrlToText).toHaveBeenCalledWith("https://example.com/article");
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("File: /home/user/.nbctl/tmp/url-456.txt");
      expect(result.textResultForLlm).toContain("Characters: 5,000");
      expect(result.textResultForLlm).toContain("Words: 800");
      expect(result.textResultForLlm).toContain('paste(filePath=');

      // CRITICAL: text content must NOT be in the result
      expect(result.textResultForLlm).not.toContain("CONTENT START");
      expect(result.textResultForLlm).not.toContain("CONTENT END");
    });

    it("returns error result when URL conversion fails", async () => {
      mockUrlToText.mockRejectedValue(new Error("Failed to fetch URL: ECONNREFUSED"));

      const tool = buildUrlToTextTool();
      const result = await callToolHandler(tool, { url: "https://down.example.com" }) as { textResultForLlm: string; resultType: string };

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("Failed to convert web page");
      expect(result.textResultForLlm).toContain("ECONNREFUSED");
    });
  });

  describe("pdfToText tool (file-based)", () => {
    it("returns filePath + metrics + pageCount on success, NOT text content", async () => {
      mockPdfToText.mockResolvedValue({
        filePath: "/home/user/.nbctl/tmp/pdf-789.txt",
        charCount: 25000,
        wordCount: 4000,
        pageCount: 12,
      });

      const tool = buildPdfToTextTool();
      const result = await callToolHandler(tool, { path: "/docs/report.pdf" }) as { textResultForLlm: string; resultType: string };

      expect(mockPdfToText).toHaveBeenCalledWith("/docs/report.pdf");
      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("File: /home/user/.nbctl/tmp/pdf-789.txt");
      expect(result.textResultForLlm).toContain("Characters: 25,000");
      expect(result.textResultForLlm).toContain("Words: 4,000");
      expect(result.textResultForLlm).toContain("Pages: 12");
      expect(result.textResultForLlm).toContain('paste(filePath=');

      // CRITICAL: text content must NOT be in the result
      expect(result.textResultForLlm).not.toContain("CONTENT START");
      expect(result.textResultForLlm).not.toContain("CONTENT END");
    });

    it("returns error result when PDF conversion fails", async () => {
      mockPdfToText.mockRejectedValue(new Error("PDF file not found: /missing.pdf"));

      const tool = buildPdfToTextTool();
      const result = await callToolHandler(tool, { path: "/missing.pdf" }) as { textResultForLlm: string; resultType: string };

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("Failed to convert PDF");
      expect(result.textResultForLlm).toContain("PDF file not found");
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
