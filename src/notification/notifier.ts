/**
 * Notifier — fire-and-forget MCP notification for async task completion.
 *
 * Sends `notifications/task-completed` to the connected MCP client when an
 * AsyncTask reaches a terminal state. Errors are caught and logged; the caller
 * is never disrupted.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AsyncTask, TaskNotificationPayload } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export class Notifier {
  private server: Server | null;

  constructor(server: Server | null) {
    this.server = server;
  }

  /** Update the server reference (called when MCP server starts). */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Send a `notifications/task-completed` notification for the given task.
   *
   * Fire-and-forget: any error (disconnected client, transport failure, etc.)
   * is caught and logged as a warning — the caller is never thrown at.
   */
  notify(task: AsyncTask): void {
    if (!this.server) {
      logger.warn("Notifier: no MCP server set, skipping notification", {
        taskId: task.taskId,
      });
      return;
    }

    const payload = this.buildPayload(task);

    // Fire-and-forget: launch but never await at the call-site.
    this.server
      .notification({
        method: "notifications/task-completed",
        params: { ...payload } as Record<string, unknown>,
      })
      .catch((err: unknown) => {
        logger.warn("Notifier: failed to send notification", {
          taskId: task.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Build a TaskNotificationPayload from an AsyncTask. */
  private buildPayload(task: AsyncTask): TaskNotificationPayload {
    return {
      taskId: task.taskId,
      status: task.status === "failed" ? "failed" : "completed",
      notebook: task.notebookAlias,
      result: task.result ?? {},
      originalContext: task.context,
      command: task.command,
      timestamp: new Date().toISOString(),
    };
  }
}
