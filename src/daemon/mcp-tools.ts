/**
 * MCP tool registration for the daemon.
 *
 * Exports `registerDaemonTools()` which registers all daemon-level MCP tools
 * (get_status, shutdown, reauth) on the given NbctlMcpServer.
 *
 * T043: get_status — daemon status overview or task lookup
 * T044: shutdown   — gracefully stop the daemon
 * T045: reauth     — switch Chrome to headed mode for re-authentication
 */

import { z } from "zod";
import type { NbctlMcpServer } from "./mcp-server.js";
import type { TabManager } from "../tab-manager/tab-manager.js";
import type { Scheduler } from "./scheduler.js";
import type { StateManager } from "../state/state-manager.js";
import type { NetworkGate } from "../network-gate/network-gate.js";
import type { TaskStore } from "../state/task-store.js";
import type { DaemonStatusResult } from "../shared/types.js";
import { MAX_TABS, NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolRegistrationDeps {
  tabManager: TabManager;
  scheduler: Scheduler;
  stateManager: StateManager;
  networkGate: NetworkGate;
  taskStore: TaskStore;
  googleSession?: { valid: boolean };
}

// ---------------------------------------------------------------------------
// registerDaemonTools
// ---------------------------------------------------------------------------

export function registerDaemonTools(
  server: NbctlMcpServer,
  deps: ToolRegistrationDeps,
): void {
  registerGetStatus(server, deps);
  // shutdown removed from MCP interface — daemon lifecycle managed via CLI (Ctrl+C / SIGTERM).
  registerReauth(server, deps);
  registerListAgents(server, deps);
}

// ---------------------------------------------------------------------------
// T043: get_status
// ---------------------------------------------------------------------------

function registerGetStatus(
  server: NbctlMcpServer,
  deps: ToolRegistrationDeps,
): void {
  server.registerTool(
    "get_status",
    {
      description:
        "Return daemon status overview, or look up specific tasks. " +
        "With no parameters: returns daemon health, active tabs, network status, and pending tasks. " +
        "With taskId: returns a single task. " +
        "With all=true or recent=true: returns task lists.",
      inputSchema: {
        taskId: z.string().optional().describe("Look up a specific task by ID"),
        all: z.boolean().optional().describe("Return all tasks"),
        recent: z
          .boolean()
          .optional()
          .describe("Return recently completed/failed tasks"),
        notebook: z
          .string()
          .optional()
          .describe("Filter tasks by notebook alias"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of tasks to return"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args: {
      taskId?: string;
      all?: boolean;
      recent?: boolean;
      notebook?: string;
      limit?: number;
    }) => {
      // Single task lookup
      if (args.taskId) {
        const task = await deps.taskStore.get(args.taskId);
        if (!task) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Task not found: ${args.taskId}` }),
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task) }],
        };
      }

      // All tasks
      if (args.all) {
        const tasks = await deps.taskStore.getAll({
          notebook: args.notebook,
          limit: args.limit,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
        };
      }

      // Recent completed/failed tasks
      if (args.recent) {
        const tasks = await deps.taskStore.getRecent({
          notebook: args.notebook,
          limit: args.limit,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
        };
      }

      // Default: daemon status overview
      const state = await deps.stateManager.load();
      const networkHealth = deps.networkGate.getHealth();

      const allTabs = deps.tabManager.listTabs();
      const usedSlots = allTabs.filter((t) => t.state === "active").length;
      const idleSlots = allTabs.filter((t) => t.state === "idle").length;

      const status: DaemonStatusResult = {
        running: true,
        tabPool: {
          usedSlots,
          maxSlots: MAX_TABS,
          idleSlots,
        },
        network: networkHealth,
        activeNotebooks: Object.keys(state.notebooks),
        defaultNotebook: state.defaultNotebook,
        pendingTasks: deps.scheduler.getQueueSize(),
        runningTasks: deps.scheduler.getRunningCount(),
        agentHealth: deps.scheduler.getHealth(),
        googleSessionValid: deps.googleSession?.valid ?? false,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status) }],
      };
    },
  );
}



// ---------------------------------------------------------------------------
// T045: reauth
// ---------------------------------------------------------------------------

function registerReauth(
  server: NbctlMcpServer,
  deps: ToolRegistrationDeps,
): void {
  server.registerTool(
    "reauth",
    {
      description:
        "Switch Chrome to headed mode for re-authentication. " +
        "All tabs must be closed first. After logging in, call reauth " +
        "again to switch back to headless mode.",
      inputSchema: {
        headless: z
          .boolean()
          .optional()
          .describe(
            "Target mode: false = headed (for login), true = headless (resume). " +
              "Defaults to false (open headed Chrome for login).",
          ),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args: { headless?: boolean }) => {
      const targetHeadless = args.headless ?? false;

      try {
        await deps.tabManager.switchMode(targetHeadless);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
        };
      }

      // When switching to headed mode, navigate to NotebookLM so the user
      // can see the login page (or confirm they're already logged in).
      if (!targetHeadless) {
        try {
          const currentUrl = await deps.tabManager.withTempTab(
            "__reauth__",
            NOTEBOOKLM_HOMEPAGE,
            async (tab) => {
              // Brief wait for page to settle (redirects, login check).
              await new Promise((resolve) => setTimeout(resolve, 3_000));
              return tab.page.url();
            },
          );

          const isLoggedIn =
            currentUrl.startsWith(NOTEBOOKLM_HOMEPAGE) &&
            !currentUrl.includes("accounts.google.com");

          // Update shared session state so get_status reflects current login.
          if (isLoggedIn && deps.googleSession) {
            deps.googleSession.valid = true;
          }

          const loginStatus = isLoggedIn
            ? "Already logged in to NotebookLM."
            : "Google login page detected. Please log in in the Chrome window.";

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  mode: "headed",
                  loggedIn: isLoggedIn,
                  message: loginStatus +
                    " After logging in, call reauth with headless=true to resume.",
                }),
              },
            ],
          };
        } catch (navErr: unknown) {
          const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  mode: "headed",
                  message:
                    "Chrome opened in headed mode but failed to navigate to NotebookLM: " +
                    navMsg +
                    ". Please manually navigate to https://notebooklm.google.com and log in.",
                }),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              mode: "headless",
              message:
                "Chrome switched back to headless mode. Normal operations can resume.",
            }),
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// T100: list_agents → list_operations (G2: script-first)
// ---------------------------------------------------------------------------

function registerListAgents(
  server: NbctlMcpServer,
  _deps: ToolRegistrationDeps,
): void {
  server.registerTool(
    "list_agents",
    {
      description:
        "List all available scripted operations with their names, descriptions, " +
        "and parameters. Useful for discovering what operations " +
        "can be performed via the exec tool.",
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const { getAvailableOperations, buildScriptCatalog } = await import("../scripts/index.js");
      const operations = getAvailableOperations();
      const catalog = buildScriptCatalog();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ operations, catalog }),
          },
        ],
      };
    },
  );
}
