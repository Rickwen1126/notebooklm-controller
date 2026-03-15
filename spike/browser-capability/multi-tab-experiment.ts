/**
 * Multi-Tab Concurrency Experiment
 *
 * 測試 Chrome CDP 是否支援多個 tab 同時操作：
 *   1. 開兩個 NotebookLM tab（不同 notebook）
 *   2. 同時在兩個 tab 上執行 CDP 操作（click, find, screenshot, paste）
 *   3. 觀察是否有衝突、阻塞、或交叉污染
 *
 * Usage:
 *   npx tsx spike/browser-capability/multi-tab-experiment.ts
 */

import puppeteer from "puppeteer-core";
import type { CDPSession, Page, Browser } from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const SCREENSHOTS_DIR = join(import.meta.dirname, "screenshots");

// =============================================================================
// CDP helpers
// =============================================================================

async function captureScreenshot(cdp: CDPSession): Promise<string> {
  const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  return data;
}

async function saveScreenshot(cdp: CDPSession, label: string): Promise<string> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const base64 = await captureScreenshot(cdp);
  const path = join(SCREENSHOTS_DIR, `mt-${label}-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchPaste(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

async function findElements(page: Page, query: string): Promise<Array<{ text: string; x: number; y: number }>> {
  return page.evaluate((q: string) => {
    const results: Array<{ text: string; x: number; y: number }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode as HTMLElement;
      const text = el.textContent?.trim() ?? "";
      const aria = el.getAttribute("aria-label") ?? "";
      if (text.includes(q) || aria.includes(q)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          results.push({ text: text.slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
      }
    }
    return results;
  }, query);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Test cases
// =============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

// Test 1: Concurrent screenshots on two tabs
async function testConcurrentScreenshots(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 1] Concurrent screenshots on two tabs...");

  try {
    // Take screenshots simultaneously
    const [ss1, ss2] = await Promise.all([
      captureScreenshot(tab1.cdp),
      captureScreenshot(tab2.cdp),
    ]);

    const size1 = ss1.length;
    const size2 = ss2.length;

    // They should be different (different pages)
    const areDifferent = ss1 !== ss2;

    // Save them
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    writeFileSync(join(SCREENSHOTS_DIR, `mt-concurrent-tab1-${Date.now()}.png`), Buffer.from(ss1, "base64"));
    writeFileSync(join(SCREENSHOTS_DIR, `mt-concurrent-tab2-${Date.now()}.png`), Buffer.from(ss2, "base64"));

    console.log(`  Tab1 screenshot: ${size1} bytes`);
    console.log(`  Tab2 screenshot: ${size2} bytes`);
    console.log(`  Screenshots different: ${areDifferent}`);

    return {
      name: "Concurrent Screenshots",
      passed: size1 > 0 && size2 > 0 && areDifferent,
      details: `Tab1=${size1}B, Tab2=${size2}B, different=${areDifferent}`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Concurrent Screenshots", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// Test 2: Concurrent find operations
async function testConcurrentFind(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 2] Concurrent find on two tabs...");

  try {
    const [els1, els2] = await Promise.all([
      findElements(tab1.page, "來源"),
      findElements(tab2.page, "來源"),
    ]);

    console.log(`  Tab1 found: ${els1.length} elements`);
    console.log(`  Tab2 found: ${els2.length} elements`);

    return {
      name: "Concurrent Find",
      passed: els1.length > 0 && els2.length > 0,
      details: `Tab1=${els1.length} els, Tab2=${els2.length} els`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Concurrent Find", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// Test 3: Concurrent clicks on two tabs
async function testConcurrentClicks(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 3] Concurrent clicks on two tabs...");

  try {
    // Find clickable elements on both tabs
    const [els1, els2] = await Promise.all([
      findElements(tab1.page, "來源"),
      findElements(tab2.page, "對話"),
    ]);

    if (els1.length === 0 || els2.length === 0) {
      return { name: "Concurrent Clicks", passed: false, details: "Cannot find target elements", durationMs: Date.now() - t0 };
    }

    // Click simultaneously
    await Promise.all([
      dispatchClick(tab1.cdp, els1[0].x, els1[0].y),
      dispatchClick(tab2.cdp, els2[0].x, els2[0].y),
    ]);

    await sleep(1000);

    // Verify by screenshot
    const [ss1, ss2] = await Promise.all([
      saveScreenshot(tab1.cdp, "after-click-tab1"),
      saveScreenshot(tab2.cdp, "after-click-tab2"),
    ]);

    console.log(`  Tab1 clicked "來源" at (${els1[0].x}, ${els1[0].y})`);
    console.log(`  Tab2 clicked "對話" at (${els2[0].x}, ${els2[0].y})`);

    return {
      name: "Concurrent Clicks",
      passed: true,
      details: `Tab1→來源, Tab2→對話, no error`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Concurrent Clicks", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// Test 4: Concurrent paste on two tabs (the real stress test)
async function testConcurrentPaste(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 4] Concurrent paste on two tabs...");

  try {
    // Navigate both to chat input
    const [chat1, chat2] = await Promise.all([
      findElements(tab1.page, "開始輸入"),
      findElements(tab2.page, "開始輸入"),
    ]);

    if (chat1.length === 0 || chat2.length === 0) {
      // Try English fallback
      const [chatEn1, chatEn2] = await Promise.all([
        findElements(tab1.page, "placeholder"),
        findElements(tab2.page, "placeholder"),
      ]);
      console.log(`  Chat inputs: Tab1=${chat1.length}/${chatEn1.length}, Tab2=${chat2.length}/${chatEn2.length}`);

      if (chat1.length === 0 && chatEn1.length === 0) {
        return { name: "Concurrent Paste", passed: false, details: "Cannot find chat input on tabs", durationMs: Date.now() - t0 };
      }
    }

    // Click chat inputs to focus
    if (chat1.length > 0 && chat2.length > 0) {
      await Promise.all([
        dispatchClick(tab1.cdp, chat1[0].x, chat1[0].y),
        dispatchClick(tab2.cdp, chat2[0].x, chat2[0].y),
      ]);
      await sleep(500);
    }

    // Paste different text simultaneously
    const text1 = "TAB1_UNIQUE_TEXT_" + Date.now();
    const text2 = "TAB2_UNIQUE_TEXT_" + Date.now();

    await Promise.all([
      dispatchPaste(tab1.cdp, text1),
      dispatchPaste(tab2.cdp, text2),
    ]);

    await sleep(1000);

    // Verify: each tab should have its own text, no cross-contamination
    const [content1, content2] = await Promise.all([
      tab1.page.evaluate(() => {
        const inputs = document.querySelectorAll("textarea, input, [contenteditable]");
        for (const el of inputs) {
          const val = (el as HTMLTextAreaElement).value ?? el.textContent ?? "";
          if (val.includes("TAB")) return val;
        }
        return "";
      }),
      tab2.page.evaluate(() => {
        const inputs = document.querySelectorAll("textarea, input, [contenteditable]");
        for (const el of inputs) {
          const val = (el as HTMLTextAreaElement).value ?? el.textContent ?? "";
          if (val.includes("TAB")) return val;
        }
        return "";
      }),
    ]);

    const tab1HasOwn = content1.includes("TAB1");
    const tab2HasOwn = content2.includes("TAB2");
    const tab1HasOther = content1.includes("TAB2");
    const tab2HasOther = content2.includes("TAB1");

    console.log(`  Tab1 content: "${content1.slice(0, 40)}..." → has own=${tab1HasOwn}, has other=${tab1HasOther}`);
    console.log(`  Tab2 content: "${content2.slice(0, 40)}..." → has own=${tab2HasOwn}, has other=${tab2HasOther}`);

    const noCrossContamination = !tab1HasOther && !tab2HasOther;

    // Save screenshots
    await Promise.all([
      saveScreenshot(tab1.cdp, "after-paste-tab1"),
      saveScreenshot(tab2.cdp, "after-paste-tab2"),
    ]);

    return {
      name: "Concurrent Paste",
      passed: tab1HasOwn && tab2HasOwn && noCrossContamination,
      details: `Tab1=${tab1HasOwn}, Tab2=${tab2HasOwn}, crossContamination=${!noCrossContamination}`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Concurrent Paste", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// Test 5: Sequential vs Parallel speed comparison
async function testSpeedComparison(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 5] Sequential vs Parallel speed comparison...");

  try {
    // Sequential: screenshot tab1 then tab2
    const seqStart = Date.now();
    await captureScreenshot(tab1.cdp);
    await captureScreenshot(tab2.cdp);
    await findElements(tab1.page, "來源");
    await findElements(tab2.page, "來源");
    const seqMs = Date.now() - seqStart;

    // Parallel: screenshot both at once
    const parStart = Date.now();
    await Promise.all([
      captureScreenshot(tab1.cdp),
      captureScreenshot(tab2.cdp),
    ]);
    await Promise.all([
      findElements(tab1.page, "來源"),
      findElements(tab2.page, "來源"),
    ]);
    const parMs = Date.now() - parStart;

    const speedup = (seqMs / parMs).toFixed(2);

    console.log(`  Sequential: ${seqMs}ms`);
    console.log(`  Parallel:   ${parMs}ms`);
    console.log(`  Speedup:    ${speedup}x`);

    return {
      name: "Speed Comparison",
      passed: true,
      details: `Sequential=${seqMs}ms, Parallel=${parMs}ms, Speedup=${speedup}x`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Speed Comparison", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// Test 6: Rapid alternating operations (interleaved)
async function testInterleavedOperations(
  tab1: { page: Page; cdp: CDPSession; label: string },
  tab2: { page: Page; cdp: CDPSession; label: string },
): Promise<TestResult> {
  const t0 = Date.now();
  console.log("\n[Test 6] Rapid interleaved operations (screenshot-find-click alternating)...");

  try {
    const ops: string[] = [];

    // Rapidly alternate between tabs
    for (let i = 0; i < 5; i++) {
      // Tab1 screenshot
      await captureScreenshot(tab1.cdp);
      ops.push(`T1:ss`);

      // Tab2 find
      const els = await findElements(tab2.page, "來源");
      ops.push(`T2:find(${els.length})`);

      // Tab1 find
      const els1 = await findElements(tab1.page, "對話");
      ops.push(`T1:find(${els1.length})`);

      // Tab2 screenshot
      await captureScreenshot(tab2.cdp);
      ops.push(`T2:ss`);
    }

    console.log(`  Completed ${ops.length} interleaved ops: ${ops.join(" → ")}`);

    return {
      name: "Interleaved Operations",
      passed: true,
      details: `${ops.length} ops completed without error`,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { name: "Interleaved Operations", passed: false, details: (err as Error).message, durationMs: Date.now() - t0 };
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("[multi-tab] Connecting to Chrome...");
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  const pages = await browser.pages();

  // Find existing NotebookLM tab
  const existingTab = pages.find((p) => p.url().includes("notebooklm.google.com/notebook"));
  if (!existingTab) {
    throw new Error("No NotebookLM notebook tab found. Open a notebook first.");
  }
  console.log(`[multi-tab] Tab1: ${existingTab.url()}`);

  // Open a second NotebookLM tab (go to homepage, open a different notebook)
  console.log("[multi-tab] Opening second tab...");
  const newPage = await browser.newPage();
  await newPage.goto("https://notebooklm.google.com", { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(3000);

  // Find a notebook link to click into
  const notebooks = await newPage.evaluate(() => {
    const rows = document.querySelectorAll("tr");
    const results: Array<{ text: string; x: number; y: number }> = [];
    rows.forEach((row) => {
      const text = row.textContent?.trim().slice(0, 60) ?? "";
      if (text && !text.includes("標題")) {
        const r = row.getBoundingClientRect();
        if (r.width > 0) results.push({ text, x: Math.round(r.x + 100), y: Math.round(r.y + r.height / 2) });
      }
    });
    return results;
  });

  // Pick a different notebook than the first tab
  const tab1NotebookId = existingTab.url().match(/notebook\/([^?]+)/)?.[1] ?? "";
  let clickedSecond = false;

  for (const nb of notebooks) {
    // Click a notebook row
    const cdpTemp = await newPage.createCDPSession();
    await dispatchClick(cdpTemp, nb.x, nb.y);
    await sleep(3000);
    await cdpTemp.detach();

    const url = newPage.url();
    const secondId = url.match(/notebook\/([^?]+)/)?.[1] ?? "";
    if (secondId && secondId !== tab1NotebookId) {
      clickedSecond = true;
      break;
    }
    // Same notebook, try next
    await newPage.goto("https://notebooklm.google.com", { waitUntil: "networkidle2", timeout: 15000 });
    await sleep(2000);
  }

  if (!clickedSecond) {
    // If we can't find a different notebook, just use the same one in tab2
    console.log("[multi-tab] Warning: using same notebook for both tabs");
    await newPage.goto(existingTab.url(), { waitUntil: "networkidle2", timeout: 15000 });
    await sleep(3000);
  }

  console.log(`[multi-tab] Tab2: ${newPage.url()}`);

  // Create CDP sessions
  const cdp1 = await existingTab.createCDPSession();
  const cdp2 = await newPage.createCDPSession();

  const tab1 = { page: existingTab, cdp: cdp1, label: "tab1" };
  const tab2 = { page: newPage, cdp: cdp2, label: "tab2" };

  // Initial screenshots
  await Promise.all([
    saveScreenshot(cdp1, "initial-tab1"),
    saveScreenshot(cdp2, "initial-tab2"),
  ]);

  // Run tests
  const results: TestResult[] = [];

  results.push(await testConcurrentScreenshots(tab1, tab2));
  results.push(await testConcurrentFind(tab1, tab2));
  results.push(await testConcurrentClicks(tab1, tab2));
  results.push(await testConcurrentPaste(tab1, tab2));
  results.push(await testSpeedComparison(tab1, tab2));
  results.push(await testInterleavedOperations(tab1, tab2));

  // Cleanup: close the second tab
  await cdp2.detach();
  await newPage.close();
  await cdp1.detach();

  // =============================================================================
  // Summary
  // =============================================================================

  console.log(`\n${"=".repeat(60)}`);
  console.log("  MULTI-TAB CONCURRENCY RESULTS");
  console.log(`${"=".repeat(60)}\n`);

  console.log("| # | Test | Result | Duration | Details |");
  console.log("|---|------|--------|----------|---------|");
  for (const [i, r] of results.entries()) {
    console.log(`| ${i + 1} | ${r.name} | ${r.passed ? "✅" : "❌"} | ${r.durationMs}ms | ${r.details} |`);
  }

  const passCount = results.filter((r) => r.passed).length;
  console.log(`\n${passCount}/${results.length} PASSED`);

  if (passCount === results.length) {
    console.log("\n→ 結論：Chrome CDP 支援多 tab 並發操作，無衝突。Multi-tab 架構可行。");
  } else {
    const failed = results.filter((r) => !r.passed);
    console.log(`\n→ 有 ${failed.length} 個測試失敗，需要調查：`);
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.details}`);
    }
  }

  console.log("\n[multi-tab] Done");
}

main().catch((err) => {
  console.error("[multi-tab] Fatal:", err);
  process.exit(1);
});
