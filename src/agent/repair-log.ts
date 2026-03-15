/**
 * Repair log + screenshot persistence.
 *
 * - saveRepairLog: persists error context + recovery analysis to ~/.nbctl/repair-logs/
 * - saveScreenshot: persists operation screenshots to ~/.nbctl/screenshots/
 * - cleanupScreenshots: auto-cleanup, keeps last N files
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPAIR_LOGS_DIR, SCREENSHOTS_DIR, RECOVERY_MODEL } from "../shared/config.js";
import type { RepairLog, UIMap } from "../shared/types.js";
import type { ScriptResult } from "../scripts/types.js";
import type { RecoveryResult } from "./recovery-session.js";
import { logger } from "../shared/logger.js";

const MAX_SCREENSHOTS = 200;

// ---------------------------------------------------------------------------
// saveRepairLog
// ---------------------------------------------------------------------------

/**
 * Save a structured repair log entry with error context and recovery results.
 *
 * @returns The file path of the saved repair log.
 */
export function saveRepairLog(
  scriptResult: ScriptResult,
  uiMap: UIMap,
  recovery: RecoveryResult,
): string {
  mkdirSync(REPAIR_LOGS_DIR, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${ts}_${scriptResult.operation}_${scriptResult.failedSelector ?? "unknown"}.json`;
  const filepath = join(REPAIR_LOGS_DIR, filename);

  // Look up the UIMap value for the failed selector
  let uiMapValue: Record<string, unknown> | null = null;
  if (scriptResult.failedSelector) {
    const el = uiMap.elements[scriptResult.failedSelector];
    const sel = uiMap.selectors[scriptResult.failedSelector];
    if (el) uiMapValue = { ...el };
    else if (sel) uiMapValue = { selector: sel };
  }

  // Save final screenshot as separate file (too large for JSON)
  let finalScreenshotPath: string | null = null;
  if (recovery.finalScreenshot) {
    finalScreenshotPath = filepath.replace(".json", ".png");
    writeFileSync(finalScreenshotPath, Buffer.from(recovery.finalScreenshot, "base64"));
  }

  const log: RepairLog = {
    operation: scriptResult.operation,
    failedAtStep: scriptResult.failedAtStep,
    failedSelector: scriptResult.failedSelector,
    uiMapValue,
    scriptLog: scriptResult.log,
    recovery: {
      success: recovery.success,
      model: RECOVERY_MODEL,
      toolCalls: recovery.toolCalls,
      durationMs: recovery.durationMs,
      result: recovery.result?.slice(0, 1000) ?? null,
      analysis: recovery.analysis,
      toolCallLog: recovery.toolCallLog,
      agentMessages: recovery.agentMessages,
      finalScreenshotPath: finalScreenshotPath ? finalScreenshotPath.split("/").pop()! : null,
    },
    suggestedPatch: recovery.suggestedPatch,
    timestamp: now.toISOString(),
  };

  writeFileSync(filepath, JSON.stringify(log, null, 2));

  logger.child({ module: "repair-log" }).info("Repair log saved", {
    filepath,
    operation: scriptResult.operation,
    failedSelector: scriptResult.failedSelector,
    recoverySuccess: recovery.success,
    hasPatch: recovery.suggestedPatch !== null,
  });

  return filepath;
}

// ---------------------------------------------------------------------------
// saveScreenshot
// ---------------------------------------------------------------------------

/**
 * Save a screenshot to ~/.nbctl/screenshots/ with auto-cleanup.
 *
 * @param base64 - Base64-encoded PNG data
 * @param taskId - Task ID for filename
 * @param step - Step description for filename
 * @returns The file path of the saved screenshot.
 */
export function saveScreenshot(
  base64: string,
  taskId: string,
  step: string,
): string {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const timestamp = Date.now();
  const safeStep = step.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
  const filename = `${taskId}-${safeStep}-${timestamp}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  writeFileSync(filepath, Buffer.from(base64, "base64"));

  // Auto-cleanup: keep last N files
  cleanupScreenshots(MAX_SCREENSHOTS);

  return filepath;
}

// ---------------------------------------------------------------------------
// cleanupScreenshots
// ---------------------------------------------------------------------------

/**
 * Remove oldest screenshots when count exceeds maxFiles.
 */
export function cleanupScreenshots(maxFiles: number = MAX_SCREENSHOTS): void {
  if (!existsSync(SCREENSHOTS_DIR)) return;

  try {
    const files = readdirSync(SCREENSHOTS_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({
        name: f,
        path: join(SCREENSHOTS_DIR, f),
        mtime: statSync(join(SCREENSHOTS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    if (files.length <= maxFiles) return;

    const toDelete = files.slice(0, files.length - maxFiles);
    for (const file of toDelete) {
      unlinkSync(file.path);
    }

    logger.child({ module: "repair-log" }).info("Screenshot cleanup", {
      deleted: toDelete.length,
      remaining: maxFiles,
    });
  } catch (err) {
    // Non-critical — don't fail operations for cleanup errors
    logger.child({ module: "repair-log" }).warn("Screenshot cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
