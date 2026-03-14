/**
 * Convert a git repository into a single text representation using repomix.
 *
 * T072: repomix CLI wrapper with word count + 500K limit validation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/** Maximum character count for NotebookLM text source. */
const MAX_CHAR_COUNT = 500_000;

export interface RepoToTextResult {
  text: string;
  charCount: number;
  wordCount: number;
}

/**
 * Convert a git repo at `repoPath` to a single plain-text string.
 *
 * Uses `repomix --stdout --style plain` to produce AI-friendly output.
 * Respects .gitignore and repomix.config.json if present.
 *
 * @throws If path is not a git repo, repomix fails, or output exceeds 500K chars.
 */
export async function repoToText(repoPath: string): Promise<RepoToTextResult> {
  // 1. Validate path is a git repo.
  try {
    await stat(join(repoPath, ".git"));
  } catch {
    throw new Error(`Path is not a valid git repository: ${repoPath}`);
  }

  // 2. Run repomix with stdout output.
  let text: string;
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["repomix", ".", "--stdout", "--style", "plain"],
      {
        cwd: repoPath,
        maxBuffer: 100 * 1024 * 1024, // 100MB buffer
        timeout: 120_000, // 2 min timeout
      },
    );
    text = stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`repomix failed: ${msg}`);
  }

  // 3. Calculate metrics.
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // 4. Validate size limit.
  if (charCount > MAX_CHAR_COUNT) {
    throw new Error(
      `Content exceeds ${MAX_CHAR_COUNT.toLocaleString()} character limit ` +
      `(actual: ${charCount.toLocaleString()}). Please split manually.`,
    );
  }

  return { text, charCount, wordCount };
}
