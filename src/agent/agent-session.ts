/**
 * Agent session — LLM-based execution for operations that need judgment.
 *
 * Unlike deterministic scripts (0 LLM), Agent Sessions use an LLM with
 * browser tools to accomplish tasks that require visual analysis, scrolling,
 * content reading, or multi-step decision making.
 *
 * Examples: scan notebooks, smart rename, audio generation monitoring.
 */

import type { CopilotSession, Tool, SessionEvent } from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CDPSession, Page } from "puppeteer-core";
import type { CopilotClientSingleton } from "./client.js";
import type { AgentConfig } from "../shared/types.js";
import { createBrowserTools } from "./browser-tools-shared.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSessionOptions {
  client: CopilotClientSingleton;
  cdp: CDPSession;
  page: Page;
  /** Agent config loaded from agents/*.md */
  agentConfig: AgentConfig;
  /** What the agent should accomplish */
  goal: string;
  /** Model override. Defaults to gpt-4.1. */
  model?: string;
  /** Timeout per iteration in ms. Defaults to DEFAULT_SESSION_TIMEOUT_MS (5 min). */
  timeoutMs?: number;
  /** Max iterations (multi-turn loop). Defaults to 10. */
  maxIterations?: number;
}

export interface AgentSessionResult {
  success: boolean;
  result: string | null;
  toolCalls: number;
  toolCallLog: Array<{ tool: string; input: string; output: string }>;
  agentMessages: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an Agent Session — LLM with browser tools executes a task that
 * needs judgment (not deterministic enough for scripts).
 */
export async function runAgentSession(
  options: AgentSessionOptions,
): Promise<AgentSessionResult> {
  const {
    client,
    cdp,
    page,
    agentConfig,
    goal,
    model = "gpt-4.1",
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    maxIterations = 10,
  } = options;

  const log = logger.child({ module: "agent-session", agent: agentConfig.name });
  const t0 = Date.now();

  let capturedResult: string | null = null;

  const browserTools = createBrowserTools(cdp, page);

  const submitResultTool = defineTool("submitResult", {
    description: "Submit the task result when done. You MUST call this before finishing.",
    parameters: z.object({
      success: z.boolean().describe("Whether you completed the task"),
      result: z.string().describe("The task result (structured data, list, summary, etc.)"),
    }),
    handler: async (args: { success: boolean; result: string }) => {
      capturedResult = args.result;
      return { textResultForLlm: "Result submitted.", resultType: "success" as const };
    },
  });

  const allTools = [...browserTools, submitResultTool] as Tool<any>[];

  // Build system message from agent config prompt + goal
  const systemMessage = `${agentConfig.prompt}

## Current Task

${goal}

## Rules

- Use browser tools (screenshot, find, click, read, wait) to accomplish the task.
- Call submitResult when done with structured output.
- Do NOT use bash, edit, grep, or any non-browser tools.`;

  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;

  log.info("Starting Agent session", {
    agent: agentConfig.name,
    goal: goal.slice(0, 100),
    model,
  });

  let session: CopilotSession | undefined;
  try {
    const sdkClient = client.getClient();

    session = await sdkClient.createSession({
      tools: allTools,
      model,
      systemMessage: { mode: "replace" as const, content: systemMessage },
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });

    // Capture tool call log + agent messages
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

    // Iterative loop: keep sending prompts until submitResult is called
    // or max iterations reached. Each iteration continues the conversation.
    // Per-iteration timeout doesn't kill the session — agent continues in next iteration.
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const prompt = iteration === 1
        ? goal
        : "繼續執行任務。如果 TODO list 所有項目都完成了，請呼叫 submitResult 提交結果。";

      log.info("Agent iteration", { iteration, maxIterations, agent: agentConfig.name, toolCalls: toolCallCount });

      try {
        await session.sendAndWait({ prompt }, timeoutMs);
      } catch (iterErr) {
        // Timeout or error in this iteration — don't kill the session.
        // The conversation context is preserved, agent can continue.
        const msg = iterErr instanceof Error ? iterErr.message : String(iterErr);
        log.warn("Agent iteration timeout/error, continuing", { iteration, error: msg });
      }

      // Check if submitResult was called (may have been called during this or any previous iteration)
      if (capturedResult !== null) {
        log.info("Agent completed via submitResult", { iteration, toolCalls: toolCallCount });
        break;
      }

      if (iteration === maxIterations) {
        log.warn("Agent reached max iterations without submitResult", { maxIterations, toolCalls: toolCallCount });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Agent session failed", { error: msg });
  } finally {
    if (session) {
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 5_000)),
        ]);
      } catch { /* swallow */ }
    }
  }

  const result: AgentSessionResult = {
    success: capturedResult !== null,
    result: capturedResult,
    toolCalls: toolCallCount,
    toolCallLog,
    agentMessages,
    durationMs: Date.now() - t0,
  };

  log.info("Agent session completed", {
    agent: agentConfig.name,
    success: result.success,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
  });

  return result;
}
