/**
 * Convert a PDF file into a plain text file using pdf-parse.
 *
 * T083: Read PDF, extract text from all pages.
 * T-SB09: File-based output — text written to temp file, never returned in memory.
 *         Tool boundary = context boundary (Finding #51, FR-009.1).
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { PDFParse } from "pdf-parse";
import { TMP_DIR } from "../shared/config.js";

/** Maximum character count for NotebookLM text source. */
const MAX_CHAR_COUNT = 500_000;

export interface PdfToTextResult {
  /** Path to the temp file containing extracted text. */
  filePath: string;
  charCount: number;
  wordCount: number;
  pageCount: number;
}

/**
 * Extract text from a PDF file and write it to a temp file.
 *
 * Uses pdf-parse (PDFParse v2) to extract text from all pages.
 *
 * The text is written to `~/.nbctl/tmp/pdf-{timestamp}.txt` and NEVER
 * returned in memory — ensuring LLM context is not polluted with large content
 * (Tool boundary = context boundary, Finding #51).
 *
 * @throws If file does not exist, is not readable, PDF is corrupt, or output exceeds 500K chars.
 */
export async function pdfToText(pdfPath: string): Promise<PdfToTextResult> {
  // 0. Security: pdfPath must be absolute to prevent path traversal.
  if (!isAbsolute(pdfPath)) {
    throw new Error(`pdfPath must be an absolute path: ${pdfPath}`);
  }

  // 1. Validate file exists.
  try {
    await stat(pdfPath);
  } catch {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  // 2. Read the PDF file into a buffer.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await readFile(pdfPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read PDF file: ${msg}`);
  }

  // 3. Parse PDF and extract text.
  let text: string;
  let pageCount: number;
  try {
    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
    const textResult = await parser.getText();
    text = textResult.text;
    pageCount = textResult.total;
    await parser.destroy();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse PDF: ${msg}`);
  }

  if (!text || text.trim().length === 0) {
    throw new Error(`No text content found in PDF: ${pdfPath}`);
  }

  text = text.trim();

  // 4. Calculate metrics.
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // 5. Validate size limit.
  if (charCount > MAX_CHAR_COUNT) {
    throw new Error(
      `Content exceeds ${MAX_CHAR_COUNT.toLocaleString()} character limit ` +
      `(actual: ${charCount.toLocaleString()}). The PDF is too long.`,
    );
  }

  // 6. Write to temp file (text never returned in memory to caller).
  await mkdir(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, `pdf-${Date.now()}.txt`);
  await writeFile(filePath, text, "utf-8");

  return { filePath, charCount, wordCount, pageCount };
}
