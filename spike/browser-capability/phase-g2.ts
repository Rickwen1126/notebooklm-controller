/**
 * Phase G2 — Script + Recovery-on-fail Spike
 *
 * Happy path: Script success → return immediately (0 LLM cost)
 * Failure:    Recovery session (GPT-5-mini reasoning model) →
 *             ① complete task with browser tools
 *             ② analyze failure cause
 *             ③ output error log with suggestedPatch
 *
 * Usage:
 *   npx tsx spike/browser-capability/phase-g2.ts "問題"                       # query
 *   npx tsx spike/browser-capability/phase-g2.ts --add-source "內容"          # addSource
 *   npx tsx spike/browser-capability/phase-g2.ts --corrupt chat_input "問題"  # test recovery
 *   npx tsx spike/browser-capability/phase-g2.ts --test                       # full test suite
 */

import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type UIMap,
  type ScriptResult,
  connectToChrome,
  resolveLocale,
  loadUIMap,
  corruptUIMap,
  formatLogForAgent,
  captureScreenshot,
  dispatchClick,
  dispatchPaste,
  dispatchType,
  screenshotResult,
  textResult,
  createEventLogger,
} from "./phase-g-shared.js";
import { scriptedQuery, scriptedAddSource } from "./phase-g-scripts.js";

// =============================================================================
// Config
// =============================================================================

const RECOVERY_MODEL = "gpt-5-mini"; // Reasoning model, free
const RECOVERY_TIMEOUT_MS = 2 * 60 * 1000; // 2 min — fail fast, don't loop
const REPAIR_LOGS_DIR = join(homedir(), ".nbctl", "repair-logs");

// =============================================================================
// Error Log types
// =============================================================================

interface RepairLog {
  operation: string;
  failedAtStep: number | null;
  failedSelector: string | null;
  uiMapValue: Record<string, unknown> | null;
  scriptLog: ScriptResult["log"];
  recovery: {
    success: boolean;
    model: string;
    toolCalls: number;
    durationMs: number;
    result: string | null;
    analysis: string | null;
    toolCallLog: RecoveryToolCall[];
    agentMessages: string[];
    finalScreenshotPath: string | null;
  };
  suggestedPatch: {
    elementKey: string;
    oldValue: string;
    newValue: string;
    confidence: number;
  } | null;
  timestamp: string;
}

// =============================================================================
// Recovery Session — completion + analysis in one session
// =============================================================================

interface RecoveryToolCall {
  tool: string;
  input: string;   // truncated
  output: string;  // truncated
}

interface RecoveryResult {
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

function createBrowserTools(cdp: any, page: any): Tool[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => screenshotResult(await captureScreenshot(cdp)),
  });

  const findTool = defineTool("find", {
    description: "Find interactive elements by text/aria-label/placeholder. Returns coordinates. Use '*' to list all.",
    parameters: z.object({ query: z.string().describe("Text to search for, or '*' for all") }),
    handler: async (args) => {
      const results = await page.evaluate((q: string) => {
        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const matches: Array<{
          tag: string; text: string; ariaLabel: string | null; placeholder: string | null;
          disabled: boolean; center: { x: number; y: number };
          rect: { x: number; y: number; w: number; h: number };
        }> = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label");
          const placeholder = el.getAttribute("placeholder");
          if (q === "*" || text.includes(q) || ariaLabel?.includes(q) || placeholder?.includes(q)) {
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
      }, args.query);
      if (results.length === 0) return textResult(`No elements found for: "${args.query}"`);
      return textResult(results.map((r) =>
        `[${r.tag}] text="${r.text}" aria="${r.ariaLabel ?? ""}" placeholder="${r.placeholder ?? ""}"${r.disabled ? " DISABLED" : ""} → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})`,
      ).join("\n"));
    },
  });

  const clickTool = defineTool("click", {
    description: "Click at coordinates. Use find() first to get coordinates.",
    parameters: z.object({ x: z.number(), y: z.number() }),
    handler: async (args) => {
      await dispatchClick(cdp, args.x, args.y);
      await new Promise((r) => setTimeout(r, 500));
      return screenshotResult(await captureScreenshot(cdp), `Clicked at (${args.x}, ${args.y}).`);
    },
  });

  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position.",
    parameters: z.object({ text: z.string() }),
    handler: async (args) => {
      await dispatchPaste(cdp, args.text);
      return textResult(`Pasted ${args.text.length} chars.`);
    },
  });

  const typeTool = defineTool("type", {
    description: "Type text or special keys (Escape, Enter, Tab, Ctrl+A).",
    parameters: z.object({ text: z.string() }),
    handler: async (args) => {
      await dispatchType(cdp, page, args.text);
      return textResult(`Typed: "${args.text}"`);
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM elements by CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources).`,
    parameters: z.object({ selector: z.string() }),
    handler: async (args) => {
      const result = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return { count: 0, items: [] as Array<{ tag: string; text: string; visible: boolean }> };
        return {
          count: els.length,
          items: Array.from(els).map((el) => ({
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 500),
            visible: getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none",
          })),
        };
      }, args.selector);
      if (result.count === 0) return textResult(`(no match for "${args.selector}")`);
      return textResult(
        [`Found ${result.count} element(s):`,
          ...result.items.map((item, i) => {
            const vis = item.visible ? "" : " (HIDDEN)";
            return `[${i + 1}] ${item.tag}${vis}: ${item.text.slice(0, 200)}${item.text.length > 200 ? "..." : ""}`;
          }),
        ].join("\n"),
      );
    },
  });

  const waitTool = defineTool("wait", {
    description: "Wait N seconds.",
    parameters: z.object({ seconds: z.number().min(1).max(60) }),
    handler: async (args) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      return screenshotResult(await captureScreenshot(cdp), `Waited ${args.seconds}s.`);
    },
  });

  return [screenshotTool, findTool, clickTool, pasteTool, typeTool, readTool, waitTool] as Tool[];
}

async function runRecoverySession(
  client: CopilotClient,
  cdp: any,
  page: any,
  scriptResult: ScriptResult,
  goal: string,
): Promise<RecoveryResult> {
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
    handler: async (args) => {
      capturedResult = args.result ?? null;
      capturedAnalysis = args.analysis;
      capturedPatch = args.suggestedPatch ?? null;
      return textResult("Result submitted.");
    },
  });

  const allTools = [...browserTools, submitResultTool] as Tool[];

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

  const logger = createEventLogger("Recovery");
  const toolCallLog: RecoveryToolCall[] = [];
  const agentMessages: string[] = [];

  console.log("\n[g2] ====== Recovery Session (GPT-5-mini) ======");
  console.log(`[g2] Failed at step ${scriptResult.failedAtStep}: ${scriptResult.failedSelector}`);

  const session = await client.createSession({
    tools: allTools,
    model: RECOVERY_MODEL,
    systemMessage: { mode: "append" as const, content: systemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  // Capture structured tool call log + agent messages for repair context.
  // SDK types (from session-events.d.ts):
  //   tool.execution_start:    { toolCallId, toolName, arguments? }
  //   tool.execution_complete: { toolCallId, success, result?: { content } }
  //   assistant.message:       { content }
  const pendingByCallId = new Map<string, { tool: string; input: string }>();

  session.on((event) => {
    if (event.type === "tool.execution_start") {
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
  session.on(logger.handler);

  await session.sendAndWait({ prompt: userPrompt }, RECOVERY_TIMEOUT_MS);
  await session.disconnect();

  // On failure: take a final screenshot for repair context
  let finalScreenshot: string | null = null;
  if (capturedResult === null) {
    try {
      finalScreenshot = await captureScreenshot(cdp);
    } catch { /* ignore */ }
  }

  const result: RecoveryResult = {
    success: capturedResult !== null,
    result: capturedResult,
    analysis: capturedAnalysis,
    suggestedPatch: capturedPatch,
    toolCalls: logger.toolCallCount,
    toolCallLog,
    agentMessages,
    finalScreenshot,
    durationMs: Date.now() - t0,
  };

  console.log(`[g2] Recovery: ${result.success ? "SUCCESS" : "FAILED"} (${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls} tool calls)`);
  if (result.analysis) console.log(`[g2] Analysis: ${result.analysis.slice(0, 200)}`);
  if (result.suggestedPatch) console.log(`[g2] Patch: ${result.suggestedPatch.elementKey} "${result.suggestedPatch.oldValue}" → "${result.suggestedPatch.newValue}" (confidence: ${result.suggestedPatch.confidence})`);

  return result;
}

// =============================================================================
// Save repair log
// =============================================================================

function saveRepairLog(
  scriptResult: ScriptResult,
  uiMap: UIMap,
  recovery: RecoveryResult,
): string {
  mkdirSync(REPAIR_LOGS_DIR, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${ts}_${scriptResult.operation}_${scriptResult.failedSelector ?? "unknown"}.json`;
  const filepath = join(REPAIR_LOGS_DIR, filename);

  // Look up the UIMap value for the failed selector
  let uiMapValue: Record<string, unknown> | null = null;
  if (scriptResult.failedSelector) {
    const el = uiMap.elements[scriptResult.failedSelector];
    const sel = uiMap.selectors[scriptResult.failedSelector];
    if (el) uiMapValue = { ...el };
    else if (sel) uiMapValue = { selector: sel };
  }

  // Save final screenshot as separate file (too large for JSON)
  let finalScreenshotPath: string | null = null;
  if (recovery.finalScreenshot) {
    finalScreenshotPath = filepath.replace(".json", ".png");
    writeFileSync(finalScreenshotPath, Buffer.from(recovery.finalScreenshot, "base64"));
  }

  const log: RepairLog = {
    operation: scriptResult.operation,
    failedAtStep: scriptResult.failedAtStep,
    failedSelector: scriptResult.failedSelector,
    uiMapValue,
    scriptLog: scriptResult.log,
    recovery: {
      success: recovery.success,
      model: RECOVERY_MODEL,
      toolCalls: recovery.toolCalls,
      durationMs: recovery.durationMs,
      result: recovery.result?.slice(0, 1000) ?? null,
      analysis: recovery.analysis,
      toolCallLog: recovery.toolCallLog,
      agentMessages: recovery.agentMessages,
      finalScreenshotPath: finalScreenshotPath ? finalScreenshotPath.split("/").pop()! : null,
    },
    suggestedPatch: recovery.suggestedPatch,
    timestamp: now.toISOString(),
  };

  writeFileSync(filepath, JSON.stringify(log, null, 2));
  console.log(`[g2] Repair log saved: ${filepath}`);
  if (finalScreenshotPath) console.log(`[g2] Final screenshot: ${finalScreenshotPath}`);
  return filepath;
}

// =============================================================================
// Pipeline: Script → (success? return : recovery)
// =============================================================================

interface PipelineResult {
  source: "script" | "recovery" | "failed";
  result: string | null;
  scriptResult: ScriptResult;
  recovery: RecoveryResult | null;
  repairLogPath: string | null;
  totalMs: number;
  breakdown: {
    scriptMs: number;
    recoveryMs: number;
  };
}

async function runPipeline(
  client: CopilotClient,
  cdp: any,
  page: any,
  uiMap: UIMap,
  operation: "query" | "addSource",
  input: string,
): Promise<PipelineResult> {
  const t0 = Date.now();
  const breakdown = { scriptMs: 0, recoveryMs: 0 };

  // Step 1: Run deterministic script
  console.log(`\n[g2] ====== Script: ${operation} ======`);
  const scriptT0 = Date.now();
  const scriptResult = operation === "query"
    ? await scriptedQuery(cdp, page, uiMap, input)
    : await scriptedAddSource(cdp, page, uiMap, input);
  breakdown.scriptMs = Date.now() - scriptT0;

  console.log(`[g2] Script: ${scriptResult.status} (${(breakdown.scriptMs / 1000).toFixed(1)}s)`);
  console.log(formatLogForAgent(scriptResult.log));

  // Happy path: script succeeded → return immediately, 0 LLM cost
  if (scriptResult.status === "success") {
    console.log(`[g2] ✓ Happy path — returning directly (0 LLM cost)`);
    return {
      source: "script",
      result: scriptResult.result,
      scriptResult,
      recovery: null,
      repairLogPath: null,
      totalMs: Date.now() - t0,
      breakdown,
    };
  }

  // Failure path: recovery session
  const goal = operation === "query"
    ? `向 NotebookLM 提問：「${input}」，然後取得回答文字。`
    : `在 NotebookLM 新增一個文字來源，內容為：「${input.slice(0, 200)}」`;

  const recoveryT0 = Date.now();
  const recovery = await runRecoverySession(client, cdp, page, scriptResult, goal);
  breakdown.recoveryMs = Date.now() - recoveryT0;

  // Save error log (regardless of recovery success)
  const repairLogPath = saveRepairLog(scriptResult, uiMap, recovery);

  return {
    source: recovery.success ? "recovery" : "failed",
    result: recovery.result,
    scriptResult,
    recovery,
    repairLogPath,
    totalMs: Date.now() - t0,
    breakdown,
  };
}

// =============================================================================
// Test suite
// =============================================================================

interface TestCase {
  id: string;
  description: string;
  run: (client: CopilotClient, cdp: any, page: any, uiMap: UIMap) => Promise<{
    status: "PASS" | "FAIL";
    detail: string;
    durationMs: number;
  }>;
}

function buildTestSuite(): TestCase[] {
  const defaultQuestion = "TypeScript 的型別系統有哪些核心特性？";
  const defaultSource = "React 是一個用於構建用戶界面的 JavaScript 函式庫。它採用組件化設計，支援虛擬 DOM 和單向資料流。";

  return [
    // G2-01: Happy path query — script success, 0 LLM
    {
      id: "G2-01", description: "happy path query (0 LLM cost)",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const result = await runPipeline(client, cdp, page, uiMap, "query", defaultQuestion);
        const isHappy = result.source === "script" && result.recovery === null;
        return {
          status: isHappy && result.result ? "PASS" : "FAIL",
          detail: `source=${result.source}, LLM=${result.recovery ? "yes" : "no"}, ${(result.totalMs / 1000).toFixed(1)}s. Answer: ${(result.result ?? "null").slice(0, 80)}`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G2-02: Happy path addSource — script success, 0 LLM
    {
      id: "G2-02", description: "happy path addSource (0 LLM cost)",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const result = await runPipeline(client, cdp, page, uiMap, "addSource", defaultSource);
        const isHappy = result.source === "script" && result.recovery === null;
        return {
          status: isHappy ? "PASS" : "FAIL",
          detail: `source=${result.source}, LLM=${result.recovery ? "yes" : "no"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G2-03: Corrupt chat_input → recovery completes task + produces error log
    {
      id: "G2-03", description: "corrupt chat_input → recovery completes + error log",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const { corrupted } = corruptUIMap(uiMap, "chat_input");
        const result = await runPipeline(client, cdp, page, corrupted, "query", defaultQuestion);
        const hasLog = result.repairLogPath !== null;
        const recovered = result.source === "recovery" && result.result !== null;
        return {
          status: recovered && hasLog ? "PASS" : "FAIL",
          detail: `source=${result.source}, errorLog=${hasLog}, recovery=${result.recovery?.success}, patch=${result.recovery?.suggestedPatch ? "yes" : "no"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G2-04: Corrupt submit_button → verify error log format + suggestedPatch
    {
      id: "G2-04", description: "corrupt submit_button → error log format + patch",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const { corrupted } = corruptUIMap(uiMap, "submit_button");
        const result = await runPipeline(client, cdp, page, corrupted, "query", defaultQuestion);
        const hasLog = result.repairLogPath !== null;

        // Verify log file is valid JSON with expected fields
        let logValid = false;
        if (result.repairLogPath) {
          try {
            const { readFileSync } = await import("node:fs");
            const log: RepairLog = JSON.parse(readFileSync(result.repairLogPath, "utf-8"));
            logValid = !!(
              log.operation === "query" &&
              log.failedSelector === "submit_button" &&
              log.scriptLog.length > 0 &&
              log.recovery.model === RECOVERY_MODEL &&
              log.recovery.analysis &&
              log.timestamp
            );
          } catch { /* ignore */ }
        }

        return {
          status: hasLog && logValid ? "PASS" : "FAIL",
          detail: `errorLog=${hasLog}, logValid=${logValid}, patch=${result.recovery?.suggestedPatch ? `"${result.recovery.suggestedPatch.newValue}" (${result.recovery.suggestedPatch.confidence})` : "none"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G2-05: Happy path speed — confirm no LLM overhead
    {
      id: "G2-05", description: "happy path speed (3 runs, no LLM)",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const times: number[] = [];

        for (let i = 0; i < 3; i++) {
          console.log(`\n[g2] === Speed run ${i + 1}/3 ===`);
          const result = await runPipeline(client, cdp, page, uiMap, "query", defaultQuestion);
          if (result.source !== "script") {
            return {
              status: "FAIL",
              detail: `Run ${i + 1} went to recovery (not happy path)`,
              durationMs: Date.now() - t0,
            };
          }
          times.push(result.totalMs);
          await new Promise((r) => setTimeout(r, 2000));
        }

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        return {
          status: "PASS",
          detail: `Runs: ${times.map(t => `${(t / 1000).toFixed(1)}s`).join(", ")} (avg ${(avg / 1000).toFixed(1)}s). All 0 LLM.`,
          durationMs: Date.now() - t0,
        };
      },
    },
  ];
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  let mode: "query" | "addsource" | "corrupt" | "test" = "query";
  let corruptKey = "";
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-source") {
      mode = "addsource";
    } else if (args[i] === "--corrupt") {
      mode = "corrupt";
      corruptKey = args[++i] ?? "chat_input";
    } else if (args[i] === "--test") {
      mode = "test";
    } else {
      remaining.push(args[i]);
    }
  }
  const input = remaining.join(" ");

  if (!input && mode !== "test") {
    console.log(`Phase G2 — Script + Recovery-on-fail

Usage:
  npx tsx spike/browser-capability/phase-g2.ts "question"                       # query (happy path)
  npx tsx spike/browser-capability/phase-g2.ts --add-source "content"           # addSource (happy path)
  npx tsx spike/browser-capability/phase-g2.ts --corrupt chat_input "question"  # test recovery
  npx tsx spike/browser-capability/phase-g2.ts --test                           # full test suite

Tests:
  G2-01: Happy path query (0 LLM cost)
  G2-02: Happy path addSource (0 LLM cost)
  G2-03: Corrupt chat_input → recovery completes + error log
  G2-04: Corrupt submit_button → error log format + patch
  G2-05: Happy path speed (3 runs, no LLM)

Prerequisites:
  - Chrome running on port 9222 (npx tsx spike/browser-capability/experiment.ts launch)
  - NotebookLM tab open with at least 1 source`);
    process.exit(0);
  }

  // Connect
  console.log("[g2] Connecting to Chrome...");
  const { browser, page, cdp } = await connectToChrome();
  console.log(`[g2] Connected: ${page.url()}`);

  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);
  console.log(`[g2] Locale: ${locale}`);

  const client = new CopilotClient({ autoStart: false, autoRestart: false });

  try {
    await client.start();
    console.log("[g2] CopilotClient started");

    switch (mode) {
      case "query": {
        const result = await runPipeline(client, cdp, page, uiMap, "query", input);
        printResult(result);
        break;
      }

      case "addsource": {
        const result = await runPipeline(client, cdp, page, uiMap, "addSource", input);
        printResult(result);
        break;
      }

      case "corrupt": {
        console.log(`[g2] Corrupting UIMap key: ${corruptKey}`);
        const { corrupted } = corruptUIMap(uiMap, corruptKey);
        const result = await runPipeline(client, cdp, page, corrupted, "query", input);
        printResult(result);
        break;
      }

      case "test": {
        const suite = buildTestSuite();
        const results: Array<{ id: string; description: string; status: string; detail: string; durationMs: number }> = [];

        console.log(`\n${"=".repeat(60)}`);
        console.log(`  PHASE G2 TEST SUITE — ${suite.length} tests`);
        console.log(`${"=".repeat(60)}\n`);

        // Get notebook URL for state reset between tests
        const notebookUrl = page.url();

        for (const test of suite) {
          // Reset page state: navigate to notebook URL to clear any leftover state
          console.log(`\n[g2] Resetting page state...`);
          await page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
          await new Promise((r) => setTimeout(r, 2000));

          console.log(`\n${"─".repeat(60)}`);
          console.log(`  ${test.id}: ${test.description}`);
          console.log(`${"─".repeat(60)}`);

          try {
            const result = await test.run(client, cdp, page, uiMap);
            results.push({ id: test.id, description: test.description, ...result });
            console.log(`\n  [${result.status}] ${test.id} (${(result.durationMs / 1000).toFixed(1)}s)`);
            console.log(`  ${result.detail}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ id: test.id, description: test.description, status: "FAIL", detail: msg, durationMs: 0 });
            console.error(`\n  [FAIL] ${test.id}: ${msg}`);
          }
        }

        // Summary
        const passed = results.filter((r) => r.status === "PASS").length;
        console.log(`\n${"=".repeat(60)}`);
        console.log(`  RESULTS: ${passed}/${results.length} PASS`);
        console.log(`${"=".repeat(60)}`);
        console.log("");
        console.log("| ID    | Description                | Status | Duration | Detail |");
        console.log("|-------|----------------------------|--------|----------|--------|");
        for (const r of results) {
          console.log(`| ${r.id.padEnd(5)} | ${r.description.slice(0, 26).padEnd(26)} | ${r.status.padEnd(6)} | ${(r.durationMs / 1000).toFixed(1).padStart(6)}s | ${r.detail.slice(0, 60)} |`);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[g2] Error: ${err instanceof Error ? err.message : err}`);
    console.error(err);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) console.error("[g2] Client errors:", errors.map((e) => e.message));
    browser.disconnect();
    console.log("\n[g2] Done");
  }
}

function printResult(result: PipelineResult): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RESULT`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Source:    ${result.source}`);
  console.log(`  Script:    ${result.scriptResult.status} (${(result.breakdown.scriptMs / 1000).toFixed(1)}s)`);
  if (result.recovery) {
    console.log(`  Recovery:  ${result.recovery.success ? "SUCCESS" : "FAILED"} (${(result.breakdown.recoveryMs / 1000).toFixed(1)}s, ${result.recovery.toolCalls} tool calls)`);
    if (result.recovery.analysis) {
      console.log(`  Analysis:  ${result.recovery.analysis.slice(0, 200)}`);
    }
    if (result.recovery.suggestedPatch) {
      const p = result.recovery.suggestedPatch;
      console.log(`  Patch:     ${p.elementKey} "${p.oldValue}" → "${p.newValue}" (confidence: ${p.confidence})`);
    }
  }
  console.log(`  Total:     ${(result.totalMs / 1000).toFixed(1)}s`);
  if (result.result) {
    console.log(`  Answer:    ${result.result.slice(0, 200)}`);
  }
  if (result.repairLogPath) {
    console.log(`  Error log: ${result.repairLogPath}`);
  }
  console.log(`${"=".repeat(60)}`);
}

main();
