import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PreToolUseHookInput,
  PostToolUseHookInput,
  ErrorOccurredHookInput,
  SessionEndHookInput,
} from "@github/copilot-sdk";

import {
  createSessionHooks,
  type HooksContext,
} from "../../../src/agent/hooks.js";

// ---------------------------------------------------------------------------
// Suppress logger output during tests.
// ---------------------------------------------------------------------------

const { mockChildLogger, mockLogger } = vi.hoisted(() => {
  const mockChildLogger: Record<string, any> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  mockChildLogger.child.mockReturnValue(mockChildLogger);

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue(mockChildLogger),
  };

  return { mockChildLogger, mockLogger };
});

vi.mock("../../../src/shared/logger.js", () => ({
  logger: mockLogger,
}));

// ---------------------------------------------------------------------------
// Mock NetworkGate
// ---------------------------------------------------------------------------

function createMockNetworkGate() {
  return {
    acquirePermit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    reportAnomaly: vi.fn(),
    getHealth: vi.fn().mockReturnValue({ status: "healthy" }),
    reset: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreToolUseInput(
  overrides?: Partial<PreToolUseHookInput>,
): PreToolUseHookInput {
  return {
    timestamp: Date.now(),
    cwd: "/tmp/test",
    toolName: "browser_click",
    toolArgs: { selector: "#ok" },
    ...overrides,
  };
}

function makeErrorInput(
  overrides?: Partial<ErrorOccurredHookInput>,
): ErrorOccurredHookInput {
  return {
    timestamp: Date.now(),
    cwd: "/tmp/test",
    error: "something went wrong",
    errorContext: "tool_execution",
    recoverable: true,
    ...overrides,
  };
}

function makeSessionEndInput(
  overrides?: Partial<SessionEndHookInput>,
): SessionEndHookInput {
  return {
    timestamp: Date.now(),
    cwd: "/tmp/test",
    reason: "complete",
    ...overrides,
  };
}

function makePostToolUseInput(
  overrides?: Partial<PostToolUseHookInput>,
): PostToolUseHookInput {
  return {
    timestamp: Date.now(),
    cwd: "/tmp/test",
    toolName: "browser_click",
    toolArgs: { selector: "#ok" },
    toolResult: {
      textResultForLlm: "clicked",
      resultType: "success",
    },
    ...overrides,
  };
}

const INVOCATION = { sessionId: "sess-123" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionHooks", () => {
  let mockGate: ReturnType<typeof createMockNetworkGate>;
  let context: HooksContext;

  beforeEach(() => {
    mockGate = createMockNetworkGate();
    context = {
      networkGate: mockGate as unknown as HooksContext["networkGate"],
      taskId: "task-001",
      notebookAlias: "my-notebook",
    };
  });

  // -----------------------------------------------------------------------
  // onPreToolUse
  // -----------------------------------------------------------------------

  describe("onPreToolUse", () => {
    it("calls NetworkGate.acquirePermit before each tool", async () => {
      const hooks = createSessionHooks(context);
      const input = makePreToolUseInput();

      await hooks.onPreToolUse!(input, INVOCATION);

      expect(mockGate.acquirePermit).toHaveBeenCalledOnce();
    });

    it("calls acquirePermit on every invocation", async () => {
      const hooks = createSessionHooks(context);

      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "tool_a" }), INVOCATION);
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "tool_b" }), INVOCATION);
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "tool_c" }), INVOCATION);

      expect(mockGate.acquirePermit).toHaveBeenCalledTimes(3);
    });

    it("fail-open: if acquirePermit errors, tool still proceeds (FR-195)", async () => {
      mockGate.acquirePermit.mockRejectedValueOnce(
        new Error("gate internal error"),
      );

      const hooks = createSessionHooks(context);
      const input = makePreToolUseInput();

      // Should resolve (not reject), allowing the tool to proceed.
      const result = await hooks.onPreToolUse!(input, INVOCATION);

      // undefined means "no modifications, proceed normally".
      expect(result).toBeUndefined();
    });

    it("fail-open: proceeds even when acquirePermit throws a non-Error", async () => {
      mockGate.acquirePermit.mockRejectedValueOnce("string error");

      const hooks = createSessionHooks(context);

      const result = await hooks.onPreToolUse!(
        makePreToolUseInput(),
        INVOCATION,
      );

      expect(result).toBeUndefined();
    });

    it("logs tool invocation with correlation context (taskId, notebookAlias)", async () => {
      // Reset spies so we get a clean slate.
      mockLogger.child.mockClear();
      mockChildLogger.info.mockClear();

      const hooks = createSessionHooks(context);

      // Verify logger.child was called with correlation context.
      expect(mockLogger.child).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-001",
          notebookAlias: "my-notebook",
        }),
      );

      // Fire a tool invocation.
      await hooks.onPreToolUse!(
        makePreToolUseInput({ toolName: "screenshot" }),
        INVOCATION,
      );

      // The child logger's info should have been called with tool details.
      expect(mockChildLogger.info).toHaveBeenCalledWith(
        "Tool invocation starting",
        expect.objectContaining({
          toolName: "screenshot",
          actionType: "screenshot",
          sessionId: "sess-123",
          toolCallIndex: 1,
        }),
      );
    });

    it("increments toolCallIndex across multiple invocations", async () => {
      mockChildLogger.info.mockClear();
      const hooks = createSessionHooks(context);

      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "tool_a" }), INVOCATION);
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "tool_b" }), INVOCATION);

      const calls = mockChildLogger.info.mock.calls.filter(
        (c: unknown[]) => c[0] === "Tool invocation starting",
      );
      expect(calls[0][1].toolCallIndex).toBe(1);
      expect(calls[1][1].toolCallIndex).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // onPostToolUse
  // -----------------------------------------------------------------------

  describe("onPostToolUse", () => {
    it("returns undefined (no modifications)", async () => {
      const hooks = createSessionHooks(context);
      const result = await hooks.onPostToolUse!(
        makePostToolUseInput(),
        INVOCATION,
      );
      expect(result).toBeUndefined();
    });

    it("logs tool duration and call index (FR-051)", async () => {
      mockChildLogger.info.mockClear();
      const hooks = createSessionHooks(context);

      // Pre → Post sequence to get timing
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "click" }), INVOCATION);
      await hooks.onPostToolUse!(makePostToolUseInput({ toolName: "click" }), INVOCATION);

      const postCall = mockChildLogger.info.mock.calls.find(
        (c: unknown[]) => c[0] === "Tool invocation completed",
      );
      expect(postCall).toBeDefined();
      expect(postCall![1]).toEqual(
        expect.objectContaining({
          actionType: "click",
          toolDurationMs: expect.any(Number),
          toolCallIndex: 1,
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // onErrorOccurred
  // -----------------------------------------------------------------------

  describe("onErrorOccurred", () => {
    it("returns retry for transient errors (network timeout)", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Request timeout after 30000ms" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "retry" }),
      );
    });

    it("returns retry for 429 errors", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "HTTP 429 Too Many Requests" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "retry" }),
      );
    });

    it("returns retry for rate limit errors", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Rate limit exceeded" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "retry" }),
      );
    });

    it("returns retry for 503 errors", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "503 Service Unavailable" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "retry" }),
      );
    });

    it("returns skip for non-critical errors (element not found)", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Element not found: #submit-button" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "skip" }),
      );
    });

    it("returns skip for selector not found", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Selector .foo not found on page" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "skip" }),
      );
    });

    it("returns abort for fatal errors (auth expired)", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Authentication expired, please re-login" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "abort" }),
      );
    });

    it("returns abort for Chrome crash", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Chrome crashed unexpectedly" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "abort" }),
      );
    });

    it("returns abort for browser closed", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Browser closed: target page destroyed" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "abort" }),
      );
    });

    it("returns abort for unknown errors (safe default)", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Something completely unexpected happened" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({ errorHandling: "abort" }),
      );
    });

    it("includes retryCount=3 for retry decisions", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "ETIMEDOUT connecting to host" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({
          errorHandling: "retry",
          retryCount: 3,
        }),
      );
    });

    it("includes userNotification for abort decisions", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onErrorOccurred!(
        makeErrorInput({ error: "Auth expired" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({
          errorHandling: "abort",
          userNotification: expect.stringContaining("Auth expired"),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // onSessionEnd
  // -----------------------------------------------------------------------

  describe("onSessionEnd", () => {
    it("performs cleanup and returns session summary", async () => {
      const hooks = createSessionHooks(context);

      const result = await hooks.onSessionEnd!(
        makeSessionEndInput({ reason: "complete" }),
        INVOCATION,
      );

      expect(result).toEqual(
        expect.objectContaining({
          sessionSummary: expect.stringContaining("reason: complete"),
        }),
      );
    });

    it("includes duration in summary", async () => {
      const hooks = createSessionHooks(context);

      // Allow some time to pass.
      const result = await hooks.onSessionEnd!(
        makeSessionEndInput(),
        INVOCATION,
      );

      expect(result?.sessionSummary).toMatch(/completed in \d+ms/);
    });

    it("includes aggregate tool and error counts in summary (FR-051)", async () => {
      const hooks = createSessionHooks(context);

      // Simulate 2 tool calls and 1 error
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "click" }), INVOCATION);
      await hooks.onPostToolUse!(makePostToolUseInput({ toolName: "click" }), INVOCATION);
      await hooks.onPreToolUse!(makePreToolUseInput({ toolName: "type" }), INVOCATION);
      await hooks.onPostToolUse!(makePostToolUseInput({ toolName: "type" }), INVOCATION);
      await hooks.onErrorOccurred!(makeErrorInput({ error: "timeout" }), INVOCATION);

      const result = await hooks.onSessionEnd!(
        makeSessionEndInput(),
        INVOCATION,
      );

      expect(result?.sessionSummary).toContain("tools: 2");
      expect(result?.sessionSummary).toContain("errors: 1");
    });

    it("logs session end with duration", async () => {
      // Reset the child logger spies so we get a clean slate.
      mockChildLogger.info.mockClear();

      const hooks = createSessionHooks(context);

      await hooks.onSessionEnd!(
        makeSessionEndInput({ reason: "error", error: "boom" }),
        INVOCATION,
      );

      expect(mockChildLogger.info).toHaveBeenCalledWith(
        "Session ended",
        expect.objectContaining({
          reason: "error",
          durationMs: expect.any(Number),
          totalToolCalls: expect.any(Number),
          totalErrors: expect.any(Number),
          error: "boom",
        }),
      );
    });

    it("handles all session end reasons", async () => {
      const reasons: SessionEndHookInput["reason"][] = [
        "complete",
        "error",
        "abort",
        "timeout",
        "user_exit",
      ];

      for (const reason of reasons) {
        const hooks = createSessionHooks(context);
        const result = await hooks.onSessionEnd!(
          makeSessionEndInput({ reason }),
          INVOCATION,
        );

        expect(result?.sessionSummary).toContain(`reason: ${reason}`);
        expect(result?.sessionSummary).toContain("tools:");
        expect(result?.sessionSummary).toContain("errors:");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Hook wiring
  // -----------------------------------------------------------------------

  describe("hook wiring", () => {
    it("returns all required hooks", () => {
      const hooks = createSessionHooks(context);

      expect(hooks.onPreToolUse).toBeTypeOf("function");
      expect(hooks.onPostToolUse).toBeTypeOf("function");
      expect(hooks.onErrorOccurred).toBeTypeOf("function");
      expect(hooks.onSessionEnd).toBeTypeOf("function");
    });
  });
});
