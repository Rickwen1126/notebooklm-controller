/**
 * NetworkGate — centralized traffic gate with exponential backoff (FR-195).
 *
 * Every outbound browser action acquires a permit before proceeding.
 * When an anomaly is reported (429, 503, CAPTCHA, timeout), the gate
 * enters a throttled state and forces callers to wait until the backoff
 * window expires.
 *
 * Fail-open: if acquirePermit itself throws internally, it resolves
 * with a warning log rather than rejecting, so the caller is never
 * blocked by a gate bug.
 */

import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { NetworkHealth } from "../shared/types.js";

const log = logger.child({ module: "NetworkGate" });

export class NetworkGate {
  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  private static instance: NetworkGate | null = null;

  static getInstance(): NetworkGate {
    if (!NetworkGate.instance) {
      NetworkGate.instance = new NetworkGate();
    }
    return NetworkGate.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    NetworkGate.instance = null;
  }

  // -----------------------------------------------------------------------
  // Internal state
  // -----------------------------------------------------------------------

  private backoffUntil: number | null = null;
  private currentBackoffMs: number = BACKOFF_INITIAL_MS;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Acquire a permit to proceed with a network operation.
   *
   * - Healthy: resolves immediately.
   * - Throttled: resolves once the backoff window expires.
   * - Internal error: resolves with a warning log (fail-open, FR-195).
   */
  async acquirePermit(): Promise<void> {
    try {
      if (this.backoffUntil === null) {
        return;
      }

      const remaining = this.backoffUntil - Date.now();
      if (remaining <= 0) {
        // Backoff expired — return to healthy.
        this.backoffUntil = null;
        this.currentBackoffMs = BACKOFF_INITIAL_MS;
        return;
      }

      log.info("Waiting for backoff to expire", {
        remainingMs: remaining,
        backoffUntil: new Date(this.backoffUntil).toISOString(),
      });

      await this.sleep(remaining);

      // After sleeping, clear throttle state.
      this.backoffUntil = null;
      this.currentBackoffMs = BACKOFF_INITIAL_MS;
    } catch (err: unknown) {
      // Fail-open (FR-195): never reject.
      log.warn("acquirePermit encountered an internal error; failing open", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Report a network anomaly. Triggers exponential backoff with jitter.
   *
   * Accepted signals: "HTTP 429", "503", "CAPTCHA", "timeout".
   */
  reportAnomaly(signal: string): void {
    const jitteredMs = this.applyJitter(this.currentBackoffMs);
    this.backoffUntil = Date.now() + jitteredMs;

    log.warn("Network anomaly reported; entering backoff", {
      signal,
      backoffMs: jitteredMs,
      backoffUntil: new Date(this.backoffUntil).toISOString(),
    });

    // Increase for next anomaly (exponential), capped at max.
    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * 2,
      BACKOFF_MAX_MS,
    );
  }

  /** Return a snapshot of the current network health. */
  getHealth(): NetworkHealth {
    const now = Date.now();
    const isThrottled = this.backoffUntil !== null && this.backoffUntil > now;

    return {
      status: isThrottled ? "throttled" : "healthy",
      backoffUntil: isThrottled
        ? new Date(this.backoffUntil!).toISOString()
        : null,
      backoffRemainingMs: isThrottled ? this.backoffUntil! - now : null,
      lastCheckedAt: new Date(now).toISOString(),
      recentLatencyMs: 0,
    };
  }

  /** Reset to a clean healthy state. Primarily for testing. */
  reset(): void {
    this.backoffUntil = null;
    this.currentBackoffMs = BACKOFF_INITIAL_MS;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Apply +-20 % jitter to a duration. */
  private applyJitter(ms: number): number {
    const jitterFactor = 0.8 + Math.random() * 0.4; // [0.8, 1.2)
    return Math.round(ms * jitterFactor);
  }

  /** Promise-based sleep that works with both real and fake timers. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
