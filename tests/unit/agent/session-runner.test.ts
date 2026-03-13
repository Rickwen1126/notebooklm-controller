import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the SDK module before importing the module under test.
// ---------------------------------------------------------------------------

const mockSendAndWait = vi.fn();
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockCreateSession = vi.fn();

const fakeSdkClient = {
  createSession: mockCreateSession,
};

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {},
}));

// Import module under test after mocks are established.
import { runSession } from "../../../src/agent/session-runner.js";
import type {
  SessionRunnerOptions,
  SessionResult,
} from "../../../src/agent/session-runner.js";
import type { CopilotClientSingleton } from "../../../src/agent/client.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "../../../src/shared/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake CopilotClientSingleton that returns our mock SDK client. */
function makeFakeClient(): CopilotClientSingleton {
  return {
    getClient: () => fakeSdkClient,
  } as unknown as CopilotClientSingleton;
}

/** Build default SessionRunnerOptions with sensible defaults. */
function makeOptions(
  overrides?: Partial<SessionRunnerOptions>,
): SessionRunnerOptions {
  return {
    client: makeFakeClient(),
    tools: [],
    customAgents: [],
    hooks: {},
    ...overrides,
  };
}

/** Build a fake AssistantMessageEvent returned by sendAndWait. */
function fakeAssistantMessage(content: string) {
  return {
    type: "assistant.message" as const,
    id: "evt-1",
    timestamp: new Date().toISOString(),
    parentId: null,
    data: {
      messageId: "msg-1",
      content,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: createSession returns a fake session with sendAndWait + disconnect.
  mockCreateSession.mockResolvedValue({
    sessionId: "test-session-id",
    sendAndWait: mockSendAndWait,
    disconnect: mockDisconnect,
  });

  // Default: sendAndWait returns a successful assistant message.
  mockSendAndWait.mockResolvedValue(
    fakeAssistantMessage("Hello from agent"),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSession", () => {
  it("creates session with tools, custom agents, and hooks", async () => {
    const tools = [
      {
        name: "test-tool",
        description: "A test tool",
        handler: vi.fn(),
      },
    ];
    const customAgents = [
      { name: "test-agent", prompt: "You are a test agent" },
    ];
    const hooks = {
      onPreToolUse: vi.fn(),
    };

    const options = makeOptions({ tools, customAgents, hooks });
    await runSession(options, "do something");

    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    expect(createArg.tools).toBe(tools);
    expect(createArg.customAgents).toBe(customAgents);
    expect(createArg.hooks).toBe(hooks);
    expect(typeof createArg.onPermissionRequest).toBe("function");
  });

  it("sends prompt via sendAndWait and returns result", async () => {
    const result = await runSession(makeOptions(), "summarize this");

    expect(mockSendAndWait).toHaveBeenCalledOnce();
    expect(mockSendAndWait).toHaveBeenCalledWith(
      { prompt: "summarize this" },
      DEFAULT_SESSION_TIMEOUT_MS,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe("Hello from agent");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("disconnects session after completion", async () => {
    await runSession(makeOptions(), "any prompt");

    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it("disconnects session even after sendAndWait failure", async () => {
    mockSendAndWait.mockRejectedValue(new Error("model error"));

    await runSession(makeOptions(), "any prompt");

    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it("handles configurable timeout (FR-031)", async () => {
    const customTimeout = 60_000;
    const options = makeOptions({ timeoutMs: customTimeout });

    await runSession(options, "test prompt");

    expect(mockSendAndWait).toHaveBeenCalledWith(
      { prompt: "test prompt" },
      customTimeout,
    );
  });

  it("uses DEFAULT_SESSION_TIMEOUT_MS when no timeout specified", async () => {
    await runSession(makeOptions(), "test prompt");

    expect(mockSendAndWait).toHaveBeenCalledWith(
      { prompt: "test prompt" },
      DEFAULT_SESSION_TIMEOUT_MS,
    );
  });

  it("handles timeout error from sendAndWait gracefully", async () => {
    mockSendAndWait.mockRejectedValue(new Error("Timeout reached"));

    const result = await runSession(makeOptions(), "slow prompt");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout reached");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles errors from sendAndWait gracefully", async () => {
    mockSendAndWait.mockRejectedValue(
      new Error("Connection lost"),
    );

    const result = await runSession(makeOptions(), "failing prompt");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection lost");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles non-Error thrown values", async () => {
    mockSendAndWait.mockRejectedValue("string error");

    const result = await runSession(makeOptions(), "test");

    expect(result.success).toBe(false);
    expect(result.error).toBe("string error");
  });

  it("collects result from session response", async () => {
    mockSendAndWait.mockResolvedValue(
      fakeAssistantMessage("The answer is 42"),
    );

    const result = await runSession(makeOptions(), "what is 42?");

    expect(result.success).toBe(true);
    expect(result.result).toBe("The answer is 42");
  });

  it("handles undefined response from sendAndWait", async () => {
    mockSendAndWait.mockResolvedValue(undefined);

    const result = await runSession(makeOptions(), "silent prompt");

    expect(result.success).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it("handles createSession failure gracefully", async () => {
    mockCreateSession.mockRejectedValue(
      new Error("Failed to create session"),
    );

    const result = await runSession(makeOptions(), "test");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to create session");
    // disconnect should NOT be called since session was never created.
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("handles getClient failure gracefully", async () => {
    const badClient = {
      getClient: () => {
        throw new Error("CopilotClient is not running. Call start() first.");
      },
    } as unknown as CopilotClientSingleton;

    const result = await runSession(
      makeOptions({ client: badClient }),
      "test",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not running");
  });

  it("does not throw when disconnect fails", async () => {
    mockDisconnect.mockRejectedValue(new Error("disconnect error"));

    // Should not throw — disconnect errors are logged but swallowed.
    const result = await runSession(makeOptions(), "test");

    expect(result.success).toBe(true);
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it("forwards custom onPermissionRequest handler", async () => {
    const customHandler = vi.fn().mockReturnValue({ result: "deny" });
    const options = makeOptions({ onPermissionRequest: customHandler });

    await runSession(options, "test");

    const createArg = mockCreateSession.mock.calls[0][0];
    expect(createArg.onPermissionRequest).toBe(customHandler);
  });
});
