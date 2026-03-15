/**
 * T081: Unit tests for pdf-to-text (file-based output).
 *
 * Tests the PDF-to-text converter: file validation, pdf-parse extraction,
 * file-based output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock config for TMP_DIR
vi.mock("../../../src/shared/config.js", () => ({
  TMP_DIR: "/tmp/nbctl-test",
}));

// Mock pdf-parse — must use class to support `new PDFParse()`
// Control variables mutated per-test.
let mockGetTextResult: { text: string; total: number } = {
  text: "Page 1 content here.\n\nPage 2 content here.",
  total: 2,
};
let mockGetTextError: Error | null = null;
const mockDestroyFn = vi.fn();
// Track constructor args for assertion
let constructorArgs: unknown = null;

vi.mock("pdf-parse", () => {
  return {
    PDFParse: class {
      constructor(options: unknown) {
        constructorArgs = options;
      }
      async getText() {
        if (mockGetTextError) throw mockGetTextError;
        return mockGetTextResult;
      }
      async destroy() {
        mockDestroyFn();
      }
    },
  };
});

import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { pdfToText } from "../../../src/content/pdf-to-text.js";

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

describe("pdfToText", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: file exists
    mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
    // Default: readFile returns a buffer
    mockReadFile.mockResolvedValue(Buffer.from("fake-pdf-data"));
    // Default: mkdir/writeFile succeed
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    // Default: PDFParse extracts text successfully
    mockGetTextResult = {
      text: "Page 1 content here.\n\nPage 2 content here.",
      total: 2,
    };
    mockGetTextError = null;
    constructorArgs = null;
  });

  it("extracts PDF text and returns filePath + metrics (not text)", async () => {
    const result = await pdfToText("/docs/test.pdf");

    // Returns filePath, not text
    expect(result.filePath).toContain("/tmp/nbctl-test/pdf-");
    expect(result.filePath).toContain(".txt");
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.pageCount).toBe(2);

    // Text was NOT in the return value
    expect(result).not.toHaveProperty("text");

    // Temp file was written
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/nbctl-test", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("pdf-"),
      expect.any(String),
      "utf-8",
    );
  });

  it("passes file data as Uint8Array to PDFParse constructor", async () => {
    await pdfToText("/docs/test.pdf");

    const args = constructorArgs as { data: Uint8Array };
    expect(args).toBeDefined();
    expect(args.data).toBeInstanceOf(Uint8Array);
  });

  it("destroys the parser after extraction", async () => {
    await pdfToText("/docs/test.pdf");

    expect(mockDestroyFn).toHaveBeenCalled();
  });

  it("throws when file does not exist", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));

    await expect(pdfToText("/missing/file.pdf")).rejects.toThrow(
      "PDF file not found",
    );
  });

  it("throws when file cannot be read", async () => {
    mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(pdfToText("/locked/file.pdf")).rejects.toThrow(
      "Failed to read PDF file",
    );
  });

  it("throws when PDF parsing fails (corrupt PDF)", async () => {
    mockGetTextError = new Error("Invalid PDF structure");

    await expect(pdfToText("/docs/corrupt.pdf")).rejects.toThrow(
      "Failed to parse PDF: Invalid PDF structure",
    );
  });

  it("throws when PDF has no text content", async () => {
    mockGetTextResult = { text: "", total: 1 };

    await expect(pdfToText("/docs/image-only.pdf")).rejects.toThrow(
      "No text content found in PDF",
    );
  });

  it("throws when whitespace-only text content", async () => {
    mockGetTextResult = { text: "   \n\n  ", total: 1 };

    await expect(pdfToText("/docs/blank.pdf")).rejects.toThrow(
      "No text content found in PDF",
    );
  });

  it("handles content exceeding 500K without throwing (limit enforced at dispatch layer)", async () => {
    const hugeText = "x".repeat(500_001);
    mockGetTextResult = { text: hugeText, total: 1 };

    const result = await pdfToText("/docs/huge.pdf");
    expect(result.charCount).toBe(500_001);
    expect(result.filePath).toContain("/tmp/nbctl-test/pdf-");
  });

  // T105: Security — pdfPath must be absolute
  it("throws if pdfPath is relative (security: prevent path traversal)", async () => {
    await expect(pdfToText("relative/file.pdf")).rejects.toThrow(
      "pdfPath must be an absolute path",
    );
  });

  it("throws if pdfPath is dot-relative (security)", async () => {
    await expect(pdfToText("../../../etc/passwd")).rejects.toThrow(
      "pdfPath must be an absolute path",
    );
  });

  it("calculates word count correctly", async () => {
    mockGetTextResult = { text: "alpha beta gamma delta epsilon", total: 1 };

    const result = await pdfToText("/docs/test.pdf");
    expect(result.wordCount).toBe(5);
  });
});
