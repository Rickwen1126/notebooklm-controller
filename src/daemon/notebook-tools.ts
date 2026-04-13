/**
 * MCP tool registration for notebook management.
 *
 * Exports `registerNotebookTools()` which registers all notebook-level MCP tools
 * on the given NbctlMcpServer.
 *
 * T049: register_notebook   — register an existing NotebookLM notebook by URL
 * T050: list_notebooks      — list all registered notebooks
 * T053: set_default         — set the default notebook alias
 * T054: rename_notebook     — rename a notebook's alias
 * T055: unregister_notebook — remove a notebook from local registry and cache
 * T056: register_all_notebooks — scan homepage and batch-register notebooks
 * T057: create_notebook     — create a new notebook via homepage runner
 * T058: list_notebook_index — grouped notebook catalog/index view
 * T059: set_notebook_catalog — persist local notebook catalog metadata
 */

import { z } from "zod";
import type { NbctlMcpServer } from "./mcp-server.js";
import type { Scheduler } from "./scheduler.js";
import type { TabManager } from "../tab-manager/tab-manager.js";
import type { StateManager } from "../state/state-manager.js";
import type { TaskStore } from "../state/task-store.js";
import type { CacheManager } from "../state/cache-manager.js";
import type {
  NotebookCatalogMetadata,
  NotebookCatalogRole,
  NotebookEntry,
} from "../shared/types.js";
import { NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { buildNotebookIndex } from "../shared/notebook-index.js";
import { normalizeUrl, generateAlias } from "../shared/notebook-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTEBOOK_URL_PREFIX = `${NOTEBOOKLM_HOMEPAGE}/notebook/`;

/**
 * Alias validation regex:
 * - 2-50 chars: starts and ends with [a-z0-9], middle allows hyphens
 * - 1 char: single [a-z0-9]
 */
const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const CATALOG_ROLES = [
  "canonical",
  "reference",
  "practice",
  "guide",
  "idioms",
  "blueprint",
  "strategy",
  "source",
  "core",
  "book",
  "implementation",
] as const satisfies readonly NotebookCatalogRole[];
const CATALOG_STATUSES = [
  "keep",
  "review-needed",
  "deprecated",
] as const satisfies readonly NonNullable<NotebookCatalogMetadata["status"]>[];

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
  registerAddAllNotebooks(server, deps);
  registerListNotebooks(server, deps);
  registerListNotebookIndex(server, deps);
  registerSetNotebookCatalog(server, deps);
  registerSetDefault(server, deps);
  registerRenameNotebook(server, deps);
  registerUnregisterNotebook(server, deps);
}

// ---------------------------------------------------------------------------
// create_notebook — thin submitter → createNotebook runner
// ---------------------------------------------------------------------------

function registerCreateNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
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
        const alias = args.alias ?? generateAlias(title);

        const aliasError = validateAlias(alias);
        if (aliasError) {
          return errorResult(aliasError);
        }

        // Check alias not already taken
        const state = await deps.stateManager.load();
        if (state.notebooks[alias]) {
          return errorResult(`Alias already exists: "${alias}"`);
        }

        const task = await deps.scheduler.submit({
          notebookAlias: "__homepage__",
          command: "create_notebook",
          runner: "createNotebook",
          runnerInput: { title, alias },
        });

        await deps.scheduler.waitForTask(task.taskId);

        const completed = await deps.taskStore.get(task.taskId);
        if (!completed || completed.status !== "completed") {
          const err = completed?.error ?? "Task failed";
          return errorResult(`Failed to create notebook: ${err}`);
        }
        return jsonResult(completed.result ?? { success: false });
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
        "To create a new notebook in NotebookLM, use create_notebook instead.",
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
// T056: register_all_notebooks — thin submitter → scanAllNotebooks runner
// ---------------------------------------------------------------------------

function registerAddAllNotebooks(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "register_all_notebooks",
    {
      description:
        "Batch-register all notebooks in the NotebookLM account. " +
        "Scans the homepage, clicks each notebook to capture its URL, " +
        "and registers it. Skips already-registered notebooks. " +
        "Uses per-notebook recovery on script failures. " +
        "Set async=true for large accounts to avoid client-side timeout; " +
        "poll get_status(taskId) until completion.",
      inputSchema: {
        async: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return immediately with taskId instead of waiting for the full scan to complete",
          ),
      },
    },
    async (args: { async?: boolean }) => {
      try {
        if (!deps.scheduler || !deps.taskStore) {
          return errorResult("register_all_notebooks requires scheduler");
        }

        const task = await deps.scheduler.submit({
          notebookAlias: "__homepage__",
          command: "register_all_notebooks",
          runner: "scanAllNotebooks",
        });

        if (args.async) {
          return jsonResult({
            taskId: task.taskId,
            status: "queued",
            notebook: "__homepage__",
            next_action: `Call get_status(taskId='${task.taskId}') every 15-20 seconds. Stop when status is 'completed' or 'failed'.`,
          });
        }

        await deps.scheduler.waitForTask(task.taskId);

        const completed = await deps.taskStore.get(task.taskId);
        if (!completed || completed.status !== "completed") {
          return errorResult(completed?.error ?? "Task failed");
        }

        return jsonResult(completed.result ?? { success: false });
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
// T058: list_notebook_index
// ---------------------------------------------------------------------------

function registerListNotebookIndex(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "list_notebook_index",
    {
      description:
        "Return a grouped notebook catalog/index view derived from local notebook aliases " +
        "and optional catalog metadata. Supports grouped output by default, or flat output.",
      inputSchema: {
        domain: z
          .string()
          .optional()
          .describe("Optional domain filter, e.g. 'go', 'ai-tool', 'arch'"),
        flat: z
          .boolean()
          .optional()
          .default(false)
          .describe("When true, return a flat notebook list with domain/topic/role columns"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args: { domain?: string; flat?: boolean }) => {
      try {
        const state = await deps.stateManager.load();
        const index = buildNotebookIndex(state.notebooks, state.defaultNotebook);
        const filteredDomains = args.domain
          ? index.domains.filter((group) => group.domain === args.domain)
          : index.domains;

        if (args.flat) {
          const notebooks = filteredDomains.flatMap((domain) =>
            domain.topics.flatMap((topic) => topic.notebooks),
          );
          return jsonResult({
            mode: "flat",
            total: notebooks.length,
            defaultNotebook: index.defaultNotebook,
            notebooks,
          });
        }

        return jsonResult({
          mode: "grouped",
          total: filteredDomains.reduce(
            (sum, domain) => sum + domain.topics.reduce((topicSum, topic) => topicSum + topic.notebooks.length, 0),
            0,
          ),
          defaultNotebook: index.defaultNotebook,
          domains: filteredDomains,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T059: set_notebook_catalog
// ---------------------------------------------------------------------------

function registerSetNotebookCatalog(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "set_notebook_catalog",
    {
      description:
        "Update local notebook catalog metadata for a single notebook. " +
        "This only affects local curation/index views and does not modify the remote NotebookLM notebook.",
      inputSchema: {
        alias: z
          .string()
          .describe("Alias of the notebook to update"),
        domain: z
          .string()
          .nullable()
          .optional()
          .describe("Logical catalog domain, e.g. 'go', 'arch', 'ai-tool'. Use null to clear."),
        topic: z
          .string()
          .nullable()
          .optional()
          .describe("Catalog topic within the domain. Use null to clear."),
        role: z
          .enum(CATALOG_ROLES)
          .nullable()
          .optional()
          .describe("Notebook role inside its topic group. Use null to clear."),
        status: z
          .enum(CATALOG_STATUSES)
          .nullable()
          .optional()
          .describe("Local curation status. Use null to clear."),
        canonicalFor: z
          .string()
          .nullable()
          .optional()
          .describe("Optional human-readable note for what this notebook is canonical for. Use null to clear."),
        notes: z
          .string()
          .nullable()
          .optional()
          .describe("Optional local notes for future curation. Use null to clear."),
      },
    },
    async (
      args: {
        alias?: string;
        domain?: string | null;
        topic?: string | null;
        role?: NotebookCatalogRole | null;
        status?: NotebookCatalogMetadata["status"];
        canonicalFor?: string | null;
        notes?: string | null;
      },
    ) => {
      try {
        const alias = args.alias ?? "";
        if (!alias) {
          return errorResult("'alias' parameter is required");
        }

        const state = await deps.stateManager.load();
        const existing = state.notebooks[alias];
        if (!existing) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        const hasPatch =
          args.domain !== undefined ||
          args.topic !== undefined ||
          args.role !== undefined ||
          args.status !== undefined ||
          args.canonicalFor !== undefined ||
          args.notes !== undefined;
        if (!hasPatch) {
          return errorResult(
            "At least one catalog field must be provided: domain, topic, role, status, canonicalFor, or notes",
          );
        }

        const nextCatalog: NotebookCatalogMetadata = {
          domain: existing.catalog?.domain ?? null,
          topic: existing.catalog?.topic ?? null,
          role: existing.catalog?.role ?? null,
          status: existing.catalog?.status ?? null,
          canonicalFor: existing.catalog?.canonicalFor ?? null,
          notes: existing.catalog?.notes ?? null,
        };

        if (args.domain !== undefined) nextCatalog.domain = args.domain;
        if (args.topic !== undefined) nextCatalog.topic = args.topic;
        if (args.role !== undefined) nextCatalog.role = args.role;
        if (args.status !== undefined) nextCatalog.status = args.status;
        if (args.canonicalFor !== undefined) nextCatalog.canonicalFor = args.canonicalFor;
        if (args.notes !== undefined) nextCatalog.notes = args.notes;

        const hasCatalogValue = Object.values(nextCatalog).some((value) => value !== null);
        const catalog = hasCatalogValue ? nextCatalog : undefined;
        await deps.stateManager.updateNotebook(alias, { catalog });

        return jsonResult({
          success: true,
          alias,
          catalog: catalog ?? null,
        });
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
