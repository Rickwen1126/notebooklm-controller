/**
 * Convert a web page URL into a plain text file using Readability.
 *
 * T082: Fetch URL, extract article content with @mozilla/readability + jsdom.
 * T-SB09: File-based output — text written to temp file, never returned in memory.
 *         Tool boundary = context boundary (Finding #51, FR-009.1).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { TMP_DIR } from "../shared/config.js";

/** Maximum character count for NotebookLM text source. */
const MAX_CHAR_COUNT = 500_000;

/** Timeout for HTTP fetch (30 seconds). */
const FETCH_TIMEOUT_MS = 30_000;

export interface UrlToTextResult {
  /** Path to the temp file containing extracted text. */
  filePath: string;
  charCount: number;
  wordCount: number;
}

/**
 * Fetch a web page and extract its article content as plain text.
 *
 * Uses built-in fetch() to download the page, JSDOM to parse the HTML,
 * and @mozilla/readability to extract the main article content.
 *
 * The text is written to `~/.nbctl/tmp/url-{timestamp}.txt` and NEVER
 * returned in memory — ensuring LLM context is not polluted with large content
 * (Tool boundary = context boundary, Finding #51).
 *
 * @throws If URL is invalid, fetch fails, no readable content, or output exceeds 500K chars.
 */
export async function urlToText(url: string): Promise<UrlToTextResult> {
  // 1. Validate URL format.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!parsedUrl.protocol.startsWith("http")) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol} (only http/https supported)`);
  }

  // 2. Fetch the page.
  let html: string;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; nbctl/0.1; +https://github.com/notebooklm-controller)",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch URL: ${msg}`);
  }

  // 3. Parse with JSDOM and extract with Readability.
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent) {
    throw new Error(`No readable content found at: ${url}`);
  }

  // 4. Build output text with title header.
  const titleLine = article.title ? `# ${article.title}\n\n` : "";
  const text = titleLine + article.textContent.trim();

  // 5. Calculate metrics.
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // 6. Validate size limit.
  if (charCount > MAX_CHAR_COUNT) {
    throw new Error(
      `Content exceeds ${MAX_CHAR_COUNT.toLocaleString()} character limit ` +
      `(actual: ${charCount.toLocaleString()}). The article is too long.`,
    );
  }

  // 7. Write to temp file (text never returned in memory to caller).
  await mkdir(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, `url-${Date.now()}.txt`);
  await writeFile(filePath, text, "utf-8");

  return { filePath, charCount, wordCount };
}
