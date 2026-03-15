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

/** Map of operation name -> script function. */
const SCRIPT_REGISTRY: Record<string, (ctx: ScriptContext, params: Record<string, string>) => Promise<ScriptResult>> = {
  query: (ctx, p) => scriptedQuery(ctx, p.question ?? ""),
  addSource: async (ctx, p) => {
    try {
      const content = await preprocessAddSource(p);
      return scriptedAddSource(ctx, content);
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
    description: "Add a source to the notebook. Supports: plain text (content param), git repo (sourceType=repo + sourcePath), URL webpage (sourceType=url + sourceUrl), PDF file (sourceType=pdf + sourcePath). Content is automatically converted.",
    params: {
      content: "(for text) The text content to add",
      sourceType: "(optional) text | repo | url | pdf. Default: text",
      sourcePath: "(for repo/pdf) Absolute path to the repo or PDF file",
      sourceUrl: "(for url) The URL to fetch and convert",
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
