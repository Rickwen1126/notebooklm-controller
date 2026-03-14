/**
 * T069 + T-SB08: Unit tests for repo-to-text (file-based output).
 *
 * Tests the repomix wrapper: git validation, word count, 500K limit,
 * file-based output (text written to temp file, filePath returned).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { repoToText } from "../../../src/content/repo-to-text.js";

// Mock fs/promises for .git directory check + temp file write
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock child_process for repomix CLI
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock config for TMP_DIR
vi.mock("../../../src/shared/config.js", () => ({
  TMP_DIR: "/tmp/nbctl-test",
}));

import { stat, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";

const mockStat = vi.mocked(stat);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockExecFile = vi.mocked(execFile);

describe("repoToText", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: .git exists
    mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
    // Default: mkdir/writeFile succeed
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("converts a git repo and returns filePath + metrics (not text)", async () => {
    const fakeOutput = "file: hello.ts\nconsole.log('hello world');\n";

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(null, { stdout: fakeOutput, stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await repoToText("/fake/repo");

    // Returns filePath, not text
    expect(result.filePath).toContain("/tmp/nbctl-test/repo-");
    expect(result.filePath).toContain(".txt");
    expect(result.charCount).toBe(fakeOutput.length);
    expect(result.wordCount).toBeGreaterThan(0);

    // Text was NOT in the return value
    expect(result).not.toHaveProperty("text");

    // Temp file was written
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/nbctl-test", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("repo-"),
      fakeOutput,
      "utf-8",
    );
  });

  it("throws if path is not a git repo", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));

    await expect(repoToText("/not/a/repo")).rejects.toThrow(
      "Path is not a valid git repository",
    );
  });

  it("throws if repomix fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(new Error("repomix crash"), { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    await expect(repoToText("/fake/repo")).rejects.toThrow("repomix failed");
  });

  it("throws if output exceeds 500K character limit", async () => {
    const hugeOutput = "x".repeat(500_001);

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(null, { stdout: hugeOutput, stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    await expect(repoToText("/fake/repo")).rejects.toThrow(
      "exceeds 500,000 character limit",
    );
  });

  it("calculates word count correctly", async () => {
    const text = "one two three\nfour five";

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(null, { stdout: text, stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await repoToText("/fake/repo");
    expect(result.wordCount).toBe(5);
    expect(result.charCount).toBe(text.length);
  });
});
