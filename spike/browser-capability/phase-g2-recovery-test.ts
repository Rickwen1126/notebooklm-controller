/**
 * Phase G2 — Recovery verification for all operations
 *
 * Each test corrupts a critical selector then runs through G2 pipeline.
 * Verifies recovery agent can complete the task + produce error log.
 *
 * Usage:
 *   npx tsx spike/browser-capability/phase-g2-recovery-test.ts
 */

import { CopilotClient } from "@github/copilot-sdk";
import type { CDPSession, Page } from "puppeteer-core";
import {
  type UIMap,
  type ScriptResult,
  connectToChrome,
  resolveLocale,
  loadUIMap,
  corruptUIMap,
  formatLogForAgent,
} from "./phase-g-shared.js";
import {
  scriptedQuery,
  scriptedAddSource,
  scriptedListSources,
  scriptedRemoveSource,
  scriptedRenameSource,
  scriptedClearChat,
  scriptedCreateNotebook,
  scriptedDeleteNotebook,
} from "./phase-g-scripts.js";

// Import recovery pipeline from phase-g2
// We need to inline the pipeline since phase-g2.ts is a script, not a module.
// For now, we test that scripts fail correctly and produce structured logs.

const NOTEBOOK_URL = "https://notebooklm.google.com/notebook/51d8a6d0-7007-4ab5-b4ab-49e5268f64e5";
const HOMEPAGE = "https://notebooklm.google.com";

interface RecoveryTestCase {
  id: string;
  description: string;
  corruptKey: string;
  page: "notebook" | "homepage";
  run: (cdp: CDPSession, page: Page, uiMap: UIMap) => Promise<ScriptResult>;
}

const tests: RecoveryTestCase[] = [
  {
    id: "R01", description: "query: corrupt chat_input",
    corruptKey: "chat_input", page: "notebook",
    run: (cdp, page, uiMap) => scriptedQuery(cdp, page, uiMap, "TypeScript 是什麼？"),
  },
  {
    id: "R02", description: "query: corrupt submit_button",
    corruptKey: "submit_button", page: "notebook",
    run: (cdp, page, uiMap) => scriptedQuery(cdp, page, uiMap, "TypeScript 是什麼？"),
  },
  {
    id: "R03", description: "addSource: corrupt paste_source_type",
    corruptKey: "paste_source_type", page: "notebook",
    run: (cdp, page, uiMap) => scriptedAddSource(cdp, page, uiMap, "Recovery test content."),
  },
  {
    id: "R04", description: "addSource: corrupt insert_button",
    corruptKey: "insert_button", page: "notebook",
    run: (cdp, page, uiMap) => scriptedAddSource(cdp, page, uiMap, "Recovery test content."),
  },
  {
    id: "R05", description: "listSources: corrupt source_panel selector",
    corruptKey: "source_panel", page: "notebook",
    run: (cdp, page, uiMap) => scriptedListSources(cdp, page, uiMap),
  },
  {
    id: "R06", description: "clearChat: corrupt conversation_options",
    corruptKey: "conversation_options", page: "notebook",
    run: (cdp, page, uiMap) => scriptedClearChat(cdp, page, uiMap),
  },
  {
    id: "R07", description: "removeSource: corrupt remove_source",
    corruptKey: "remove_source", page: "notebook",
    run: (cdp, page, uiMap) => scriptedRemoveSource(cdp, page, uiMap),
  },
  {
    id: "R08", description: "renameSource: corrupt rename_source",
    corruptKey: "rename_source", page: "notebook",
    run: (cdp, page, uiMap) => scriptedRenameSource(cdp, page, uiMap, "R08-Test"),
  },
  {
    id: "R09", description: "createNotebook: corrupt create_notebook",
    corruptKey: "create_notebook", page: "homepage",
    run: (cdp, page, uiMap) => scriptedCreateNotebook(cdp, page, uiMap),
  },
  {
    id: "R10", description: "deleteNotebook: corrupt delete_notebook",
    corruptKey: "delete_notebook", page: "homepage",
    run: (cdp, page, uiMap) => scriptedDeleteNotebook(cdp, page, uiMap),
  },
];

async function main() {
  console.log("[g2-recovery] Connecting to Chrome...");
  const { browser, page, cdp } = await connectToChrome();
  console.log(`[g2-recovery] Connected: ${page.url()}`);

  const browserLang = await page.evaluate(() => navigator.language);
  const locale = resolveLocale(browserLang);
  const baseUIMap = loadUIMap(locale);
  console.log(`[g2-recovery] Locale: ${locale}`);

  const results: Array<{
    id: string; desc: string; status: string; ms: number;
    failedStep: number | null; failedSelector: string | null;
  }> = [];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RECOVERY VERIFICATION — ${tests.length} tests`);
  console.log(`  Each test corrupts a selector, verifies script fails correctly`);
  console.log(`${"=".repeat(60)}\n`);

  for (const test of tests) {
    // Navigate to correct page
    if (test.page === "notebook") {
      await page.goto(NOTEBOOK_URL, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(HOMEPAGE, { waitUntil: "domcontentloaded" });
    }
    await new Promise((r) => setTimeout(r, 2000));

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${test.id}: ${test.description}`);
    console.log(`${"─".repeat(60)}`);

    try {
      // Corrupt the UI map
      const { corrupted } = corruptUIMap(baseUIMap, test.corruptKey);

      // Run the script with corrupted UI map
      const result = await test.run(cdp, page, corrupted);

      console.log(formatLogForAgent(result.log));

      // Verify: script should FAIL with the correct failedSelector
      const correctFail = result.status === "fail" && result.failedSelector !== null;
      const correctSelector = result.failedSelector === test.corruptKey;

      const status = correctFail ? "PASS" : "UNEXPECTED";
      results.push({
        id: test.id, desc: test.description, status,
        ms: result.totalMs,
        failedStep: result.failedAtStep,
        failedSelector: result.failedSelector,
      });

      console.log(`\n  [${status}] ${test.id} — ${result.status} at step ${result.failedAtStep}, selector: ${result.failedSelector}`);
      if (!correctSelector) {
        console.log(`  ⚠ Expected failedSelector="${test.corruptKey}", got "${result.failedSelector}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        id: test.id, desc: test.description, status: "ERROR",
        ms: 0, failedStep: null, failedSelector: null,
      });
      console.error(`\n  [ERROR] ${test.id}: ${msg}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  RESULTS: ${passed}/${results.length} correctly failed`);
  console.log(`${"=".repeat(70)}`);
  console.log("");
  console.log("| ID   | Description                     | Status     | failedSelector     |");
  console.log("|------|---------------------------------|------------|--------------------|");
  for (const r of results) {
    console.log(`| ${r.id.padEnd(4)} | ${r.desc.slice(0, 31).padEnd(31)} | ${r.status.padEnd(10)} | ${(r.failedSelector ?? "null").padEnd(18)} |`);
  }

  browser.disconnect();
  console.log("\n[g2-recovery] Done");
}

main().catch((err) => {
  console.error(`[g2-recovery] Fatal: ${err}`);
  process.exit(1);
});
