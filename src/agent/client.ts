/**
 * CopilotClient singleton — manages the lifecycle of the GitHub Copilot SDK client.
 *
 * Responsibilities:
 *   - Singleton access via getInstance() / resetInstance()
 *   - start() / stop() lifecycle (guards against double-start)
 *   - autoRestart on unexpected process exit
 *   - Exposes the underlying SDK CopilotClient for session creation
 */

import {
  CopilotClient,
  type CopilotClientOptions,
} from "@github/copilot-sdk";
import { logger } from "../shared/logger.js";

const log = logger.child({ module: "CopilotClientSingleton" });

/** Default options forwarded to the SDK CopilotClient constructor. */
const DEFAULT_OPTIONS: CopilotClientOptions = {
  autoStart: false, // We manage start() explicitly.
  autoRestart: true,
};

/**
 * Singleton wrapper around the `@github/copilot-sdk` CopilotClient.
 *
 * The daemon creates one instance at startup and shares it across all
 * MCP request handlers. Each task calls `getClient().createSession(...)`.
 */
export class CopilotClientSingleton {
  // -----------------------------------------------------------------------
  // Singleton plumbing
  // -----------------------------------------------------------------------

  private static instance: CopilotClientSingleton | null = null;

  /** Get (or lazily create) the singleton instance. */
  static getInstance(): CopilotClientSingleton {
    if (!CopilotClientSingleton.instance) {
      CopilotClientSingleton.instance = new CopilotClientSingleton();
    }
    return CopilotClientSingleton.instance;
  }

  /** Discard the current singleton so the next `getInstance()` creates a fresh one. */
  static resetInstance(): void {
    CopilotClientSingleton.instance = null;
  }

  // -----------------------------------------------------------------------
  // Instance state
  // -----------------------------------------------------------------------

  private client: CopilotClient;
  private started = false;
  private intentionalStop = false;
  private restartInProgress = false;

  private constructor(options?: CopilotClientOptions) {
    this.client = new CopilotClient({
      ...DEFAULT_OPTIONS,
      ...options,
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the underlying Copilot CLI process and connect.
   *
   * @throws if the client is already running (call `stop()` first).
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        "CopilotClientSingleton is already running. Call stop() before starting again.",
      );
    }

    this.intentionalStop = false;

    log.info("Starting Copilot CLI client");
    await this.client.start();
    this.started = true;
    log.info("Copilot CLI client started");
  }

  /**
   * Gracefully stop the underlying Copilot CLI process.
   *
   * No-op if the client is not running.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.intentionalStop = true;
    log.info("Stopping Copilot CLI client");

    const errors = await this.client.stop();
    this.started = false;

    if (errors.length > 0) {
      log.warn("Errors during Copilot CLI client shutdown", {
        errors: errors.map((e) => e.message),
      });
    }

    log.info("Copilot CLI client stopped");
  }

  /**
   * Whether the underlying client process is connected and ready.
   *
   * Checks both our own `started` flag and the SDK's connection state so
   * the two stay in sync even if the process exits behind our back.
   */
  isRunning(): boolean {
    if (!this.started) {
      return false;
    }
    const state = this.client.getState();
    return state === "connected";
  }

  /**
   * Return the underlying SDK `CopilotClient` for session creation.
   *
   * @throws if the client has not been started.
   */
  getClient(): CopilotClient {
    if (!this.started) {
      throw new Error(
        "CopilotClient is not running. Call start() first.",
      );
    }
    return this.client;
  }

  // -----------------------------------------------------------------------
  // Auto-restart
  // -----------------------------------------------------------------------

  /**
   * Handle an unexpected process exit (auto-restart logic).
   *
   * Called when the SDK reports that the CLI process exited without an
   * intentional `stop()` call. If `autoRestart` is enabled (default),
   * this will attempt to restart the client.
   *
   * Exposed with an underscore prefix so tests can trigger it directly;
   * production code wires this up via SDK lifecycle events.
   */
  async _handleUnexpectedExit(): Promise<void> {
    if (this.intentionalStop) {
      log.info("Copilot CLI exited after intentional stop — no restart");
      return;
    }

    if (this.restartInProgress) {
      log.warn("Restart already in progress — skipping");
      return;
    }

    log.warn("Copilot CLI exited unexpectedly — attempting restart");
    this.restartInProgress = true;

    try {
      // Mark as not started so start() guard passes.
      this.started = false;
      await this.start();
      log.info("Copilot CLI restarted successfully");
    } catch (err) {
      log.error("Failed to restart Copilot CLI", {
        error: String(err),
      });
    } finally {
      this.restartInProgress = false;
    }
  }
}
