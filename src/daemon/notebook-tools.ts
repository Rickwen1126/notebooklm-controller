/**
 * MCP tool registration for notebook management.
 *
 * Exports `registerNotebookTools()` which registers all notebook-level MCP tools
 * on the given NbctlMcpServer.
 *
 * T049: add_notebook      — register a new NotebookLM notebook
 * T050: list_notebooks    — list all registered notebooks
 * T051: open_notebook     — mark a notebook as active
 * T052: close_notebook    — close a notebook's tab and mark it inactive
 * T053: set_default       — set the default notebook alias
 * T054: rename_notebook   — rename a notebook's alias
 * T055: remove_notebook   — remove a notebook from state and close its tab
 */

import { z } from "zod";
import type { NbctlMcpServer } from "./mcp-server.js";
import type { TabManager } from "../tab-manager/tab-manager.js";
import type { StateManager } from "../state/state-manager.js";
import type { CacheManager } from "../state/cache-manager.js";
import type { NotebookEntry } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTEBOOK_URL_PREFIX = "https://notebooklm.google.com/notebook/";

/**
 * Alias validation regex:
 * - 2-50 chars: starts and ends with [a-z0-9], middle allows hyphens
 * - 1 char: single [a-z0-9]
 */
const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotebookToolDeps {
  stateManager: StateManager;
  tabManager: TabManager;
  cacheManager: CacheManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(message: string) {
  return jsonResult({ success: false, error: message });
}

function validateAlias(alias: string): string | null {
  if (!alias || alias.length === 0) {
    return "Alias must be non-empty";
  }
  if (alias.length > 50) {
    return "Alias must be at most 50 characters";
  }
  if (!ALIAS_PATTERN.test(alias)) {
    return (
      "Invalid alias format: must be 1-50 lowercase alphanumeric characters and hyphens, " +
      "cannot start or end with a hyphen"
    );
  }
  return null;
}

function validateUrl(url: string): string | null {
  if (!url.startsWith(NOTEBOOK_URL_PREFIX)) {
    return `Invalid NotebookLM URL: must start with "${NOTEBOOK_URL_PREFIX}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// registerNotebookTools
// ---------------------------------------------------------------------------

export function registerNotebookTools(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  registerAddNotebook(server, deps);
  registerListNotebooks(server, deps);
  registerOpenNotebook(server, deps);
  registerCloseNotebook(server, deps);
  registerSetDefault(server, deps);
  registerRenameNotebook(server, deps);
  registerRemoveNotebook(server, deps);
}

// ---------------------------------------------------------------------------
// T049: add_notebook
// ---------------------------------------------------------------------------

function registerAddNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "add_notebook",
    {
      description:
        "Register a new NotebookLM notebook. " +
        "Provide the notebook URL and a short alias for future reference.",
      inputSchema: {
        url: z
          .string()
          .describe("The full NotebookLM notebook URL"),
        alias: z
          .string()
          .describe(
            "Short alias for the notebook (1-50 chars, lowercase alphanumeric + hyphens, " +
            "no leading/trailing hyphen)",
          ),
      },
    },
    async (args: { url?: string; alias?: string }) => {
      try {
        const url = args.url ?? "";
        const alias = args.alias ?? "";

        // Validate URL
        const urlError = validateUrl(url);
        if (urlError) {
          return errorResult(urlError);
        }

        // Validate alias
        const aliasError = validateAlias(alias);
        if (aliasError) {
          return errorResult(aliasError);
        }

        // Check for duplicate alias
        const state = await deps.stateManager.load();
        if (state.notebooks[alias]) {
          return errorResult(`Alias already exists: "${alias}"`);
        }

        // Check for duplicate URL
        const existingByUrl = Object.values(state.notebooks).find(
          (nb) => nb.url === url,
        );
        if (existingByUrl) {
          return errorResult(
            `URL already registered under alias "${existingByUrl.alias}"`,
          );
        }

        // Create entry
        const now = new Date().toISOString();
        const entry: NotebookEntry = {
          alias,
          url,
          title: "",
          description: "",
          active: true,
          status: "ready",
          registeredAt: now,
          lastAccessedAt: now,
          sourceCount: 0,
        };

        await deps.stateManager.addNotebook(entry);

        return jsonResult({
          success: true,
          alias,
          url,
          title: "",
          description: "",
          sourceCount: 0,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T050: list_notebooks
// ---------------------------------------------------------------------------

function registerListNotebooks(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "list_notebooks",
    {
      description:
        "List all registered notebooks with their alias, URL, title, status, and source count.",
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const state = await deps.stateManager.load();
        const notebooks = Object.values(state.notebooks).map((nb) => ({
          alias: nb.alias,
          url: nb.url,
          title: nb.title,
          description: nb.description,
          status: nb.status,
          active: nb.active,
          sourceCount: nb.sourceCount,
        }));

        return jsonResult(notebooks);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T051: open_notebook
// ---------------------------------------------------------------------------

function registerOpenNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "open_notebook",
    {
      description:
        "Mark a notebook as active and ready for operations. " +
        "Does not open a browser tab — that happens on demand during exec.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to open"),
      },
    },
    async (args: { alias?: string }) => {
      try {
        const alias = args.alias ?? "";

        const state = await deps.stateManager.load();
        const notebook = state.notebooks[alias];
        if (!notebook) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        const now = new Date().toISOString();
        await deps.stateManager.updateNotebook(alias, {
          active: true,
          status: "ready",
          lastAccessedAt: now,
        });

        return jsonResult({
          success: true,
          alias,
          url: notebook.url,
          status: "ready",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T052: close_notebook
// ---------------------------------------------------------------------------

function registerCloseNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "close_notebook",
    {
      description:
        "Close a notebook: close its browser tab (if open) and mark it inactive.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to close"),
      },
    },
    async (args: { alias?: string }) => {
      try {
        const alias = args.alias ?? "";

        const state = await deps.stateManager.load();
        if (!state.notebooks[alias]) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        // Close any open tab for this alias
        const tabs = deps.tabManager.listTabs();
        for (const tab of tabs) {
          if (tab.notebookAlias === alias) {
            await deps.tabManager.closeTab(tab.tabId);
          }
        }

        await deps.stateManager.updateNotebook(alias, {
          active: false,
          status: "closed",
        });

        return jsonResult({ success: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T053: set_default
// ---------------------------------------------------------------------------

function registerSetDefault(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "set_default",
    {
      description:
        "Set the default notebook alias. " +
        "The default notebook is used when no alias is specified in other commands.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to set as default"),
      },
    },
    async (args: { alias?: string }) => {
      try {
        const alias = args.alias ?? "";

        const state = await deps.stateManager.load();
        if (!state.notebooks[alias]) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        await deps.stateManager.setDefault(alias);

        return jsonResult({ success: true, default: alias });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T054: rename_notebook
// ---------------------------------------------------------------------------

function registerRenameNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "rename_notebook",
    {
      description:
        "Rename a notebook's alias. Updates state atomically, including the default notebook reference if applicable.",
      inputSchema: {
        oldAlias: z.string().describe("Current alias of the notebook"),
        newAlias: z.string().describe("New alias for the notebook"),
      },
    },
    async (args: { oldAlias?: string; newAlias?: string }) => {
      try {
        const oldAlias = args.oldAlias ?? "";
        const newAlias = args.newAlias ?? "";

        // Validate new alias format
        const aliasError = validateAlias(newAlias);
        if (aliasError) {
          return errorResult(aliasError);
        }

        const state = await deps.stateManager.load();

        // Check old alias exists
        if (!state.notebooks[oldAlias]) {
          return errorResult(`Notebook not found: "${oldAlias}"`);
        }

        // Check new alias doesn't exist
        if (state.notebooks[newAlias]) {
          return errorResult(`Alias already exists: "${newAlias}"`);
        }

        // Perform rename:
        // 1. addNotebook with new alias (creates the entry)
        // 2. removeNotebook old alias (deletes old entry, clears default if it matched)
        // 3. setDefault to newAlias if default was oldAlias

        const entry = state.notebooks[oldAlias];
        const renamedEntry: NotebookEntry = {
          ...entry,
          alias: newAlias,
        };

        // Add under new alias first
        await deps.stateManager.addNotebook(renamedEntry);

        // Remove old alias (this also clears default if it matched)
        await deps.stateManager.removeNotebook(oldAlias);

        // If default was the old alias, set it to the new alias
        if (state.defaultNotebook === oldAlias) {
          await deps.stateManager.setDefault(newAlias);
        }

        return jsonResult({
          success: true,
          oldAlias,
          newAlias,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T055: remove_notebook
// ---------------------------------------------------------------------------

function registerRemoveNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "remove_notebook",
    {
      description:
        "Remove a notebook from the registry. Closes its browser tab if open and deletes the state entry.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to remove"),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args: { alias?: string }) => {
      try {
        const alias = args.alias ?? "";

        const state = await deps.stateManager.load();
        if (!state.notebooks[alias]) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        // Close any open tab for this alias
        const tabs = deps.tabManager.listTabs();
        for (const tab of tabs) {
          if (tab.notebookAlias === alias) {
            await deps.tabManager.closeTab(tab.tabId);
          }
        }

        // Remove from state (also clears default if it matches)
        await deps.stateManager.removeNotebook(alias);

        return jsonResult({ success: true, removed: alias });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}
