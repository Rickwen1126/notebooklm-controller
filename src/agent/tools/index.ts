/**
 * Tool registry — assembles the complete tool set for a single agent session.
 *
 * Combines browser tools (bound to a specific tab's CDP session) with
 * state tools (bound to notebook alias + shared deps like NetworkGate
 * and CacheManager).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { Tool } from "@github/copilot-sdk";
import type { TabHandle } from "../../shared/types.js";
import type { NetworkGate } from "../../network-gate/network-gate.js";
import type { CacheManager } from "../../state/cache-manager.js";
import { createBrowserTools } from "./browser-tools.js";
import { createStateTools } from "./state-tools.js";
import { buildContentTools } from "./content-tools.js";

export interface ToolRegistryDeps {
  networkGate: NetworkGate;
  cacheManager: CacheManager;
}

/**
 * Build the complete tool array for an agent session operating on a specific tab.
 *
 * @param tabHandle  - Runtime handle to the Chrome tab (provides CDP session)
 * @param notebookAlias - The notebook alias for state tool scoping
 * @param deps - Shared dependencies (NetworkGate, CacheManager)
 * @returns Combined array of browser + state tools
 */
export function buildToolsForTab(
  tabHandle: TabHandle,
  notebookAlias: string,
  deps: ToolRegistryDeps,
): Tool<any>[] {
  const browserTools = createBrowserTools(tabHandle);
  const stateTools = createStateTools({
    networkGate: deps.networkGate,
    cacheManager: deps.cacheManager,
    notebookAlias,
  });
  const contentTools = buildContentTools();
  return [...browserTools, ...stateTools, ...contentTools];
}
