/**
 * Experiment 1 — NotebookLM "Copied text" paste character limit
 *
 * Tests paste sizes: 10K, 50K, 100K, 200K, 500K chars
 * For each size:
 *   1. Open "Add source" → "Copied text"
 *   2. Paste generated text
 *   3. Click submit
 *   4. Check if source was added successfully or if error occurred
 *   5. Screenshot + record result
 *   6. Clean up (remove source) for next test
 *
 * Usage:
 *   # Chrome must be running on port 9222
 *   npx tsx spike/browser-capability/paste-limit-experiment.ts
 *   npx tsx spike/browser-capability/paste-limit-experiment.ts --sizes 10000,50000
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page } from "puppeteer-core";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Config
// =============================================================================

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");
const UI_MAPS_DIR = join(import.meta.dirname, "ui-maps");

const DEFAULT_SIZES = [10_000, 50_000, 100_000, 200_000, 500_000];

// =============================================================================
// UI Map
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
  const result = (await cdp.send("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  return result.data;
}

async function saveScreenshot(cdp: CDPSession, label: string): Promise<string> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const base64 = await captureScreenshot(cdp);
  const filepath = join(SCREENSHOTS_DIR, `paste-limit-${label}-${Date.now()}.png`);
  writeFileSync(filepath, Buffer.from(base64, "base64"));
  console.log(`  [screenshot] ${filepath}`);
  return filepath;
}

async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchPaste(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Find elements by text content, return coordinates
async function findElements(
  page: Page,
  searchText: string,
  options?: { match?: string },
): Promise<Array<{ text: string; x: number; y: number; width: number; height: number; tag: string }>> {
  const matchType = options?.match ?? "text";

  return page.evaluate(
    (search, match) => {
      const results: Array<{ text: string; x: number; y: number; width: number; height: number; tag: string }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        let found = false;

        if (match === "text") {
          const directText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent?.trim())
            .join(" ");
          if (directText.includes(search)) found = true;
          if (!found && el.textContent?.trim() === search) found = true;
        } else if (match === "placeholder") {
          const placeholder = el.getAttribute("placeholder") ?? "";
          if (placeholder.includes(search)) found = true;
        } else if (match === "aria-label") {
          const aria = el.getAttribute("aria-label") ?? "";
          if (aria.includes(search)) found = true;
        }

        if (found) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              text: el.textContent?.trim().substring(0, 80) ?? "",
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              tag: el.tagName.toLowerCase(),
            });
          }
        }
      }
      return results;
    },
    searchText,
    matchType,
  );
}

// Find a textarea or contenteditable for paste
async function findTextArea(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    // Look for textarea first
    const textareas = document.querySelectorAll("textarea");
    for (const ta of textareas) {
      const rect = ta.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 50) {
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      }
    }
    // Look for contenteditable
    const editables = document.querySelectorAll("[contenteditable='true']");
    for (const el of editables) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 50) {
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      }
    }
    return null;
  });
}

// =============================================================================
// Generate test text
// =============================================================================

function generateText(charCount: number): string {
  const line = "This is a test line for NotebookLM paste limit experiment. It contains information about software development, TypeScript, and web technologies. ";
  const lineLen = line.length;
  const repeatCount = Math.ceil(charCount / lineLen);
  const fullText = line.repeat(repeatCount).substring(0, charCount);
  return fullText;
}

// =============================================================================
// Core experiment: paste text of given size
// =============================================================================

interface ExperimentResult {
  sizeChars: number;
  sizeLabel: string;
  pasteSuccess: boolean;
  sourceAdded: boolean;
  actualPastedChars: number;
  error?: string;
  durationMs: number;
  screenshotPath: string;
}

async function runSingleExperiment(
  page: Page,
  cdp: CDPSession,
  uiMap: UIMap,
  sizeChars: number,
): Promise<ExperimentResult> {
  const sizeLabel = sizeChars >= 1000 ? `${sizeChars / 1000}K` : `${sizeChars}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Testing paste: ${sizeLabel} chars (${sizeChars.toLocaleString()})`);
  console.log(`${"=".repeat(60)}`);

  try {
    // Step 1: Ensure add source dialog is open
    console.log("  [1] Opening 'Add source' dialog...");
    const copiedTextLabel = uiMap.elements["copied_text_source_type"]?.text ?? "複製的文字";
    let copiedTextEls = await findElements(page, copiedTextLabel);

    if (copiedTextEls.length === 0) {
      // Dialog not open yet — first click "來源" tab, then find add source button
      const sourceTabEls = await findElements(page, "來源");
      if (sourceTabEls.length > 0) {
        await dispatchClick(cdp, sourceTabEls[0].x, sourceTabEls[0].y);
        await sleep(1500);
      }

      // Try "新增來源" or "add_source" or the "+" icon
      const addSourceText = uiMap.elements["add_source"]?.text ?? "新增來源";
      let addSourceEls = await findElements(page, addSourceText);
      if (addSourceEls.length === 0) {
        // Try aria-label match for add button
        addSourceEls = await findElements(page, "新增來源", { match: "aria-label" });
      }
      if (addSourceEls.length === 0) {
        // Try "add" icon
        addSourceEls = await findElements(page, "add");
      }
      if (addSourceEls.length === 0) {
        // Last resort: look for "+" in source panel
        addSourceEls = await findElements(page, "+");
      }

      if (addSourceEls.length > 0) {
        await dispatchClick(cdp, addSourceEls[0].x, addSourceEls[0].y);
      } else {
        throw new Error("Cannot find add source button");
      }
      await sleep(2000);
      copiedTextEls = await findElements(page, copiedTextLabel);
    }

    // Step 2: Click "Copied text" option
    console.log("  [2] Clicking 'Copied text'...");
    if (copiedTextEls.length === 0) {
      throw new Error(`Cannot find '${copiedTextLabel}' option`);
    }
    await dispatchClick(cdp, copiedTextEls[0].x, copiedTextEls[0].y);
    await sleep(2000);
    await saveScreenshot(cdp, `${sizeLabel}-after-copied-text`);

    // Step 3: Find textarea and click it
    console.log("  [3] Finding textarea...");
    const textarea = await findTextArea(page);
    if (!textarea) {
      throw new Error("Cannot find textarea for paste");
    }
    await dispatchClick(cdp, textarea.x, textarea.y);
    await sleep(500);

    // Step 4: Generate and paste text
    console.log(`  [4] Generating ${sizeLabel} chars of text...`);
    const text = generateText(sizeChars);
    console.log(`  [4] Pasting ${text.length.toLocaleString()} chars...`);
    const pasteStart = Date.now();
    await dispatchPaste(cdp, text);
    const pasteMs = Date.now() - pasteStart;
    console.log(`  [4] Paste completed in ${pasteMs}ms`);
    await sleep(1000);

    // Step 5: Check how many chars were actually pasted
    const actualChars = await page.evaluate(() => {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        if (ta.value.length > 0) return ta.value.length;
      }
      const editables = document.querySelectorAll("[contenteditable='true']");
      for (const el of editables) {
        if ((el.textContent?.length ?? 0) > 0) return el.textContent?.length ?? 0;
      }
      return 0;
    });
    console.log(`  [5] Actual pasted chars: ${actualChars.toLocaleString()} / ${sizeChars.toLocaleString()}`);

    await saveScreenshot(cdp, `${sizeLabel}-after-paste`);

    // Step 6: Click "Insert" / submit button
    console.log("  [6] Clicking submit/insert...");
    const insertText = uiMap.elements["insert_button"]?.text ?? "插入";
    const insertEls = await findElements(page, insertText);
    if (insertEls.length === 0) {
      throw new Error(`Cannot find '${insertText}' button`);
    }
    // Pick the last match (usually the button, not the header text)
    const insertBtn = insertEls[insertEls.length - 1];
    console.log(`  [6] Found '${insertText}' at (${insertBtn.x}, ${insertBtn.y}) tag=${insertBtn.tag}`);
    await dispatchClick(cdp, insertBtn.x, insertBtn.y);
    await sleep(8000); // Wait for processing (larger texts need more time)

    const screenshotPath = await saveScreenshot(cdp, `${sizeLabel}-after-insert`);

    // Step 7: Check if source was added
    // After successful insert, the dialog closes and we're back on the notebook main page
    // Check: (a) dialog is gone, (b) source count text visible like "1 個來源" or "N 個來源"
    const checkResult = await page.evaluate(() => {
      const body = document.body.textContent ?? "";
      const dialogOpen = body.includes("貼上複製的文字") || body.includes("Paste copied text");
      // Match "N 個來源" pattern
      const sourceCountMatch = body.match(/(\d+)\s*個來源/);
      const sourceCount = sourceCountMatch ? parseInt(sourceCountMatch[1], 10) : 0;
      return { dialogOpen, sourceCount };
    });
    const reallyAdded = !checkResult.dialogOpen && checkResult.sourceCount > 0;
    console.log(`  [7] Source added: ${reallyAdded} (dialogOpen=${checkResult.dialogOpen}, sourceCount=${checkResult.sourceCount})`);

    // Step 8: Clean up — remove the source we just added, or dismiss dialog
    if (reallyAdded) {
      console.log("  [8] Cleaning up — removing added source...");
      await cleanupSource(page, cdp, uiMap);
    } else if (dialogStillOpen) {
      console.log("  [8] Dialog still open, pressing Escape to dismiss...");
      // Press back arrow or X to go back to add source dialog, then Escape
      await page.keyboard.press("Escape");
      await sleep(1000);
      await page.keyboard.press("Escape");
      await sleep(1000);
    }

    return {
      sizeChars,
      sizeLabel,
      pasteSuccess: actualChars > 0,
      sourceAdded: reallyAdded,
      actualPastedChars: actualChars,
      durationMs: Date.now() - startTime,
      screenshotPath,
    };
  } catch (err) {
    const screenshotPath = await saveScreenshot(cdp, `${sizeLabel}-error`);
    console.error(`  [ERROR] ${(err as Error).message}`);

    // Try to dismiss any open dialog/modal
    await page.keyboard.press("Escape");
    await sleep(1000);
    await page.keyboard.press("Escape");
    await sleep(1000);

    return {
      sizeChars,
      sizeLabel,
      pasteSuccess: false,
      sourceAdded: false,
      actualPastedChars: 0,
      error: (err as Error).message,
      durationMs: Date.now() - startTime,
      screenshotPath,
    };
  }
}

// =============================================================================
// Cleanup: remove the last added source
// =============================================================================

async function cleanupSource(page: Page, cdp: CDPSession, uiMap: UIMap): Promise<void> {
  try {
    // Click "來源" tab first
    const sourceTabEls = await findElements(page, "來源");
    if (sourceTabEls.length > 0) {
      await dispatchClick(cdp, sourceTabEls[0].x, sourceTabEls[0].y);
      await sleep(2000);
    }

    // Find "Pasted text" / "貼上的文字" source and its more_vert menu
    const pastedTextLabel = "貼上的文字";
    const pastedEls = await findElements(page, pastedTextLabel);
    if (pastedEls.length === 0) {
      console.log("  [cleanup] No pasted text source found, skipping");
      return;
    }

    // Find more_vert buttons near the source
    const moreVertEls = await findElements(page, "more_vert");
    if (moreVertEls.length === 0) {
      console.log("  [cleanup] No more_vert button found, skipping");
      return;
    }

    // Click the more_vert closest to the pasted text y coordinate
    const targetY = pastedEls[0].y;
    const closest = moreVertEls.reduce((best, el) =>
      Math.abs(el.y - targetY) < Math.abs(best.y - targetY) ? el : best,
    );
    await dispatchClick(cdp, closest.x, closest.y);
    await sleep(1000);

    // Click "Delete" / "刪除"
    const deleteText = uiMap.elements["remove_source"]?.text ?? "刪除";
    const deleteEls = await findElements(page, deleteText);
    if (deleteEls.length > 0) {
      await dispatchClick(cdp, deleteEls[0].x, deleteEls[0].y);
      await sleep(1000);
      // Confirm deletion dialog
      const confirmEls = await findElements(page, deleteText);
      if (confirmEls.length > 0) {
        await dispatchClick(cdp, confirmEls[confirmEls.length - 1].x, confirmEls[confirmEls.length - 1].y);
      }
      await sleep(2000);
    }
    console.log("  [cleanup] Source removed");
  } catch (err) {
    console.log(`  [cleanup] Failed: ${(err as Error).message}`);
    await page.keyboard.press("Escape");
    await sleep(1000);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  let sizes = DEFAULT_SIZES;

  // Parse --sizes flag
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sizes" && args[i + 1]) {
      sizes = args[i + 1].split(",").map((s) => parseInt(s.trim(), 10));
    }
  }

  console.log("[paste-limit] Connecting to Chrome...");
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("notebooklm.google.com"));
  if (!page) {
    throw new Error("No NotebookLM tab found. Open a notebook first.");
  }
  console.log(`[paste-limit] Connected: ${page.url()}`);

  // Ensure we're inside a notebook (not homepage)
  if (!page.url().includes("/notebook/")) {
    throw new Error("Must be inside a notebook (not homepage). Navigate to a notebook first.");
  }

  const cdp = await page.createCDPSession();

  // Detect locale
  const browserLang = await page.evaluate(() => navigator.language);
  const locale = browserLang.startsWith("zh-TW") ? "zh-TW" : browserLang.startsWith("zh") ? "zh-CN" : "en";
  const uiMap = loadUIMap(locale);
  console.log(`[paste-limit] Locale: ${locale}`);
  console.log(`[paste-limit] Test sizes: ${sizes.map((s) => (s >= 1000 ? `${s / 1000}K` : s)).join(", ")}`);

  await saveScreenshot(cdp, "initial");

  const results: ExperimentResult[] = [];

  for (const size of sizes) {
    const result = await runSingleExperiment(page, cdp, uiMap, size);
    results.push(result);

    // Wait between tests
    await sleep(3000);
  }

  // =============================================================================
  // Summary
  // =============================================================================

  console.log(`\n${"=".repeat(60)}`);
  console.log("  PASTE LIMIT EXPERIMENT RESULTS");
  console.log(`${"=".repeat(60)}\n`);

  console.log("| Size | Paste OK | Chars Pasted | Source Added | Duration | Error |");
  console.log("|------|----------|-------------|-------------|----------|-------|");
  for (const r of results) {
    console.log(
      `| ${r.sizeLabel} | ${r.pasteSuccess ? "✅" : "❌"} | ${r.actualPastedChars.toLocaleString()} | ${r.sourceAdded ? "✅" : "❌"} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.error ?? "-"} |`,
    );
  }

  // Find the limit
  const lastSuccess = results.filter((r) => r.sourceAdded).pop();
  const firstFail = results.find((r) => !r.sourceAdded);

  console.log("\n--- Analysis ---");
  if (lastSuccess) {
    console.log(`Last successful paste: ${lastSuccess.sizeLabel} (${lastSuccess.actualPastedChars.toLocaleString()} chars)`);
  }
  if (firstFail) {
    console.log(`First failed paste: ${firstFail.sizeLabel} — ${firstFail.error ?? "source not added"}`);
  }
  if (!firstFail) {
    console.log("All sizes succeeded! NotebookLM accepted up to 500K chars.");
  }

  console.log("\n[paste-limit] Done");
}

main().catch((err) => {
  console.error("[paste-limit] Fatal:", err);
  process.exit(1);
});
