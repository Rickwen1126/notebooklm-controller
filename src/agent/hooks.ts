/**
 * SessionHooks — lifecycle hooks for Copilot SDK sessions.
 *
 * Integrates NetworkGate permit acquisition (fail-open, FR-195),
 * structured logging with correlation context (FR-051), and
 * error classification for retry/skip/abort decisions.
 */

import type { SessionConfig } from "@github/copilot-sdk";

/** SDK SessionHooks type derived from SessionConfig (not directly exported). */
type SessionHooks = NonNullable<SessionConfig['hooks']>;

import type { NetworkGate } from "../network-gate/network-gate.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HooksContext {
  networkGate: NetworkGate;
  taskId: string;
  notebookAlias: string;
}

// ---------------------------------------------------------------------------
// Error classification patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate a transient / retriable error. */
const TRANSIENT_PATTERNS = [
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /429/,
  /too many requests/i,
  /rate limit/i,
  /503/,
  /service unavailable/i,
  /network/i,
] as const;

/** Patterns that indicate a non-critical error the agent can skip over. */
const NON_CRITICAL_PATTERNS = [
  /element not found/i,
  /selector.*not found/i,
  /no such element/i,
  /not visible/i,
  /stale element/i,
  /node not found/i,
] as const;

/** Patterns that indicate a fatal error requiring immediate abort. */
const FATAL_PATTERNS = [
  /auth.*expired/i,
  /authentication.*failed/i,
  /unauthorized/i,
  /chrome.*crash/i,
  /browser.*closed/i,
  /target.*closed/i,
  /session.*closed/i,
  /protocol error/i,
  /cdp.*disconnect/i,
] as const;

type ErrorHandling = "retry" | "skip" | "abort";

function classifyError(error: string): ErrorHandling {
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(error)) return "abort";
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(error)) return "retry";
  }
  for (const pattern of NON_CRITICAL_PATTERNS) {
    if (pattern.test(error)) return "skip";
  }
  // Default: unknown errors are treated as abort to avoid silent data loss.
  return "abort";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionHooks(context: HooksContext): SessionHooks {
  const { networkGate, taskId, notebookAlias } = context;

  const log = logger.child({
    module: "SessionHooks",
    taskId,
    notebookAlias,
  });

  const sessionStartTime = Date.now();
  let toolCallCount = 0;
  let errorCount = 0;
  let lastToolStartTime = 0;

  // -------------------------------------------------------------------------
  // onPreToolUse
  // -------------------------------------------------------------------------

  const onPreToolUse: SessionHooks['onPreToolUse'] = async (input, invocation) => {
    const { toolName } = input;
    toolCallCount++;
    lastToolStartTime = Date.now();

    // Structured logging with correlation context (FR-051).
    log.info("Tool invocation starting", {
      actionType: toolName,
      sessionId: invocation.sessionId,
      toolName,
      toolCallIndex: toolCallCount,
    });

    // Acquire a network permit before each tool call.
    // Fail-open (FR-195): if acquirePermit throws, log a warning and proceed.
    try {
      await networkGate.acquirePermit();
    } catch (err: unknown) {
      log.warn("NetworkGate.acquirePermit failed; proceeding (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
        toolName,
      });
    }

    // Allow the tool to proceed.
    return undefined;
  };

  // -------------------------------------------------------------------------
  // onPostToolUse
  // -------------------------------------------------------------------------

  const onPostToolUse: SessionHooks['onPostToolUse'] = async (input) => {
    const toolDurationMs = lastToolStartTime > 0 ? Date.now() - lastToolStartTime : undefined;

    log.info("Tool invocation completed", {
      actionType: input.toolName,
      resultType: input.toolResult.resultType,
      toolDurationMs,
      toolCallIndex: toolCallCount,
    });

    return undefined;
  };

  // -------------------------------------------------------------------------
  // onErrorOccurred
  // -------------------------------------------------------------------------

  const onErrorOccurred: SessionHooks['onErrorOccurred'] = async (input) => {
    const { error, errorContext, recoverable } = input;
    const handling = classifyError(error);
    errorCount++;

    log.error("Error occurred during session", {
      error,
      errorContext,
      recoverable,
      handling,
      errorIndex: errorCount,
    });

    return {
      errorHandling: handling,
      retryCount: handling === "retry" ? 3 : undefined,
      userNotification:
        handling === "abort"
          ? `Fatal error: ${error}`
          : undefined,
    };
  };

  // -------------------------------------------------------------------------
  // onSessionEnd
  // -------------------------------------------------------------------------

  const onSessionEnd: SessionHooks['onSessionEnd'] = async (input) => {
    const durationMs = Date.now() - sessionStartTime;

    log.info("Session ended", {
      reason: input.reason,
      durationMs,
      totalToolCalls: toolCallCount,
      totalErrors: errorCount,
      finalMessage: input.finalMessage,
      error: input.error,
    });

    return {
      sessionSummary: `Session completed in ${durationMs}ms (reason: ${input.reason}, tools: ${toolCallCount}, errors: ${errorCount})`,
    };
  };

  return {
    onPreToolUse,
    onPostToolUse,
    onErrorOccurred,
    onSessionEnd,
  };
}
