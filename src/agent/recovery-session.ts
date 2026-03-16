/**
 * Recovery session — LLM-based completion when a deterministic script fails.
 *
 * Uses GPT-5-mini (reasoning model) to:
 * 1. Complete the original task from the current browser state
 * 2. Analyze why the script failed
 * 3. Suggest a UIMap patch if applicable
 *
 * Constrained to 10 tool calls to prevent infinite loops.
 */

import type { CopilotSession, Tool, SessionEvent } from "@github/copilot-sdk";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CDPSession, Page } from "puppeteer-core";
import type { CopilotClientSingleton } from "./client.js";
import { createBrowserTools } from "./browser-tools-shared.js";
import type { ScriptResult } from "../scripts/types.js";
import { formatLogForAgent } from "../scripts/types.js";
import { RECOVERY_MODEL, RECOVERY_TIMEOUT_MS } from "../shared/config.js";
import type { RepairLog, RecoveryToolCall } from "../shared/types.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  success: boolean;
  result: string | null;
  analysis: string | null;
  suggestedPatch: RepairLog["suggestedPatch"];
  toolCalls: number;
  toolCallLog: RecoveryToolCall[];
  agentMessages: string[];
  finalScreenshot: string | null; // base64, only on failure
  durationMs: number;
}

export interface RecoverySessionOptions {
  client: CopilotClientSingleton;
  cdp: CDPSession;
  page: Page;
  scriptResult: ScriptResult;
  goal: string;
  model?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a Recovery session to complete a failed script task.
 *
 * The Recovery agent has browser tools + a submitResult tool.
 * It must call submitResult within 10 tool calls.
 */
export async function runRecoverySession(
  options: RecoverySessionOptions,
): Promise<RecoveryResult> {
  const {
    client,
    cdp,
    page,
    scriptResult,
    goal,
    model = RECOVERY_MODEL,
    timeoutMs = RECOVERY_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "recovery-session" });
  const t0 = Date.now();

  let capturedResult: string | null = null;
  let capturedAnalysis: string | null = null;
  let capturedPatch: RepairLog["suggestedPatch"] = null;

  const browserTools = createBrowserTools(cdp, page);

  const submitResultTool = defineTool("submitResult", {
    description: "Submit task result and failure analysis. Call this when done.",
    parameters: z.object({
      success: z.boolean().describe("Whether you completed the original task"),
      result: z.string().optional().describe("The task result (e.g. answer text)"),
      analysis: z.string().describe("Why the script failed: selector changed? flow changed? wrong page state?"),
      suggestedPatch: z.object({
        elementKey: z.string().describe("The UIMap key to fix (e.g. 'chat_input')"),
        oldValue: z.string().describe("The broken value that caused the failure"),
        newValue: z.string().describe("The correct value you discovered"),
        confidence: z.number().min(0).max(1).describe("How confident you are in this fix"),
      }).optional().describe("If you found the correct selector/text, suggest a patch"),
    }),
    handler: async (args: {
      success: boolean;
      result?: string;
      analysis: string;
      suggestedPatch?: { elementKey: string; oldValue: string; newValue: string; confidence: number };
    }) => {
      capturedResult = args.result ?? null;
      capturedAnalysis = args.analysis;
      capturedPatch = args.suggestedPatch ?? null;
      return { textResultForLlm: "Result submitted.", resultType: "success" as const };
    },
  });

  const allTools = [...browserTools, submitResultTool] as Tool<any>[];

  const formattedLog = formatLogForAgent(scriptResult.log);

  const systemMessage = `你是 NotebookLM 操作的 recovery agent。一個自動化腳本在第 ${scriptResult.failedAtStep} 步失敗了。

## 你的任務（按順序）

1. **完成任務**：用 browser tools 從當前狀態接續完成原始目標。不需要重做腳本已成功的步驟。
2. **分析原因**：說明為什麼腳本失敗（selector 變了？流程變了？頁面狀態不對？）
3. **呼叫 submitResult** 提交結果和分析。如果你找到了正確的 selector/text 值，填入 suggestedPatch。

## 關鍵規則

- **你必須在 10 個 tool call 內呼叫 submitResult。** 不要無限嘗試。
- **不要判斷答案品質。** NotebookLM 只能根據來源回答。如果來源沒有相關資訊，「抱歉，來源中沒有相關資訊」就是正確的答案。你的工作是完成機械操作，不是得到特定內容的答案。
- **不要重複提問。** 提交一次問題、讀取一次答案就夠了。
- **只能使用：** screenshot, find, click, paste, type, read, wait, submitResult。**禁止** bash, view, edit, grep 等內建工具。

## 操作提示
- 先用 screenshot 看當前畫面狀態
- 如果要找 UI 元素，用 find("*") 列出所有可互動元素
- 聊天區提交按鈕在 y > 400 的位置（文字「提交」，aria-label）
- 答案用 read(".to-user-container .message-content") 讀取
- 等答案生成完成需要 wait 10-15 秒`;

  const userPrompt = `## 原始目標
${goal}

## 腳本已完成的步驟
${formattedLog}

## 失敗資訊
failedAtStep: ${scriptResult.failedAtStep}
failedSelector: ${scriptResult.failedSelector}
scriptStatus: ${scriptResult.status}

請先 screenshot 看當前畫面，然後接續完成任務。`;

  const toolCallLog: RecoveryToolCall[] = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;

  log.info("Starting Recovery session", {
    operation: scriptResult.operation,
    failedAtStep: scriptResult.failedAtStep,
    failedSelector: scriptResult.failedSelector,
    model,
  });

  let session: CopilotSession | undefined;
  try {
    const sdkClient = client.getClient();

    session = await sdkClient.createSession({
      tools: allTools,
      model,
      systemMessage: { mode: "append" as const, content: systemMessage },
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });

    // Capture structured tool call log + agent messages
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

    await session.sendAndWait({ prompt: userPrompt }, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Recovery session failed", { error: msg });
  } finally {
    if (session) {
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 5_000)),
        ]);
      } catch {
        // swallow disconnect errors
      }
    }
  }

  // On failure: take a final screenshot for repair context
  let finalScreenshot: string | null = null;
  if (capturedResult === null) {
    try {
      const ss = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      finalScreenshot = ss.data;
    } catch { /* ignore */ }
  }

  const result: RecoveryResult = {
    success: capturedResult !== null,
    result: capturedResult,
    analysis: capturedAnalysis,
    suggestedPatch: capturedPatch,
    toolCalls: toolCallCount,
    toolCallLog,
    agentMessages,
    finalScreenshot,
    durationMs: Date.now() - t0,
  };

  log.info("Recovery session completed", {
    success: result.success,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
    hasPatch: result.suggestedPatch !== null,
  });

  return result;
}
