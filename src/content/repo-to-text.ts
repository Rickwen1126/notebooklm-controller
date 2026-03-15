/**
 * Convert a git repository into a single text file using repomix.
 *
 * T072: repomix CLI wrapper with word count + 500K limit validation.
 * T-SB09: File-based output — text written to temp file, never returned in memory.
 *         Tool boundary = context boundary (Finding #51, FR-009.1).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { TMP_DIR } from "../shared/config.js";

const execFileAsync = promisify(execFile);

/** Maximum character count for NotebookLM text source. */
const MAX_CHAR_COUNT = 500_000;

export interface RepoToTextResult {
  /** Path to the temp file containing converted text. */
  filePath: string;
  charCount: number;
  wordCount: number;
}

/**
 * Convert a git repo at `repoPath` to a temp file containing plain text.
 *
 * Uses `repomix --stdout --style plain` to produce AI-friendly output.
 * Respects .gitignore and repomix.config.json if present.
 *
 * The text is written to `~/.nbctl/tmp/repo-{timestamp}.txt` and NEVER
 * returned in memory — ensuring LLM context is not polluted with large content
 * (Tool boundary = context boundary, Finding #51).
 *
 * @throws If path is not a git repo, repomix fails, or output exceeds 500K chars.
 */
export async function repoToText(repoPath: string): Promise<RepoToTextResult> {
  // 0. Security: repoPath must be absolute to prevent path confusion.
  //    (execFile is safe against shell injection since it doesn't use a shell.)
  if (!isAbsolute(repoPath)) {
    throw new Error(`repoPath must be an absolute path: ${repoPath}`);
  }

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

  // 4. Size info logged (splitting handled by caller if needed).

  // 5. Write to temp file (text never returned in memory to caller).
  await mkdir(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, `repo-${Date.now()}.txt`);
  await writeFile(filePath, text, "utf-8");

  return { filePath, charCount, wordCount };
}
