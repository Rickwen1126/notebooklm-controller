/**
 * Phase G — Shared types, CDP helpers, UI map, log utilities
 *
 * Reuses patterns from phase-f.ts but extracted for modular use.
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page, Browser } from "puppeteer-core";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultObject, SessionEvent } from "@github/copilot-sdk";

// =============================================================================
// Config
// =============================================================================

export const CDP_PORT = 9222;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
export const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");
export const UI_MAPS_DIR = join(import.meta.dirname, "ui-maps");

// =============================================================================
// Core types
// =============================================================================

export interface ScriptLogEntry {
  step: number;
  action: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  durationMs: number;
}

export interface ScriptResult {
  operation: string;
  status: "success" | "partial" | "fail";
  result: string | null;
  log: ScriptLogEntry[];
  totalMs: number;
  failedAtStep: number | null;
  failedSelector: string | null;
}

export interface SelectorPatch {
  elementKey: string;
  oldValue: string;
  newValue: string;
  confidence: number;
  reasoning: string;
}

// =============================================================================
// UI Map
// =============================================================================

export interface UIMapElement {
  text: string;
  match?: string;
  disambiguate?: string;
}

export interface UIMap {
  locale: string;
  verified: boolean;
  elements: Record<string, UIMapElement>;
  selectors: Record<string, string>;
}

export function resolveLocale(browserLang: string): string {
  if (browserLang.startsWith("zh-TW") || browserLang.includes("Hant")) return "zh-TW";
  if (browserLang.startsWith("zh")) return "zh-CN";
  return "en";
}

export function loadUIMap(locale: string): UIMap {
  const filepath = join(UI_MAPS_DIR, `${locale}.json`);
  if (!existsSync(filepath)) {
    return JSON.parse(readFileSync(join(UI_MAPS_DIR, "en.json"), "utf-8"));
  }
  return JSON.parse(readFileSync(filepath, "utf-8"));
}

// =============================================================================
// Log utilities
// =============================================================================

export function createLogEntry(
  step: number,
  action: string,
  status: "ok" | "warn" | "fail",
  detail: string,
  startMs: number,
): ScriptLogEntry {
  return { step, action, status, detail, durationMs: Date.now() - startMs };
}

export function formatLogForAgent(log: ScriptLogEntry[]): string {
  const lines = log.map((entry) => {
    const icon = entry.status === "ok" ? "✓" : entry.status === "warn" ? "⚠" : "✗";
    return `  [${icon}] Step ${entry.step}: ${entry.action} (${entry.durationMs}ms) — ${entry.detail}`;
  });
  return lines.join("\n");
}

// =============================================================================
// corruptUIMap — for testing repair agent
// =============================================================================

export function corruptUIMap(uiMap: UIMap, key: string): { corrupted: UIMap; original: string } {
  const copy: UIMap = JSON.parse(JSON.stringify(uiMap));

  // Check elements first
  if (copy.elements[key]) {
    const original = copy.elements[key].text;
    copy.elements[key].text = `.BROKEN-${key}-${Date.now()}`;
    return { corrupted: copy, original };
  }

  // Check selectors
  if (copy.selectors[key]) {
    const original = copy.selectors[key];
    copy.selectors[key] = `.BROKEN-${key}-${Date.now()}`;
    return { corrupted: copy, original };
  }

  throw new Error(`Key "${key}" not found in UIMap elements or selectors`);
}

// =============================================================================
// Chrome connection
// =============================================================================

export async function connectToChrome(): Promise<{ browser: Browser; page: Page; cdp: CDPSession }> {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm.google.com")) ?? pages[0];
  if (!page) throw new Error("No pages found in Chrome");
  const cdp = await page.createCDPSession();
  return { browser, page, cdp };
}

// =============================================================================
// CDP helpers (reused from phase-f)
// =============================================================================

export async function captureScreenshot(cdp: CDPSession): Promise<string> {
  const result = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  return result.data;
}

export async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function dispatchPaste(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

export async function dispatchType(cdp: CDPSession, page: Page, text: string): Promise<void> {
  const specialKeys: Record<string, { key: string; code: string; keyCode: number }> = {
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  };
  if (text === "Ctrl+A" || text === "ctrl+a") {
    const selected = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        el.select();
        return true;
      }
      const sel = window.getSelection();
      if (sel && document.activeElement) {
        sel.selectAllChildren(document.activeElement);
        return true;
      }
      return false;
    });
    if (!selected) {
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

// =============================================================================
// findElementByText — targeted DOM query (not full find tool scan)
// =============================================================================

export interface FoundElement {
  tag: string;
  text: string;
  center: { x: number; y: number };
  rect: { x: number; y: number; w: number; h: number };
  disabled: boolean;
}

export async function findElementByText(
  page: Page,
  text: string,
  options?: { match?: "text" | "placeholder" | "aria-label"; disambiguate?: string },
): Promise<FoundElement | null> {
  const matchType = options?.match ?? "text";
  const disambiguate = options?.disambiguate;

  const results = await page.evaluate(
    (searchText: string, matchType: string) => {
      const INTERACTIVE = [
        "button", "a", "input", "textarea", "select",
        "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
        "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
        "[role=combobox]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]",
      ].join(", ");

      const matches: Array<{
        tag: string; text: string; disabled: boolean;
        center: { x: number; y: number };
        rect: { x: number; y: number; w: number; h: number };
      }> = [];

      for (const el of document.querySelectorAll(INTERACTIVE)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;

        let found = false;
        if (matchType === "placeholder") {
          found = el.getAttribute("placeholder")?.includes(searchText) ?? false;
        } else if (matchType === "aria-label") {
          found = el.getAttribute("aria-label")?.includes(searchText) ?? false;
        } else {
          found = (el.textContent?.trim() ?? "").includes(searchText);
        }

        if (found) {
          matches.push({
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 80),
            disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
            center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
      }
      return matches;
    },
    text,
    matchType,
  );

  if (results.length === 0) return null;

  // Apply disambiguate filter (e.g., "y>400")
  if (disambiguate) {
    const match = disambiguate.match(/^([xy])\s*([><])\s*(\d+)$/);
    if (match) {
      const [, axis, op, val] = match;
      const threshold = parseInt(val, 10);
      const filtered = results.filter((r) => {
        const v = axis === "y" ? r.center.y : r.center.x;
        return op === ">" ? v > threshold : v < threshold;
      });
      if (filtered.length > 0) return filtered[0];
    }
  }

  return results[0];
}

// =============================================================================
// Wait primitives — Node-side polling, not throttled by Chrome background tabs
// =============================================================================

interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Wait until a CSS selector's elements are all gone (display:none, visibility:hidden, or removed).
 * Used for: .thinking-message disappear, dialog close, source removal, chat clear.
 */
export async function waitForGone(
  page: Page,
  selector: string,
  options?: WaitOptions,
): Promise<{ gone: boolean; elapsedMs: number }> {
  const timeout = options?.timeoutMs ?? 30_000;
  const interval = options?.pollIntervalMs ?? 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const visible = await page.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        return true;
      }
      return false;
    })()`) as boolean;

    if (!visible) return { gone: true, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { gone: false, elapsedMs: Date.now() - start };
}

/**
 * Wait until a CSS selector has at least one visible element.
 * Used for: dialog appear, source panel visible, h1 loaded.
 */
export async function waitForVisible(
  page: Page,
  selector: string,
  options?: WaitOptions,
): Promise<{ visible: boolean; elapsedMs: number }> {
  const timeout = options?.timeoutMs ?? 15_000;
  const interval = options?.pollIntervalMs ?? 300;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const found = await page.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        return true;
      }
      return false;
    })()`) as boolean;

    if (found) return { visible: true, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { visible: false, elapsedMs: Date.now() - start };
}

/**
 * Wait until a button/element found by text is NOT disabled.
 * Used for: insert button enable after content paste.
 */
export async function waitForEnabled(
  page: Page,
  text: string,
  matchType: "text" | "placeholder" | "aria-label" = "text",
  options?: WaitOptions,
): Promise<{ enabled: boolean; element: FoundElement | null; elapsedMs: number }> {
  const timeout = options?.timeoutMs ?? 10_000;
  const interval = options?.pollIntervalMs ?? 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const el = await findElementByText(page, text, { match: matchType });
    if (el && !el.disabled) return { enabled: true, element: el, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { enabled: false, element: null, elapsedMs: Date.now() - start };
}

/**
 * Wait until page URL matches a pattern (or changes from initial).
 * Used for: create notebook redirect.
 */
export async function waitForNavigation(
  page: Page,
  opts?: WaitOptions & { urlContains?: string; notUrl?: string },
): Promise<{ navigated: boolean; url: string; elapsedMs: number }> {
  const timeout = opts?.timeoutMs ?? 15_000;
  const interval = opts?.pollIntervalMs ?? 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const url = page.url();
    if (opts?.urlContains && url.includes(opts.urlContains)) {
      return { navigated: true, url, elapsedMs: Date.now() - start };
    }
    if (opts?.notUrl && url !== opts.notUrl) {
      return { navigated: true, url, elapsedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { navigated: false, url: page.url(), elapsedMs: Date.now() - start };
}

/**
 * Wait for element count to change from a baseline.
 * Used for: source count after add/remove.
 */
export async function waitForCountChange(
  page: Page,
  selector: string,
  baselineCount: number,
  options?: WaitOptions,
): Promise<{ changed: boolean; newCount: number; elapsedMs: number }> {
  const timeout = options?.timeoutMs ?? 15_000;
  const interval = options?.pollIntervalMs ?? 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const count = await page.evaluate(`(() => {
      return document.querySelectorAll(${JSON.stringify(selector)}).length;
    })()`) as number;

    if (count !== baselineCount) {
      return { changed: true, newCount: count, elapsedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { changed: false, newCount: baselineCount, elapsedMs: Date.now() - start };
}

// =============================================================================
// Tool result helpers
// =============================================================================

export function screenshotResult(base64: string, text?: string): ToolResultObject {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filepath = join(SCREENSHOTS_DIR, `phase-g-${Date.now()}.png`);
  writeFileSync(filepath, Buffer.from(base64, "base64"));
  return {
    textResultForLlm: text ?? "Screenshot captured.",
    resultType: "success",
    binaryResultsForLlm: [{ data: base64, mimeType: "image/png", type: "image" }],
  };
}

export function textResult(text: string): ToolResultObject {
  return { textResultForLlm: text, resultType: "success" };
}

// =============================================================================
// Event logger (reused from phase-f)
// =============================================================================

export function createEventLogger(label: string) {
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
