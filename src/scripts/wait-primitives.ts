/**
 * Wait primitives — Node-side polling for DOM state changes.
 *
 * All use Node-side setTimeout + synchronous page.evaluate per poll.
 * This avoids Chrome background-tab throttling (setTimeout → ~1/min).
 * String-form evaluate avoids esbuild __name injection bug.
 */

import type { Page } from "puppeteer-core";
import type { PollOptions, FoundElement } from "./types.js";
import { findElementByText } from "./find-element.js";

interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Poll for answer text stability using djb2 hash comparison.
 * Three-layer check: .thinking-message visibility → hash stability → defense filters.
 */
export async function pollForAnswer(
  page: Page,
  answerSelector: string,
  options?: PollOptions,
): Promise<{ text: string | null; elapsedMs: number; stable: boolean }> {
  const maxWait = options?.maxWaitMs ?? 60_000;
  const stableCount = options?.stableCount ?? 3;
  const pollInterval = options?.pollIntervalMs ?? 1000;
  const rejectPattern = options?.rejectPattern ?? "Thinking|Refining|Checking|正在思考|正在整理|正在檢查";
  const baselineHash = options?.baselineHash ?? "";
  const rejectRe = rejectPattern ? new RegExp(rejectPattern, "i") : null;

  const startTime = Date.now();
  let lastHash = "";
  let sameCount = 0;
  let stable = false;

  while (Date.now() - startTime < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));

    // Layer 1: .thinking-message visibility check
    const isThinking = await page.evaluate(`(() => {
      const el = document.querySelector('div.thinking-message');
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })()`) as boolean;

    if (isThinking) { sameCount = 0; lastHash = ""; continue; }

    // Layer 2: text hash stability check
    const check = await page.evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(answerSelector)});
      if (els.length === 0) return { hash: "", len: 0, sample: "" };
      const target = els[els.length - 1];
      const text = (target.textContent || "").trim();
      let h = 5381;
      for (let i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; }
      return { hash: h.toString(36), len: text.length, sample: text.slice(0, 60) };
    })()`) as { hash: string; len: number; sample: string };

    if (!check.hash || check.len === 0) { sameCount = 0; lastHash = ""; continue; }

    // Layer 3: Defense-in-depth filters
    if (check.len < 50) { sameCount = 0; lastHash = ""; continue; }
    if (rejectRe && rejectRe.test(check.sample)) { sameCount = 0; lastHash = ""; continue; }
    if (baselineHash && check.hash === baselineHash) { sameCount = 0; lastHash = ""; continue; }

    // Stability check
    if (check.hash === lastHash) {
      sameCount++;
      if (sameCount >= stableCount) { stable = true; break; }
    } else {
      lastHash = check.hash;
      sameCount = 1;
    }
  }

  // One full serialization to fetch final text
  const text = await page.evaluate(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(answerSelector)});
    if (els.length === 0) return null;
    const target = els[els.length - 1];
    return ((target.textContent || "").trim()).slice(0, 5000) || null;
  })()`) as string | null;

  return { text, elapsedMs: Date.now() - startTime, stable };
}

/**
 * Wait until a CSS selector's elements are all gone (hidden or removed).
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
 * Wait until page URL changes or matches a pattern.
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
