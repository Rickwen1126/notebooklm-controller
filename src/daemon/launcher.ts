/**
 * Thin launcher — CLI entry point (`npx nbctl`).
 *
 * Responsibilities:
 * 1. Check if the daemon is already running (PID guard via state.json).
 * 2. Start the daemon if not running.
 * 3. Handle SIGTERM/SIGINT for clean shutdown.
 */

import { readFileSync } from "node:fs";
import { STATE_FILE } from "../shared/config.js";
import { DaemonAlreadyRunningError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { startDaemon, stopDaemon } from "./index.js";
import type { DaemonRuntime } from "./index.js";

const log = logger.child({ module: "launcher" });

// ---------------------------------------------------------------------------
// PID guard
// ---------------------------------------------------------------------------

/** Check if a process with the given PID is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check only
    return true;
  } catch {
    return false;
  }
}

/** Check if the daemon is already running based on state.json. */
export function checkAlreadyRunning(): void {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as { pid: number | null; port: number };
    if (state.pid && isProcessAlive(state.pid)) {
      throw new DaemonAlreadyRunningError(state.port);
    }
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) throw err;
    // State file doesn't exist or is corrupted — safe to start.
  }
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

export async function launch(options?: {
  headless?: boolean;
  chromePath?: string;
}): Promise<void> {
  checkAlreadyRunning();

  let runtime: DaemonRuntime | null = null;

  const shutdown = async () => {
    if (runtime) {
      log.info("Shutdown signal received");
      await stopDaemon(runtime);
      runtime = null;
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  runtime = await startDaemon(options);
  log.info("Daemon launched and ready");
}
