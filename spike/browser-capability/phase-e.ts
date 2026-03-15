/**
 * Phase E — CustomAgents Production Simulation
 *
 * 模擬生產環境：載入 agents/*.md config → customAgents[]，
 * 用自然語言 prompt 讓 main agent 自動路由到正確的 sub-agent。
 *
 * Usage:
 *   # Chrome must be running (port 9222)
 *   npx tsx spike/browser-capability/experiment.ts launch
 *   npx tsx spike/browser-capability/experiment.ts navigate https://notebooklm.google.com/notebook/<id>
 *
 *   # Run with natural language prompt
 *   npx tsx spike/browser-capability/phase-e.ts "列出這個筆記本的來源"
 *   npx tsx spike/browser-capability/phase-e.ts "幫我問一個問題：TypeScript 的優勢是什麼？"
 *   npx tsx spike/browser-capability/phase-e.ts "把這段文字加入來源：Hello World"
 *   npx tsx spike/browser-capability/phase-e.ts --model gpt-4.1 "列出所有來源"
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { Tool, ToolResultObject, SessionEvent, CustomAgentConfig } from "@github/copilot-sdk";

// =============================================================================
// Config
// =============================================================================

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");
const UI_MAPS_DIR = join(import.meta.dirname, "ui-maps");
const AGENTS_DIR = join(import.meta.dirname, "../../agents");
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// UI Map
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
// Agent Config Loader — parse agents/*.md (YAML frontmatter + Markdown body)
// =============================================================================

interface ParsedAgent {
  name: string;
  displayName: string;
  description: string;
  tools: string[];
  infer: boolean;
  prompt: string; // Markdown body (after template rendering)
}

function parseYamlFrontmatter(content: string): { yaml: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { yaml: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];

  // Simple YAML parser for our flat structure
  const yaml: Record<string, unknown> = {};
  const lines = yamlStr.split("\n");
  let currentKey = "";
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Skip comments, parameter blocks (nested YAML — not needed for CustomAgentConfig)
    if (line.startsWith("#")) continue;

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
        // Might be start of a list or nested object
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

  // Close final list
  if (currentList !== null) {
    yaml[currentKey] = currentList;
  }

  return { yaml, body };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function loadAgentConfigs(ui: UIMap): ParsedAgent[] {
  if (!existsSync(AGENTS_DIR)) {
    console.warn(`[phase-e] agents/ directory not found at ${AGENTS_DIR}`);
    return [];
  }

  // Load shared knowledge template
  const knowledgePath = join(AGENTS_DIR, "_knowledge.md");
  let knowledgeTemplate = "";
  if (existsSync(knowledgePath)) {
    knowledgeTemplate = readFileSync(knowledgePath, "utf-8");
  }

  // Build template variables from UI map
  const templateVars: Record<string, string> = {};
  for (const [key, el] of Object.entries(ui.elements)) {
    templateVars[key] = el.text;
  }
  for (const [key, sel] of Object.entries(ui.selectors)) {
    templateVars[key] = sel;
  }
  // Render knowledge with UI map vars
  const knowledge = renderTemplate(knowledgeTemplate, templateVars);
  templateVars["NOTEBOOKLM_KNOWLEDGE"] = knowledge;

  // Load each agent .md file
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md") && !f.startsWith("_"));
  const agents: ParsedAgent[] = [];

  for (const file of files) {
    const raw = readFileSync(join(AGENTS_DIR, file), "utf-8");
    const { yaml, body } = parseYamlFrontmatter(raw);

    const name = yaml.name as string;
    if (!name) {
      console.warn(`[phase-e] Skipping ${file}: no name in frontmatter`);
      continue;
    }

    const prompt = renderTemplate(body, templateVars);

    agents.push({
      name,
      displayName: (yaml.displayName as string) ?? name,
      description: (yaml.description as string) ?? "",
      tools: (yaml.tools as string[]) ?? [],
      infer: (yaml.infer as boolean) ?? true,
      prompt,
    });
  }

  return agents;
}

// =============================================================================
// CDP helpers (same as phase-b.ts)
// =============================================================================

async function captureScreenshot(cdp: CDPSession): Promise<string> {
  const result = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  return result.data;
}

async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchType(cdp: CDPSession, text: string): Promise<void> {
  // Handle special keys
  const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
    "Escape": { key: "Escape", code: "Escape", keyCode: 27 },
    "Enter": { key: "Enter", code: "Enter", keyCode: 13 },
    "Tab": { key: "Tab", code: "Tab", keyCode: 9 },
    "Backspace": { key: "Backspace", code: "Backspace", keyCode: 8 },
  };

  // Ctrl+A handling
  if (text === "Ctrl+A" || text === "ctrl+a") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", modifiers: 2, // Ctrl
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", modifiers: 2,
    });
    return;
  }

  const special = specialKeys[text];
  if (special) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: special.key, code: special.code, windowsVirtualKeyCode: special.keyCode,
    });
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
  const filepath = join(SCREENSHOTS_DIR, `phase-e-${Date.now()}.png`);
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
// Browser Tools (same as phase-b.ts, reusable)
// =============================================================================

function createBrowserTools(cdp: CDPSession, page: Page): Tool[] {
  const screenshotTool = defineTool("screenshot", {
    description: "Capture a screenshot of the current browser tab.",
    parameters: z.object({}),
    handler: async () => screenshotResult(await captureScreenshot(cdp)),
  });

  const findTool = defineTool("find", {
    description: `Find interactive elements by text/aria-label/placeholder/CSS selector. Returns coordinates for clicking. ALWAYS use before click().`,
    parameters: z.object({
      query: z.string().describe("Text to search for, or CSS selector"),
    }),
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
              tag: el.tagName,
              text: text.slice(0, 80),
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
    parameters: z.object({
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
    }),
    handler: async (args) => {
      await dispatchClick(cdp, args.x, args.y);
      await new Promise((r) => setTimeout(r, 500));
      return screenshotResult(await captureScreenshot(cdp), `Clicked at (${args.x}, ${args.y}).`);
    },
  });

  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position. Click target input first.",
    parameters: z.object({ text: z.string().describe("Text to paste") }),
    handler: async (args) => {
      await dispatchPaste(cdp, args.text);
      return textResult(`Pasted ${args.text.length} chars: "${args.text.slice(0, 80)}${args.text.length > 80 ? "..." : ""}"`);
    },
  });

  const typeTool = defineTool("type", {
    description: "Type text or special keys (Escape, Enter, Tab, Ctrl+A). Use paste() for bulk text.",
    parameters: z.object({ text: z.string().describe("Text or special key") }),
    handler: async (args) => {
      await dispatchType(cdp, args.text);
      return textResult(`Typed: "${args.text}"`);
    },
  });

  const scrollTool = defineTool("scroll", {
    description: "Scroll page at coordinates.",
    parameters: z.object({
      x: z.number(), y: z.number(),
      deltaX: z.number().optional(),
      deltaY: z.number().describe("Positive=down, negative=up"),
    }),
    handler: async (args) => {
      await dispatchScroll(cdp, args.x, args.y, args.deltaX ?? 0, args.deltaY);
      await new Promise((r) => setTimeout(r, 300));
      return screenshotResult(await captureScreenshot(cdp), `Scrolled.`);
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM via CSS selector. Key selectors: ".to-user-container .message-content" (answer), ".source-panel" (sources), "studio-panel" (studio), "h1" (title), "tr[tabindex]" (notebook list).`,
    parameters: z.object({ selector: z.string().describe("CSS selector") }),
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

  return [screenshotTool, findTool, clickTool, pasteTool, typeTool, scrollTool, readTool, navigateTool, waitTool] as any as Tool<unknown>[];
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  let prompt: string | undefined;
  let model: string | undefined = "gpt-4.1";

  for (let i = 0; i < args.length; ) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[i + 1];
      args.splice(i, 2);
    } else {
      i++;
    }
  }

  prompt = args.join(" ");
  if (!prompt) {
    console.log(`Phase E — CustomAgents Production Simulation

Usage:
  npx tsx spike/browser-capability/phase-e.ts "<natural language prompt>"
  npx tsx spike/browser-capability/phase-e.ts --model gpt-4.1 "<prompt>"

Examples:
  "列出這個筆記本的來源"
  "幫我問一個問題：TypeScript 的優勢是什麼？"
  "把這段文字加入來源：Hello World 這是測試內容"

Prerequisites:
  - Chrome running on port 9222
  - Browser on a NotebookLM page`);
    process.exit(0);
  }

  // 1. Connect to Chrome
  const t0 = Date.now();
  console.log("[phase-e] Connecting to Chrome...");
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm.google.com")) ?? pages[0];
  if (!page) { console.error("No pages found"); process.exit(1); }
  const cdp = await page.createCDPSession();
  console.log(`[phase-e] Connected: ${page.url()} (${Date.now() - t0}ms)`);

  // 2. Load UI map
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);
  console.log(`[phase-e] Locale: ${locale}`);

  // 3. Load agent configs
  const agentConfigs = loadAgentConfigs(uiMap);
  console.log(`[phase-e] Loaded ${agentConfigs.length} agents: ${agentConfigs.map(a => a.name).join(", ")}`);

  // Convert to SDK CustomAgentConfig format
  // NOTE: tools set to undefined = all tools (including custom external tools)
  // Agent config's tools[] only filters built-in tools; custom tools need "*" or undefined
  const forceAllTools = process.argv.includes("--all-tools");
  const customAgents: CustomAgentConfig[] = agentConfigs.map(a => ({
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    prompt: a.prompt,
    tools: forceAllTools ? undefined : a.tools,
    infer: a.infer,
  }));

  // 4. Create tools
  const tools = createBrowserTools(cdp, page);
  console.log(`[phase-e] Created ${tools.length} browser tools`);

  // 5. Build system message for main agent
  const e = uiMap.elements;
  const systemMessage = `你是 NotebookLM 控制器的 main agent。你接收使用者的自然語言指令，分析意圖後委派給正確的 sub-agent 執行。

## 可用的 Sub-agents

${agentConfigs.map(a => `- **task:${a.name}** — ${a.description}`).join("\n")}

## 路由規則

根據使用者指令判斷應該呼叫哪個 sub-agent：
- 提問/查詢 → task:query
- 列出來源 → task:list-sources
- 加入/新增來源 → task:add-source
- 移除來源 → task:remove-source
- 重命名來源 → task:rename-source
- 生成語音摘要 → task:generate-audio
- 下載音訊 → task:download-audio
- 建立/刪除/改標題筆記本 → task:manage-notebook
- 同步/讀取筆記本狀態 → task:sync-notebook
- 清除對話 → task:clear-chat

## 注意事項

- 一個指令可能需要多個 sub-agent 依序執行（例如「加來源然後問問題」→ add-source → query）
- 委派時傳遞明確的參數和目標
- 最後回報操作結果給使用者

## 當前頁面

瀏覽器已開啟 NotebookLM，locale: ${locale}。`;

  // 6. Create session
  const t1 = Date.now();
  console.log("[phase-e] Starting CopilotClient...");
  const client = new CopilotClient({ autoStart: false, autoRestart: false });

  try {
    await client.start();
    console.log(`[phase-e] Client started (${Date.now() - t1}ms)`);

    const session = await client.createSession({
      tools,
      customAgents,
      hooks: {},
      ...(model ? { model } : {}),
      systemMessage: { mode: "append" as const, content: systemMessage },
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });

    const t2 = Date.now();
    console.log(`[phase-e] Session: ${session.sessionId} (${t2 - t1}ms setup)`);
    console.log(`[phase-e] Model: ${model ?? "(default)"}`);
    console.log(`[phase-e] Agents: ${customAgents.length}`);

    // Event observer
    let toolCallCount = 0;
    session.on((event: SessionEvent) => {
      const ts = new Date(event.timestamp).toLocaleTimeString("zh-TW");
      switch (event.type) {
        case "assistant.turn_start":
          console.log(`\n[${ts}] 🔄 Turn started`);
          break;
        case "assistant.turn_end":
          console.log(`[${ts}] ✅ Turn ended`);
          break;
        case "assistant.message": {
          const content = (event.data as { content?: string }).content ?? "";
          console.log(`[${ts}] 💬 Agent: ${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`);
          break;
        }
        case "assistant.reasoning": {
          const reasoning = (event.data as { content?: string }).content ?? "";
          console.log(`[${ts}] 🧠 Reasoning: ${reasoning.slice(0, 200)}${reasoning.length > 200 ? "..." : ""}`);
          break;
        }
        case "tool.execution_start": {
          toolCallCount++;
          const d = event.data as { toolName?: string; input?: unknown };
          const inputStr = JSON.stringify(d.input ?? {});
          console.log(`[${ts}] 🔧 #${toolCallCount} ${d.toolName}(${inputStr.slice(0, 150)}${inputStr.length > 150 ? "..." : ""})`);
          break;
        }
        case "tool.execution_complete": {
          const d = event.data as { toolName?: string; result?: { textResultForLlm?: string } };
          const r = d.result?.textResultForLlm ?? "(no text)";
          console.log(`[${ts}] ✔️  ${d.toolName} → ${r.slice(0, 200)}${r.length > 200 ? "..." : ""}`);
          break;
        }
        case "session.error": {
          const d = event.data as { message?: string; errorType?: string };
          console.error(`[${ts}] ❌ [${d.errorType}]: ${d.message}`);
          break;
        }
        case "assistant.streaming_delta":
        case "assistant.message_delta":
        case "assistant.reasoning_delta":
        case "tool.execution_partial_result":
        case "tool.execution_progress":
        case "session.idle":
          break;
        default:
          console.log(`[${ts}] 📋 ${event.type}`);
      }
    });

    // 7. Send natural language prompt
    console.log(`\n[phase-e] ====== Prompt: "${prompt}" ======\n`);
    const startTime = Date.now();
    const response = await session.sendAndWait({ prompt }, SESSION_TIMEOUT_MS);
    const durationMs = Date.now() - startTime;

    console.log(`\n[phase-e] ====== Done ======`);
    console.log(`[phase-e] Duration: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`[phase-e] Tool calls: ${toolCallCount}`);

    if (response?.data?.content) {
      console.log(`\n[phase-e] Response:\n${response.data.content}`);
    }

    await session.disconnect();
  } catch (err) {
    console.error(`[phase-e] Error: ${err instanceof Error ? err.message : err}`);
    console.error(err);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) console.error("[phase-e] Client errors:", errors.map(e => e.message));
    browser.disconnect();
    console.log("[phase-e] Done");
  }
}

main();
