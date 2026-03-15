/**
 * Experiment 2+3 — File-based Paste vs Baseline (text in context)
 *
 * Validates that an LLM agent can add a large source via:
 *   A) filePath mode: repoToText → temp file → paste(filePath=...) — text never enters LLM context
 *   B) baseline mode: repoToText → text in ToolResult → paste(text=...) — text enters LLM context
 *
 * Compares: success rate, token usage, speed, whether auto-compact triggers.
 *
 * Usage:
 *   npx tsx spike/browser-capability/paste-filepath-experiment.ts
 *   npx tsx spike/browser-capability/paste-filepath-experiment.ts --size 100000
 *   npx tsx spike/browser-capability/paste-filepath-experiment.ts --mode filePath
 *   npx tsx spike/browser-capability/paste-filepath-experiment.ts --mode baseline
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const TMP_DIR = join(tmpdir(), "nbctl-spike");

// =============================================================================
// UI Map
// =============================================================================

interface UIMap {
  locale: string;
  verified: boolean;
  elements: Record<string, { text: string; match?: string; disambiguate?: string }>;
  selectors: Record<string, string>;
}

function loadUIMap(locale: string): UIMap {
  const filepath = join(UI_MAPS_DIR, `${locale}.json`);
  if (!existsSync(filepath)) {
    return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8"));
  }
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

// =============================================================================
// CDP helpers (self-contained)
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
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  };

  if (text === "Ctrl+A") {
    await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement;
      if (el && typeof el.select === "function") el.select();
    });
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

// =============================================================================
// Tool result helpers
// =============================================================================

function screenshotResult(base64: string, text?: string): ToolResultObject {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filepath = join(SCREENSHOTS_DIR, `paste-fp-${Date.now()}.png`);
  writeFileSync(filepath, Buffer.from(base64, "base64"));
  return {
    textResultForLlm: text ?? "Screenshot captured.",
    resultType: "success",
    binaryResultsForLlm: [{ data: base64, mimeType: "image/png", type: "image" }],
  };
}

function textResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "success" };
}

// =============================================================================
// Generate test content
// =============================================================================

function generateRepoContent(charCount: number): string {
  const lines = [
    "# Sample Repository: TypeScript Best Practices",
    "",
    "## Overview",
    "This document covers TypeScript best practices for large-scale applications.",
    "It includes patterns for type safety, error handling, and project structure.",
    "",
    "## Type Safety Patterns",
    "- Use strict mode in tsconfig.json",
    "- Prefer interfaces over type aliases for object shapes",
    "- Use discriminated unions for state management",
    "- Leverage const assertions for literal types",
    "",
    "## Error Handling",
    "- Create custom error classes extending Error",
    "- Use Result<T, E> pattern for expected failures",
    "- Reserve try-catch for unexpected errors",
    "",
    "## Project Structure",
    "- Organize by feature, not by file type",
    "- Keep barrel exports minimal to avoid circular deps",
    "- Use path aliases for cross-module imports",
    "",
  ];
  const block = lines.join("\n");
  const repeatCount = Math.ceil(charCount / block.length);
  return block.repeat(repeatCount).substring(0, charCount);
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
    description: "Find interactive elements by text/aria-label/placeholder/CSS selector.",
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
          disabled: boolean; center: { x: number; y: number };
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
            });
          }
        }
        if (matches.length === 0) {
          try {
            for (const el of document.querySelectorAll(q)) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              matches.push({
                tag: el.tagName, text: (el.textContent?.trim() ?? "").slice(0, 80),
                ariaLabel: el.getAttribute("aria-label"),
                disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
                center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
              });
            }
          } catch { /* not a valid selector */ }
        }
        return matches;
      }, args.query);
      if (results.length === 0) return textResult(`No elements found for: "${args.query}"`);
      return textResult(results.map((r) => {
        const attrs = [r.ariaLabel ? `aria="${r.ariaLabel}"` : "", r.disabled ? "DISABLED" : ""].filter(Boolean).join(" ");
        return `[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})${attrs ? `  ${attrs}` : ""}`;
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

  const typeTool = defineTool("type", {
    description: "Type text or special keys (Escape, Enter, Tab, Ctrl+A).",
    parameters: z.object({ text: z.string() }),
    handler: async (args) => {
      await dispatchType(cdp, page, args.text);
      return textResult(`Typed: "${args.text}"`);
    },
  });

  const readTool = defineTool("read", {
    description: `Read DOM via CSS selector. Key selectors: ".source-panel" (sources), "h1" (title).`,
    parameters: z.object({ selector: z.string() }),
    handler: async (args) => {
      const result = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return { count: 0, items: [] as Array<{ tag: string; text: string }> };
        return {
          count: els.length,
          items: Array.from(els).map((el) => ({
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 500),
          })),
        };
      }, args.selector);
      if (result.count === 0) return textResult(`(no match for "${args.selector}")`);
      return textResult(result.items.map((item, i) => `[${i + 1}] ${item.tag}: ${item.text.slice(0, 200)}`).join("\n"));
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

  return [screenshotTool, findTool, clickTool, typeTool, readTool, waitTool] as Tool[];
}

// =============================================================================
// Mode A: filePath-based paste (text never enters LLM context)
// =============================================================================

function createFilePathTools(cdp: CDPSession, charCount: number): Tool[] {
  // repoToText: writes to temp file, returns path + metrics only
  const repoToTextTool = defineTool("repoToText", {
    description: "Convert a repository to text. Returns a filePath (the text is saved to a file — do NOT ask for the content). Use paste(filePath=...) to paste it.",
    parameters: z.object({
      repoPath: z.string().describe("Path to the repository"),
    }),
    handler: async (args) => {
      const content = generateRepoContent(charCount);
      mkdirSync(TMP_DIR, { recursive: true });
      const filePath = join(TMP_DIR, `repo-${Date.now()}.txt`);
      writeFileSync(filePath, content, "utf-8");
      console.log(`  [repoToText] Wrote ${content.length.toLocaleString()} chars to ${filePath}`);
      // Return ONLY metadata — no text content
      return textResult(JSON.stringify({
        filePath,
        charCount: content.length,
        wordCount: content.split(/\s+/).length,
        summary: "TypeScript best practices repository covering type safety, error handling, and project structure.",
      }));
    },
  });

  // paste: accepts filePath OR text
  const pasteTool = defineTool("paste", {
    description: "Paste content at cursor. Supports two modes: (1) paste(filePath=...) reads file and pastes — use this for large content from repoToText. (2) paste(text=...) pastes text directly — use for short text only.",
    parameters: z.object({
      filePath: z.string().optional().describe("File path to read and paste (for large content from repoToText)"),
      text: z.string().optional().describe("Short text to paste directly"),
    }),
    handler: async (args) => {
      let content: string;
      if (args.filePath) {
        content = readFileSync(args.filePath, "utf-8");
        console.log(`  [paste] Reading from file: ${args.filePath} (${content.length.toLocaleString()} chars)`);
      } else if (args.text) {
        content = args.text;
      } else {
        return textResult("Error: provide either filePath or text");
      }
      await dispatchPaste(cdp, content);
      return textResult(`Pasted ${content.length.toLocaleString()} chars.`);
    },
  });

  return [repoToTextTool, pasteTool] as Tool[];
}

// =============================================================================
// Mode B: baseline paste (text enters LLM context)
// =============================================================================

function createBaselineTools(cdp: CDPSession, charCount: number): Tool[] {
  // repoToText: returns the full text in the tool result
  const repoToTextTool = defineTool("repoToText", {
    description: "Convert a repository to text. Returns the full text content. Use paste(text=...) to paste it into NotebookLM.",
    parameters: z.object({
      repoPath: z.string().describe("Path to the repository"),
    }),
    handler: async (args) => {
      const content = generateRepoContent(charCount);
      console.log(`  [repoToText] Generated ${content.length.toLocaleString()} chars (returned in ToolResult)`);
      // Return FULL text in the tool result — enters LLM context
      return textResult(content);
    },
  });

  // paste: only accepts text
  const pasteTool = defineTool("paste", {
    description: "Paste text at cursor position. Click target input first.",
    parameters: z.object({ text: z.string() }),
    handler: async (args) => {
      await dispatchPaste(cdp, args.text);
      return textResult(`Pasted ${args.text.length.toLocaleString()} chars.`);
    },
  });

  return [repoToTextTool, pasteTool] as Tool[];
}

// =============================================================================
// Event logger
// =============================================================================

function createEventLogger(label: string) {
  let toolCallCount = 0;
  const handler = (event: SessionEvent) => {
    if (event.type === "tool_call") {
      toolCallCount++;
      const name = event.tool?.name ?? "unknown";
      console.log(`  [${new Date().toLocaleTimeString()}] [${label}] #${toolCallCount} ${name}({})`);
    }
    if (event.type === "message" && event.content) {
      console.log(`  [${new Date().toLocaleTimeString()}] [${label}] message: ${event.content.slice(0, 100)}`);
    }
    if (event.type === "turn_end") {
      console.log(`  [${new Date().toLocaleTimeString()}] [${label}] turn ended`);
    }
  };
  return { handler, get toolCallCount() { return toolCallCount; } };
}

// =============================================================================
// Run experiment
// =============================================================================

interface ExperimentResult {
  mode: "filePath" | "baseline";
  sizeChars: number;
  success: boolean;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

async function runExperiment(
  mode: "filePath" | "baseline",
  client: CopilotClient,
  cdp: CDPSession,
  page: Page,
  uiMap: UIMap,
  charCount: number,
  model: string,
): Promise<ExperimentResult> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Experiment: ${mode} mode, ${(charCount / 1000).toFixed(0)}K chars`);
  console.log(`${"=".repeat(60)}`);

  const t0 = Date.now();

  // Build tools
  const browserTools = createBrowserTools(cdp, page);
  const modeTools = mode === "filePath"
    ? createFilePathTools(cdp, charCount)
    : createBaselineTools(cdp, charCount);
  const allTools = [...browserTools, ...modeTools] as Tool[];

  // System message with step-by-step recipe
  const systemMessage = mode === "filePath"
    ? `你是 NotebookLM 操作助手。你要將 repository 內容作為來源加入 NotebookLM。

## 操作步驟（嚴格按照順序執行）

1. 呼叫 repoToText(repoPath="/fake/repo") → 取得 filePath 和 charCount（text 已存在檔案中，不會回傳給你）
2. find("來源") → click 切換到來源 tab
3. find("新增來源") 或 find("add") → click 開啟 add source dialog
4. find("複製的文字") → click 選擇 copied text 類型
5. find("textarea") 或 find("在這裡貼上文字") → click 確保 textarea 獲得焦點
6. paste(filePath=<步驟1取得的filePath>) → 將檔案內容貼入
7. find("插入") → 確認非 DISABLED → click 送出
8. wait(5) → 等待處理
9. screenshot() → 確認來源已新增
10. read(".source-panel") → 驗證新來源出現在列表

## 重要
- 你**只能用** find, click, type, read, wait, screenshot, repoToText, paste 這些 tools
- repoToText 回傳的是 filePath，**不是文字內容**。用 paste(filePath=...) 貼入
- **禁止**使用 bash, view, edit 等任何其他工具`
    : `你是 NotebookLM 操作助手。你要將 repository 內容作為來源加入 NotebookLM。

## 操作步驟（嚴格按照順序執行）

1. 呼叫 repoToText(repoPath="/fake/repo") → 取得 text 內容
2. find("來源") → click 切換到來源 tab
3. find("新增來源") 或 find("add") → click 開啟 add source dialog
4. find("複製的文字") → click 選擇 copied text 類型
5. find("textarea") 或 find("在這裡貼上文字") → click 確保 textarea 獲得焦點
6. paste(text=<步驟1取得的內容>) → 貼入文字
7. find("插入") → 確認非 DISABLED → click 送出
8. wait(5) → 等待處理
9. screenshot() → 確認來源已新增
10. read(".source-panel") → 驗證新來源出現在列表

## 重要
- 你**只能用** find, click, type, read, wait, screenshot, repoToText, paste 這些 tools
- repoToText 回傳的是完整文字，用 paste(text=...) 貼入
- **禁止**使用 bash, view, edit 等任何其他工具`;

  const logger = createEventLogger(mode);

  try {
    const session = await client.createSession({
      tools: allTools,
      model,
      systemMessage: { mode: "append" as const, content: systemMessage },
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });

    session.on(logger.handler);

    console.log(`[exp] Session: ${session.sessionId}`);

    const prompt = "請將 /fake/repo 這個 repository 的內容加入 NotebookLM 作為來源。";
    const response = await session.sendAndWait({ prompt }, SESSION_TIMEOUT_MS);

    await session.disconnect();

    const durationMs = Date.now() - t0;
    console.log(`[exp] Done: ${(durationMs / 1000).toFixed(1)}s, ${logger.toolCallCount} tool calls`);

    if (response?.data?.content) {
      console.log(`[exp] Response: ${response.data.content.slice(0, 200)}`);
    }

    return {
      mode,
      sizeChars: charCount,
      success: true,
      toolCalls: logger.toolCallCount,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.error(`[exp] ERROR: ${(err as Error).message}`);

    // Try to dismiss dialogs
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 1000));

    return {
      mode,
      sizeChars: charCount,
      success: false,
      toolCalls: logger.toolCallCount,
      durationMs,
      error: (err as Error).message,
    };
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  let charCount = 100_000; // default 100K
  let modes: Array<"filePath" | "baseline"> = ["filePath", "baseline"];
  let model = "gpt-4.1";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--size" && args[i + 1]) charCount = parseInt(args[i + 1], 10);
    if (args[i] === "--mode" && args[i + 1]) modes = [args[i + 1] as "filePath" | "baseline"];
    if (args[i] === "--model" && args[i + 1]) model = args[i + 1];
  }

  console.log("[exp] Connecting to Chrome...");
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm.google.com/notebook"));
  if (!page) {
    throw new Error("No NotebookLM notebook tab found. Navigate to a notebook first.");
  }
  console.log(`[exp] Connected: ${page.url()}`);
  console.log(`[exp] Model: ${model}, Size: ${(charCount / 1000).toFixed(0)}K, Modes: ${modes.join(", ")}`);

  const cdp = await page.createCDPSession();
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = browserLang.startsWith("zh-TW") ? "zh-TW" : "en";
  const uiMap = loadUIMap(locale);

  const client = new CopilotClient({ autoStart: true });
  await new Promise((r) => setTimeout(r, 3000)); // Wait for CLI startup

  const results: ExperimentResult[] = [];

  for (const mode of modes) {
    const result = await runExperiment(mode, client, cdp, page, uiMap, charCount, model);
    results.push(result);

    // Wait between experiments
    await new Promise((r) => setTimeout(r, 3000));
  }

  await client.stop();

  // =============================================================================
  // Summary
  // =============================================================================

  console.log(`\n${"=".repeat(60)}`);
  console.log("  FILE-BASED PASTE EXPERIMENT RESULTS");
  console.log(`${"=".repeat(60)}\n`);

  console.log("| Mode | Size | Success | Tool Calls | Duration | Error |");
  console.log("|------|------|---------|------------|----------|-------|");
  for (const r of results) {
    console.log(
      `| ${r.mode} | ${(r.sizeChars / 1000).toFixed(0)}K | ${r.success ? "✅" : "❌"} | ${r.toolCalls} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.error ?? "-"} |`,
    );
  }

  console.log("\n--- Analysis ---");
  const fp = results.find((r) => r.mode === "filePath");
  const bl = results.find((r) => r.mode === "baseline");
  if (fp && bl) {
    console.log(`filePath: ${fp.success ? "PASS" : "FAIL"} in ${(fp.durationMs / 1000).toFixed(1)}s`);
    console.log(`baseline: ${bl.success ? "PASS" : "FAIL"} in ${(bl.durationMs / 1000).toFixed(1)}s`);
    if (fp.success && !bl.success) {
      console.log("→ filePath mode works, baseline fails — confirms file-based approach is necessary");
    } else if (fp.success && bl.success) {
      console.log(`→ Both work, but filePath saves ~${((bl.sizeChars / 4) / 1000).toFixed(0)}K tokens from LLM context`);
    }
  }

  console.log("\n[exp] Done");
}

main().catch((err) => {
  console.error("[exp] Fatal:", err);
  process.exit(1);
});
