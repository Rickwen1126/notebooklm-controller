/**
 * Phase G — Script-first + Agent-as-supervisor Spike
 *
 * Deterministic scripts handle happy path (3-phase polling + structured log).
 * Agent only does supervision/verification/fallback.
 * Repair agent fixes broken selectors when needed.
 *
 * Usage:
 *   # Direct dispatch (typed tool mode, zero Planner)
 *   npx tsx spike/browser-capability/phase-g.ts "問題"
 *   npx tsx spike/browser-capability/phase-g.ts --add-source "內容文字"
 *
 *   # Planner dispatch (NL mode)
 *   npx tsx spike/browser-capability/phase-g.ts --nl "問 NotebookLM xxx"
 *   npx tsx spike/browser-capability/phase-g.ts --nl "加來源再問問題"
 *
 *   # Test modes
 *   npx tsx spike/browser-capability/phase-g.ts --corrupt answer "問題"
 *   npx tsx spike/browser-capability/phase-g.ts --compare "問題"
 *   npx tsx spike/browser-capability/phase-g.ts --test
 */

import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { z } from "zod";
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
import {
  runSupervisorSession,
  runRepairSession,
  applyPatch,
} from "./phase-g-supervisor.js";

// =============================================================================
// Config
// =============================================================================

const SUPERVISOR_MODEL = "gpt-4.1";
const REPAIR_MODEL = "gpt-4.1"; // Plan says gpt-5.4, fallback to gpt-4.1 if unavailable
const PLANNER_MODEL = "gpt-4.1";

// =============================================================================
// Full pipeline: Script → Supervisor → (Repair → Retry) if needed
// =============================================================================

interface PipelineResult {
  scriptResult: ScriptResult;
  supervisorVerdict: "pass" | "fallback" | "escalate" | "skipped";
  repairApplied: boolean;
  retryResult: ScriptResult | null;
  finalAnswer: string | null;
  totalMs: number;
  breakdown: {
    scriptMs: number;
    supervisorMs: number;
    repairMs: number;
    retryMs: number;
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
  const breakdown = { scriptMs: 0, supervisorMs: 0, repairMs: 0, retryMs: 0 };

  // Step 1: Run deterministic script
  console.log(`\n[phase-g] ====== Script: ${operation} ======`);
  const scriptT0 = Date.now();
  const scriptResult = operation === "query"
    ? await scriptedQuery(cdp, page, uiMap, input)
    : await scriptedAddSource(cdp, page, uiMap, input);
  breakdown.scriptMs = Date.now() - scriptT0;

  console.log(`[phase-g] Script: ${scriptResult.status} (${(breakdown.scriptMs / 1000).toFixed(1)}s)`);
  console.log(formatLogForAgent(scriptResult.log));

  // Step 2: Supervisor verification
  const supervisorT0 = Date.now();
  const supervisorResult = await runSupervisorSession(client, cdp, page, scriptResult, SUPERVISOR_MODEL);
  breakdown.supervisorMs = Date.now() - supervisorT0;

  let finalAnswer = supervisorResult.answer;
  let repairApplied = false;
  let retryResult: ScriptResult | null = null;

  // Step 3: If escalate → Repair → Retry
  if (supervisorResult.verdict === "escalate" && scriptResult.failedSelector) {
    console.log(`\n[phase-g] Escalating to Repair agent for: ${scriptResult.failedSelector}`);

    const repairT0 = Date.now();
    const repairResult = await runRepairSession(client, cdp, page, scriptResult, uiMap, REPAIR_MODEL);
    breakdown.repairMs = Date.now() - repairT0;

    if (repairResult.patch && repairResult.patch.confidence >= 0.5) {
      console.log(`[phase-g] Repair patch: ${repairResult.patch.elementKey} "${repairResult.patch.oldValue}" → "${repairResult.patch.newValue}" (confidence: ${repairResult.patch.confidence})`);

      // Apply patch in-memory and retry
      const patchedUIMap = applyPatch(uiMap, repairResult.patch);
      repairApplied = true;

      const retryT0 = Date.now();
      retryResult = operation === "query"
        ? await scriptedQuery(cdp, page, patchedUIMap, input)
        : await scriptedAddSource(cdp, page, patchedUIMap, input);
      breakdown.retryMs = Date.now() - retryT0;

      console.log(`[phase-g] Retry: ${retryResult.status} (${(breakdown.retryMs / 1000).toFixed(1)}s)`);

      if (retryResult.status === "success") {
        finalAnswer = retryResult.result;
      }
    } else {
      console.log(`[phase-g] Repair: ${repairResult.patch ? `low confidence (${repairResult.patch.confidence})` : "no patch produced"}`);
    }
  }

  return {
    scriptResult,
    supervisorVerdict: supervisorResult.verdict,
    repairApplied,
    retryResult,
    finalAnswer,
    totalMs: Date.now() - t0,
    breakdown,
  };
}

// =============================================================================
// Planner dispatch (NL mode)
// =============================================================================

interface PlannerStep {
  operation: "query" | "addSource";
  input: string;
}

async function runPlannerDispatch(
  client: CopilotClient,
  userPrompt: string,
): Promise<PlannerStep[]> {
  let capturedSteps: PlannerStep[] | null = null;

  const submitStepsTool = defineTool("submitSteps", {
    description: "Submit the parsed operation steps.",
    parameters: z.object({
      reasoning: z.string(),
      steps: z.array(z.object({
        operation: z.enum(["query", "addSource"]).describe("Which script to run"),
        input: z.string().describe("The question text or source content"),
      })),
    }),
    handler: async (args) => {
      capturedSteps = args.steps;
      return textResult(`Steps accepted: ${args.steps.length}`);
    },
  });

  const plannerSystemMessage = `你是 NotebookLM 控制器的 Planner。分析使用者的自然語言指令，拆解成操作步驟。

## 可用操作

1. **query** — 向 NotebookLM 提問。input = 問題文字。
2. **addSource** — 加入文字來源。input = 來源內容文字。

## 規則

1. 單一操作 → 1 個 step
2. 複合操作（如「加來源再問問題」）→ 多個 steps，按順序
3. input 必須明確，不能含糊
4. 呼叫 submitSteps 提交結果`;

  const logger = createEventLogger("Planner");
  console.log("\n[phase-g] ====== Planner Session ======");
  const t0 = Date.now();

  const session = await client.createSession({
    tools: [submitStepsTool] as Tool[],
    model: PLANNER_MODEL,
    systemMessage: { mode: "append" as const, content: plannerSystemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);
  await session.sendAndWait({ prompt: userPrompt }, 60_000);
  await session.disconnect();

  const plannerMs = Date.now() - t0;
  console.log(`[phase-g] Planner done: ${(plannerMs / 1000).toFixed(1)}s`);

  if (!capturedSteps) {
    throw new Error("Planner did not submit steps");
  }

  for (const [i, step] of capturedSteps.entries()) {
    console.log(`[phase-g]   Step ${i + 1}: ${step.operation}("${step.input.slice(0, 80)}")`);
  }

  return capturedSteps;
}

// =============================================================================
// Phase F pure-agent baseline (for comparison)
// =============================================================================

async function runPhaseFBaseline(
  client: CopilotClient,
  cdp: any,
  page: any,
  question: string,
): Promise<{ answer: string | null; durationMs: number; toolCalls: number }> {
  const browserTools = createFullBrowserTools(cdp, page);

  const logger = createEventLogger("PhaseF-Baseline");
  const t0 = Date.now();

  const systemMessage = `你是 NotebookLM 操作員。使用 browser tools 完成以下操作。

## 操作步驟（query）

1. 用 find 找到聊天輸入框（placeholder "開始輸入"）
2. 用 click 點擊輸入框
3. 用 paste 貼上問題
4. 用 find 找到提交按鈕（文字 "提交"，y > 400 區分）
5. 用 click 點擊提交
6. 用 wait 等待 3-5 秒
7. 用 read 讀取 ".to-user-container .message-content" 取得答案
8. 如果答案還在生成（包含 "Thinking"），再 wait + read
9. 確認答案穩定後回報

## 重要：工具限制
你只能使用 screenshot, find, click, paste, type, read, wait。
**禁止使用** bash, view, edit, grep 等任何其他內建工具。`;

  const session = await client.createSession({
    tools: browserTools,
    model: SUPERVISOR_MODEL,
    systemMessage: { mode: "append" as const, content: systemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);

  const response = await session.sendAndWait(
    { prompt: `向 NotebookLM 提問：${question}` },
    3 * 60 * 1000,
  );

  await session.disconnect();

  return {
    answer: response?.data?.content ?? null,
    durationMs: Date.now() - t0,
    toolCalls: logger.toolCallCount,
  };
}

// Duplicate browser tools for baseline (can't import from phase-f easily)
function createFullBrowserTools(cdp: any, page: any): Tool[] {
  return [
    defineTool("screenshot", {
      description: "Capture a screenshot.",
      parameters: z.object({}),
      handler: async () => screenshotResult(await captureScreenshot(cdp)),
    }),
    defineTool("find", {
      description: "Find interactive elements by text/aria-label/placeholder.",
      parameters: z.object({ query: z.string() }),
      handler: async (args: { query: string }) => {
        const results = await page.evaluate((q: string) => {
          const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=combobox], [tabindex]:not([tabindex='-1']), [contenteditable]";
          const matches: Array<{ tag: string; text: string; center: { x: number; y: number } }> = [];
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
                center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              });
            }
          }
          return matches;
        }, args.query);
        if (results.length === 0) return textResult(`No elements found for: "${args.query}"`);
        return textResult(results.map(r => `[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})`).join("\n"));
      },
    }),
    defineTool("click", {
      description: "Click at coordinates.",
      parameters: z.object({ x: z.number(), y: z.number() }),
      handler: async (args: { x: number; y: number }) => {
        await dispatchClick(cdp, args.x, args.y);
        await new Promise(r => setTimeout(r, 500));
        return screenshotResult(await captureScreenshot(cdp), `Clicked at (${args.x}, ${args.y}).`);
      },
    }),
    defineTool("paste", {
      description: "Paste text at cursor.",
      parameters: z.object({ text: z.string() }),
      handler: async (args: { text: string }) => {
        await dispatchPaste(cdp, args.text);
        return textResult(`Pasted ${args.text.length} chars.`);
      },
    }),
    defineTool("type", {
      description: "Type text or special keys.",
      parameters: z.object({ text: z.string() }),
      handler: async (args: { text: string }) => {
        await dispatchType(cdp, page, args.text);
        return textResult(`Typed: "${args.text}"`);
      },
    }),
    defineTool("read", {
      description: "Read DOM via CSS selector.",
      parameters: z.object({ selector: z.string() }),
      handler: async (args: { selector: string }) => {
        const result = await page.evaluate((sel: string) => {
          const els = document.querySelectorAll(sel);
          if (els.length === 0) return { count: 0, items: [] as Array<{ tag: string; text: string }> };
          return { count: els.length, items: Array.from(els).map(el => ({ tag: el.tagName, text: (el.textContent?.trim() ?? "").slice(0, 500) })) };
        }, args.selector);
        if (result.count === 0) return textResult(`(no match for "${args.selector}")`);
        return textResult(result.items.map((item: { tag: string; text: string }, i: number) => `[${i + 1}] ${item.tag}: ${item.text.slice(0, 200)}`).join("\n"));
      },
    }),
    defineTool("wait", {
      description: "Wait N seconds.",
      parameters: z.object({ seconds: z.number().min(1).max(60) }),
      handler: async (args: { seconds: number }) => {
        await new Promise(r => setTimeout(r, args.seconds * 1000));
        return screenshotResult(await captureScreenshot(cdp), `Waited ${args.seconds}s.`);
      },
    }),
  ] as Tool[];
}

// =============================================================================
// Test suite
// =============================================================================

interface TestCase {
  id: string;
  type: "normal" | "broken" | "compare" | "nl-single" | "nl-composite" | "dispatch-compare";
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
    // G01: Normal query speed
    {
      id: "G01", type: "normal", description: "scriptedQuery speed test",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const result = await runPipeline(client, cdp, page, uiMap, "query", defaultQuestion);
        return {
          status: result.finalAnswer ? "PASS" : "FAIL",
          detail: `${(result.totalMs / 1000).toFixed(1)}s total (script=${(result.breakdown.scriptMs / 1000).toFixed(1)}s, supervisor=${(result.breakdown.supervisorMs / 1000).toFixed(1)}s). Answer: ${(result.finalAnswer ?? "null").slice(0, 100)}`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G02: Normal addSource speed
    {
      id: "G02", type: "normal", description: "scriptedAddSource speed test",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const result = await runPipeline(client, cdp, page, uiMap, "addSource", defaultSource);
        return {
          status: result.scriptResult.status === "success" ? "PASS" : "FAIL",
          detail: `${(result.totalMs / 1000).toFixed(1)}s total (script=${(result.breakdown.scriptMs / 1000).toFixed(1)}s, supervisor=${(result.breakdown.supervisorMs / 1000).toFixed(1)}s)`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G03: Corrupt answer selector → repair → retry
    {
      id: "G03", type: "broken", description: "corrupt answer selector → repair → retry",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const { corrupted } = corruptUIMap(uiMap, "answer");
        const result = await runPipeline(client, cdp, page, corrupted, "query", defaultQuestion);
        return {
          status: result.repairApplied && result.retryResult?.status === "success" ? "PASS" : "FAIL",
          detail: `repair=${result.repairApplied}, retry=${result.retryResult?.status ?? "none"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G04: Corrupt chat_input → repair → retry
    {
      id: "G04", type: "broken", description: "corrupt chat_input → repair → retry",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const { corrupted } = corruptUIMap(uiMap, "chat_input");
        const result = await runPipeline(client, cdp, page, corrupted, "query", defaultQuestion);
        return {
          status: result.repairApplied && result.retryResult?.status === "success" ? "PASS" : "FAIL",
          detail: `repair=${result.repairApplied}, retry=${result.retryResult?.status ?? "none"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G05: Corrupt submit_button → repair → retry
    {
      id: "G05", type: "broken", description: "corrupt submit_button → repair → retry",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const { corrupted } = corruptUIMap(uiMap, "submit_button");
        const result = await runPipeline(client, cdp, page, corrupted, "query", defaultQuestion);
        return {
          status: result.repairApplied && result.retryResult?.status === "success" ? "PASS" : "FAIL",
          detail: `repair=${result.repairApplied}, retry=${result.retryResult?.status ?? "none"}, ${(result.totalMs / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G06: Compare script vs phase-f pure agent (3 runs)
    {
      id: "G06", type: "compare", description: "direct script vs phase-f pure agent (3 runs)",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const scriptTimes: number[] = [];
        const agentTimes: number[] = [];

        for (let i = 0; i < 3; i++) {
          console.log(`\n[phase-g] === Compare run ${i + 1}/3: Script ===`);
          const scriptResult = await runPipeline(client, cdp, page, uiMap, "query", defaultQuestion);
          scriptTimes.push(scriptResult.totalMs);

          // Wait for UI to settle between runs
          await new Promise((r) => setTimeout(r, 2000));

          console.log(`\n[phase-g] === Compare run ${i + 1}/3: Pure Agent ===`);
          const agentResult = await runPhaseFBaseline(client, cdp, page, defaultQuestion);
          agentTimes.push(agentResult.durationMs);

          await new Promise((r) => setTimeout(r, 2000));
        }

        const avgScript = scriptTimes.reduce((a, b) => a + b, 0) / scriptTimes.length;
        const avgAgent = agentTimes.reduce((a, b) => a + b, 0) / agentTimes.length;
        const speedup = avgAgent / avgScript;

        const detail = [
          `Script: ${scriptTimes.map(t => `${(t / 1000).toFixed(1)}s`).join(", ")} (avg ${(avgScript / 1000).toFixed(1)}s)`,
          `Agent:  ${agentTimes.map(t => `${(t / 1000).toFixed(1)}s`).join(", ")} (avg ${(avgAgent / 1000).toFixed(1)}s)`,
          `Speedup: ${speedup.toFixed(1)}x`,
        ].join("\n");

        return { status: "PASS", detail, durationMs: Date.now() - t0 };
      },
    },
    // G07: Planner dispatch single step
    {
      id: "G07", type: "nl-single", description: "Planner dispatch: single query",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const steps = await runPlannerDispatch(client, `問 NotebookLM：${defaultQuestion}`);
        if (steps.length !== 1 || steps[0].operation !== "query") {
          return { status: "FAIL", detail: `Expected 1 query step, got ${steps.length} steps: ${JSON.stringify(steps)}`, durationMs: Date.now() - t0 };
        }
        const result = await runPipeline(client, cdp, page, uiMap, steps[0].operation, steps[0].input);
        return {
          status: result.finalAnswer ? "PASS" : "FAIL",
          detail: `Planner → ${steps.length} step(s). Pipeline: ${(result.totalMs / 1000).toFixed(1)}s. Answer: ${(result.finalAnswer ?? "null").slice(0, 80)}`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G08: Planner dispatch composite
    {
      id: "G08", type: "nl-composite", description: "Planner dispatch: addSource + query",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();
        const steps = await runPlannerDispatch(client, `加入以下來源：「${defaultSource}」，然後問 NotebookLM：React 的核心特性是什麼？`);
        if (steps.length < 2) {
          return { status: "FAIL", detail: `Expected 2+ steps, got ${steps.length}: ${JSON.stringify(steps)}`, durationMs: Date.now() - t0 };
        }
        const results: PipelineResult[] = [];
        for (const step of steps) {
          const result = await runPipeline(client, cdp, page, uiMap, step.operation, step.input);
          results.push(result);
        }
        const lastResult = results[results.length - 1];
        return {
          status: lastResult.finalAnswer ? "PASS" : "FAIL",
          detail: `Planner → ${steps.length} steps. Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
          durationMs: Date.now() - t0,
        };
      },
    },
    // G09: Direct vs Planner dispatch speed comparison
    {
      id: "G09", type: "dispatch-compare", description: "direct vs planner dispatch speed",
      run: async (client, cdp, page, uiMap) => {
        const t0 = Date.now();

        // Direct dispatch
        console.log("\n[phase-g] === Direct dispatch ===");
        const directT0 = Date.now();
        const directResult = await runPipeline(client, cdp, page, uiMap, "query", defaultQuestion);
        const directMs = Date.now() - directT0;

        await new Promise((r) => setTimeout(r, 2000));

        // Planner dispatch
        console.log("\n[phase-g] === Planner dispatch ===");
        const plannerT0 = Date.now();
        const steps = await runPlannerDispatch(client, `問 NotebookLM：${defaultQuestion}`);
        const plannerResult = await runPipeline(client, cdp, page, uiMap, steps[0].operation, steps[0].input);
        const plannerMs = Date.now() - plannerT0;

        const overhead = plannerMs - directMs;

        return {
          status: "PASS",
          detail: `Direct: ${(directMs / 1000).toFixed(1)}s | Planner: ${(plannerMs / 1000).toFixed(1)}s | Overhead: ${(overhead / 1000).toFixed(1)}s`,
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

  // Parse flags
  let mode: "direct-query" | "direct-addsource" | "nl" | "corrupt" | "compare" | "test" = "direct-query";
  let corruptKey = "";
  let input = "";

  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-source") {
      mode = "direct-addsource";
    } else if (args[i] === "--nl") {
      mode = "nl";
    } else if (args[i] === "--corrupt") {
      mode = "corrupt";
      corruptKey = args[++i] ?? "answer";
    } else if (args[i] === "--compare") {
      mode = "compare";
    } else if (args[i] === "--test") {
      mode = "test";
    } else {
      remaining.push(args[i]);
    }
  }
  input = remaining.join(" ");

  if (!input && mode !== "test") {
    console.log(`Phase G — Script-first + Agent-as-supervisor

Usage:
  npx tsx spike/browser-capability/phase-g.ts "question"                      # direct scriptedQuery
  npx tsx spike/browser-capability/phase-g.ts --add-source "content"          # direct scriptedAddSource
  npx tsx spike/browser-capability/phase-g.ts --nl "NL instruction"           # Planner dispatch
  npx tsx spike/browser-capability/phase-g.ts --corrupt answer "question"     # broken selector test
  npx tsx spike/browser-capability/phase-g.ts --compare "question"            # direct vs phase-f
  npx tsx spike/browser-capability/phase-g.ts --test                          # full test suite

Tests:
  G01: scriptedQuery speed
  G02: scriptedAddSource speed
  G03: corrupt answer → repair → retry
  G04: corrupt chat_input → repair → retry
  G05: corrupt submit_button → repair → retry
  G06: direct script vs phase-f pure agent (3 runs)
  G07: Planner dispatch single step
  G08: Planner dispatch composite (addSource + query)
  G09: direct vs planner dispatch speed comparison

Prerequisites:
  - Chrome running on port 9222
  - NotebookLM tab open`);
    process.exit(0);
  }

  // Connect to Chrome
  console.log("[phase-g] Connecting to Chrome...");
  const { browser, page, cdp } = await connectToChrome();
  console.log(`[phase-g] Connected: ${page.url()}`);

  // Load UI map
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);
  console.log(`[phase-g] Locale: ${locale}`);

  // Start CopilotClient
  const client = new CopilotClient({ autoStart: false, autoRestart: false });

  try {
    await client.start();
    console.log("[phase-g] CopilotClient started");

    switch (mode) {
      case "direct-query": {
        const result = await runPipeline(client, cdp, page, uiMap, "query", input);
        printPipelineResult(result, "direct-query");
        break;
      }

      case "direct-addsource": {
        const result = await runPipeline(client, cdp, page, uiMap, "addSource", input);
        printPipelineResult(result, "direct-addsource");
        break;
      }

      case "nl": {
        const steps = await runPlannerDispatch(client, input);
        for (const [i, step] of steps.entries()) {
          console.log(`\n[phase-g] ====== Pipeline Step ${i + 1}/${steps.length}: ${step.operation} ======`);
          const result = await runPipeline(client, cdp, page, uiMap, step.operation, step.input);
          printPipelineResult(result, `nl-step-${i + 1}`);
        }
        break;
      }

      case "corrupt": {
        console.log(`[phase-g] Corrupting UIMap key: ${corruptKey}`);
        const { corrupted } = corruptUIMap(uiMap, corruptKey);
        const result = await runPipeline(client, cdp, page, corrupted, "query", input);
        printPipelineResult(result, `corrupt-${corruptKey}`);
        break;
      }

      case "compare": {
        // Script-first pipeline
        console.log("\n[phase-g] ====== Script-first Pipeline ======");
        const scriptResult = await runPipeline(client, cdp, page, uiMap, "query", input);

        await new Promise((r) => setTimeout(r, 2000));

        // Phase-F pure agent baseline
        console.log("\n[phase-g] ====== Phase-F Pure Agent Baseline ======");
        const agentResult = await runPhaseFBaseline(client, cdp, page, input);

        console.log(`\n${"=".repeat(60)}`);
        console.log("  COMPARISON");
        console.log(`${"=".repeat(60)}`);
        console.log(`  Script-first: ${(scriptResult.totalMs / 1000).toFixed(1)}s`);
        console.log(`    Script:     ${(scriptResult.breakdown.scriptMs / 1000).toFixed(1)}s`);
        console.log(`    Supervisor: ${(scriptResult.breakdown.supervisorMs / 1000).toFixed(1)}s`);
        console.log(`  Pure Agent:   ${(agentResult.durationMs / 1000).toFixed(1)}s (${agentResult.toolCalls} tool calls)`);
        console.log(`  Speedup:      ${(agentResult.durationMs / scriptResult.totalMs).toFixed(1)}x`);
        console.log(`${"=".repeat(60)}`);
        break;
      }

      case "test": {
        const suite = buildTestSuite();
        const results: Array<{ id: string; description: string; status: string; detail: string; durationMs: number }> = [];

        console.log(`\n${"=".repeat(60)}`);
        console.log(`  PHASE G TEST SUITE — ${suite.length} tests`);
        console.log(`${"=".repeat(60)}\n`);

        for (const test of suite) {
          console.log(`\n${"─".repeat(60)}`);
          console.log(`  ${test.id}: ${test.description}`);
          console.log(`${"─".repeat(60)}`);

          try {
            const result = await test.run(client, cdp, page, uiMap);
            results.push({ id: test.id, description: test.description, ...result });
            const icon = result.status === "PASS" ? "PASS" : "FAIL";
            console.log(`\n  [${icon}] ${test.id} (${(result.durationMs / 1000).toFixed(1)}s)`);
            console.log(`  ${result.detail}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ id: test.id, description: test.description, status: "FAIL", detail: msg, durationMs: 0 });
            console.error(`\n  [FAIL] ${test.id}: ${msg}`);
          }

          // Settle between tests
          await new Promise((r) => setTimeout(r, 2000));
        }

        // Summary table
        const passed = results.filter((r) => r.status === "PASS").length;
        console.log(`\n${"=".repeat(60)}`);
        console.log(`  RESULTS: ${passed}/${results.length} PASS`);
        console.log(`${"=".repeat(60)}`);
        console.log("");
        console.log("| ID   | Type      | Status | Duration | Detail |");
        console.log("|------|-----------|--------|----------|--------|");
        for (const r of results) {
          console.log(`| ${r.id} | ${r.description.slice(0, 25).padEnd(25)} | ${r.status.padEnd(6)} | ${(r.durationMs / 1000).toFixed(1).padStart(6)}s | ${r.detail.slice(0, 60)} |`);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[phase-g] Error: ${err instanceof Error ? err.message : err}`);
    console.error(err);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) console.error("[phase-g] Client errors:", errors.map((e) => e.message));
    browser.disconnect();
    console.log("\n[phase-g] Done");
  }
}

function printPipelineResult(result: PipelineResult, label: string): void {
  console.log(`\n[phase-g] ====== ${label} Result ======`);
  console.log(`[phase-g] Script:     ${result.scriptResult.status} (${(result.breakdown.scriptMs / 1000).toFixed(1)}s)`);
  console.log(`[phase-g] Supervisor: ${result.supervisorVerdict} (${(result.breakdown.supervisorMs / 1000).toFixed(1)}s)`);
  if (result.repairApplied) {
    console.log(`[phase-g] Repair:     applied (${(result.breakdown.repairMs / 1000).toFixed(1)}s)`);
    console.log(`[phase-g] Retry:      ${result.retryResult?.status ?? "none"} (${(result.breakdown.retryMs / 1000).toFixed(1)}s)`);
  }
  console.log(`[phase-g] Total:      ${(result.totalMs / 1000).toFixed(1)}s`);
  if (result.finalAnswer) {
    console.log(`[phase-g] Answer:     ${result.finalAnswer.slice(0, 200)}`);
  }
}

main();
