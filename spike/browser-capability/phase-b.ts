/**
 * Phase B — Copilot SDK Runtime Experiment
 *
 * Self-contained spike: NO imports from src/.
 * Wraps 7 browser tools in defineTool() and lets the Copilot SDK agent
 * autonomously operate NotebookLM.
 *
 * Usage:
 *   # Make sure Chrome is running (port 9222, spike profile)
 *   npx tsx spike/browser-capability/experiment.ts launch
 *
 *   # Run Phase B with a prompt
 *   npx tsx spike/browser-capability/phase-b.ts "建立一個新筆記本，加入一段關於 TypeScript 的來源，然後問一個問題並回傳回答"
 *
 *   # Or use a preset task
 *   npx tsx spike/browser-capability/phase-b.ts --preset create-and-query
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
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
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// =============================================================================
// UI Map — locale-specific element text/selectors
// =============================================================================

interface UIMapElement {
  text: string;
  match?: "text" | "placeholder" | "aria-label";
  disambiguate?: string;
}

interface UIMap {
  locale: string;
  verified: boolean;
  elements: Record<string, UIMapElement>;
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
    console.warn(`[phase-b] No UI map for locale "${locale}", falling back to en`);
    return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8"));
  }
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

// =============================================================================
// Self-contained CDP helpers (copied from src/tab-manager/cdp-helpers.ts)
// =============================================================================

async function captureScreenshot(
  cdp: CDPSession,
  options?: { format?: "png" | "jpeg"; quality?: number },
): Promise<string> {
  const result = (await cdp.send("Page.captureScreenshot", {
    format: options?.format ?? "png",
    ...(options?.quality !== undefined ? { quality: options.quality } : {}),
  })) as { data: string };
  return result.data;
}

async function dispatchClick(
  cdp: CDPSession,
  x: number,
  y: number,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function dispatchType(cdp: CDPSession, text: string): Promise<void> {
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
  }
}

async function dispatchScroll(
  cdp: CDPSession,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

async function dispatchPaste(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

// =============================================================================
// Tool result helpers
// =============================================================================

function screenshotResult(base64: string, text?: string): ToolResultObject {
  // Also save to disk for debugging
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filepath = join(SCREENSHOTS_DIR, `phase-b-${Date.now()}.png`);
  writeFileSync(filepath, Buffer.from(base64, "base64"));

  return {
    textResultForLlm: text ?? `Screenshot captured. Saved to ${filepath}`,
    resultType: "success",
    binaryResultsForLlm: [
      { data: base64, mimeType: "image/png", type: "image" },
    ],
  };
}

function textResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "success" };
}

function errorResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "failure", error: text };
}

// =============================================================================
// 7 Browser Tools — defineTool() format for Copilot SDK
// =============================================================================

function createBrowserTools(cdp: CDPSession, page: Page): Tool[] {
  // --- 1. screenshot ---
  const screenshotTool = defineTool("screenshot", {
    description:
      "Capture a screenshot of the current browser tab. Returns the image so you can see the page state.",
    parameters: z.object({}),
    handler: async () => {
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(base64);
    },
  });

  // --- 2. find ---
  const findTool = defineTool("find", {
    description: `Find interactive elements on the page by text content, placeholder, aria-label, or CSS selector.
Returns a list of matching elements with their tag, text, and CENTER coordinates for clicking.
ALWAYS use this tool before clicking — never guess coordinates from screenshots.
If searching for a button/link, use its visible text. For form fields, use placeholder text.
When multiple results appear, pick the one that best matches your intent.`,
    parameters: z.object({
      query: z
        .string()
        .describe(
          "Text to search for in element content/aria-label/placeholder, OR a CSS selector",
        ),
    }),
    handler: async (args) => {
      const results = await page.evaluate((q: string) => {
        const matches: Array<{
          tag: string;
          text: string;
          ariaLabel: string | null;
          disabled: boolean;
          ariaExpanded: string | null;
          center: { x: number; y: number };
          rect: { x: number; y: number; w: number; h: number };
        }> = [];

        // Search interactive elements by text (broad selector for Angular Material etc.)
        const INTERACTIVE = [
          "button", "a", "input", "textarea", "select",
          "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
          "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
          "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
        ].join(", ");
        const all = document.querySelectorAll(INTERACTIVE);
        for (const el of all) {
          const text = el.textContent?.trim() ?? "";
          const ariaLabel = el.getAttribute("aria-label") ?? "";
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (
            text.includes(q) ||
            ariaLabel.includes(q) ||
            el.getAttribute("placeholder")?.includes(q)
          ) {
            matches.push({
              tag: el.tagName,
              text: text.slice(0, 80),
              ariaLabel: el.getAttribute("aria-label"),
              disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
              ariaExpanded: el.getAttribute("aria-expanded"),
              center: {
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2),
              },
              rect: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                w: Math.round(r.width),
                h: Math.round(r.height),
              },
            });
          }
        }

        // Fallback: try as CSS selector
        if (matches.length === 0) {
          try {
            const els = document.querySelectorAll(q);
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "none") continue;
              matches.push({
                tag: el.tagName,
                text: (el.textContent?.trim() ?? "").slice(0, 80),
                ariaLabel: el.getAttribute("aria-label"),
                disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
                ariaExpanded: el.getAttribute("aria-expanded"),
                center: {
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2),
                },
                rect: {
                  x: Math.round(r.x),
                  y: Math.round(r.y),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                },
              });
            }
          } catch {
            // Not a valid selector
          }
        }

        return matches;
      }, args.query);

      if (results.length === 0) {
        return textResult(
          `No elements found for: "${args.query}". Try a different search term, or use find("collapse_content") if a source panel is expanded and blocking the UI.`,
        );
      }

      const lines = results.map((r) => {
        const attrs = [
          r.ariaLabel ? `aria="${r.ariaLabel}"` : "",
          r.disabled ? "DISABLED" : "",
          r.ariaExpanded !== null ? `expanded=${r.ariaExpanded}` : "",
        ].filter(Boolean).join(" ");
        return `[${r.tag}] "${r.text}" → center(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})${attrs ? `  ${attrs}` : ""}`;
      });
      return textResult(lines.join("\n"));
    },
  });

  // --- 3. click ---
  const clickTool = defineTool("click", {
    description:
      "Click at the given x,y coordinates. Use find() first to get accurate coordinates — NEVER guess from screenshots. Returns a screenshot after clicking.",
    parameters: z.object({
      x: z.number().describe("X coordinate in CSS pixels"),
      y: z.number().describe("Y coordinate in CSS pixels"),
    }),
    handler: async (args) => {
      await dispatchClick(cdp, args.x, args.y);
      // Small delay for UI to react
      await new Promise((r) => setTimeout(r, 500));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        `Clicked at (${args.x}, ${args.y}). Screenshot shows result.`,
      );
    },
  });

  // --- 4. paste ---
  const pasteTool = defineTool("paste", {
    description:
      "Paste text at the current cursor position. Use this for all text input — it's faster and more reliable than type(). Make sure to click the target input field first.",
    parameters: z.object({
      text: z.string().describe("Text to paste"),
    }),
    handler: async (args) => {
      await dispatchPaste(cdp, args.text);
      return textResult(
        `Pasted ${args.text.length} characters: "${args.text.slice(0, 80)}${args.text.length > 80 ? "..." : ""}"`,
      );
    },
  });

  // --- 5. type ---
  const typeTool = defineTool("type", {
    description:
      "Type text character-by-character. Only use this for special keys (Enter, Tab, Escape) or short text. For bulk text input, use paste() instead.",
    parameters: z.object({
      text: z.string().describe("Text to type character by character"),
    }),
    handler: async (args) => {
      await dispatchType(cdp, args.text);
      return textResult(`Typed: "${args.text}"`);
    },
  });

  // --- 6. scroll ---
  const scrollTool = defineTool("scroll", {
    description:
      "Scroll the page at the given coordinates. Returns a screenshot after scrolling.",
    parameters: z.object({
      x: z.number().describe("X coordinate for scroll origin"),
      y: z.number().describe("Y coordinate for scroll origin"),
      deltaX: z.number().optional().describe("Horizontal scroll delta (default: 0)"),
      deltaY: z.number().describe("Vertical scroll delta (positive = down, negative = up)"),
    }),
    handler: async (args) => {
      await dispatchScroll(cdp, args.x, args.y, args.deltaX ?? 0, args.deltaY);
      await new Promise((r) => setTimeout(r, 300));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        `Scrolled at (${args.x}, ${args.y}) by (${args.deltaX ?? 0}, ${args.deltaY}).`,
      );
    },
  });

  // --- 7. read ---
  const readTool = defineTool("read", {
    description: `Read page state using a CSS selector. Returns element count + structured info for state verification.
Key selectors for NotebookLM:
  - ".to-user-container .message-content" → model's answer text only
  - ".message-content" → all messages (questions + answers)
  - ".from-user-container" → user's questions
  - ".suggestions-container" → suggested follow-up questions
  - ".source-panel .source-item" → source list items (check count)
Use this for both content extraction AND state verification (element count, visibility, presence).`,
    parameters: z.object({
      selector: z.string().describe("CSS selector to query"),
    }),
    handler: async (args) => {
      const result = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return { count: 0, items: [] as Array<{ tag: string; text: string; visible: boolean }> };
        const items = Array.from(els).map((el) => {
          const style = getComputedStyle(el);
          return {
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 500),
            visible: style.visibility !== "hidden" && style.display !== "none",
          };
        });
        return { count: items.length, items };
      }, args.selector);

      if (result.count === 0) {
        return textResult(`No elements matched "${args.selector}"`);
      }
      const lines = [`Found ${result.count} element(s) matching "${args.selector}":`];
      for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i];
        const vis = item.visible ? "" : " (HIDDEN)";
        const preview = item.text.length > 200 ? item.text.slice(0, 200) + "..." : item.text;
        lines.push(`[${i + 1}] ${item.tag}${vis}: ${preview}`);
      }
      return textResult(lines.join("\n"));
    },
  });

  // --- 8. navigate ---
  const navigateTool = defineTool("navigate", {
    description:
      "Navigate the browser to a URL. Use this to go to NotebookLM home: navigate('https://notebooklm.google.com'). Returns a screenshot after navigation.",
    parameters: z.object({
      url: z.string().describe("URL to navigate to"),
    }),
    handler: async (args) => {
      await page.goto(args.url, { waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2000));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(base64, `Navigated to: ${page.url()}`);
    },
  });

  // --- 9. wait ---
  const waitTool = defineTool("wait", {
    description:
      "Wait for a specified number of seconds. Use this after submitting a question to NotebookLM (wait 10-15 seconds for the answer to generate).",
    parameters: z.object({
      seconds: z
        .number()
        .min(1)
        .max(30)
        .describe("Number of seconds to wait (1-30)"),
    }),
    handler: async (args) => {
      await new Promise((r) => setTimeout(r, args.seconds * 1000));
      const base64 = await captureScreenshot(cdp);
      return screenshotResult(
        base64,
        `Waited ${args.seconds} seconds. Screenshot shows current state.`,
      );
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [
    screenshotTool,
    findTool,
    clickTool,
    pasteTool,
    typeTool,
    scrollTool,
    readTool,
    navigateTool,
    waitTool,
  ] as any as Tool<unknown>[];
}

// =============================================================================
// Preset prompts
// =============================================================================

// System-level knowledge about NotebookLM UI — generated from UI map config
function generateKnowledge(ui: UIMap): string {
  const e = ui.elements;
  const s = ui.selectors;
  return `## NotebookLM 操作手冊

你是一個瀏覽器操作 agent，透過 tool calls 操控 Google NotebookLM。
瀏覽器已經開啟並登入 Google 帳號，你只需要操作 UI。
UI locale: ${ui.locale}

### 核心操作規則

1. **絕對不要猜座標** — 永遠先用 find() 取得精確座標，再用 click()。截圖中的座標因縮放會有 2-5 倍誤差。
2. **用 paste() 不用 type()** — 大段文字一律用 paste()，type() 只用於特殊按鍵。
3. **提交按鈕有兩個** — 頁面上有兩個提交按鈕（搜尋欄和 Chat 欄），永遠選 y 座標 > 400 的那個。
4. **回答需要等待** — 提交問題後，用 wait(15) 等 15 秒再 read()。如果讀到 "Refining..." 就再 wait(10)。
5. **來源展開會遮蔽按鈕** — 如果 find("${e.add_source.text}") 失敗，先 find("${e.collapse_source.text}") 點擊收合。

### 狀態確認原則

每個操作後，你必須確認頁面狀態正確才進行下一步。
你有 find、read、screenshot 三個觀測工具，自行判斷用哪個（或組合）能最可靠地確認當前狀態。
- find() 可確認元素存在性、座標、disabled/expanded 狀態
- read() 可確認元素數量、文字內容、可見性
- screenshot() 可看到完整視覺狀態（適合不確定頁面狀態時使用）
效率提示：DOM 查詢比截圖快且不消耗 vision tokens，如果 DOM 已能明確確認狀態，優先使用。

### 已知 UI 元素和操作方式

| 操作 | 步驟 |
|------|------|
| 建立筆記本 | find("${e.create_notebook.text}") → click |
| 加來源（文字） | find("${e.paste_source_type.text}") → click → find("${e.paste_textarea.text}") → click → paste(內容) → find("${e.insert_button.text}") → click |
| 提問 | find("${e.chat_input.text}") → click → paste(問題) → find("${e.submit_button.text}") → click(選 y>400) |
| 讀回答 | wait(15) → read("${s.answer}") |
| 收合來源面板 | find("${e.collapse_source.text}") → click |

### 已知 CSS Selectors

- 回答文字："${s.answer}"
- 問題文字："${s.question}"
- 建議問題："${s.suggestions}"
- 來源面板："${s.source_panel}"
`;
}

function generatePresets(ui: UIMap): Record<string, string> {
  const knowledge = generateKnowledge(ui);
  const e = ui.elements;
  const s = ui.selectors;
  return {
    "create-and-query": `${knowledge}

## 你的任務

你現在在 NotebookLM 首頁。請依序完成以下步驟：

### Step 1: 建立新筆記本
- 確認在首頁（用你認為最適合的觀測方式）
- find("${e.create_notebook.text}") 取得按鈕座標
- click() 建立新筆記本
- wait(3) 等頁面載入

### Step 2: 新增來源
- 新筆記本建立後會自動彈出對話框
- find("${e.paste_source_type.text}") → click 選擇來源類型
- find("${e.paste_textarea.text}") → click 讓 textarea 獲得焦點
- paste() 貼入以下來源內容：
"TypeScript 是 JavaScript 的超集，由 Microsoft 開發並於 2012 年首次發布。TypeScript 的核心特色是靜態型別系統，允許開發者在編譯時期就發現型別錯誤，而非等到執行時期。TypeScript 支援介面（interface）、泛型（generics）、列舉（enum）、元組（tuple）等進階型別特性。TypeScript 編譯器（tsc）將 .ts 檔案編譯為標準 JavaScript，因此可以在任何支援 JS 的環境中執行。TypeScript 4.x 引入了模板字面量型別（Template Literal Types）和條件型別推斷改進。TypeScript 5.x 則引入了裝飾器（Decorators）的 Stage 3 標準實作。目前 TypeScript 已被 Angular、Vue 3、Next.js 等主流框架採用為預設語言。VS Code 本身就是用 TypeScript 開發的。"
- find("${e.insert_button.text}") → click 送出
- wait(5) 等來源處理

### Step 3: 提問
- find("${e.chat_input.text}") → click 讓 chat 輸入框獲得焦點
- paste("TypeScript 的核心特色是什麼？它支援哪些進階型別特性？")
- find("${e.submit_button.text}") → 注意選 y > 400 的結果 → click
- wait(15) 等 NotebookLM 生成回答

### Step 4: 讀取回答
- read("${s.answer}") 取得回答
- 如果回答包含 "Refining" 或為空，wait(10) 後重試
- 回報完整回答內容

請依序完成 Step 1 到 Step 4，全部做完才停下。不要中途暫停詢問。`,
  };
}

// =============================================================================
// Main — connect to Chrome, create SDK session, run agent
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let prompt: string | undefined;
  let model: string | undefined;
  let localeOverride: string | undefined;
  let presetName: string | undefined;

  // Extract flags from anywhere in args
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--model" && args[i + 1]) {
      model = args[i + 1];
      args.splice(i, 2);
    } else if (args[i] === "--locale" && args[i + 1]) {
      localeOverride = args[i + 1];
      args.splice(i, 2);
    } else if (args[i] === "--preset" && args[i + 1]) {
      presetName = args[i + 1];
      args.splice(i, 2);
    } else {
      i++;
    }
  }

  if (!presetName && args.length > 0) {
    prompt = args.join(" ");
  } else if (!presetName) {
    console.log(`Phase B — Copilot SDK Runtime Experiment

Usage:
  npx tsx spike/browser-capability/phase-b.ts "<prompt>"
  npx tsx spike/browser-capability/phase-b.ts --preset create-and-query
  npx tsx spike/browser-capability/phase-b.ts --preset create-and-query --locale en

Options:
  --model <model>    Specify LLM model (e.g., gpt-4.1)
  --locale <locale>  Force locale (zh-TW, zh-CN, en). Auto-detects from Chrome if omitted.
  --preset <name>    Use a preset task (create-and-query)

Prerequisites:
  - Chrome running with CDP on port 9222
  - Run: npx tsx spike/browser-capability/experiment.ts launch`);
    process.exit(0);
  }

  // 1. Connect to Chrome
  const t0 = Date.now();
  console.log("[phase-b] Connecting to Chrome...");
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null, // CRITICAL: prevent 800x600 override
  });
  const pages = await browser.pages();
  const page =
    pages.find((p) => p.url().includes("notebooklm.google.com")) ?? pages[0];
  if (!page) {
    console.error("No pages found in Chrome");
    process.exit(1);
  }
  const cdp = await page.createCDPSession();
  console.log(`[phase-b] Connected to: ${page.url()} (${Date.now() - t0}ms)`);

  // 1.5. Detect or override locale, load UI map
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = localeOverride ?? resolveLocale(browserLang);

  if (localeOverride && resolveLocale(browserLang) !== localeOverride) {
    // Override via ?hl= URL parameter — Google uses account settings, not Accept-Language
    const hlMap: Record<string, string> = {
      "en": "en", "zh-TW": "zh-TW", "zh-CN": "zh-CN",
    };
    const hl = hlMap[localeOverride] ?? localeOverride;
    const currentUrl = new URL(page.url());
    currentUrl.searchParams.set("hl", hl);
    console.log(`[phase-b] Overriding locale: ${browserLang} → ${localeOverride} (via ?hl=${hl})`);
    await page.goto(currentUrl.toString(), { waitUntil: "networkidle2", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`[phase-b] Page reloaded with locale override`);
  }

  const uiMap = loadUIMap(locale);
  console.log(`[phase-b] Locale: ${locale} (browser: ${browserLang}, verified: ${uiMap.verified})`);

  // Resolve prompt from preset if needed
  if (presetName) {
    const presets = generatePresets(uiMap);
    const preset = presets[presetName];
    if (!preset) {
      console.error(`Unknown preset: ${presetName}`);
      console.error(`Available: ${Object.keys(presets).join(", ")}`);
      process.exit(1);
    }
    prompt = preset;
  }

  // 2. Create tools
  const tools = createBrowserTools(cdp, page);
  console.log(`[phase-b] Created ${tools.length} tools (${Date.now() - t0}ms from start)`);

  // 3. Create Copilot SDK client + session
  const t1 = Date.now();
  console.log("[phase-b] Starting CopilotClient...");
  const client = new CopilotClient({
    autoStart: false,
    autoRestart: false,
  });

  try {
    await client.start();
    const t2 = Date.now();
    console.log(`[phase-b] CopilotClient started (${t2 - t1}ms)`);

    console.log("[phase-b] Creating session with %d tools...", tools.length);
    const session = await client.createSession({
      tools,
      customAgents: [],
      hooks: {},
      ...(model ? { model } : {}),
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });
    const t3 = Date.now();
    console.log(`[phase-b] Session created: ${session.sessionId} (${t3 - t2}ms)`);
    console.log(`[phase-b] Model: ${model ?? "(default)"}`);
    console.log(`[phase-b] Total setup: ${t3 - t0}ms`);

    // 3.5. Attach event observer — logs every agent step
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
          console.log(
            `[${ts}] 💬 Agent: ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
          );
          break;
        }
        case "assistant.reasoning": {
          const reasoning = (event.data as { content?: string }).content ?? "";
          console.log(
            `[${ts}] 🧠 Reasoning: ${reasoning.slice(0, 150)}${reasoning.length > 150 ? "..." : ""}`,
          );
          break;
        }
        case "tool.execution_start": {
          toolCallCount++;
          const d = event.data as { toolName?: string; input?: unknown };
          const inputStr = JSON.stringify(d.input ?? {});
          console.log(
            `[${ts}] 🔧 Tool #${toolCallCount} START: ${d.toolName}(${inputStr.slice(0, 120)}${inputStr.length > 120 ? "..." : ""})`,
          );
          break;
        }
        case "tool.execution_complete": {
          const d = event.data as {
            toolName?: string;
            result?: { textResultForLlm?: string };
          };
          const resultText = d.result?.textResultForLlm ?? "(no text)";
          console.log(
            `[${ts}] ✔️  Tool DONE: ${d.toolName} → ${resultText.slice(0, 150)}${resultText.length > 150 ? "..." : ""}`,
          );
          break;
        }
        case "session.error": {
          const d = event.data as { message?: string; errorType?: string };
          console.error(
            `[${ts}] ❌ ERROR [${d.errorType}]: ${d.message}`,
          );
          break;
        }
        // Skip noisy events
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

    // 4. Send prompt and wait
    console.log("[phase-b] Sending prompt...");
    console.log(`[phase-b] Prompt: ${prompt.slice(0, 100)}...`);
    console.log("[phase-b] ------- Agent running -------");

    const startTime = Date.now();
    const response = await session.sendAndWait({ prompt: prompt! }, SESSION_TIMEOUT_MS);
    const durationMs = Date.now() - startTime;

    console.log("\n[phase-b] ------- Agent done -------");
    console.log(`[phase-b] Duration: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`[phase-b] Total tool calls: ${toolCallCount}`);

    if (response?.data?.content) {
      console.log("[phase-b] Agent response:");
      console.log(response.data.content);
    } else {
      console.log("[phase-b] No response content");
    }

    // 5. Disconnect
    await session.disconnect();
    console.log("[phase-b] Session disconnected");
  } catch (err) {
    console.error(
      `[phase-b] Error: ${err instanceof Error ? err.message : err}`,
    );
    console.error(err);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) {
      console.error(
        "[phase-b] Client stop errors:",
        errors.map((e) => e.message),
      );
    }
    browser.disconnect();
    console.log("[phase-b] Done");
  }
}

main();
