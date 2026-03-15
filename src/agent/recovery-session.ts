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
// Browser tools for Recovery agent
// ---------------------------------------------------------------------------

function createRecoveryBrowserTools(cdp: CDPSession, page: Page): Tool<any>[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => {
      const result = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: "Screenshot captured.",
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: result.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  const findTool = defineTool("find", {
    description: "Find interactive elements by text/aria-label/placeholder. Returns coordinates. Use '*' to list all.",
    parameters: z.object({ query: z.string().describe("Text to search for, or '*' for all") }),
    handler: async (args: { query: string }) => {
      const results = await page.evaluate(`(async () => {
        const q = ${JSON.stringify(args.query)};
        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const matches = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const text = (el.textContent || "").trim();
          const ariaLabel = el.getAttribute("aria-label");
          const placeholder = el.getAttribute("placeholder");
          if (q === "*" || text.includes(q) || (ariaLabel && ariaLabel.includes(q)) || (placeholder && placeholder.includes(q))) {
            matches.push({
              tag: el.tagName, text: text.slice(0, 80),
              ariaLabel, placeholder,
              disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
              center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            });
          }
        }
        return matches;
      })()`) as Array<Record<string, unknown>>;
      if (results.length === 0) return { textResultForLlm: `No elements found for: "${args.query}"`, resultType: "success" as const };
      return {
        textResultForLlm: results.map((r: any) =>
          `[${r.tag}] text="${r.text}" aria="${r.ariaLabel ?? ""}" placeholder="${r.placeholder ?? ""}"${r.disabled ? " DISABLED" : ""} → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})`,
        ).join("\n"),
        resultType: "success" as const,
      };
    },
  });

  const clickTool = defineTool("click", {
    description: "Click at coordinates. Use find() first to get coordinates.",
    parameters: z.object({ x: z.number(), y: z.number() }),
    handler: async (args: { x: number; y: number }) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: args.x, y: args.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: args.x, y: args.y, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 500));
      const ss = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: `Clicked at (${args.x}, ${args.y}).`,
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: ss.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position.",
    parameters: z.object({ text: z.string() }),
    handler: async (args: { text: string }) => {
      await cdp.send("Input.insertText", { text: args.text });
      return { textResultForLlm: `Pasted ${args.text.length} chars.`, resultType: "success" as const };
    },
  });

  const typeTool = defineTool("type", {
    description: "Type text or special keys (Escape, Enter, Tab, Ctrl+A).",
    parameters: z.object({ text: z.string() }),
    handler: async (args: { text: string }) => {
      const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
        Escape: { key: "Escape", code: "Escape", keyCode: 27 },
        Enter: { key: "Enter", code: "Enter", keyCode: 13 },
        Tab: { key: "Tab", code: "Tab", keyCode: 9 },
        Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      };
      if (args.text === "Ctrl+A" || args.text === "ctrl+a") {
        await page.evaluate(`(() => {
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select(); return; }
          const sel = window.getSelection();
          if (sel && document.activeElement) sel.selectAllChildren(document.activeElement);
        })()`);
        return { textResultForLlm: "Selected all.", resultType: "success" as const };
      }
      const special = specialKeys[args.text];
      if (special) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
        return { textResultForLlm: `Typed: "${args.text}"`, resultType: "success" as const };
      }
      for (const char of args.text) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
      }
      return { textResultForLlm: `Typed: "${args.text}"`, resultType: "success" as const };
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM elements by CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources).`,
    parameters: z.object({ selector: z.string() }),
    handler: async (args: { selector: string }) => {
      const result = await page.evaluate(`(() => {
        const sel = ${JSON.stringify(args.selector)};
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return { count: 0, items: [] };
        return {
          count: els.length,
          items: Array.from(els).map((el) => ({
            tag: el.tagName,
            text: ((el.textContent || "").trim()).slice(0, 500),
            visible: getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none",
          })),
        };
      })()`) as { count: number; items: Array<{ tag: string; text: string; visible: boolean }> };
      if (result.count === 0) return { textResultForLlm: `(no match for "${args.selector}")`, resultType: "success" as const };
      return {
        textResultForLlm: [`Found ${result.count} element(s):`,
          ...result.items.map((item, i) => {
            const vis = item.visible ? "" : " (HIDDEN)";
            return `[${i + 1}] ${item.tag}${vis}: ${item.text.slice(0, 200)}${item.text.length > 200 ? "..." : ""}`;
          }),
        ].join("\n"),
        resultType: "success" as const,
      };
    },
  });

  const waitTool = defineTool("wait", {
    description: "Wait N seconds.",
    parameters: z.object({ seconds: z.number().min(1).max(60) }),
    handler: async (args: { seconds: number }) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      const ss = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      return {
        textResultForLlm: `Waited ${args.seconds}s.`,
        resultType: "success" as const,
        binaryResultsForLlm: [{ data: ss.data, mimeType: "image/png", type: "image" as const }],
      };
    },
  });

  return [screenshotTool, findTool, clickTool, pasteTool, typeTool, readTool, waitTool] as Tool<any>[];
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

  const browserTools = createRecoveryBrowserTools(cdp, page);

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
