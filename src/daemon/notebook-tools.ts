/**
 * MCP tool registration for notebook management.
 *
 * Exports `registerNotebookTools()` which registers all notebook-level MCP tools
 * on the given NbctlMcpServer.
 *
 * T049: add_notebook      — register a new NotebookLM notebook
 * T050: list_notebooks    — list all registered notebooks
 * T053: set_default       — set the default notebook alias
 * T054: rename_notebook   — rename a notebook's alias
 * T055: unregister_notebook — remove a notebook from local registry and cache
 */

import { z } from "zod";
import type { NbctlMcpServer } from "./mcp-server.js";
import type { Scheduler } from "./scheduler.js";
import type { TabManager } from "../tab-manager/tab-manager.js";
import type { StateManager } from "../state/state-manager.js";
import type { TaskStore } from "../state/task-store.js";
import type { CacheManager } from "../state/cache-manager.js";
import type { NotebookEntry } from "../shared/types.js";
import { NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTEBOOK_URL_PREFIX = `${NOTEBOOKLM_HOMEPAGE}/notebook/`;

/** Strip query params, hash fragments, and trailing slash for consistent URL comparison. */
const normalizeUrl = (u: string) =>
  u.split("?")[0].split("#")[0].replace(/\/$/, "");

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
  scheduler?: Scheduler;
  taskStore?: TaskStore;
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
  registerCreateNotebook(server, deps);
  registerAddNotebook(server, deps);
  registerAddAllNotebooks(server);
  registerListNotebooks(server, deps);
  registerSetDefault(server, deps);
  registerRenameNotebook(server, deps);
  registerUnregisterNotebook(server, deps);
}

// ---------------------------------------------------------------------------
// create_notebook — create a new notebook on NotebookLM and auto-register
// ---------------------------------------------------------------------------

function registerCreateNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  const log = logger.child({ module: "create_notebook" });

  server.registerTool(
    "create_notebook",
    {
      description:
        "Create a new notebook on NotebookLM with the given title. " +
        "Automatically registers it so it can be used immediately. " +
        "Returns the alias, URL, and title.",
      inputSchema: {
        title: z
          .string()
          .describe("Title for the new notebook"),
        alias: z
          .string()
          .optional()
          .describe(
            "Alias for the notebook (auto-generated from title if omitted). " +
            "1-50 chars, lowercase alphanumeric + hyphens.",
          ),
      },
    },
    async (args: { title?: string; alias?: string }) => {
      try {
        const title = args.title?.trim() ?? "";
        if (!title) {
          return errorResult("'title' parameter is required");
        }

        if (!deps.scheduler || !deps.taskStore) {
          return errorResult("create_notebook requires scheduler (internal configuration error)");
        }

        // Generate alias from title if not provided
        const generated =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50) || "notebook";
        const alias = args.alias ?? generated;

        const aliasError = validateAlias(alias);
        if (aliasError) {
          return errorResult(aliasError);
        }

        // Check alias not already taken
        const state = await deps.stateManager.load();
        if (state.notebooks[alias]) {
          return errorResult(`Alias already exists: "${alias}"`);
        }

        // 1. Agent creates + renames the notebook on NotebookLM
        log.info("Creating notebook via agent", { title, alias });

        const task = await deps.scheduler.submit({
          notebookAlias: "__homepage__",
          command:
            `建立一本新的筆記本，標題設定為「${title}」。` +
            `步驟：先點「新建」建立筆記本，然後回首頁用「編輯標題」改名為「${title}」。` +
            `改名時用 paste(text="${title}", clear=true) 取代舊標題。` +
            `最後驗證首頁上的標題完全正確。`,
        });

        await deps.scheduler.waitForTask(task.taskId);

        const completed = await deps.taskStore.get(task.taskId);
        if (!completed || completed.status !== "completed") {
          const err = completed?.error ?? "Task failed";
          return errorResult(`Failed to create notebook: ${err}`);
        }

        // 2. Extract notebook URL by clicking into it from the homepage.
        //    The click may open a new tab (target=_blank) — handle both cases.
        //    Uses acquireTab/releaseTab so this tab participates in the pool.
        log.info("Extracting notebook URL: navigate into notebook from homepage");

        let tabHandle;
        try {
          tabHandle = await deps.tabManager.acquireTab({
            notebookAlias: "__create-extract__",
            url: NOTEBOOKLM_HOMEPAGE,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Tab pool at capacity during URL extraction: ${msg}`);
        }

        let notebookUrl: string;
        try {
          await new Promise((resolve) => setTimeout(resolve, 4_000));

          // Track pages before click so we can detect new tabs
          const browser = tabHandle.page.browser();
          const pagesBefore = await browser.pages();

          // Click on the notebook row matching the title (or first row if title not found)
          const clicked = await tabHandle.page.evaluate((searchTitle: string) => {
            const rows = document.querySelectorAll("tr[tabindex], [role='row'], a[href*='/notebook/']");
            for (const row of rows) {
              if (row.textContent?.includes(searchTitle)) {
                (row as HTMLElement).click();
                return "title-match";
              }
            }
            if (rows.length > 0) {
              (rows[0] as HTMLElement).click();
              return "first-row";
            }
            return null;
          }, title);

          if (!clicked) {
            return errorResult("Could not find any notebook on the homepage to extract URL");
          }

          await new Promise((resolve) => setTimeout(resolve, 5_000));

          // Check if a new tab was opened
          const pagesAfter = await browser.pages();
          const newPage = pagesAfter.find((p) => !pagesBefore.includes(p));

          if (newPage && newPage.url().includes("/notebook/")) {
            // New tab opened — get URL from it, close it
            notebookUrl = newPage.url();
            await newPage.close();
          } else {
            // Same-tab navigation
            notebookUrl = tabHandle.page.url();
          }
        } finally {
          await deps.tabManager.releaseTab(tabHandle.tabId);
        }

        // Normalize: strip query params, hash, trailing slash
        notebookUrl = normalizeUrl(notebookUrl);

        log.info("URL extracted", { url: notebookUrl });

        if (!notebookUrl) {
          return errorResult(
            `Notebook "${title}" was created but could not find its URL on the homepage. ` +
            `Use register_notebook to manually register it.`,
          );
        }

        // 3. Auto-register
        const now = new Date().toISOString();
        const entry: NotebookEntry = {
          alias,
          url: notebookUrl,
          title,
          description: "",
          status: "ready",
          registeredAt: now,
          lastAccessedAt: now,
          sourceCount: 0,
        };

        await deps.stateManager.addNotebook(entry);

        log.info("Notebook created and registered", { alias, url: notebookUrl, title });

        return jsonResult({
          success: true,
          alias,
          url: notebookUrl,
          title,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T049: add_notebook
// ---------------------------------------------------------------------------

function registerAddNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "register_notebook",
    {
      description:
        "Register an existing NotebookLM notebook by URL. " +
        "Provide the notebook URL and a short alias for future reference. " +
        "To create a new notebook, use exec(prompt='建立新筆記本') instead.",
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
          (nb) => normalizeUrl(nb.url) === normalizeUrl(url),
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
// T056: add_all_notebooks (stub — interaction model TBD, post-MVP)
// ---------------------------------------------------------------------------

function registerAddAllNotebooks(
  server: NbctlMcpServer,
): void {
  server.registerTool(
    "register_all_notebooks",
    {
      description:
        "Batch-register all notebooks in the NotebookLM account. " +
        "Navigates to the homepage, extracts the notebook list, and adds each one. " +
        "Note: This tool requires agent integration (post-MVP). " +
        "Interaction model (preview+confirm) is pending design.",
    },
    async () => {
      return jsonResult({
        success: false,
        error: "register_all_notebooks is not yet implemented. Use register_notebook to register notebooks individually.",
      });
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
// T055: unregister_notebook
// ---------------------------------------------------------------------------

function registerUnregisterNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "unregister_notebook",
    {
      description:
        "Remove a notebook from the local registry and clean up cached data. " +
        "Does not affect the remote NotebookLM notebook or browser state.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to unregister"),
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

        // Remove from state (also clears default if it matches)
        await deps.stateManager.removeNotebook(alias);

        // Clean up per-notebook cache
        await deps.cacheManager.clearNotebook(alias);

        return jsonResult({ success: true, unregistered: alias });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}
