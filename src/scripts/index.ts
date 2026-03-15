/**
 * Script dispatcher — routes operation names to scripted functions.
 * Also provides buildScriptCatalog() for the Planner system message.
 */

import { readFileSync } from "node:fs";
import type { ScriptContext, ScriptResult } from "./types.js";
import {
  scriptedQuery,
  scriptedAddSource,
  scriptedListSources,
  scriptedRemoveSource,
  scriptedRenameSource,
  scriptedClearChat,
  scriptedListNotebooks,
  scriptedCreateNotebook,
  scriptedRenameNotebook,
  scriptedDeleteNotebook,
} from "./operations.js";
import { repoToText } from "../content/repo-to-text.js";
import { urlToText } from "../content/url-to-text.js";
import { pdfToText } from "../content/pdf-to-text.js";
import { logger } from "../shared/logger.js";

const contentLog = logger.child({ module: "content-pipeline" });

/**
 * Preprocess addSource params: if sourceType is specified,
 * run the appropriate converter and return text content.
 */
async function preprocessAddSource(params: Record<string, string>): Promise<string> {
  const sourceType = params.sourceType ?? "text";

  if (sourceType === "text") {
    return params.content ?? "";
  }

  if (sourceType === "repo") {
    const path = params.sourcePath;
    if (!path) throw new Error("sourcePath is required for sourceType=repo");
    contentLog.info("Converting repo to text", { path });
    const result = await repoToText(path);
    contentLog.info("Repo converted", { charCount: result.charCount, wordCount: result.wordCount });
    return readFileSync(result.filePath, "utf-8");
  }

  if (sourceType === "url") {
    const url = params.sourceUrl;
    if (!url) throw new Error("sourceUrl is required for sourceType=url");
    contentLog.info("Converting URL to text", { url });
    const result = await urlToText(url);
    contentLog.info("URL converted", { charCount: result.charCount, wordCount: result.wordCount });
    return readFileSync(result.filePath, "utf-8");
  }

  if (sourceType === "pdf") {
    const path = params.sourcePath;
    if (!path) throw new Error("sourcePath is required for sourceType=pdf");
    contentLog.info("Converting PDF to text", { path });
    const result = await pdfToText(path);
    contentLog.info("PDF converted", { charCount: result.charCount, wordCount: result.wordCount, pageCount: result.pageCount });
    return readFileSync(result.filePath, "utf-8");
  }

  throw new Error(`Unknown sourceType: ${sourceType}`);
}

/** Max chars per source paste. 100K keeps paste fast (~20s) and avoids textarea hang. */
const CHUNK_SIZE = 100_000;

/**
 * Split text into chunks of at most CHUNK_SIZE chars.
 * Tries to break at newline boundaries for cleaner splits.
 */
function splitIntoChunks(text: string, maxSize: number = CHUNK_SIZE): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    // Try to break at a newline within the last 10% of the chunk
    const searchStart = end - Math.floor(maxSize * 0.1);
    const lastNewline = text.lastIndexOf("\n", end);
    if (lastNewline > searchStart) {
      end = lastNewline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Map of operation name -> script function. */
const SCRIPT_REGISTRY: Record<string, (ctx: ScriptContext, params: Record<string, string>) => Promise<ScriptResult>> = {
  query: (ctx, p) => scriptedQuery(ctx, p.question ?? ""),
  addSource: async (ctx, p) => {
    try {
      const content = await preprocessAddSource(p);
      const chunks = splitIntoChunks(content);
      const sourceName = p.sourceName;
      let renamed = false;
      const allLogs: ScriptResult["log"] = [];
      const t0 = Date.now();

      for (let i = 0; i < chunks.length; i++) {
        if (chunks.length > 1) {
          contentLog.info(`Pasting chunk ${i + 1}/${chunks.length}`, { charCount: chunks[i].length });
        }

        const result = await scriptedAddSource(ctx, chunks[i]);
        allLogs.push(...result.log);

        if (result.status !== "success") {
          return {
            operation: "addSource",
            status: "fail" as const,
            result: `Failed at chunk ${i + 1}/${chunks.length}`,
            log: allLogs,
            totalMs: Date.now() - t0,
            failedAtStep: result.failedAtStep,
            failedSelector: result.failedSelector,
          };
        }

        // Auto-rename: only if sourceName provided AND exactly 1 "貼上的文字" exists.
        // If multiple unnamed sources exist, skip rename (can't identify which is new).
        if (sourceName) {
          const pastedTextLabel = ctx.uiMap.elements.paste_source_type?.text ?? "Copied text";
          const defaultSourceName = "貼上的文字"; // NotebookLM's default name for pasted sources
          const unnamedCount = await ctx.page.evaluate(`(() => {
            const panel = document.querySelector('.source-panel');
            if (!panel) return 0;
            const titles = panel.querySelectorAll('[class*=title]');
            let count = 0;
            for (const t of titles) {
              if (t.textContent.trim() === '${defaultSourceName}') count++;
            }
            return count;
          })()`) as number;

          if (unnamedCount === 1) {
            const renameTo = chunks.length > 1
              ? `${sourceName} (part ${i + 1}/${chunks.length})`
              : sourceName;
            contentLog.info("Renaming source", { name: renameTo, unnamedCount });
            const renameResult = await scriptedRenameSource(ctx, renameTo);
            allLogs.push(...renameResult.log);
            if (renameResult.status === "success") {
              renamed = true;
            } else {
              contentLog.warn("Source rename failed (non-critical)", { name: renameTo });
            }
          } else if (unnamedCount > 1) {
            contentLog.warn("Multiple unnamed sources found, skipping auto-rename", { unnamedCount });
            allLogs.push({
              step: 99, action: "auto_rename_skipped", status: "warn",
              detail: `Found ${unnamedCount} sources named "${defaultSourceName}" — cannot identify which is new. Use rename source tool to rename manually.`,
              durationMs: 0,
            });
          }
        }

        // Brief pause between chunks to let NotebookLM process
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      const renameNote = renamed ? `, named "${sourceName}"` : (sourceName ? ` (rename skipped — multiple unnamed sources)` : "");
      const summary = chunks.length > 1
        ? `Added ${chunks.length} source parts (${content.length} chars total)${renameNote}`
        : `Source added${renameNote}`;

      return {
        operation: "addSource",
        status: "success",
        result: summary,
        log: allLogs,
        totalMs: Date.now() - t0,
        failedAtStep: null,
        failedSelector: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        operation: "addSource",
        status: "fail" as const,
        result: null,
        log: [{ step: 0, action: "content_preprocessing", status: "fail" as const, detail: msg, durationMs: 0 }],
        totalMs: 0,
        failedAtStep: 0,
        failedSelector: null,
      };
    }
  },
  listSources: (ctx) => scriptedListSources(ctx),
  removeSource: (ctx) => scriptedRemoveSource(ctx),
  renameSource: (ctx, p) => scriptedRenameSource(ctx, p.newName ?? ""),
  clearChat: (ctx) => scriptedClearChat(ctx),
  listNotebooks: (ctx) => scriptedListNotebooks(ctx),
  createNotebook: (ctx) => scriptedCreateNotebook(ctx),
  renameNotebook: (ctx, p) => scriptedRenameNotebook(ctx, p.newName ?? ""),
  deleteNotebook: (ctx) => scriptedDeleteNotebook(ctx),
};

/**
 * Run a scripted operation by name.
 *
 * @returns ScriptResult with success/fail status and structured log.
 * @throws Error if operation name is not found in registry.
 */
export async function runScript(
  operation: string,
  params: Record<string, string>,
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const scriptFn = SCRIPT_REGISTRY[operation];
  if (!scriptFn) {
    return {
      operation,
      status: "fail",
      result: null,
      log: [{ step: 0, action: "dispatch", status: "fail", detail: `Unknown operation: ${operation}`, durationMs: 0 }],
      totalMs: 0,
      failedAtStep: 0,
      failedSelector: null,
    };
  }
  return scriptFn(ctx, params);
}

/** Catalog entry for the Planner to understand available operations. */
interface ScriptCatalogEntry {
  operation: string;
  description: string;
  params: Record<string, string>;
  startPage: "notebook" | "homepage";
}

const SCRIPT_CATALOG: ScriptCatalogEntry[] = [
  { operation: "query", description: "Ask NotebookLM a question and get the answer", params: { question: "The question to ask" }, startPage: "notebook" },
  {
    operation: "addSource",
    description: "Add a source to the notebook. Supports: plain text (content param), git repo (sourceType=repo + sourcePath), URL webpage (sourceType=url + sourceUrl), PDF file (sourceType=pdf + sourcePath). Content is automatically converted. Auto-renamed after paste using sourceName.",
    params: {
      content: "(for text) The text content to add",
      sourceType: "(optional) text | repo | url | pdf. Default: text",
      sourcePath: "(for repo/pdf) Absolute path to the repo or PDF file",
      sourceUrl: "(for url) The URL to fetch and convert",
      sourceName: "(recommended) Human-readable name for the source, e.g. 'my-project (repo)'",
    },
    startPage: "notebook",
  },
  { operation: "listSources", description: "List all sources in the notebook", params: {}, startPage: "notebook" },
  { operation: "removeSource", description: "Remove the first source from the notebook", params: {}, startPage: "notebook" },
  { operation: "renameSource", description: "Rename the first source in the notebook", params: { newName: "New name for the source" }, startPage: "notebook" },
  { operation: "clearChat", description: "Clear the chat history", params: {}, startPage: "notebook" },
  { operation: "listNotebooks", description: "List all notebooks on the homepage", params: {}, startPage: "homepage" },
  { operation: "createNotebook", description: "Create a new notebook", params: {}, startPage: "homepage" },
  { operation: "renameNotebook", description: "Rename the first notebook on the homepage", params: { newName: "New name for the notebook" }, startPage: "homepage" },
  { operation: "deleteNotebook", description: "Delete the first notebook on the homepage", params: {}, startPage: "homepage" },
];

/**
 * Build a catalog string for the Planner system message.
 * Replaces the old agent-config-based buildPlannerCatalog.
 */
export function buildScriptCatalog(): string {
  return SCRIPT_CATALOG.map((entry) => {
    const paramStr = Object.keys(entry.params).length > 0
      ? `\n    params: ${JSON.stringify(entry.params)}`
      : "";
    return `  - operation: ${entry.operation}\n    description: ${entry.description}\n    startPage: ${entry.startPage}${paramStr}`;
  }).join("\n");
}

/** Get all available operation names. */
export function getAvailableOperations(): string[] {
  return Object.keys(SCRIPT_REGISTRY);
}
