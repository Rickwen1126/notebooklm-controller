/**
 * CopilotClient singleton — manages the lifecycle of the GitHub Copilot SDK client.
 *
 * Responsibilities:
 *   - Singleton access via getInstance() / resetInstance()
 *   - start() / stop() lifecycle (guards against double-start)
 *   - Delegates restart to SDK via `autoRestart: true`
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

}
