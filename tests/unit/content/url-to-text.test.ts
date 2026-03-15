/**
 * T080: Unit tests for url-to-text (file-based output).
 *
 * Tests the URL-to-text converter: URL validation, fetch handling,
 * readability extraction, 500K limit, file-based output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs/promises for temp file write
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock config for TMP_DIR
vi.mock("../../../src/shared/config.js", () => ({
  TMP_DIR: "/tmp/nbctl-test",
}));

// Mock jsdom — must use class to support `new JSDOM()`
const mockDoc = { title: "Test Page" };
vi.mock("jsdom", () => {
  return {
    JSDOM: class {
      window = { document: mockDoc };
      constructor() {}
    },
  };
});

// Mock @mozilla/readability — must use class to support `new Readability()`
let mockParseResult: unknown = {
  title: "Test Page",
  textContent: "Hello world article content here",
  content: "<p>Hello world article content here</p>",
  length: 31,
  excerpt: "Hello world",
  byline: null,
  dir: null,
  siteName: null,
  lang: null,
  publishedTime: null,
};
vi.mock("@mozilla/readability", () => {
  return {
    Readability: class {
      parse() { return mockParseResult; }
    },
  };
});

import { writeFile, mkdir } from "node:fs/promises";
import { urlToText } from "../../../src/content/url-to-text.js";

const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

describe("urlToText", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: mkdir/writeFile succeed
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    // Default: fetch returns valid HTML
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("<html><body><p>Hello world</p></body></html>"),
    }));

    // Default: Readability returns content
    mockParseResult = {
      title: "Test Page",
      textContent: "Hello world article content here",
      content: "<p>Hello world article content here</p>",
      length: 31,
      excerpt: "Hello world",
      byline: null,
      dir: null,
      siteName: null,
      lang: null,
      publishedTime: null,
    };
  });

  it("fetches URL and returns filePath + metrics (not text)", async () => {
    const result = await urlToText("https://example.com/article");

    // Returns filePath, not text
    expect(result.filePath).toContain("/tmp/nbctl-test/url-");
    expect(result.filePath).toContain(".txt");
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);

    // Text was NOT in the return value
    expect(result).not.toHaveProperty("text");

    // Temp file was written
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/nbctl-test", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("url-"),
      expect.any(String),
      "utf-8",
    );
  });

  it("includes title in extracted text", async () => {
    await urlToText("https://example.com/article");

    const writtenText = mockWriteFile.mock.calls[0][1] as string;
    expect(writtenText).toContain("# Test Page");
    expect(writtenText).toContain("Hello world article content here");
  });

  it("throws for invalid URL", async () => {
    await expect(urlToText("not-a-url")).rejects.toThrow("Invalid URL");
  });

  it("throws for non-http protocol (ftp)", async () => {
    await expect(urlToText("ftp://example.com")).rejects.toThrow(
      "Unsupported protocol",
    );
  });

  // T105: Security — only http: and https: allowed (SSRF prevention)
  it("throws for file:// protocol (security: SSRF prevention)", async () => {
    await expect(urlToText("file:///etc/passwd")).rejects.toThrow(
      "Unsupported protocol",
    );
  });

  it("throws for javascript: protocol (security)", async () => {
    await expect(urlToText("javascript:alert(1)")).rejects.toThrow(
      "Unsupported protocol",
    );
  });

  it("throws when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(urlToText("https://example.com")).rejects.toThrow(
      "Failed to fetch URL: ECONNREFUSED",
    );
  });

  it("throws on non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    await expect(urlToText("https://example.com/missing")).rejects.toThrow(
      "HTTP 404 Not Found",
    );
  });

  it("throws when no readable content is found", async () => {
    mockParseResult = null;

    await expect(urlToText("https://example.com/blank")).rejects.toThrow(
      "No readable content found",
    );
  });

  it("throws when textContent is empty", async () => {
    mockParseResult = { title: "Empty", textContent: "", content: "", length: 0, excerpt: null, byline: null, dir: null, siteName: null, lang: null, publishedTime: null };

    await expect(urlToText("https://example.com/empty")).rejects.toThrow(
      "No readable content found",
    );
  });

  it("throws if content exceeds 5M character limit", async () => {
    const hugeContent = "x".repeat(5_000_001);
    mockParseResult = { title: null, textContent: hugeContent, content: hugeContent, length: hugeContent.length, excerpt: null, byline: null, dir: null, siteName: null, lang: null, publishedTime: null };

    await expect(urlToText("https://example.com/huge")).rejects.toThrow(
      "exceeds 5,000,000 character limit",
    );
  });

  it("calculates word count correctly", async () => {
    mockParseResult = { title: null, textContent: "one two three four five", content: "<p>one two three four five</p>", length: 23, excerpt: null, byline: null, dir: null, siteName: null, lang: null, publishedTime: null };

    const result = await urlToText("https://example.com/words");
    expect(result.wordCount).toBe(5);
  });
});
