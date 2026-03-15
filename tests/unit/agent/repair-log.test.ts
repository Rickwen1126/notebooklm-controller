import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Hoisted mutable refs for temp directories
// ---------------------------------------------------------------------------

const dirs = vi.hoisted(() => ({
  repairLogsDir: "",
  screenshotsDir: "",
}));

// ---------------------------------------------------------------------------
// Mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", () => ({
  get REPAIR_LOGS_DIR() { return dirs.repairLogsDir; },
  get SCREENSHOTS_DIR() { return dirs.screenshotsDir; },
  RECOVERY_MODEL: "gpt-5-mini",
}));

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  };
  childLogger.child = () => childLogger;
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { saveRepairLog, saveScreenshot, cleanupScreenshots } from "../../../src/agent/repair-log.js";
import type { ScriptResult } from "../../../src/scripts/types.js";
import type { RecoveryResult } from "../../../src/agent/recovery-session.js";
import type { UIMap } from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "repair-log-test-"));
  dirs.repairLogsDir = join(tempDir, "repair-logs");
  dirs.screenshotsDir = join(tempDir, "screenshots");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScriptResult(): ScriptResult {
  return {
    operation: "query",
    status: "fail",
    result: null,
    log: [{ step: 1, action: "find", status: "fail", detail: "Not found", durationMs: 10 }],
    totalMs: 10,
    failedAtStep: 1,
    failedSelector: "chat_input",
  };
}

function makeRecoveryResult(overrides: Partial<RecoveryResult> = {}): RecoveryResult {
  return {
    success: true,
    result: "Answer text",
    analysis: "Selector changed",
    suggestedPatch: { elementKey: "chat_input", oldValue: "BROKEN", newValue: "開始輸入", confidence: 0.9 },
    toolCalls: 5,
    toolCallLog: [{ tool: "find", input: '{"query":"*"}', output: "Found 3 elements" }],
    agentMessages: ["Looking at the page..."],
    finalScreenshot: null,
    durationMs: 5000,
    ...overrides,
  };
}

function makeUIMap(): UIMap {
  return {
    locale: "zh-TW",
    verified: true,
    elements: {
      chat_input: { text: "開始輸入", match: "placeholder" },
    },
    selectors: {
      answer: ".to-user-container .message-content",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("saveRepairLog", () => {
  it("creates a JSON repair log file", () => {
    const filepath = saveRepairLog(makeScriptResult(), makeUIMap(), makeRecoveryResult());

    expect(filepath).toContain("repair-logs");
    expect(filepath).toContain("query");
    expect(filepath).toContain("chat_input");
    expect(filepath.endsWith(".json")).toBe(true);
    expect(existsSync(filepath)).toBe(true);
  });

  it("saves valid JSON with all required fields", async () => {
    const filepath = saveRepairLog(makeScriptResult(), makeUIMap(), makeRecoveryResult());
    const content = await readFile(filepath, "utf-8");
    const log = JSON.parse(content);

    expect(log.operation).toBe("query");
    expect(log.failedAtStep).toBe(1);
    expect(log.failedSelector).toBe("chat_input");
    expect(log.uiMapValue).toEqual({ text: "開始輸入", match: "placeholder" });
    expect(log.recovery.success).toBe(true);
    expect(log.recovery.model).toBe("gpt-5-mini");
    expect(log.recovery.toolCalls).toBe(5);
    expect(log.suggestedPatch).toBeTruthy();
    expect(log.timestamp).toBeTruthy();
  });

  it("saves final screenshot as separate PNG when present", () => {
    const recovery = makeRecoveryResult({ finalScreenshot: "aGVsbG8=" }); // "hello" in base64
    const filepath = saveRepairLog(makeScriptResult(), makeUIMap(), recovery);

    const pngPath = filepath.replace(".json", ".png");
    expect(existsSync(pngPath)).toBe(true);
  });

  it("looks up UIMap element value for failed selector", async () => {
    const filepath = saveRepairLog(makeScriptResult(), makeUIMap(), makeRecoveryResult());
    const content = await readFile(filepath, "utf-8");
    const log = JSON.parse(content);

    expect(log.uiMapValue).toEqual({ text: "開始輸入", match: "placeholder" });
  });

  it("falls back to selector map when element not found", async () => {
    const scriptResult = makeScriptResult();
    scriptResult.failedSelector = "answer";

    const filepath = saveRepairLog(scriptResult, makeUIMap(), makeRecoveryResult());
    const content = await readFile(filepath, "utf-8");
    const log = JSON.parse(content);

    expect(log.uiMapValue).toEqual({ selector: ".to-user-container .message-content" });
  });

  it("sets uiMapValue to null when selector not in UIMap", async () => {
    const scriptResult = makeScriptResult();
    scriptResult.failedSelector = "nonexistent_selector";

    const filepath = saveRepairLog(scriptResult, makeUIMap(), makeRecoveryResult());
    const content = await readFile(filepath, "utf-8");
    const log = JSON.parse(content);

    expect(log.uiMapValue).toBeNull();
  });

  it("truncates recovery result to 1000 chars", async () => {
    const longResult = "x".repeat(2000);
    const recovery = makeRecoveryResult({ result: longResult });

    const filepath = saveRepairLog(makeScriptResult(), makeUIMap(), recovery);
    const content = await readFile(filepath, "utf-8");
    const log = JSON.parse(content);

    expect(log.recovery.result.length).toBe(1000);
  });
});

describe("saveScreenshot", () => {
  it("creates a PNG file in screenshots dir", () => {
    const filepath = saveScreenshot("aGVsbG8=", "task-123", "after_query");

    expect(filepath).toContain("screenshots");
    expect(filepath).toContain("task-123");
    expect(filepath).toContain("after_query");
    expect(filepath.endsWith(".png")).toBe(true);
    expect(existsSync(filepath)).toBe(true);
  });

  it("sanitizes step name in filename", () => {
    const filepath = saveScreenshot("aGVsbG8=", "task-1", "step/with:special chars!");

    expect(filepath).not.toContain("/with");
    expect(filepath).not.toContain(":");
    expect(filepath).not.toContain("!");
  });
});

describe("cleanupScreenshots", () => {
  it("removes oldest files when over limit", () => {
    mkdirSync(dirs.screenshotsDir, { recursive: true });
    // Create 5 files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dirs.screenshotsDir, `test-${i}.png`), "data");
    }

    cleanupScreenshots(3);

    const remaining = readdirSync(dirs.screenshotsDir);
    expect(remaining.length).toBe(3);
  });

  it("does nothing when under limit", () => {
    mkdirSync(dirs.screenshotsDir, { recursive: true });
    writeFileSync(join(dirs.screenshotsDir, "test-0.png"), "data");

    cleanupScreenshots(10);

    const remaining = readdirSync(dirs.screenshotsDir);
    expect(remaining.length).toBe(1);
  });

  it("handles non-existent directory gracefully", () => {
    // Should not throw
    cleanupScreenshots(10);
  });
});
