/**
 * T069: Unit tests for repo-to-text.
 *
 * Tests the repomix wrapper: git validation, word count, 500K limit.
 * Uses vi.mock to mock child_process.execFile so we don't need a real repo.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { repoToText } from "../../../src/content/repo-to-text.js";

// Mock fs/promises for .git directory check
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
}));

// Mock child_process for repomix CLI
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const mockStat = vi.mocked(stat);
const mockExecFile = vi.mocked(execFile);

describe("repoToText", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: .git exists
    mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
  });

  it("converts a git repo to text with metrics", async () => {
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

    expect(result.text).toBe(fakeOutput);
    expect(result.charCount).toBe(fakeOutput.length);
    expect(result.wordCount).toBeGreaterThan(0);
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
  });
});
