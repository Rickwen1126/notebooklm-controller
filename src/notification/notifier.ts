/**
 * Notifier — fire-and-forget MCP notification for async task completion.
 *
 * Sends `notifications/task-completed` to all connected MCP clients when an
 * AsyncTask reaches a terminal state. Errors are caught and logged; the caller
 * is never disrupted.
 *
 * ============================================================================
 * 待研究：MCP Push Notification 的根本限制
 * ============================================================================
 *
 * 問題描述（發現於 2026-03-15）：
 *   MCP Streamable HTTP 有兩種 server push 路徑：
 *     1. GET /mcp SSE（standalone stream）— 需要 client 主動維持長連線
 *     2. EventStore + Last-Event-ID replay — 需要 client reconnect 時帶 header
 *
 *   Claude Code 等 stateless MCP clients 兩者都不做：
 *     - exec async=true → taskId 回傳 → POST 連線關閉
 *     - 沒有持久 GET SSE，沒有 Last-Event-ID
 *     - task 完成 → notify() 呼叫 → "Not connected" 或 session 已不存在
 *
 *   Log 現象：
 *     Notifier: failed to send notification { error: "Not connected" }
 *     Notifier: no active MCP sessions, notification dropped
 *
 *   這些 warn log 是預期行為，不是 bug，但也代表 notification 實際上無用。
 *
 * 目前解法：
 *   async 任務結果透過 polling 取得（get_status tool）。
 *   exec async=true 的 response 已包含明確的 polling 指令，由 LLM 主動輪詢。
 *   sync 任務（async=false，預設）直接在 tool response 回傳結果，不走 notification。
 *
 * 未來研究方向（如果需要 true push）：
 *   Option A: EventStore 實作 — 在 StreamableHTTPServerTransport 注入 eventStore，
 *             client reconnect 時帶 Last-Event-ID 即可 replay 錯過的 notification。
 *             但前提是 client（Claude Code）支援這個 header。
 *   Option B: session affinity — exec 呼叫時從 extra.sessionId 取得 session，
 *             task 存 sessionId，notify 時只送那個 session（而非 broadcast）。
 *             可減少無效呼叫，但根本問題（session 已關）仍在。
 *   Option C: 接受 polling 架構，移除 Notifier — 最簡單，目前 exec sync 已夠用。
 * ============================================================================
 */

import type { NbctlMcpServer } from "../daemon/mcp-server.js";
import type { AsyncTask, TaskNotificationPayload } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export class Notifier {
  private mcpServer: NbctlMcpServer | null;

  constructor(mcpServer: NbctlMcpServer | null) {
    this.mcpServer = mcpServer;
  }

  /** Update the MCP server reference (called when MCP server starts). */
  setServer(mcpServer: NbctlMcpServer): void {
    this.mcpServer = mcpServer;
  }

  /**
   * Send a `notifications/task-completed` notification to all active sessions.
   *
   * NOTE: In practice this will almost always fail for stateless clients like
   * Claude Code (no persistent GET SSE). Failures are logged at debug level
   * since they are expected, not actionable errors. See 待研究 note above.
   *
   * Fire-and-forget: any error is caught and logged — the caller is never thrown at.
   */
  notify(task: AsyncTask): void {
    if (!this.mcpServer) {
      logger.debug("Notifier: no MCP server set, skipping notification", {
        taskId: task.taskId,
      });
      return;
    }

    const payload = this.buildPayload(task);
    const notification = {
      method: "notifications/task-completed",
      params: { ...payload } as Record<string, unknown>,
    };

    // Broadcast to all currently-active sessions at notification time.
    // This avoids holding a stale reference to a session that may have disconnected.
    let sent = 0;
    for (const sessionServer of this.mcpServer.getSessionServers()) {
      sent++;
      sessionServer.server
        .notification(notification)
        .catch((err: unknown) => {
          // Expected for stateless clients — demote to debug (see 待研究 note).
          logger.debug("Notifier: failed to send notification", {
            taskId: task.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    if (sent === 0) {
      // Expected: stateless client has no active SSE session after exec returns.
      logger.debug("Notifier: no active MCP sessions, notification dropped", {
        taskId: task.taskId,
      });
    }
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
