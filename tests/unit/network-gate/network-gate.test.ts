import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkGate } from "../../../src/network-gate/network-gate.js";
import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS } from "../../../src/shared/config.js";

// Suppress logger output during tests.
vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, child: () => childLogger };
  return { logger: childLogger };
});

describe("NetworkGate", () => {
  let gate: NetworkGate;

  beforeEach(() => {
    vi.useFakeTimers();
    NetworkGate.resetInstance();
    gate = NetworkGate.getInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
    NetworkGate.resetInstance();
  });

  // -----------------------------------------------------------------------
  // acquirePermit — healthy
  // -----------------------------------------------------------------------

  it("acquirePermit resolves immediately when healthy", async () => {
    const start = Date.now();
    await gate.acquirePermit();
    const elapsed = Date.now() - start;

    expect(elapsed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // acquirePermit — throttled (waits during backoff)
  // -----------------------------------------------------------------------

  it("acquirePermit waits during backoff period", async () => {
    // Seed Math.random to produce 0.5 → jitter factor = 0.8 + 0.5*0.4 = 1.0
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    gate.reportAnomaly("HTTP 429");

    const permitPromise = gate.acquirePermit();
    let resolved = false;
    permitPromise.then(() => { resolved = true; });

    // Advance time just short of the backoff.
    await vi.advanceTimersByTimeAsync(BACKOFF_INITIAL_MS - 1);
    expect(resolved).toBe(false);

    // Advance past the backoff.
    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);

    vi.spyOn(Math, "random").mockRestore();
  });

  // -----------------------------------------------------------------------
  // reportAnomaly triggers backoff
  // -----------------------------------------------------------------------

  it("reportAnomaly triggers backoff", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0x

    gate.reportAnomaly("503");

    const health = gate.getHealth();
    expect(health.status).toBe("throttled");
    expect(health.backoffRemainingMs).toBeGreaterThan(0);

    vi.spyOn(Math, "random").mockRestore();
  });

  // -----------------------------------------------------------------------
  // Exponential backoff: initial 5s, doubles each time, max 5min
  // -----------------------------------------------------------------------

  it("exponential backoff: initial 5s, doubles each time, max 5min", () => {
    // Use jitter factor = 1.0 so we see exact doubling.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // First anomaly: 5 000 ms
    gate.reportAnomaly("HTTP 429");
    let health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(BACKOFF_INITIAL_MS); // 5 000

    // Reset to healthy so we can trigger again cleanly.
    gate.reset();

    // Second anomaly after reset starts fresh at BACKOFF_INITIAL_MS again
    // because reset() re-initialises currentBackoffMs.
    // Instead, report two anomalies without resetting, each extending.
    gate.reportAnomaly("HTTP 429"); // 5 000
    gate.reportAnomaly("HTTP 429"); // 10 000 (doubled)

    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(10_000);

    // Continue doubling.
    gate.reportAnomaly("timeout"); // 20 000
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(20_000);

    gate.reportAnomaly("timeout"); // 40 000
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(40_000);

    gate.reportAnomaly("timeout"); // 80 000
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(80_000);

    gate.reportAnomaly("timeout"); // 160 000
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(160_000);

    gate.reportAnomaly("timeout"); // 300 000 (capped at max)
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(BACKOFF_MAX_MS); // 300 000

    // One more should still be capped.
    gate.reportAnomaly("CAPTCHA"); // still 300 000
    health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(BACKOFF_MAX_MS);

    vi.spyOn(Math, "random").mockRestore();
  });

  // -----------------------------------------------------------------------
  // Backoff includes jitter (not exact doubles)
  // -----------------------------------------------------------------------

  it("backoff includes jitter (not exact doubles)", () => {
    // First call: random = 0.0 → jitter factor = 0.8 → 4000
    // Second call: random = 1.0 → jitter factor = 1.2 → 12000
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom.mockReturnValueOnce(0.0); // first anomaly: 5000 * 0.8 = 4000
    mockRandom.mockReturnValueOnce(1.0); // second anomaly: 10000 * 1.2 = 12000 (but close enough)

    gate.reportAnomaly("HTTP 429");
    let health = gate.getHealth();
    expect(health.backoffRemainingMs).toBe(4_000); // 5000 * 0.8

    gate.reportAnomaly("HTTP 429");
    health = gate.getHealth();
    // currentBackoffMs was doubled to 10_000 after first report.
    // 10_000 * (0.8 + 1.0*0.4) = 10_000 * 1.2 = 12_000
    expect(health.backoffRemainingMs).toBe(12_000);

    // Neither is an exact double of the base.
    expect(health.backoffRemainingMs).not.toBe(10_000);

    mockRandom.mockRestore();
  });

  // -----------------------------------------------------------------------
  // getHealth returns current NetworkHealth
  // -----------------------------------------------------------------------

  it("getHealth returns current NetworkHealth shape", () => {
    const health = gate.getHealth();

    expect(health).toEqual({
      status: "healthy",
      backoffUntil: null,
      backoffRemainingMs: null,
      lastCheckedAt: expect.any(String),
      recentLatencyMs: 0,
    });

    // Verify lastCheckedAt is a valid ISO string.
    expect(() => new Date(health.lastCheckedAt)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Health status transitions: healthy → throttled → healthy
  // -----------------------------------------------------------------------

  it("health status transitions: healthy -> throttled -> healthy (after backoff expires)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0x

    // Starts healthy.
    expect(gate.getHealth().status).toBe("healthy");

    // Anomaly → throttled.
    gate.reportAnomaly("CAPTCHA");
    expect(gate.getHealth().status).toBe("throttled");

    // Advance time past the backoff.
    await vi.advanceTimersByTimeAsync(BACKOFF_INITIAL_MS + 1);

    // Should be healthy again.
    expect(gate.getHealth().status).toBe("healthy");

    vi.spyOn(Math, "random").mockRestore();
  });

  // -----------------------------------------------------------------------
  // Fail-open (FR-195)
  // -----------------------------------------------------------------------

  it("fail-open: if acquirePermit itself errors internally, it resolves (not rejects) with warning", async () => {
    // Force an internal error by making Date.now() throw on the second call
    // inside acquirePermit (after the first call in the try block).
    const originalDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call in acquirePermit → throw to trigger catch.
        throw new Error("synthetic internal error");
      }
      return originalDateNow();
    });

    // Should resolve, not reject.
    await expect(gate.acquirePermit()).resolves.toBeUndefined();

    vi.spyOn(Date, "now").mockRestore();
  });

  // -----------------------------------------------------------------------
  // Multiple reportAnomaly calls extend backoff exponentially
  // -----------------------------------------------------------------------

  it("multiple reportAnomaly calls extend backoff exponentially", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0x

    const backoffs: number[] = [];

    gate.reportAnomaly("HTTP 429"); // 5 000
    backoffs.push(gate.getHealth().backoffRemainingMs!);

    gate.reportAnomaly("503"); // 10 000
    backoffs.push(gate.getHealth().backoffRemainingMs!);

    gate.reportAnomaly("CAPTCHA"); // 20 000
    backoffs.push(gate.getHealth().backoffRemainingMs!);

    gate.reportAnomaly("timeout"); // 40 000
    backoffs.push(gate.getHealth().backoffRemainingMs!);

    expect(backoffs).toEqual([5_000, 10_000, 20_000, 40_000]);

    // Each step is double the previous.
    for (let i = 1; i < backoffs.length; i++) {
      expect(backoffs[i]).toBe(backoffs[i - 1]! * 2);
    }

    vi.spyOn(Math, "random").mockRestore();
  });

  // -----------------------------------------------------------------------
  // Singleton pattern
  // -----------------------------------------------------------------------

  it("getInstance returns the same instance", () => {
    const a = NetworkGate.getInstance();
    const b = NetworkGate.getInstance();
    expect(a).toBe(b);
  });

  // -----------------------------------------------------------------------
  // reset() returns to healthy state
  // -----------------------------------------------------------------------

  it("reset() clears backoff and returns to healthy", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    gate.reportAnomaly("HTTP 429");
    expect(gate.getHealth().status).toBe("throttled");

    gate.reset();
    expect(gate.getHealth().status).toBe("healthy");
    expect(gate.getHealth().backoffUntil).toBeNull();
    expect(gate.getHealth().backoffRemainingMs).toBeNull();

    vi.spyOn(Math, "random").mockRestore();
  });
});
