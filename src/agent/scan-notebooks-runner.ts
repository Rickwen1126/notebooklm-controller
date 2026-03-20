/**
 * scanAllNotebooks runner — formal runner dispatched via RUNNER_REGISTRY.
 *
 * Flow: extractNotebookNames → per-notebook getNotebookUrl (script + recovery on fail) → register
 *
 * Receives a tabHandle from the dispatcher (already acquired, viewport set).
 * Does NOT manage tab lifecycle.
 */

import { buildScriptContext } from "./session-runner.js";
import { runRecoverySession } from "./recovery-session.js";
import { saveRepairLog } from "./repair-log.js";
import { scriptedExtractNotebookNames, scriptedGetNotebookUrl } from "../scripts/operations.js";
import { NOTEBOOKLM_HOMEPAGE } from "../shared/config.js";
import { normalizeUrl, generateAlias } from "../shared/notebook-utils.js";
import { logger } from "../shared/logger.js";
import type { RunTaskDeps } from "../daemon/types.js";
import type { AsyncTask, TabHandle, NotebookEntry } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ScanAllNotebooksResult {
  success: boolean;
  total: number;
  registered: Array<{ alias: string; url: string; title: string }>;
  skipped: Array<{ name: string; reason: string }>;
  recovered: Array<{ alias: string; url: string; title: string }>;
  errorReport: {
    scriptFailures: number;
    recoveryAttempts: number;
    recoverySuccesses: number;
    finalFailures: Array<{
      name: string;
      scriptStep: number;
      scriptError: string;
      recoveryError: string;
      repairLogPath: string;
    }>;
  };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deduplicateAlias(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 50);
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Runner entry point
// ---------------------------------------------------------------------------

export async function runScanAllNotebooksTask(
  _task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
): Promise<{ success: boolean; result?: object; error?: string }> {
  const log = logger.child({ module: "scanAllNotebooks" });
  const t0 = Date.now();

  const registered: ScanAllNotebooksResult["registered"] = [];
  const skipped: ScanAllNotebooksResult["skipped"] = [];
  const recovered: ScanAllNotebooksResult["recovered"] = [];
  const errorReport: ScanAllNotebooksResult["errorReport"] = {
    scriptFailures: 0,
    recoveryAttempts: 0,
    recoverySuccesses: 0,
    finalFailures: [],
  };

  try {
    // 1. Build script context from tab handle.
    const ctx = buildScriptContext({
      cdpSession: tabHandle.cdpSession,
      page: tabHandle.page,
      uiMap: deps.uiMap,
    });

    // 2. Extract all notebook names from the homepage.
    log.info("Extracting notebook names from homepage");
    const extractResult = await scriptedExtractNotebookNames(ctx);

    if (extractResult.status !== "success" || !extractResult.result) {
      log.error("Failed to extract notebook names", {
        status: extractResult.status,
        failedAtStep: extractResult.failedAtStep,
        failedSelector: extractResult.failedSelector,
      });
      return {
        success: false,
        error: `extractNotebookNames failed at step ${extractResult.failedAtStep}: ${extractResult.failedSelector ?? "unknown"}`,
      };
    }

    const names = JSON.parse(extractResult.result) as Array<{ name: string }>;
    log.info("Extracted notebook names", { count: names.length });

    // 3. Load existing state for URL/alias dedup.
    const state = await deps.stateManager.load();
    const existingUrls = new Set(
      Object.values(state.notebooks).map((nb) => normalizeUrl(nb.url)),
    );
    const existingAliases = new Set(Object.keys(state.notebooks));

    // 4. Per-notebook loop: getNotebookUrl → register.
    for (const { name } of names) {
      if (!name || !name.trim()) {
        skipped.push({ name: "(empty)", reason: "empty name" });
        continue;
      }

      log.info("Processing notebook", { name });

      // 4a. Run scriptedGetNotebookUrl
      const urlResult = await scriptedGetNotebookUrl(ctx, name);

      if (urlResult.status === "success" && urlResult.result) {
        // 4b. Script succeeded — parse URL and register.
        const parsed = JSON.parse(urlResult.result) as { name: string; url: string };
        const normalized = normalizeUrl(parsed.url);

        if (existingUrls.has(normalized)) {
          skipped.push({ name, reason: "URL already registered" });
          log.info("Skipped (duplicate URL)", { name, url: normalized });
          continue;
        }

        const baseAlias = generateAlias(name);
        const alias = deduplicateAlias(baseAlias, existingAliases);
        existingAliases.add(alias);
        existingUrls.add(normalized);

        const now = new Date().toISOString();
        const entry: NotebookEntry = {
          alias,
          url: normalized,
          title: name,
          description: "",
          status: "ready",
          registeredAt: now,
          lastAccessedAt: now,
          sourceCount: 0,
        };

        await deps.stateManager.addNotebook(entry);
        registered.push({ alias, url: normalized, title: name });
        log.info("Registered notebook", { alias, url: normalized, title: name });
        continue;
      }

      // 4c. Script failed — attempt recovery.
      errorReport.scriptFailures++;
      errorReport.recoveryAttempts++;
      log.warn("scriptedGetNotebookUrl failed, attempting recovery", {
        name,
        failedAtStep: urlResult.failedAtStep,
        failedSelector: urlResult.failedSelector,
      });

      const goal = `Navigate to notebook "${name}" and obtain its URL. The homepage should be showing notebook list.`;

      const recoveryResult = await runRecoverySession({
        client: deps.copilotClient,
        cdp: tabHandle.cdpSession,
        page: tabHandle.page,
        scriptResult: urlResult,
        goal,
      });

      if (recoveryResult.success) {
        // 4d. Recovery success — read URL from page.url() (browser state authority).
        errorReport.recoverySuccesses++;
        const currentUrl = tabHandle.page.url();
        const normalized = normalizeUrl(currentUrl);

        // Save repair log for learning.
        try {
          saveRepairLog(urlResult, deps.uiMap, recoveryResult);
        } catch {
          /* non-critical */
        }

        if (existingUrls.has(normalized)) {
          skipped.push({ name, reason: "URL already registered (via recovery)" });
        } else {
          const baseAlias = generateAlias(name);
          const alias = deduplicateAlias(baseAlias, existingAliases);
          existingAliases.add(alias);
          existingUrls.add(normalized);

          const now = new Date().toISOString();
          const entry: NotebookEntry = {
            alias,
            url: normalized,
            title: name,
            description: "",
            status: "ready",
            registeredAt: now,
            lastAccessedAt: now,
            sourceCount: 0,
          };

          await deps.stateManager.addNotebook(entry);
          recovered.push({ alias, url: normalized, title: name });
          log.info("Registered notebook (via recovery)", {
            alias,
            url: normalized,
            title: name,
          });
        }

        // Navigate back to homepage (explicit goto, not goBack — recovery
        // may have performed multiple navigations making goBack unreliable).
        try {
          await tabHandle.page.goto(NOTEBOOKLM_HOMEPAGE, { waitUntil: "domcontentloaded" });
          await new Promise((r) => setTimeout(r, 2000));
        } catch {
          /* best-effort */
        }

        continue;
      }

      // 4e. Recovery also failed — save repair log and record in errorReport.
      let repairLogPath = "";
      try {
        repairLogPath = saveRepairLog(urlResult, deps.uiMap, recoveryResult);
      } catch {
        /* non-critical */
      }

      errorReport.finalFailures.push({
        name,
        scriptStep: urlResult.failedAtStep ?? -1,
        scriptError: urlResult.failedSelector ?? "unknown",
        recoveryError: recoveryResult.analysis ?? "No analysis",
        repairLogPath,
      });

      log.error("Failed to get URL for notebook (recovery also failed)", {
        name,
        repairLogPath,
      });

      // Best-effort: navigate back to homepage for next iteration.
      try {
        await tabHandle.page.goto(NOTEBOOKLM_HOMEPAGE, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 2000));
      } catch {
        /* best-effort */
      }
    }

    // 5. Build final result.
    const durationMs = Date.now() - t0;
    const result: ScanAllNotebooksResult = {
      success: errorReport.finalFailures.length === 0,
      total: names.length,
      registered,
      skipped,
      recovered,
      errorReport,
      durationMs,
    };

    log.info("Scan completed", {
      total: result.total,
      registered: registered.length,
      skipped: skipped.length,
      recovered: recovered.length,
      failures: errorReport.finalFailures.length,
      durationMs,
    });

    return {
      success: result.success,
      result,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error("scanAllNotebooks runner failed", { error: errorMessage, durationMs });

    return {
      success: false,
      error: errorMessage,
    };
  }
}
