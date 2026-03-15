/**
 * Phase G — Supervisor agent session + Repair agent session
 *
 * Supervisor: Minimal intervention. Checks script result, verifies with screenshot.
 * Repair: Vision + strong reasoning to fix broken selectors.
 */

import type { CDPSession, Page } from "puppeteer-core";
import { z } from "zod";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import {
  type UIMap,
  type ScriptResult,
  type SelectorPatch,
  formatLogForAgent,
  captureScreenshot,
  screenshotResult,
  textResult,
  createEventLogger,
  dispatchClick,
  dispatchPaste,
  dispatchType,
} from "./phase-g-shared.js";

const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

// =============================================================================
// Browser tools for fallback (subset of phase-f tools)
// =============================================================================

function createBrowserTools(cdp: CDPSession, page: Page): Tool[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => screenshotResult(await captureScreenshot(cdp)),
  });

  const findTool = defineTool("find", {
    description: "Find interactive elements by text/aria-label/placeholder. Returns coordinates.",
    parameters: z.object({ query: z.string().describe("Text to search for") }),
    handler: async (args) => {
      const results = await page.evaluate((q: string) => {
        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const matches: Array<{
          tag: string; text: string; ariaLabel: string | null;
          disabled: boolean; center: { x: number; y: number };
          rect: { x: number; y: number; w: number; h: number };
        }> = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label") ?? "";
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (text.includes(q) || ariaLabel.includes(q) || el.getAttribute("placeholder")?.includes(q)) {
            matches.push({
              tag: el.tagName, text: text.slice(0, 80),
              ariaLabel: el.getAttribute("aria-label"),
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
        `[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})`,
      ).join("\n"));
    },
  });

  const clickTool = defineTool("click", {
    description: "Click at coordinates. Use find() first.",
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
    description: `Read DOM via CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources).`,
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

// =============================================================================
// Supervisor Session — Minimum intervention
// =============================================================================

export interface SupervisorResult {
  verdict: "pass" | "fallback" | "escalate";
  answer: string | null;
  toolCalls: number;
  durationMs: number;
}

export async function runSupervisorSession(
  client: CopilotClient,
  cdp: CDPSession,
  page: Page,
  scriptResult: ScriptResult,
  model?: string,
): Promise<SupervisorResult> {
  const t0 = Date.now();
  let capturedVerdict: SupervisorResult["verdict"] = "escalate";
  let capturedAnswer: string | null = scriptResult.result;

  // Tools for supervisor
  const browserTools = createBrowserTools(cdp, page);

  const submitVerdictTool = defineTool("submitVerdict", {
    description: "Submit your verdict on the script result. Use after verification.",
    parameters: z.object({
      verdict: z.enum(["pass", "fallback", "escalate"]).describe(
        "pass: script succeeded, result confirmed. fallback: partially failed, you completed remaining steps. escalate: cannot fix, need repair agent.",
      ),
      answer: z.string().optional().describe("The final answer or result text (if available)"),
      note: z.string().optional().describe("Brief note on what you observed"),
    }),
    handler: async (args) => {
      capturedVerdict = args.verdict;
      if (args.answer) capturedAnswer = args.answer;
      return textResult(`Verdict accepted: ${args.verdict}`);
    },
  });

  const allTools = [...browserTools, submitVerdictTool] as Tool[];

  // Build prompt with script result
  const formattedLog = formatLogForAgent(scriptResult.log);

  const supervisorSystemMessage = `你是 NotebookLM 操作的監督者。你收到一個腳本自動操作的結果，需要驗證。

## 規則

1. **status=success**：先用 screenshot 截圖驗證畫面正確，確認結果，呼叫 submitVerdict(verdict="pass")
2. **status=partial**：用 browser tools (find, click, paste, read) 完成剩餘步驟，然後 submitVerdict(verdict="fallback")
3. **status=fail**：回報失敗詳情，呼叫 submitVerdict(verdict="escalate")

**最少介入原則**：不要重複做腳本已成功的步驟。success 時只需 1 次截圖驗證。

## 重要：工具限制
你只能使用以下 tools：screenshot, find, click, paste, type, read, wait, submitVerdict
**禁止使用** bash, view, edit, grep 等任何其他內建工具。`;

  const userPrompt = `## 腳本執行結果

operation: ${scriptResult.operation}
status: ${scriptResult.status}
totalMs: ${scriptResult.totalMs}
${scriptResult.result ? `result: ${scriptResult.result.slice(0, 500)}` : "result: null"}
${scriptResult.failedAtStep ? `failedAtStep: ${scriptResult.failedAtStep}` : ""}
${scriptResult.failedSelector ? `failedSelector: ${scriptResult.failedSelector}` : ""}

## 執行 Log

${formattedLog}

請先用 screenshot 截圖查看當前畫面，然後驗證並提交 verdict。`;

  const logger = createEventLogger("Supervisor");

  console.log("\n[phase-g] ====== Supervisor Session ======");

  const session = await client.createSession({
    tools: allTools,
    ...(model ? { model } : {}),
    systemMessage: { mode: "append" as const, content: supervisorSystemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);

  await session.sendAndWait({ prompt: userPrompt }, SESSION_TIMEOUT_MS);

  await session.disconnect();

  const result: SupervisorResult = {
    verdict: capturedVerdict,
    answer: capturedAnswer,
    toolCalls: logger.toolCallCount,
    durationMs: Date.now() - t0,
  };

  console.log(`[phase-g] Supervisor done: ${result.verdict} (${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls} tool calls)`);

  return result;
}

// =============================================================================
// Repair Session — Selector fix agent
// =============================================================================

export interface RepairResult {
  patch: SelectorPatch | null;
  toolCalls: number;
  durationMs: number;
}

export async function runRepairSession(
  client: CopilotClient,
  cdp: CDPSession,
  page: Page,
  scriptResult: ScriptResult,
  uiMap: UIMap,
  model?: string,
): Promise<RepairResult> {
  const t0 = Date.now();
  let capturedPatch: SelectorPatch | null = null;

  const submitRepairTool = defineTool("submitRepair", {
    description: "Submit a selector/text repair patch.",
    parameters: z.object({
      elementKey: z.string().describe("The UIMap key to fix (e.g., 'chat_input', 'answer')"),
      oldValue: z.string().describe("The current broken value"),
      newValue: z.string().describe("The corrected value"),
      confidence: z.number().min(0).max(1).describe("Confidence in the fix (0-1)"),
      reasoning: z.string().describe("Why this fix should work"),
    }),
    handler: async (args) => {
      capturedPatch = {
        elementKey: args.elementKey,
        oldValue: args.oldValue,
        newValue: args.newValue,
        confidence: args.confidence,
        reasoning: args.reasoning,
      };
      return textResult(`Repair patch accepted: ${args.elementKey} "${args.oldValue}" → "${args.newValue}"`);
    },
  });

  // Repair agent also gets find + read + screenshot for DOM inspection
  const inspectTools: Tool[] = [
    defineTool("screenshot", {
      description: "Capture a screenshot of the current browser tab.",
      parameters: z.object({}),
      handler: async () => screenshotResult(await captureScreenshot(cdp)),
    }),
    defineTool("find", {
      description: "Find interactive elements by text/aria-label/placeholder. Returns coordinates and metadata.",
      parameters: z.object({ query: z.string().describe("Text to search for") }),
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
            center: { x: number; y: number };
          }> = [];
          for (const el of document.querySelectorAll(INTERACTIVE)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none") continue;
            const text = el.textContent?.trim() ?? "";
            const ariaLabel = el.getAttribute("aria-label");
            const placeholder = el.getAttribute("placeholder");
            if (text.includes(q) || ariaLabel?.includes(q) || placeholder?.includes(q) || q === "*") {
              matches.push({
                tag: el.tagName, text: text.slice(0, 80),
                ariaLabel, placeholder,
                center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              });
            }
          }
          return matches;
        }, args.query);
        if (results.length === 0) return textResult(`No elements found for: "${args.query}"`);
        return textResult(results.map((r) =>
          `[${r.tag}] text="${r.text}" aria="${r.ariaLabel ?? ""}" placeholder="${r.placeholder ?? ""}" → (${r.center.x}, ${r.center.y})`,
        ).join("\n"));
      },
    }),
    defineTool("read", {
      description: "Read DOM via CSS selector.",
      parameters: z.object({ selector: z.string() }),
      handler: async (args) => {
        const result = await page.evaluate((sel: string) => {
          const els = document.querySelectorAll(sel);
          if (els.length === 0) return { count: 0, items: [] as Array<{ tag: string; text: string }> };
          return {
            count: els.length,
            items: Array.from(els).map((el) => ({
              tag: el.tagName,
              text: (el.textContent?.trim() ?? "").slice(0, 300),
            })),
          };
        }, args.selector);
        if (result.count === 0) return textResult(`(no match for "${args.selector}")`);
        return textResult(result.items.map((item, i) => `[${i + 1}] ${item.tag}: ${item.text}`).join("\n"));
      },
    }),
  ] as Tool[];

  const allTools = [...inspectTools, submitRepairTool] as Tool[];

  // Build full context for repair
  const formattedLog = formatLogForAgent(scriptResult.log);

  // Serialize UIMap for repair agent to see full mapping
  const uiMapSummary = [
    "## UIMap Elements",
    ...Object.entries(uiMap.elements).map(([k, v]) =>
      `  ${k}: text="${v.text}" match=${v.match ?? "text"} ${v.disambiguate ? `disambiguate="${v.disambiguate}"` : ""}`,
    ),
    "",
    "## UIMap Selectors",
    ...Object.entries(uiMap.selectors).map(([k, v]) => `  ${k}: "${v}"`),
  ].join("\n");

  const repairSystemMessage = `你是 NotebookLM 的 selector 修復專家。一個自動化腳本因為 UI 元素找不到而失敗。
你的任務是分析截圖和 DOM，找出正確的 selector/text 值，提交修復 patch。

## 你的工具

- screenshot: 截圖看畫面
- find: 用 text/aria-label/placeholder 搜尋互動元素（用 "*" 列出所有元素）
- read: 用 CSS selector 讀取 DOM
- submitRepair: 提交修復 patch

## 修復流程

1. 先用 screenshot 截圖看畫面
2. 用 find("*") 列出所有可互動元素
3. 比對失敗的 selector 和當前 DOM
4. 找到正確的 text/selector 值
5. 呼叫 submitRepair 提交修復

## 重要

- 只修復失敗的那個 selector，不要改其他的
- confidence 要誠實評估
- 如果 find 找不到對應元素，可能是畫面狀態不對（不在正確頁面），confidence 設低

## 重要：工具限制
**禁止使用** bash, view, edit, grep 等任何其他內建工具。`;

  const userPrompt = `## 失敗的腳本 Log

operation: ${scriptResult.operation}
failedAtStep: ${scriptResult.failedAtStep}
failedSelector: ${scriptResult.failedSelector}

${formattedLog}

## 完整 UIMap

${uiMapSummary}

## 截圖已附上

請分析並提交修復 patch。`;

  const logger = createEventLogger("Repair");

  console.log("\n[phase-g] ====== Repair Session ======");
  console.log(`[phase-g] Failed selector: ${scriptResult.failedSelector}`);

  const session = await client.createSession({
    tools: allTools,
    ...(model ? { model } : {}),
    systemMessage: { mode: "append" as const, content: repairSystemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);

  await session.sendAndWait({ prompt: userPrompt }, SESSION_TIMEOUT_MS);

  await session.disconnect();

  const result: RepairResult = {
    patch: capturedPatch,
    toolCalls: logger.toolCallCount,
    durationMs: Date.now() - t0,
  };

  console.log(`[phase-g] Repair done: ${capturedPatch ? `patch=${capturedPatch.elementKey}` : "no patch"} (${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls} tool calls)`);

  return result;
}

// =============================================================================
// Apply patch to UIMap (in-memory)
// =============================================================================

export function applyPatch(uiMap: UIMap, patch: SelectorPatch): UIMap {
  const patched: UIMap = JSON.parse(JSON.stringify(uiMap));

  if (patched.elements[patch.elementKey]) {
    patched.elements[patch.elementKey].text = patch.newValue;
    console.log(`[phase-g] Patch applied: elements.${patch.elementKey}.text = "${patch.newValue}"`);
  } else if (patched.selectors[patch.elementKey]) {
    patched.selectors[patch.elementKey] = patch.newValue;
    console.log(`[phase-g] Patch applied: selectors.${patch.elementKey} = "${patch.newValue}"`);
  } else {
    console.warn(`[phase-g] Patch target not found: ${patch.elementKey}`);
  }

  return patched;
}
