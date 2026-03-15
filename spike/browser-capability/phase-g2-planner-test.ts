/**
 * Phase G2 — NL Planner + Script pipeline integration test
 *
 * Tests natural language → Planner → Script(s) → Result flow.
 * Single-step and multi-step composite operations.
 *
 * Usage:
 *   npx tsx spike/browser-capability/phase-g2-planner-test.ts
 */

import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { z } from "zod";
import type { CDPSession, Page } from "puppeteer-core";
import {
  type UIMap,
  type ScriptResult,
  connectToChrome,
  resolveLocale,
  loadUIMap,
  formatLogForAgent,
  createEventLogger,
  textResult,
} from "./phase-g-shared.js";
import {
  scriptedQuery,
  scriptedAddSource,
  scriptedListSources,
  scriptedRemoveSource,
  scriptedRenameSource,
  scriptedClearChat,
  scriptedListNotebooks,
  scriptedCreateNotebook,
  scriptedRenameNotebook,
  scriptedDeleteNotebook,
} from "./phase-g-scripts.js";

// =============================================================================
// Config
// =============================================================================

const PLANNER_MODEL = "gpt-4.1";
const PLANNER_TIMEOUT_MS = 60_000;

// =============================================================================
// Planner types
// =============================================================================

type OperationType =
  | "query" | "addSource" | "listSources"
  | "removeSource" | "renameSource" | "clearChat"
  | "listNotebooks" | "createNotebook" | "renameNotebook" | "deleteNotebook";

interface PlannerStep {
  operation: OperationType;
  params: Record<string, string>;
}

// =============================================================================
// Planner session — NL → structured steps
// =============================================================================

async function runPlanner(
  client: CopilotClient,
  userPrompt: string,
): Promise<{ steps: PlannerStep[]; durationMs: number }> {
  let capturedSteps: PlannerStep[] | null = null;
  const t0 = Date.now();

  const submitPlanTool = defineTool("submitPlan", {
    description: "Submit the parsed operation steps.",
    parameters: z.object({
      steps: z.array(z.object({
        operation: z.enum([
          "query", "addSource", "listSources",
          "removeSource", "renameSource", "clearChat",
          "listNotebooks", "createNotebook", "renameNotebook", "deleteNotebook",
        ]).describe("Which script to run"),
        question: z.string().optional().describe("For query: the question text"),
        content: z.string().optional().describe("For addSource: the source content"),
        newName: z.string().optional().describe("For renameSource/renameNotebook: the new name"),
      })),
    }),
    handler: async (args) => {
      capturedSteps = args.steps.map((s) => ({
        operation: s.operation as OperationType,
        params: {
          ...(s.question ? { question: s.question } : {}),
          ...(s.content ? { content: s.content } : {}),
          ...(s.newName ? { newName: s.newName } : {}),
        },
      }));
      return textResult(`Plan accepted: ${args.steps.length} step(s)`);
    },
  });

  const rejectInputTool = defineTool("rejectInput", {
    description: "Reject invalid/unsupported input with user-facing message.",
    parameters: z.object({
      reason: z.enum(["off_topic", "ambiguous", "missing_params", "unsupported", "dangerous_bulk"]),
      userMessage: z.string().describe("User-facing explanation in the user's language"),
    }),
    handler: async (args) => {
      return textResult(`Rejected: [${args.reason}] ${args.userMessage}`);
    },
  });

  const systemMessage = `你是 NotebookLM 控制器的 Planner。分析使用者的自然語言指令，拆解成操作步驟。

## 可用操作

| 操作 | 參數 | 說明 |
|------|------|------|
| query | question | 向 NotebookLM 提問 |
| addSource | content | 加入文字來源 |
| listSources | (無) | 列出所有來源 |
| removeSource | (無) | 移除第一個來源 |
| renameSource | newName | 重命名第一個來源 |
| clearChat | (無) | 清除對話記錄 |
| listNotebooks | (無) | 列出所有筆記本 |
| createNotebook | (無) | 建立新筆記本 |
| renameNotebook | newName | 重命名第一個筆記本 |
| deleteNotebook | (無) | 刪除第一個筆記本 |

## 規則

1. 單一操作 → 1 個 step
2. 複合操作 → 多個 steps，按邏輯順序
3. params 必須從使用者指令中提取，不可自行編造
4. 呼叫 submitPlan 提交結果
5. 如果指令不明確、缺少參數、不支援、或危險（批量刪除），呼叫 rejectInput`;

  const logger = createEventLogger("Planner");
  console.log(`\n[planner] ====== Planner Session ======`);
  console.log(`[planner] Input: "${userPrompt}"`);

  const session = await client.createSession({
    tools: [submitPlanTool, rejectInputTool] as Tool[],
    model: PLANNER_MODEL,
    systemMessage: { mode: "append" as const, content: systemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);
  await session.sendAndWait({ prompt: userPrompt }, PLANNER_TIMEOUT_MS);
  await session.disconnect();

  const durationMs = Date.now() - t0;
  console.log(`[planner] Done: ${(durationMs / 1000).toFixed(1)}s, ${capturedSteps?.length ?? 0} step(s)`);

  if (!capturedSteps) {
    throw new Error("Planner did not submit steps (might have rejected input)");
  }

  return { steps: capturedSteps, durationMs };
}

// =============================================================================
// Script dispatcher — runs the correct script for each step
// =============================================================================

async function runStep(
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  step: PlannerStep,
): Promise<ScriptResult> {
  switch (step.operation) {
    case "query":
      return scriptedQuery(cdp, page, uiMap, step.params.question ?? "");
    case "addSource":
      return scriptedAddSource(cdp, page, uiMap, step.params.content ?? "");
    case "listSources":
      return scriptedListSources(cdp, page, uiMap);
    case "removeSource":
      return scriptedRemoveSource(cdp, page, uiMap);
    case "renameSource":
      return scriptedRenameSource(cdp, page, uiMap, step.params.newName ?? "Renamed");
    case "clearChat":
      return scriptedClearChat(cdp, page, uiMap);
    case "listNotebooks":
      return scriptedListNotebooks(cdp, page, uiMap);
    case "createNotebook":
      return scriptedCreateNotebook(cdp, page, uiMap);
    case "renameNotebook":
      return scriptedRenameNotebook(cdp, page, uiMap, step.params.newName ?? "Renamed");
    case "deleteNotebook":
      return scriptedDeleteNotebook(cdp, page, uiMap);
    default:
      throw new Error(`Unknown operation: ${step.operation}`);
  }
}

// =============================================================================
// Test cases
// =============================================================================

interface TestCase {
  id: string;
  description: string;
  prompt: string;
  expectedSteps: number;
  expectedOps: OperationType[];
  shouldReject?: boolean;
}

const testCases: TestCase[] = [
  // Single-step operations
  {
    id: "P01", description: "single query",
    prompt: "問 NotebookLM：TypeScript 是什麼？",
    expectedSteps: 1, expectedOps: ["query"],
  },
  {
    id: "P02", description: "single listSources",
    prompt: "列出這個筆記本的所有來源",
    expectedSteps: 1, expectedOps: ["listSources"],
  },
  {
    id: "P03", description: "single addSource",
    prompt: "加入以下文字來源：「React 是一個前端 UI 框架，由 Meta 開發。」",
    expectedSteps: 1, expectedOps: ["addSource"],
  },
  {
    id: "P04", description: "single clearChat",
    prompt: "清除對話記錄",
    expectedSteps: 1, expectedOps: ["clearChat"],
  },
  // Multi-step composite
  {
    id: "P05", description: "addSource + query (2 steps)",
    prompt: "加入文字來源「Vue 是漸進式 JavaScript 框架」，然後問 NotebookLM：Vue 的核心特性是什麼？",
    expectedSteps: 2, expectedOps: ["addSource", "query"],
  },
  {
    id: "P06", description: "query + clearChat (2 steps)",
    prompt: "先問 TypeScript 的優點，然後清除對話記錄",
    expectedSteps: 2, expectedOps: ["query", "clearChat"],
  },
  {
    id: "P07", description: "addSource + listSources (2 steps)",
    prompt: "加入文字來源「測試內容」，然後列出所有來源確認",
    expectedSteps: 2, expectedOps: ["addSource", "listSources"],
  },
  // Rejection cases
  {
    id: "P08", description: "reject off-topic",
    prompt: "幫我寫一個 Python 程式",
    expectedSteps: 0, expectedOps: [], shouldReject: true,
  },
  {
    id: "P09", description: "reject ambiguous",
    prompt: "處理一下",
    expectedSteps: 0, expectedOps: [], shouldReject: true,
  },
  {
    id: "P10", description: "reject dangerous bulk",
    prompt: "刪除所有筆記本",
    expectedSteps: 0, expectedOps: [], shouldReject: true,
  },
];

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("[g2-planner] Connecting to Chrome...");
  const { browser, page, cdp } = await connectToChrome();
  console.log(`[g2-planner] Connected: ${page.url()}`);

  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);

  const client = new CopilotClient({ autoStart: false, autoRestart: false });
  await client.start();
  console.log("[g2-planner] CopilotClient started");

  const results: Array<{
    id: string; desc: string; status: string;
    plannerMs: number; execMs: number;
    steps: PlannerStep[];
    detail: string;
  }> = [];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  NL PLANNER TEST — ${testCases.length} tests`);
  console.log(`${"=".repeat(60)}\n`);

  for (const test of testCases) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${test.id}: ${test.description}`);
    console.log(`  Prompt: "${test.prompt}"`);
    console.log(`${"─".repeat(60)}`);

    try {
      if (test.shouldReject) {
        // Expect planner to reject
        try {
          const plan = await runPlanner(client, test.prompt);
          // If we get here, planner accepted when it should have rejected
          results.push({
            id: test.id, desc: test.description, status: "FAIL",
            plannerMs: plan.durationMs, execMs: 0, steps: plan.steps,
            detail: `Expected rejection but got ${plan.steps.length} step(s)`,
          });
          console.log(`\n  [FAIL] ${test.id} — Expected rejection, got plan`);
        } catch (err) {
          // Good — planner rejected (threw because capturedSteps is null)
          results.push({
            id: test.id, desc: test.description, status: "PASS",
            plannerMs: 0, execMs: 0, steps: [],
            detail: `Correctly rejected`,
          });
          console.log(`\n  [PASS] ${test.id} — Correctly rejected`);
        }
        continue;
      }

      // Normal case: expect plan + execution
      const plan = await runPlanner(client, test.prompt);

      // Verify step count and operations
      const opsMatch = plan.steps.length === test.expectedSteps &&
        plan.steps.every((s, i) => s.operation === test.expectedOps[i]);

      if (!opsMatch) {
        const got = plan.steps.map((s) => s.operation).join(" → ");
        const expected = test.expectedOps.join(" → ");
        results.push({
          id: test.id, desc: test.description, status: "FAIL",
          plannerMs: plan.durationMs, execMs: 0, steps: plan.steps,
          detail: `Plan mismatch: expected [${expected}], got [${got}]`,
        });
        console.log(`\n  [FAIL] ${test.id} — Plan mismatch: expected [${expected}], got [${got}]`);
        continue;
      }

      // Execute each step
      const execT0 = Date.now();
      let allPass = true;
      const stepResults: string[] = [];

      for (const [i, step] of plan.steps.entries()) {
        console.log(`\n[g2-planner] === Executing step ${i + 1}/${plan.steps.length}: ${step.operation} ===`);
        const result = await runStep(cdp, page, uiMap, step);
        console.log(formatLogForAgent(result.log));

        if (result.status !== "success") {
          allPass = false;
          stepResults.push(`${step.operation}: FAIL at step ${result.failedAtStep}`);
          console.log(`  Step ${i + 1} FAILED at ${result.failedAtStep}: ${result.failedSelector}`);
          break; // Stop on first failure
        } else {
          stepResults.push(`${step.operation}: OK`);
          console.log(`  Step ${i + 1} OK (${(result.totalMs / 1000).toFixed(1)}s)`);
        }

        // Brief settle between steps
        await new Promise((r) => setTimeout(r, 1500));
      }

      const execMs = Date.now() - execT0;
      results.push({
        id: test.id, desc: test.description,
        status: allPass ? "PASS" : "FAIL",
        plannerMs: plan.durationMs, execMs,
        steps: plan.steps,
        detail: stepResults.join(", "),
      });
      console.log(`\n  [${allPass ? "PASS" : "FAIL"}] ${test.id} (planner=${(plan.durationMs / 1000).toFixed(1)}s, exec=${(execMs / 1000).toFixed(1)}s)`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        id: test.id, desc: test.description, status: "ERROR",
        plannerMs: 0, execMs: 0, steps: [],
        detail: msg,
      });
      console.error(`\n  [ERROR] ${test.id}: ${msg}`);
    }

    // Settle between tests
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Summary
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  RESULTS: ${passed}/${results.length} PASS`);
  console.log(`${"=".repeat(70)}`);
  console.log("");
  console.log("| ID   | Description              | Status | Planner | Exec   | Detail |");
  console.log("|------|--------------------------|--------|---------|--------|--------|");
  for (const r of results) {
    console.log(`| ${r.id.padEnd(4)} | ${r.desc.slice(0, 24).padEnd(24)} | ${r.status.padEnd(6)} | ${(r.plannerMs / 1000).toFixed(1).padStart(5)}s | ${(r.execMs / 1000).toFixed(1).padStart(5)}s | ${r.detail.slice(0, 40)} |`);
  }

  const errors = await client.stop();
  if (errors.length > 0) console.error("[g2-planner] Client errors:", errors.map((e) => e.message));
  browser.disconnect();
  console.log("\n[g2-planner] Done");
}

main().catch((err) => {
  console.error(`[g2-planner] Fatal: ${err}`);
  process.exit(1);
});
