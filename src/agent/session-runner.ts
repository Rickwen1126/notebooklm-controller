/**
 * Session runner — executes a single agent task within a Copilot SDK session.
 *
 * Responsibilities:
 *   - Create a session via CopilotClient.createSession()
 *   - Send a prompt via session.sendAndWait()
 *   - Enforce configurable timeout (FR-031, defaults to DEFAULT_SESSION_TIMEOUT_MS)
 *   - Always disconnect the session in a finally block
 *   - Return a structured SessionResult with success/error and duration
 */

import type { CopilotSession } from "@github/copilot-sdk";
import type {
  CustomAgentConfig,
  Tool,
  PermissionHandler,
} from "@github/copilot-sdk";
import type { CopilotClientSingleton } from "./client.js";
import { DEFAULT_SESSION_TIMEOUT_MS, DEFAULT_AGENT_MODEL } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRunnerOptions {
  client: CopilotClientSingleton;
  tools: Tool[];
  customAgents: CustomAgentConfig[];
  hooks: Record<string, unknown>;
  /** Permission handler forwarded to createSession. Defaults to auto-approve. */
  onPermissionRequest?: PermissionHandler;
  /** Model to use for the session. Defaults to DEFAULT_AGENT_MODEL. */
  model?: string;
  /** Timeout in ms for sendAndWait. Defaults to DEFAULT_SESSION_TIMEOUT_MS (5 min). */
  timeoutMs?: number;
}

export interface SessionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Default permission handler (auto-approve all)
// ---------------------------------------------------------------------------

const autoApprove: PermissionHandler = () => ({ kind: "approved" as const });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single agent session: create → sendAndWait → disconnect.
 *
 * @param options - Session configuration (client, tools, agents, hooks, timeout).
 * @param prompt  - The prompt to send to the agent.
 * @returns A SessionResult indicating success/failure, duration, and optional result.
 */
export async function runSession(
  options: SessionRunnerOptions,
  prompt: string,
): Promise<SessionResult> {
  const {
    client,
    tools,
    customAgents,
    hooks,
    onPermissionRequest = autoApprove,
    model = DEFAULT_AGENT_MODEL,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = options;

  const log = logger.child({ module: "session-runner" });
  const startTime = Date.now();
  let session: CopilotSession | undefined;

  try {
    // 1. Obtain the underlying SDK client.
    const sdkClient = client.getClient();

    log.info("Creating session", {
      model,
      toolCount: tools.length,
      agentCount: customAgents.length,
      timeoutMs,
    });

    // 2. Create a session with tools, custom agents, hooks, and permission handler.
    session = await sdkClient.createSession({
      model,
      tools,
      customAgents,
      hooks,
      onPermissionRequest,
    });

    log.info("Session created, sending prompt", {
      sessionId: session.sessionId,
      promptLength: prompt.length,
    });

    // 3. Send prompt and wait for completion with timeout.
    const response = await session.sendAndWait({ prompt }, timeoutMs);

    // T041.6: Response validation — log response shape for debugging.
    if (!response) {
      log.warn("sendAndWait returned null response", {
        sessionId: session.sessionId,
      });
    }

    const content = response?.data?.content ?? undefined;
    const durationMs = Date.now() - startTime;

    log.info("Session completed successfully", {
      sessionId: session.sessionId,
      durationMs,
      hasResponse: response != null,
    });

    return {
      success: true,
      result: content,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    log.error("Session failed", {
      error: errorMessage,
      durationMs,
    });

    return {
      success: false,
      error: errorMessage,
      durationMs,
    };
  } finally {
    // 4. Always disconnect the session to release resources.
    //    T041.7: Wrap with timeout guard so a hanging disconnect() doesn't block the scheduler.
    if (session) {
      try {
        await Promise.race([
          session.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("disconnect timeout")), 5_000),
          ),
        ]);
      } catch (disconnectErr: unknown) {
        const msg =
          disconnectErr instanceof Error
            ? disconnectErr.message
            : String(disconnectErr);
        log.warn("Failed to disconnect session", { error: msg });
      }
    }
  }
}
