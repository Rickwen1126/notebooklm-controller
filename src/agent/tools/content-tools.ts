/**
 * Content tools for the Copilot SDK agent.
 *
 * Provides tools for converting external content (repo, URL, PDF) into
 * text that can be pasted into NotebookLM as a source.
 *
 * T073: repoToText defineTool wrapper.
 * T084/T085: urlToText/pdfToText (Phase 8, stubs for now).
 */

import { z } from "zod";
import { defineTool } from "@github/copilot-sdk";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { repoToText } from "../../content/repo-to-text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "success" };
}

function errorResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "error" };
}

// ---------------------------------------------------------------------------
// repoToText tool
// ---------------------------------------------------------------------------

export function buildRepoToTextTool(): Tool {
  return defineTool("repoToText", {
    description:
      "Convert a local git repository into a text file for pasting into NotebookLM. " +
      "Uses repomix to produce AI-friendly output respecting .gitignore. " +
      "Returns a filePath (text saved to temp file) + character/word count. " +
      "Use paste(filePath=...) to paste the content — text is NOT returned here.",
    parameters: z.object({
      path: z
        .string()
        .describe("Absolute path to the git repository root directory"),
    }),
    handler: async (args: { path: string }): Promise<ToolResultObject> => {
      try {
        const result = await repoToText(args.path);
        return textResult(
          `Repository converted successfully.\n` +
          `File: ${result.filePath}\n` +
          `Characters: ${result.charCount.toLocaleString()}\n` +
          `Words: ${result.wordCount.toLocaleString()}\n\n` +
          `Use paste(filePath="${result.filePath}") to paste this content into NotebookLM.`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to convert repository: ${msg}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// urlToText tool (Phase 8 stub)
// ---------------------------------------------------------------------------

export function buildUrlToTextTool(): Tool {
  return defineTool("urlToText", {
    description:
      "Fetch a web page and convert its content to clean text/Markdown " +
      "using readability extraction. For pasting into NotebookLM as a source.",
    parameters: z.object({
      url: z.string().url().describe("URL of the web page to convert"),
    }),
    handler: async (_args: { url: string }): Promise<ToolResultObject> => {
      return errorResult(
        "urlToText is not yet implemented. This feature is planned for Phase 8.",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// pdfToText tool (Phase 8 stub)
// ---------------------------------------------------------------------------

export function buildPdfToTextTool(): Tool {
  return defineTool("pdfToText", {
    description:
      "Convert a local PDF file to plain text for pasting into NotebookLM " +
      "as a source. Extracts text content from all pages.",
    parameters: z.object({
      path: z
        .string()
        .describe("Absolute path to the PDF file"),
    }),
    handler: async (_args: { path: string }): Promise<ToolResultObject> => {
      return errorResult(
        "pdfToText is not yet implemented. This feature is planned for Phase 8.",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Export all content tools
// ---------------------------------------------------------------------------

export function buildContentTools(): Tool[] {
  return [
    buildRepoToTextTool(),
    buildUrlToTextTool(),
    buildPdfToTextTool(),
  ];
}
