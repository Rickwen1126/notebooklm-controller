/**
 * Script dispatcher — routes operation names to scripted functions.
 * Also provides buildScriptCatalog() for the Planner system message.
 */

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

/** Map of operation name -> script function. */
const SCRIPT_REGISTRY: Record<string, (ctx: ScriptContext, params: Record<string, string>) => Promise<ScriptResult>> = {
  query: (ctx, p) => scriptedQuery(ctx, p.question ?? ""),
  addSource: (ctx, p) => scriptedAddSource(ctx, p.content ?? ""),
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
  { operation: "addSource", description: "Add a text source to the notebook", params: { content: "The text content to add as a source" }, startPage: "notebook" },
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
