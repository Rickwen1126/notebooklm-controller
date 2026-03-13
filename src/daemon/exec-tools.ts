/**
 * MCP tool registration for task execution.
 *
 * Exports `registerExecTools()` which registers exec and cancel_task
 * MCP tools on the given NbctlMcpServer.
 *
 * T062 + T063: exec         — execute a natural language command against a notebook
 * T064:        cancel_task  — cancel a queued or running task
 */

import { z } from "zod";
import type { NbctlMcpServer } from "./mcp-server.js";
import type { Scheduler } from "./scheduler.js";
import type { StateManager } from "../state/state-manager.js";
import type { TaskStore } from "../state/task-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecToolDeps {
  scheduler: Scheduler;
  stateManager: StateManager;
  taskStore: TaskStore;
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

// ---------------------------------------------------------------------------
// registerExecTools
// ---------------------------------------------------------------------------

export function registerExecTools(
  server: NbctlMcpServer,
  deps: ExecToolDeps,
): void {
  registerExec(server, deps);
  registerCancelTask(server, deps);
}

// ---------------------------------------------------------------------------
// T062 + T063: exec
// ---------------------------------------------------------------------------

function registerExec(
  server: NbctlMcpServer,
  deps: ExecToolDeps,
): void {
  server.registerTool(
    "exec",
    {
      description:
        "Execute a natural language instruction against a NotebookLM notebook. " +
        "By default waits for completion (sync). Set async=true to return " +
        "immediately with a taskId for later polling via get_status.",
      inputSchema: {
        prompt: z
          .string()
          .describe("Natural language instruction for the notebook agent"),
        notebook: z
          .string()
          .optional()
          .describe("Target notebook alias (uses default if omitted)"),
        async: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return immediately with taskId instead of waiting",
          ),
        context: z
          .string()
          .optional()
          .describe(
            "Context description (included in completion notification)",
          ),
      },
    },
    async (args: {
      prompt?: string;
      notebook?: string;
      async?: boolean;
      context?: string;
    }) => {
      try {
        const prompt = args.prompt ?? "";
        if (!prompt) {
          return errorResult("'prompt' parameter is required");
        }

        // -----------------------------------------------------------------
        // Resolve notebook alias
        // -----------------------------------------------------------------
        let notebookAlias = args.notebook;

        if (!notebookAlias) {
          const state = await deps.stateManager.load();
          notebookAlias = state.defaultNotebook ?? undefined;
        }

        if (!notebookAlias) {
          return errorResult(
            "No target notebook. Specify 'notebook' parameter or call set_default tool.",
          );
        }

        // -----------------------------------------------------------------
        // Verify notebook exists
        // -----------------------------------------------------------------
        const state = await deps.stateManager.load();
        if (!state.notebooks[notebookAlias]) {
          return errorResult(`Notebook not found: ${notebookAlias}`);
        }

        // -----------------------------------------------------------------
        // Submit to scheduler
        // -----------------------------------------------------------------
        const task = await deps.scheduler.submit({
          notebookAlias,
          command: prompt,
          context: args.context,
        });

        // -----------------------------------------------------------------
        // Async mode: return immediately
        // -----------------------------------------------------------------
        if (args.async) {
          return jsonResult({
            taskId: task.taskId,
            status: "queued",
            notebook: notebookAlias,
            hint: `Use get_status tool with taskId='${task.taskId}' to check results.`,
          });
        }

        // -----------------------------------------------------------------
        // Sync mode: wait for completion
        // -----------------------------------------------------------------
        await deps.scheduler.waitForIdle();

        const completed = await deps.taskStore.get(task.taskId);
        if (!completed) {
          return errorResult("Task disappeared unexpectedly");
        }

        if (completed.status === "completed") {
          return jsonResult({
            success: true,
            taskId: completed.taskId,
            notebook: notebookAlias,
            ...completed.result,
          });
        }

        if (completed.status === "cancelled") {
          return jsonResult({
            success: false,
            taskId: completed.taskId,
            notebook: notebookAlias,
            error: "Task was cancelled",
          });
        }

        // failed or other terminal state
        return jsonResult({
          success: false,
          taskId: completed.taskId,
          notebook: notebookAlias,
          error: completed.error ?? "Task failed",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// T064: cancel_task
// ---------------------------------------------------------------------------

function registerCancelTask(
  server: NbctlMcpServer,
  deps: ExecToolDeps,
): void {
  server.registerTool(
    "cancel_task",
    {
      description:
        "Cancel a queued or running task. " +
        "Queued tasks are removed immediately. " +
        "Running tasks are signalled to stop at the next safe point.",
      inputSchema: {
        taskId: z.string().describe("ID of the task to cancel"),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args: { taskId?: string }) => {
      try {
        const taskId = args.taskId ?? "";
        if (!taskId) {
          return errorResult("'taskId' parameter is required");
        }

        const cancelled = await deps.scheduler.cancel(taskId);

        const result: Record<string, unknown> = {
          taskId,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        };

        // Check if the task was running when cancelled
        const lastChange = cancelled.history[cancelled.history.length - 1];
        if (lastChange?.reason?.includes("was running")) {
          result.hint = "Agent will stop at next safe point.";
        }

        return jsonResult(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  );
}
