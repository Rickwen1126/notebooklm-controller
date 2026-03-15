import { describe, it, expect } from "vitest";
import { createLogEntry, formatLogForAgent } from "../../../src/scripts/types.js";
import type { ScriptLogEntry } from "../../../src/scripts/types.js";

describe("createLogEntry", () => {
  it("creates a log entry with computed duration", () => {
    const start = Date.now() - 100;
    const entry = createLogEntry(1, "find_button", "ok", "Found at (100, 200)", start);

    expect(entry.step).toBe(1);
    expect(entry.action).toBe("find_button");
    expect(entry.status).toBe("ok");
    expect(entry.detail).toBe("Found at (100, 200)");
    expect(entry.durationMs).toBeGreaterThanOrEqual(90); // allow some timing slack
  });

  it("supports all status values", () => {
    const start = Date.now();
    for (const status of ["ok", "warn", "fail"] as const) {
      const entry = createLogEntry(0, "test", status, "detail", start);
      expect(entry.status).toBe(status);
    }
  });
});

describe("formatLogForAgent", () => {
  it("formats log entries with status icons", () => {
    const log: ScriptLogEntry[] = [
      { step: 1, action: "find", status: "ok", detail: "Found", durationMs: 10 },
      { step: 2, action: "click", status: "warn", detail: "Slow", durationMs: 200 },
      { step: 3, action: "verify", status: "fail", detail: "Not found", durationMs: 50 },
    ];
    const formatted = formatLogForAgent(log);
    expect(formatted).toContain("[✓] Step 1");
    expect(formatted).toContain("[⚠] Step 2");
    expect(formatted).toContain("[✗] Step 3");
  });

  it("returns empty string for empty log", () => {
    expect(formatLogForAgent([])).toBe("");
  });
});
