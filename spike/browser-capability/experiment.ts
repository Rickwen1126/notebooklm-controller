/**
 * Browser Capability Spike — Experiment Script
 *
 * Launches Chrome with CDP debugging and exposes the project's 5 CDP helpers
 * as CLI commands for AI-driven browser interaction testing.
 *
 * Usage:
 *   npx tsx spike/browser-capability/experiment.ts <command> [args...]
 *
 * Commands:
 *   launch                              Start Chrome with CDP debug port
 *   status                              Check Chrome status + page URLs
 *   screenshot                          Capture screenshot → PNG file
 *   click <x> <y>                       Click at coordinates
 *   type <text>                         Type text (char by char)
 *   scroll <x> <y> <deltaX> <deltaY>   Scroll at coordinates
 *   paste <text>                        Paste text at cursor
 *   navigate <url>                      Navigate to URL
 *   close                               Close Chrome
 */

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  captureScreenshot,
  dispatchClick,
  dispatchType,
  dispatchScroll,
  dispatchPaste,
} from "../../src/tab-manager/cdp-helpers.js";

// --- Config ---

const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USER_DATA_DIR = join(homedir(), ".nbctl", "profiles", "spike");
const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const NOTEBOOKLM_HOME = "https://notebooklm.google.com";

// --- Infrastructure helpers (not counted as "tools") ---

async function isChromeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForChrome(timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isChromeRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function connectToPage() {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  // Prefer a NotebookLM page, fall back to first page
  const page =
    pages.find((p) => p.url().includes("notebooklm.google.com")) ?? pages[0];
  if (!page) throw new Error("No pages found in Chrome");
  const cdp = await page.createCDPSession();
  return { browser, page, cdp };
}

// --- Commands ---

async function launch() {
  if (await isChromeRunning()) {
    console.log(`Chrome already running on port ${CDP_PORT}`);
    return;
  }

  mkdirSync(USER_DATA_DIR, { recursive: true });

  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      NOTEBOOKLM_HOME,
    ],
    { detached: true, stdio: "ignore" },
  );
  chrome.unref();

  console.log(`Launching Chrome (PID: ${chrome.pid})...`);

  if (await waitForChrome()) {
    console.log(`Chrome ready on ${CDP_URL}`);
  } else {
    console.error("Chrome failed to start within 15s");
    process.exit(1);
  }
}

async function status() {
  if (!(await isChromeRunning())) {
    console.log("Chrome not running");
    return;
  }
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  console.log(`Chrome running. ${pages.length} tab(s):`);
  for (const page of pages) {
    console.log(`  - ${page.url()}`);
  }
  browser.disconnect();
}

async function doScreenshot() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const { browser, page, cdp } = await connectToPage();

  // Get viewport size for coordinate reference
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));

  const data = await captureScreenshot(cdp);
  const filename = `screenshot-${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, Buffer.from(data, "base64"));

  console.log(filepath);
  console.log(
    `Viewport: ${viewport.width}x${viewport.height} (DPR: ${viewport.devicePixelRatio})`,
  );
  console.log(`Page: ${page.url()}`);

  browser.disconnect();
}

async function doClick(x: number, y: number) {
  if (isNaN(x) || isNaN(y)) {
    console.error("Usage: click <x> <y>");
    process.exit(1);
  }
  const { browser, cdp } = await connectToPage();
  await dispatchClick(cdp, x, y);
  console.log(`Clicked at (${x}, ${y})`);
  browser.disconnect();
}

async function doType(text: string) {
  if (!text) {
    console.error("Usage: type <text>");
    process.exit(1);
  }
  const { browser, cdp } = await connectToPage();
  await dispatchType(cdp, text);
  console.log(`Typed: "${text}"`);
  browser.disconnect();
}

async function doScroll(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
) {
  if ([x, y, deltaX, deltaY].some(isNaN)) {
    console.error("Usage: scroll <x> <y> <deltaX> <deltaY>");
    process.exit(1);
  }
  const { browser, cdp } = await connectToPage();
  await dispatchScroll(cdp, x, y, deltaX, deltaY);
  console.log(`Scrolled at (${x}, ${y}) by (${deltaX}, ${deltaY})`);
  browser.disconnect();
}

async function doPaste(text: string) {
  if (!text) {
    console.error("Usage: paste <text>");
    process.exit(1);
  }
  const { browser, cdp } = await connectToPage();
  await dispatchPaste(cdp, text);
  console.log(
    `Pasted: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
  );
  browser.disconnect();
}

async function doRead(selector: string) {
  if (!selector) {
    console.error("Usage: read <css-selector|text-query>");
    process.exit(1);
  }
  const { browser, page } = await connectToPage();
  const result = await page.evaluate((q) => {
    // Try CSS selector first
    try {
      const els = document.querySelectorAll(q);
      if (els.length > 0) {
        const items = Array.from(els).map((el) => {
          const style = getComputedStyle(el);
          return {
            tag: el.tagName,
            text: (el.textContent?.trim() ?? "").slice(0, 500),
            visible: style.visibility !== "hidden" && style.display !== "none",
          };
        });
        return { count: items.length, items };
      }
    } catch {
      // Not a valid selector
    }
    // Fallback: find elements containing the query text
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
    );
    const items: Array<{ tag: string; text: string; visible: boolean }> = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node as Element;
      if (el.children.length === 0 || el.matches?.("p, li, h1, h2, h3, span, div.response, [class*=message], [class*=answer], [class*=response]")) {
        const t = el.textContent?.trim();
        if (t && t.includes(q)) {
          const style = getComputedStyle(el);
          items.push({
            tag: el.tagName,
            text: t.slice(0, 500),
            visible: style.visibility !== "hidden" && style.display !== "none",
          });
        }
      }
    }
    return { count: items.length, items };
  }, selector);

  if (result.count === 0) {
    console.log("(no match)");
  } else {
    console.log(`Found ${result.count} element(s):`);
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      const vis = item.visible ? "" : " (HIDDEN)";
      const preview = item.text.length > 200 ? item.text.slice(0, 200) + "..." : item.text;
      console.log(`[${i + 1}] ${item.tag}${vis}: ${preview}`);
    }
  }
  browser.disconnect();
}

async function doFind(query: string) {
  if (!query) {
    console.error("Usage: find <text|selector>");
    process.exit(1);
  }
  const { browser, page } = await connectToPage();
  const results = await page.evaluate((q) => {
    // Try text match first, then CSS selector
    const matches: Array<{
      tag: string;
      text: string;
      ariaLabel: string | null;
      disabled: boolean;
      ariaExpanded: string | null;
      center: { x: number; y: number };
      rect: { x: number; y: number; w: number; h: number };
    }> = [];

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
          text: text.slice(0, 60),
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

    // If no text matches, try as CSS selector
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
            text: (el.textContent?.trim() ?? "").slice(0, 60),
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
        // Not a valid selector, ignore
      }
    }

    return matches;
  }, query);

  if (results.length === 0) {
    console.log(`No elements found for: "${query}"`);
  } else {
    for (const r of results) {
      const attrs = [
        r.ariaLabel ? `aria="${r.ariaLabel}"` : "",
        r.disabled ? "DISABLED" : "",
        r.ariaExpanded !== null ? `expanded=${r.ariaExpanded}` : "",
      ].filter(Boolean).join(" ");
      console.log(
        `[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})  rect(${r.rect.x},${r.rect.y} ${r.rect.w}x${r.rect.h})${attrs ? `  ${attrs}` : ""}`,
      );
    }
  }
  browser.disconnect();
}

async function doShot(query?: string) {
  // Combined: screenshot + optional find (saves one round-trip)
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const { browser, page, cdp } = await connectToPage();

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));

  const data = await captureScreenshot(cdp);
  const filename = `screenshot-${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, Buffer.from(data, "base64"));

  console.log(filepath);
  console.log(
    `Viewport: ${viewport.width}x${viewport.height} (DPR: ${viewport.devicePixelRatio})`,
  );
  console.log(`Page: ${page.url()}`);

  if (query) {
    const results = await page.evaluate((q) => {
      const matches: Array<{
        tag: string;
        text: string;
        center: { x: number; y: number };
      }> = [];
      const all = document.querySelectorAll(
        "button, a, input, textarea, [role=button], [role=link], tr[tabindex], select, [contenteditable]",
      );
      for (const el of all) {
        const text = el.textContent?.trim() ?? "";
        const ariaLabel = el.getAttribute("aria-label") ?? "";
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (
          text.includes(q) ||
          ariaLabel.includes(q) ||
          el.getAttribute("placeholder")?.includes(q)
        ) {
          matches.push({
            tag: el.tagName,
            text: text.slice(0, 60),
            center: {
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
            },
          });
        }
      }
      return matches;
    }, query);
    console.log(`--- find "${query}" ---`);
    for (const r of results) {
      console.log(`[${r.tag}] "${r.text}" → click(${r.center.x}, ${r.center.y})`);
    }
  }

  browser.disconnect();
}

async function doNavigate(url: string) {
  if (!url) {
    console.error("Usage: navigate <url>");
    process.exit(1);
  }
  const { browser, page } = await connectToPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
  console.log(`Navigated to: ${page.url()}`);
  browser.disconnect();
}

async function doResize(width: number, height: number) {
  if (isNaN(width) || isNaN(height)) {
    console.error("Usage: resize <width> <height>");
    process.exit(1);
  }
  const { browser, cdp } = await connectToPage();
  const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
    windowId: number;
  };
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width, height },
  });
  console.log(`Window resized to ${width}x${height}`);
  browser.disconnect();
}

async function closeBrowser() {
  if (!(await isChromeRunning())) {
    console.log("Chrome not running");
    return;
  }
  const browser = await puppeteer.connect({
    browserURL: CDP_URL,
    defaultViewport: null,
  });
  await browser.close();
  console.log("Chrome closed");
}

// --- CLI Router ---

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "launch":
      await launch();
      break;
    case "status":
      await status();
      break;
    case "screenshot":
      await doScreenshot();
      break;
    case "click":
      await doClick(Number(args[0]), Number(args[1]));
      break;
    case "type":
      await doType(args.join(" "));
      break;
    case "scroll":
      await doScroll(
        Number(args[0]),
        Number(args[1]),
        Number(args[2]),
        Number(args[3]),
      );
      break;
    case "paste":
      await doPaste(args.join(" "));
      break;
    case "read":
      await doRead(args.join(" "));
      break;
    case "find":
      await doFind(args.join(" "));
      break;
    case "shot":
      await doShot(args.length > 0 ? args.join(" ") : undefined);
      break;
    case "navigate":
      await doNavigate(args[0]);
      break;
    case "resize":
      await doResize(Number(args[0]), Number(args[1]));
      break;
    case "close":
      await closeBrowser();
      break;
    default:
      console.log(`Browser Capability Spike — Experiment Script

Usage: npx tsx spike/browser-capability/experiment.ts <command> [args...]

Commands:
  launch                              Start Chrome with CDP debug port
  status                              Check Chrome status + page URLs
  screenshot                          Capture screenshot → PNG file
  click <x> <y>                       Click at coordinates
  type <text>                         Type text (char by char)
  scroll <x> <y> <deltaX> <deltaY>   Scroll at coordinates
  paste <text>                        Paste text at cursor
  navigate <url>                      Navigate to URL
  close                               Close Chrome

Tools constraint: only the 5 CDP helpers from src/tab-manager/cdp-helpers.ts
  captureScreenshot | dispatchClick | dispatchType | dispatchScroll | dispatchPaste`);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
