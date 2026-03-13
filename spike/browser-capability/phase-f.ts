/**
 * Phase F — Two-Session Planner + Executor
 *
 * 驗證雙 session 架構：
 *   Session 1 (Planner): 無 browser tools，純意圖解析 + prompt 組裝
 *   Session 2 (Executor): 帶 browser tools，執行結構化操作
 *
 * Usage:
 *   npx tsx spike/browser-capability/phase-f.ts "列出這個筆記本的來源"
 *   npx tsx spike/browser-capability/phase-f.ts "幫我問一個問題：TypeScript 的優勢是什麼？"
 *   npx tsx spike/browser-capability/phase-f.ts "加一段文字來源然後問問題"
 *   npx tsx spike/browser-capability/phase-f.ts --model gpt-4.1 "列出所有來源"
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool, ToolResultObject, SessionEvent } from "@github/copilot-sdk";

// =============================================================================
// Config
// =============================================================================

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");
const UI_MAPS_DIR = join(import.meta.dirname, "ui-maps");
const AGENTS_DIR = join(import.meta.dirname, "../../agents");
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;

// =============================================================================
// UI Map (same as phase-e)
// =============================================================================

interface UIMap {
  locale: string;
  verified: boolean;
  elements: Record<string, { text: string; match?: string; disambiguate?: string }>;
  selectors: Record<string, string>;
}

function resolveLocale(browserLang: string): string {
  if (browserLang.startsWith("zh-TW") || browserLang.includes("Hant")) return "zh-TW";
  if (browserLang.startsWith("zh")) return "zh-CN";
  return "en";
}

function loadUIMap(locale: string): UIMap {
  const filepath = join(UI_MAPS_DIR, `${locale}.json`);
  if (!existsSync(filepath)) {
    return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8"));
  }
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

// =============================================================================
// Agent Config Loader (same as phase-e)
// =============================================================================

interface ParsedAgent {
  name: string;
  displayName: string;
  description: string;
  tools: string[];
  prompt: string;
  parametersSchema: Record<string, { type: string; description: string; default?: string }>;
}

function parseYamlFrontmatter(content: string): { yaml: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { yaml: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const yaml: Record<string, unknown> = {};
  const lines = yamlStr.split("\n");
  let currentKey = "";
  let currentList: string[] | null = null;
  let inNestedBlock = false;
  const nestedBlock: Record<string, Record<string, unknown>> = {};
  let nestedKey = "";
  let nestedSubKey = "";

  for (const line of lines) {
    if (line.startsWith("#")) continue;

    // Detect nested block start (parameters:)
    if (line.match(/^parameters:\s*$/) || (line.match(/^parameters:/) && line.trim().endsWith("{}"))) {
      if (line.trim().endsWith("{}")) {
        yaml["parameters"] = {};
        continue;
      }
      inNestedBlock = true;
      nestedKey = "parameters";
      nestedBlock[nestedKey] = {};
      continue;
    }

    // Inside nested block (parameters)
    if (inNestedBlock) {
      // Top-level key in nested block (e.g., "  question:")
      const nestedTopMatch = line.match(/^  (\w+):\s*$/);
      if (nestedTopMatch) {
        nestedSubKey = nestedTopMatch[1];
        (nestedBlock[nestedKey] as Record<string, unknown>)[nestedSubKey] = {};
        continue;
      }
      // Nested key-value (e.g., "    type: string")
      const nestedKvMatch = line.match(/^\s{4,}(\w+):\s*(.+)$/);
      if (nestedKvMatch) {
        const [, k, v] = nestedKvMatch;
        const parent = (nestedBlock[nestedKey] as Record<string, unknown>)[nestedSubKey] as Record<string, string>;
        if (parent) parent[k] = v.replace(/^["']|["']$/g, "");
        continue;
      }
      // End of nested block (non-indented line)
      if (!line.startsWith(" ") && line.trim() !== "") {
        inNestedBlock = false;
        yaml[nestedKey] = nestedBlock[nestedKey];
      } else {
        continue;
      }
    }

    // List item
    if (line.match(/^\s+- /) && currentList !== null) {
      currentList.push(line.trim().replace(/^- /, ""));
      continue;
    }

    // Close previous list
    if (currentList !== null) {
      yaml[currentKey] = currentList;
      currentList = null;
    }

    // Key: value
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (value === "") {
        currentKey = key;
        currentList = [];
      } else if (value === "true") {
        yaml[key] = true;
      } else if (value === "false") {
        yaml[key] = false;
      } else {
        yaml[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  }

  if (currentList !== null) yaml[currentKey] = currentList;
  if (inNestedBlock) yaml[nestedKey] = nestedBlock[nestedKey];

  return { yaml, body };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function loadAgentConfigs(ui: UIMap): ParsedAgent[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const knowledgePath = join(AGENTS_DIR, "_knowledge.md");
  let knowledgeTemplate = "";
  if (existsSync(knowledgePath)) {
    knowledgeTemplate = readFileSync(knowledgePath, "utf-8");
  }

  const templateVars: Record<string, string> = {};
  for (const [key, el] of Object.entries(ui.elements)) templateVars[key] = el.text;
  for (const [key, sel] of Object.entries(ui.selectors)) templateVars[key] = sel;
  const knowledge = renderTemplate(knowledgeTemplate, templateVars);
  templateVars["NOTEBOOKLM_KNOWLEDGE"] = knowledge;

  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md") && !f.startsWith("_"));
  const agents: ParsedAgent[] = [];

  for (const file of files) {
    const raw = readFileSync(join(AGENTS_DIR, file), "utf-8");
    const { yaml, body } = parseYamlFrontmatter(raw);

    const name = yaml.name as string;
    if (!name) continue;

    agents.push({
      name,
      displayName: (yaml.displayName as string) ?? name,
      description: (yaml.description as string) ?? "",
      tools: (yaml.tools as string[]) ?? [],
      prompt: renderTemplate(body, templateVars),
      parametersSchema: (yaml.parameters as Record<string, { type: string; description: string; default?: string }>) ?? {},
    });
  }

  return agents;
}

// =============================================================================
// CDP helpers (same as phase-e)
// =============================================================================

async function captureScreenshot(cdp: CDPSession): Promise<string> {
  const result = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  return result.data;
}

async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchType(cdp: CDPSession, page: Page, text: string): Promise<void> {
  const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
    "Escape": { key: "Escape", code: "Escape", keyCode: 27 },
    "Enter": { key: "Enter", code: "Enter", keyCode: 13 },
    "Tab": { key: "Tab", code: "Tab", keyCode: 9 },
    "Backspace": { key: "Backspace", code: "Backspace", keyCode: 8 },
  };
  if (text === "Ctrl+A" || text === "ctrl+a") {
    // CDP Ctrl+A doesn't work reliably in Angular Material dialogs.
    // Use JS select() on the focused input element instead.
    const selected = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        el.select();
        return true;
      }
      // Fallback: try contenteditable
      const sel = window.getSelection();
      if (sel && document.activeElement) {
        sel.selectAllChildren(document.activeElement);
        return true;
      }
      return false;
    });
    if (!selected) {
      // Last resort: CDP Ctrl+A
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    }
    return;
  }
  const special = specialKeys[text];
  if (special) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode });
    return;
  }
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
  }
}

async function dispatchPaste(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

async function dispatchScroll(cdp: CDPSession, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

// =============================================================================
// Tool result helpers
// =============================================================================

function screenshotResult(base64: string, text?: string): ToolResultObject {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filepath = join(SCREENSHOTS_DIR, `phase-f-${Date.now()}.png`);
  writeFileSync(filepath, Buffer.from(base64, "base64"));
  return {
    textResultForLlm: text ?? `Screenshot captured.`,
    resultType: "success",
    binaryResultsForLlm: [{ data: base64, mimeType: "image/png", type: "image" }],
  };
}

function textResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "success" };
}

// =============================================================================
// Browser Tools
// =============================================================================

function createBrowserTools(cdp: CDPSession, page: Page): Tool[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => screenshotResult(await captureScreenshot(cdp)),
  });

  const findTool = defineTool("find", {
    description: `Find interactive elements by text/aria-label/placeholder/CSS selector. Returns coordinates for clicking.`,
    parameters: z.object({ query: z.string().describe("Text to search for, or CSS selector") }),
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
          disabled: boolean; ariaExpanded: string | null;
          center: { x: number; y: number };
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
              ariaExpanded: el.getAttribute("aria-expanded"),
              center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            });
          }
        }
        if (matches.length === 0) {
          try {
            for (const el of document.querySelectorAll(q)) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "none") continue;
              matches.push({
                tag: el.tagName, text: (el.textContent?.trim() ?? "").slice(0, 80),
                ariaLabel: el.getAttribute("aria-label"),
                disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
                ariaExpanded: el.getAttribute("aria-expanded"),
                center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              });
            }
          } catch { /* not a valid selector */ }
        }
        return matches;
      }, args.query);
      if (results.length === 0) return textResult(`No elements found for: "${args.query}"`);
      return textResult(results.map((r) => {
        const attrs = [
          r.ariaLabel ? `aria="${r.ariaLabel}"` : "",
          r.disabled ? "DISABLED" : "",
          r.ariaExpanded !== null ? `expanded=${r.ariaExpanded}` : "",
        ].filter(Boolean).join(" ");
        return `[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})${attrs ? `  ${attrs}` : ""}`;
      }).join("\n"));
    },
  });

  const clickTool = defineTool("click", {
    description: "Click at coordinates. Use find() first. Returns screenshot after click.",
    parameters: z.object({ x: z.number(), y: z.number() }),
    handler: async (args) => {
      await dispatchClick(cdp, args.x, args.y);
      await new Promise((r) => setTimeout(r, 500));
      return screenshotResult(await captureScreenshot(cdp), `Clicked at (${args.x}, ${args.y}).`);
    },
  });

  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position. Click target input first.",
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

  const scrollTool = defineTool("scroll", {
    description: "Scroll page at coordinates.",
    parameters: z.object({ x: z.number(), y: z.number(), deltaX: z.number().optional(), deltaY: z.number() }),
    handler: async (args) => {
      await dispatchScroll(cdp, args.x, args.y, args.deltaX ?? 0, args.deltaY);
      await new Promise((r) => setTimeout(r, 300));
      return screenshotResult(await captureScreenshot(cdp), `Scrolled.`);
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM via CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources), "studio-panel" (studio), "h1" (title).`,
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

  const navigateTool = defineTool("navigate", {
    description: "Navigate to URL. Returns screenshot.",
    parameters: z.object({ url: z.string() }),
    handler: async (args) => {
      await page.goto(args.url, { waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2000));
      return screenshotResult(await captureScreenshot(cdp), `Navigated to: ${page.url()}`);
    },
  });

  const waitTool = defineTool("wait", {
    description: "Wait N seconds. Returns screenshot.",
    parameters: z.object({ seconds: z.number().min(1).max(60) }),
    handler: async (args) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      return screenshotResult(await captureScreenshot(cdp), `Waited ${args.seconds}s.`);
    },
  });

  return [screenshotTool, findTool, clickTool, pasteTool, typeTool, scrollTool, readTool, navigateTool, waitTool] as Tool[];
}

// =============================================================================
// Plan structure (Planner → Executor)
// =============================================================================

interface ExecutionStep {
  agentName: string;
  executorPrompt: string;
  tools: string[];
}

interface ExecutionPlan {
  steps: ExecutionStep[];
  reasoning: string;
}

// =============================================================================
// Event logger
// =============================================================================

function createEventLogger(label: string) {
  let toolCallCount = 0;
  return {
    get toolCallCount() { return toolCallCount; },
    handler: (event: SessionEvent) => {
      const ts = new Date(event.timestamp).toLocaleTimeString("zh-TW");
      switch (event.type) {
        case "assistant.turn_start":
          console.log(`  [${ts}] [${label}] turn started`);
          break;
        case "assistant.turn_end":
          console.log(`  [${ts}] [${label}] turn ended`);
          break;
        case "assistant.message": {
          const content = (event.data as { content?: string }).content ?? "";
          console.log(`  [${ts}] [${label}] message: ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`);
          break;
        }
        case "assistant.reasoning": {
          const reasoning = (event.data as { content?: string }).content ?? "";
          console.log(`  [${ts}] [${label}] reasoning: ${reasoning.slice(0, 150)}${reasoning.length > 150 ? "..." : ""}`);
          break;
        }
        case "tool.execution_start": {
          toolCallCount++;
          const d = event.data as { toolName?: string; input?: unknown };
          const inputStr = JSON.stringify(d.input ?? {});
          console.log(`  [${ts}] [${label}] #${toolCallCount} ${d.toolName}(${inputStr.slice(0, 120)}${inputStr.length > 120 ? "..." : ""})`);
          break;
        }
        case "tool.execution_complete": {
          const d = event.data as { toolName?: string; result?: { textResultForLlm?: string } };
          const r = d.result?.textResultForLlm ?? "(no text)";
          console.log(`  [${ts}] [${label}] ${d.toolName} done → ${r.slice(0, 150)}${r.length > 150 ? "..." : ""}`);
          break;
        }
        case "session.error": {
          const d = event.data as { message?: string; errorType?: string };
          console.error(`  [${ts}] [${label}] ERROR [${d.errorType}]: ${d.message}`);
          break;
        }
        default:
          break;
      }
    },
  };
}

// =============================================================================
// Planner Session
// =============================================================================

async function runPlannerSession(
  client: CopilotClient,
  userPrompt: string,
  agentConfigs: ParsedAgent[],
  locale: string,
  model?: string,
): Promise<ExecutionPlan> {
  // Build agent catalog for Planner's system message
  const agentCatalog = agentConfigs.map(a => {
    const params = Object.keys(a.parametersSchema).length > 0
      ? `\n    parameters: ${JSON.stringify(a.parametersSchema)}`
      : "";
    return `  - name: ${a.name}\n    description: ${a.description}\n    tools: [${a.tools.join(", ")}]${params}`;
  }).join("\n");

  const plannerSystemMessage = `你是 NotebookLM 控制器的 Planner。你的任務是分析使用者的自然語言指令，選擇正確的 agent config，組裝結構化 prompt 給 Executor 執行。

## 可用的 Agent Configs

${agentCatalog}

## 你的輸出

呼叫 submitPlan tool，提交執行計畫。每個 step 包含：
- agentName: 選擇的 agent config 名稱
- executorPrompt: 給 Executor 的明確操作指令（中文，包含具體參數值）
- tools: 該操作需要的 tool 名稱列表（從 agent config 的 tools 欄位取）

## 規則

1. 單一操作 → 1 個 step
2. 複合操作（如「加來源然後問問題」）→ 多個 steps，按順序排列
3. executorPrompt 必須明確，不能含糊。例如不是「問一個問題」而是「向 NotebookLM 提問：TypeScript 的優勢是什麼？」
4. 不要自己執行操作，只做規劃
5. 當前 locale: ${locale}`;

  // The only tool Planner has: submitPlan
  let capturedPlan: ExecutionPlan | null = null;

  const submitPlanTool = defineTool("submitPlan", {
    description: "Submit the execution plan for the Executor to carry out.",
    parameters: z.object({
      reasoning: z.string().describe("Brief explanation of why these steps were chosen"),
      steps: z.array(z.object({
        agentName: z.string().describe("Name of the agent config to use"),
        executorPrompt: z.string().describe("Clear instruction for the Executor"),
        tools: z.array(z.string()).describe("Tool names needed for this step"),
      })),
    }),
    handler: async (args) => {
      capturedPlan = { steps: args.steps, reasoning: args.reasoning };
      return textResult(`Plan accepted: ${args.steps.length} step(s).`);
    },
  });

  const logger = createEventLogger("Planner");

  console.log("\n[phase-f] ====== Planner Session ======");
  const t0 = Date.now();

  const session = await client.createSession({
    tools: [submitPlanTool] as Tool[],
    ...(model ? { model } : {}),
    systemMessage: { mode: "append" as const, content: plannerSystemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);

  console.log(`[phase-f] Planner session: ${session.sessionId}`);
  console.log(`[phase-f] Planner prompt: "${userPrompt}"`);

  await session.sendAndWait({ prompt: userPrompt }, 60_000);
  await session.disconnect();

  const plannerMs = Date.now() - t0;
  console.log(`[phase-f] Planner done: ${(plannerMs / 1000).toFixed(1)}s, ${logger.toolCallCount} tool calls`);

  if (!capturedPlan) {
    throw new Error("Planner did not submit a plan");
  }

  console.log(`[phase-f] Plan: ${capturedPlan.reasoning}`);
  for (const [i, step] of capturedPlan.steps.entries()) {
    console.log(`[phase-f]   Step ${i + 1}: [${step.agentName}] ${step.executorPrompt.slice(0, 100)}`);
  }

  return capturedPlan;
}

// =============================================================================
// Executor Session
// =============================================================================

async function runExecutorSession(
  client: CopilotClient,
  step: ExecutionStep,
  agentConfigs: ParsedAgent[],
  allTools: Tool[],
  model?: string,
): Promise<string> {
  // Find the matching agent config
  const agentConfig = agentConfigs.find(a => a.name === step.agentName);
  if (!agentConfig) {
    throw new Error(`Unknown agent: ${step.agentName}`);
  }

  // Filter tools to only what this agent needs
  const toolNameSet = new Set(step.tools);
  const filteredTools = allTools.filter(t => toolNameSet.has((t as any).name));
  // Always include screenshot for observability
  if (!toolNameSet.has("screenshot")) {
    const screenshotTool = allTools.find(t => (t as any).name === "screenshot");
    if (screenshotTool) filteredTools.push(screenshotTool);
  }

  // Prepend tool constraint to prevent built-in tool fallback
  const toolConstraint = `## 重要：工具限制

你只能使用以下 browser tools 完成任務：${step.tools.join(", ")}, screenshot
**禁止使用** bash, view, edit, grep 等任何其他內建工具。所有操作必須透過上述 browser tools 完成。
如果你覺得需要讀取檔案或執行 shell 命令，那是錯誤的方向 — 你操作的是瀏覽器，不是檔案系統。

`;
  const executorSystemMessage = toolConstraint + agentConfig.prompt;

  const logger = createEventLogger("Executor");

  console.log(`\n[phase-f] ====== Executor Session [${step.agentName}] ======`);
  const t0 = Date.now();

  const session = await client.createSession({
    tools: filteredTools,
    ...(model ? { model } : {}),
    systemMessage: { mode: "append" as const, content: executorSystemMessage },
    onPermissionRequest: () => ({ kind: "approved" as const }),
  });

  session.on(logger.handler);

  console.log(`[phase-f] Executor session: ${session.sessionId}`);
  console.log(`[phase-f] Executor tools: [${step.tools.join(", ")}]`);
  console.log(`[phase-f] Executor prompt: "${step.executorPrompt}"`);

  let responseContent = "";
  const response = await session.sendAndWait({ prompt: step.executorPrompt }, SESSION_TIMEOUT_MS);

  if (response?.data?.content) {
    responseContent = response.data.content;
  }

  await session.disconnect();

  const executorMs = Date.now() - t0;
  console.log(`[phase-f] Executor done: ${(executorMs / 1000).toFixed(1)}s, ${logger.toolCallCount} tool calls`);

  return responseContent;
}

// =============================================================================
// Main
// =============================================================================

// =============================================================================
// Single prompt runner
// =============================================================================

interface RunResult {
  prompt: string;
  plan: ExecutionPlan | null;
  results: string[];
  durationMs: number;
  status: "PASS" | "FAIL";
  error?: string;
}

async function runSinglePrompt(
  client: CopilotClient,
  prompt: string,
  agentConfigs: ParsedAgent[],
  allTools: Tool[],
  locale: string,
  model?: string,
): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const plan = await runPlannerSession(client, prompt, agentConfigs, locale, model);
    const results: string[] = [];
    for (const [i, step] of plan.steps.entries()) {
      if (plan.steps.length > 1) {
        console.log(`\n[phase-f] ====== Step ${i + 1}/${plan.steps.length} ======`);
      }
      const result = await runExecutorSession(client, step, agentConfigs, allTools, model);
      results.push(result);
    }
    return { prompt, plan, results, durationMs: Date.now() - t0, status: "PASS" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[phase-f] FAIL: ${msg}`);
    return { prompt, plan: null, results: [], durationMs: Date.now() - t0, status: "FAIL", error: msg };
  }
}

// =============================================================================
// Batch test suite
// =============================================================================

const BATCH_TESTS: Array<{ id: string; prompt: string; agents: string[] }> = [
  // --- Read-only operations ---
  { id: "T01", prompt: "列出這個筆記本的來源", agents: ["list-sources"] },
  { id: "T02", prompt: "讀取目前筆記本的狀態（標題、來源數、音訊狀態）", agents: ["sync-notebook"] },

  // --- Query ---
  { id: "T03", prompt: "問 NotebookLM：TypeScript 的型別系統有哪些核心特性？", agents: ["query"] },

  // --- Source management ---
  { id: "T04", prompt: "加入一段文字來源，內容是：「React 是一個用於構建用戶界面的 JavaScript 函式庫。它採用組件化設計，支援虛擬 DOM 和單向資料流。React Hooks 讓函式組件也能使用狀態和生命週期功能。」", agents: ["add-source"] },
  { id: "T05", prompt: "列出來源，確認新來源已加入", agents: ["list-sources"] },
  { id: "T06", prompt: "把最新加入的「貼上的文字」來源重新命名為「React 概述」", agents: ["rename-source"] },

  // --- Cross-source query ---
  { id: "T07", prompt: "問 NotebookLM：TypeScript 和 React 之間有什麼關聯？", agents: ["query"] },

  // --- Chat management ---
  { id: "T08", prompt: "清除對話記錄", agents: ["clear-chat"] },

  // --- Source removal ---
  { id: "T09", prompt: "移除名為「React 概述」的來源", agents: ["remove-source"] },
  { id: "T10", prompt: "列出來源，確認只剩原始來源", agents: ["list-sources"] },

  // --- Notebook management (homepage) ---
  { id: "T11", prompt: "建立一個新的筆記本", agents: ["manage-notebook"] },
  { id: "T12", prompt: "回到首頁，把最新建立的筆記本重新命名為「Phase F 測試筆記本」", agents: ["manage-notebook"] },
  { id: "T13", prompt: "刪除名為「Phase F 測試筆記本」的筆記本", agents: ["manage-notebook"] },
];

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  let model: string | undefined = "gpt-4.1";
  let batchMode = false;
  let batchFrom = 0;

  for (let i = 0; i < args.length; ) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[i + 1];
      args.splice(i, 2);
    } else if (args[i] === "--batch") {
      batchMode = true;
      args.splice(i, 1);
    } else if (args[i] === "--from" && args[i + 1]) {
      batchFrom = parseInt(args[i + 1], 10);
      args.splice(i, 2);
    } else {
      i++;
    }
  }

  const prompt = args.join(" ");
  if (!prompt && !batchMode) {
    console.log(`Phase F — Two-Session Planner + Executor

Usage:
  npx tsx spike/browser-capability/phase-f.ts "<prompt>"
  npx tsx spike/browser-capability/phase-f.ts --batch              # Run full test suite
  npx tsx spike/browser-capability/phase-f.ts --batch --from 5     # Resume from T05
  npx tsx spike/browser-capability/phase-f.ts --model gpt-4.1 "<prompt>"

Test suite (--batch):
${BATCH_TESTS.map(t => `  ${t.id}: ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? "..." : ""}`).join("\n")}

Prerequisites:
  - Chrome running on port 9222
  - Browser on a NotebookLM page`);
    process.exit(0);
  }

  // 1. Connect to Chrome
  console.log("[phase-f] Connecting to Chrome...");
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm.google.com")) ?? pages[0];
  if (!page) { console.error("No pages found"); process.exit(1); }
  const cdp = await page.createCDPSession();
  console.log(`[phase-f] Connected: ${page.url()}`);

  // 2. Load UI map + agent configs
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);
  const agentConfigs = loadAgentConfigs(uiMap);
  console.log(`[phase-f] Locale: ${locale}, Agents: ${agentConfigs.map(a => a.name).join(", ")}`);

  // 3. Create browser tools
  const allTools = createBrowserTools(cdp, page);

  // 4. Start CopilotClient
  const client = new CopilotClient({ autoStart: false, autoRestart: false });

  try {
    await client.start();
    console.log("[phase-f] CopilotClient started");

    if (batchMode) {
      // === Batch mode ===
      const batchStart = Date.now();
      const results: RunResult[] = [];
      const tests = BATCH_TESTS.filter((_, i) => i + 1 >= batchFrom);

      console.log(`\n${"=".repeat(60)}`);
      console.log(`  BATCH TEST — ${tests.length} tests (from T${String(batchFrom || 1).padStart(2, "0")})`);
      console.log(`${"=".repeat(60)}\n`);

      for (const test of tests) {
        console.log(`\n${"─".repeat(60)}`);
        console.log(`  ${test.id}: ${test.prompt}`);
        console.log(`  Expected agents: [${test.agents.join(", ")}]`);
        console.log(`${"─".repeat(60)}`);

        const result = await runSinglePrompt(client, test.prompt, agentConfigs, allTools, locale, model);
        results.push(result);

        const planAgents = result.plan?.steps.map(s => s.agentName) ?? [];
        const agentMatch = test.agents.every(a => planAgents.includes(a));
        const statusIcon = result.status === "PASS" ? "✅" : "❌";
        const agentIcon = agentMatch ? "✅" : "⚠️";

        console.log(`\n  ${statusIcon} ${test.id} ${result.status} (${(result.durationMs / 1000).toFixed(1)}s) ${agentIcon} agents: [${planAgents.join(", ")}]`);

        if (result.status === "FAIL") {
          console.log(`  Error: ${result.error}`);
        }
      }

      // === Batch summary ===
      const batchMs = Date.now() - batchStart;
      const passed = results.filter(r => r.status === "PASS").length;
      const failed = results.filter(r => r.status === "FAIL").length;

      console.log(`\n${"=".repeat(60)}`);
      console.log(`  BATCH RESULTS: ${passed}/${results.length} PASS, ${failed} FAIL`);
      console.log(`  Total time: ${(batchMs / 1000).toFixed(1)}s`);
      console.log(`${"=".repeat(60)}`);
      console.log("");
      console.log("| ID | Prompt | Status | Duration | Agents |");
      console.log("|----|--------|--------|----------|--------|");
      for (const [i, r] of results.entries()) {
        const test = tests[i];
        const agents = r.plan?.steps.map(s => s.agentName).join(", ") ?? "N/A";
        console.log(`| ${test.id} | ${test.prompt.slice(0, 40)}${test.prompt.length > 40 ? "..." : ""} | ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s | ${agents} |`);
      }

    } else {
      // === Single prompt mode ===
      const result = await runSinglePrompt(client, prompt, agentConfigs, allTools, locale, model);

      console.log(`\n[phase-f] ====== Summary ======`);
      console.log(`[phase-f] Status: ${result.status}`);
      console.log(`[phase-f] Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.plan) {
        console.log(`[phase-f] Plan: ${result.plan.reasoning}`);
        for (const [i, r] of result.results.entries()) {
          console.log(`\n[phase-f] --- Result ${i + 1} [${result.plan.steps[i].agentName}] ---`);
          console.log(r.slice(0, 500));
        }
      }
    }

  } catch (err) {
    console.error(`[phase-f] Error: ${err instanceof Error ? err.message : err}`);
    console.error(err);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) console.error("[phase-f] Client errors:", errors.map(e => e.message));
    browser.disconnect();
    console.log("\n[phase-f] Done");
  }
}

main();
