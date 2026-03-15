/**
 * Phase G2 — All-operations happy path test
 *
 * Runs all 10 scripts sequentially against live NotebookLM.
 * Notebook-page ops first, then homepage ops.
 *
 * Usage:
 *   npx tsx spike/browser-capability/phase-g2-all-ops.ts
 */

import type { CDPSession, Page } from "puppeteer-core";
import {
  type UIMap,
  type ScriptResult,
  connectToChrome,
  resolveLocale,
  loadUIMap,
  formatLogForAgent,
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

const HOMEPAGE = "https://notebooklm.google.com";

interface TestCase {
  id: string;
  description: string;
  page: "notebook" | "homepage";
  run: (cdp: CDPSession, page: Page, uiMap: UIMap) => Promise<ScriptResult>;
}

const tests: TestCase[] = [
  // === Notebook-page operations ===
  {
    id: "S01", description: "listSources (baseline)", page: "notebook",
    run: (cdp, page, uiMap) => scriptedListSources(cdp, page, uiMap),
  },
  {
    id: "S02", description: "addSource (test content)", page: "notebook",
    run: (cdp, page, uiMap) => scriptedAddSource(cdp, page, uiMap,
      "Phase G2 測試來源。TypeScript 是一種靜態型別的程式語言，是 JavaScript 的超集。它增加了型別系統和編譯時期的型別檢查。"),
  },
  {
    id: "S03", description: "listSources (verify +1)", page: "notebook",
    run: (cdp, page, uiMap) => scriptedListSources(cdp, page, uiMap),
  },
  {
    id: "S04", description: "renameSource", page: "notebook",
    run: (cdp, page, uiMap) => scriptedRenameSource(cdp, page, uiMap, "G2-Test-Renamed"),
  },
  {
    id: "S05", description: "query", page: "notebook",
    run: (cdp, page, uiMap) => scriptedQuery(cdp, page, uiMap, "TypeScript 是什麼？"),
  },
  {
    id: "S06", description: "clearChat", page: "notebook",
    run: (cdp, page, uiMap) => scriptedClearChat(cdp, page, uiMap),
  },
  {
    id: "S07", description: "removeSource", page: "notebook",
    run: (cdp, page, uiMap) => scriptedRemoveSource(cdp, page, uiMap),
  },
  {
    id: "S08", description: "listSources (verify -1)", page: "notebook",
    run: (cdp, page, uiMap) => scriptedListSources(cdp, page, uiMap),
  },
  // === Homepage operations ===
  {
    id: "S09", description: "listNotebooks", page: "homepage",
    run: (cdp, page, uiMap) => scriptedListNotebooks(cdp, page, uiMap),
  },
  {
    id: "S10", description: "createNotebook", page: "homepage",
    run: (cdp, page, uiMap) => scriptedCreateNotebook(cdp, page, uiMap),
  },
  {
    id: "S11", description: "renameNotebook", page: "homepage",
    run: (cdp, page, uiMap) => scriptedRenameNotebook(cdp, page, uiMap, "G2-Test-Notebook"),
  },
  {
    id: "S12", description: "deleteNotebook", page: "homepage",
    run: (cdp, page, uiMap) => scriptedDeleteNotebook(cdp, page, uiMap),
  },
];

async function main() {
  console.log("[g2-all] Connecting to Chrome...");
  const { browser, page, cdp } = await connectToChrome();
  const notebookUrl = page.url();
  console.log(`[g2-all] Connected: ${notebookUrl}`);

  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const uiMap = loadUIMap(locale);
  console.log(`[g2-all] Locale: ${locale}`);

  const results: Array<{ id: string; desc: string; status: string; ms: number; detail: string }> = [];
  let lastPage: "notebook" | "homepage" | null = null;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ALL-OPS HAPPY PATH — ${tests.length} tests`);
  console.log(`${"=".repeat(60)}\n`);

  for (const test of tests) {
    // Navigate to correct page if needed
    if (test.page !== lastPage) {
      if (test.page === "homepage") {
        console.log(`\n[g2-all] Navigating to homepage...`);
        await page.goto(HOMEPAGE, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 3000));
      } else if (test.page === "notebook" && lastPage === "homepage") {
        console.log(`\n[g2-all] Navigating back to notebook...`);
        await page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 3000));
      }
      lastPage = test.page;
    }

    // For S11 (renameNotebook) and S12 (deleteNotebook) after createNotebook,
    // need to go back to homepage first
    if (test.id === "S11" || test.id === "S12") {
      const currentUrl = page.url();
      if (!currentUrl.includes("notebooklm.google.com") || currentUrl.includes("/notebook/")) {
        console.log(`[g2-all] Navigating to homepage for ${test.id}...`);
        await page.goto(HOMEPAGE, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${test.id}: ${test.description}`);
    console.log(`${"─".repeat(60)}`);

    try {
      const result = await test.run(cdp, page, uiMap);
      const icon = result.status === "success" ? "PASS" : "FAIL";
      const detail = result.result?.slice(0, 80) ?? result.log[result.log.length - 1]?.detail ?? "";
      results.push({
        id: test.id, desc: test.description,
        status: icon, ms: result.totalMs,
        detail,
      });

      console.log(formatLogForAgent(result.log));
      console.log(`\n  [${icon}] ${test.id} (${(result.totalMs / 1000).toFixed(1)}s)`);
      if (result.status !== "success") {
        console.log(`  Failed at step ${result.failedAtStep}: ${result.failedSelector}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: test.id, desc: test.description, status: "ERROR", ms: 0, detail: msg });
      console.error(`\n  [ERROR] ${test.id}: ${msg}`);
    }

    // Brief settle between tests
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Summary
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  RESULTS: ${passed}/${results.length} PASS`);
  console.log(`${"=".repeat(70)}`);
  console.log("");
  console.log("| ID   | Description              | Status | Time   | Detail |");
  console.log("|------|--------------------------|--------|--------|--------|");
  for (const r of results) {
    console.log(`| ${r.id.padEnd(4)} | ${r.desc.slice(0, 24).padEnd(24)} | ${r.status.padEnd(6)} | ${(r.ms / 1000).toFixed(1).padStart(5)}s | ${r.detail.slice(0, 50)} |`);
  }

  browser.disconnect();
  console.log("\n[g2-all] Done");
}

main().catch((err) => {
  console.error(`[g2-all] Fatal: ${err}`);
  process.exit(1);
});
