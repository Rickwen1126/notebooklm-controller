/**
 * Shared helpers for agent and recovery sessions.
 * Eliminates duplicated event listener setup and disconnect guard.
 */

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";

export interface SessionEventCapture {
  toolCallLog: Array<{ tool: string; input: string; output: string }>;
  agentMessages: string[];
  getToolCallCount: () => number;
}

/**
 * Attach event listeners to a CopilotSession to capture tool calls and messages.
 * Returns mutable arrays that the caller owns.
 */
export function setupSessionEventListeners(session: CopilotSession): SessionEventCapture {
  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;

  const pendingByCallId = new Map<string, { tool: string; input: string }>();

  session.on((event: SessionEvent) => {
    if (event.type === "tool.execution_start") {
      toolCallCount++;
      const d = event.data as { toolCallId: string; toolName: string; arguments?: Record<string, unknown> };
      pendingByCallId.set(d.toolCallId, {
        tool: d.toolName,
        input: JSON.stringify(d.arguments ?? {}).slice(0, 200),
      });
    } else if (event.type === "tool.execution_complete") {
      const d = event.data as { toolCallId: string; success: boolean; result?: { content: string } };
      const pending = pendingByCallId.get(d.toolCallId);
      toolCallLog.push({
        tool: pending?.tool ?? "unknown",
        input: pending?.input ?? "{}",
        output: (d.result?.content ?? "(no content)").slice(0, 300),
      });
      pendingByCallId.delete(d.toolCallId);
    } else if (event.type === "assistant.message") {
      const d = event.data as { content?: string };
      if (d.content?.trim()) agentMessages.push(d.content.slice(0, 300));
    }
  });

  return { toolCallLog, agentMessages, getToolCallCount: () => toolCallCount };
}

/**
 * Disconnect a CopilotSession with 5-second timeout guard.
 * Swallows errors — scheduler must never block on disconnect.
 */
export async function disconnectSession(session: CopilotSession): Promise<void> {
  try {
    await Promise.race([
      session.disconnect(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 5_000)),
    ]);
  } catch {
    // swallow — scheduler safety
  }
}
