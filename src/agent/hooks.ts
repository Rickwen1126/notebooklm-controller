/**
 * SessionHooks — lifecycle hooks for Copilot SDK sessions.
 *
 * Integrates NetworkGate permit acquisition (fail-open, FR-195),
 * structured logging with correlation context (FR-051), and
 * error classification for retry/skip/abort decisions.
 */

import type { ToolResultObject } from "@github/copilot-sdk";

// SDK hook types — defined locally because they're not re-exported from
// the main entry point of @github/copilot-sdk.
interface PreToolUseHookInput { toolName: string; [key: string]: unknown }
type PreToolUseHookOutput = void | undefined;
interface PostToolUseHookInput { toolName: string; toolResult: ToolResultObject; [key: string]: unknown }
type PostToolUseHookOutput = void | undefined;
interface ErrorOccurredHookInput { error: string; errorContext?: string; recoverable?: boolean; [key: string]: unknown }
interface ErrorOccurredHookOutput { errorHandling: string; retryCount?: number; userNotification?: string }
interface SessionEndHookInput { reason: string; finalMessage?: string; error?: string; [key: string]: unknown }
interface SessionEndHookOutput { sessionSummary?: string }
interface SessionHooks {
  onPreToolUse?: (input: PreToolUseHookInput, invocation: { sessionId: string }) => Promise<PreToolUseHookOutput | void> | PreToolUseHookOutput | void;
  onPostToolUse?: (input: PostToolUseHookInput, invocation: { sessionId: string }) => Promise<PostToolUseHookOutput | void> | PostToolUseHookOutput | void;
  onErrorOccurred?: (input: ErrorOccurredHookInput, invocation: { sessionId: string }) => Promise<ErrorOccurredHookOutput | void> | ErrorOccurredHookOutput | void;
  onSessionEnd?: (input: SessionEndHookInput, invocation: { sessionId: string }) => Promise<SessionEndHookOutput | void> | SessionEndHookOutput | void;
}

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

  const onPreToolUse = async (
    input: PreToolUseHookInput,
    invocation: { sessionId: string },
  ): Promise<PreToolUseHookOutput | void> => {
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

  const onPostToolUse = async (
    input: PostToolUseHookInput,
    _invocation: { sessionId: string },
  ): Promise<PostToolUseHookOutput | void> => {
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

  const onErrorOccurred = async (
    input: ErrorOccurredHookInput,
    _invocation: { sessionId: string },
  ): Promise<ErrorOccurredHookOutput | void> => {
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

  const onSessionEnd = async (
    input: SessionEndHookInput,
    _invocation: { sessionId: string },
  ): Promise<SessionEndHookOutput | void> => {
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
