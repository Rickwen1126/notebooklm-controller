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
  // defineTool: pass-through that returns a tool-like object the mock can handle
  defineTool: (name: string, opts: { handler: (...args: unknown[]) => unknown }) => ({
    name,
    handler: opts.handler,
  }),
}));

// Import module under test after mocks are established.
import {
  runSession,
  runPlannerSession,
  runExecutorSession,
  runDualSession,
  REJECTION_CATEGORIES,
} from "../../../src/agent/session-runner.js";
import type {
  SessionRunnerOptions,
  DualSessionOptions,
} from "../../../src/agent/session-runner.js";
import type { CopilotClientSingleton } from "../../../src/agent/client.js";
import type { AgentConfig, ExecutionStep } from "../../../src/shared/types.js";
import {
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_AGENT_MODEL,
} from "../../../src/shared/config.js";

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

  it("passes model to createSession when specified", async () => {
    const options = makeOptions({ model: "gpt-4o" });

    await runSession(options, "test prompt");

    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    expect(createArg.model).toBe("gpt-4o");
  });

  it("uses DEFAULT_AGENT_MODEL when model is not specified", async () => {
    await runSession(makeOptions(), "test prompt");

    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    expect(createArg.model).toBe(DEFAULT_AGENT_MODEL);
  });

  // T041.6: Response validation
  it("warns when sendAndWait returns null response", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mockSendAndWait.mockResolvedValue(null);

    const result = await runSession(makeOptions(), "silent prompt");

    expect(result.success).toBe(true);
    expect(result.result).toBeUndefined();

    // Verify the warning was logged (structured JSON to stderr).
    const warnCall = stderrSpy.mock.calls.find((call) => {
      const line = String(call[0]);
      return line.includes('"level":"warn"') && line.includes("sendAndWait returned null response");
    });
    expect(warnCall).toBeDefined();

    stderrSpy.mockRestore();
  });

  // T041.7: Disconnect hang guard
  it("disconnect timeout does not block session result", async () => {
    // Mock disconnect to never resolve (simulates a hang).
    mockDisconnect.mockReturnValue(new Promise(() => {}));

    const start = Date.now();
    const result = await runSession(makeOptions(), "test prompt");
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.result).toBe("Hello from agent");
    // The 5s disconnect timeout should fire; total time should be well under 10s.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

// ===========================================================================
// Phase 5.5: Dual Session Tests (T068D-F)
// ===========================================================================

/** Build a minimal AgentConfig for testing. */
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    description: "A test agent",
    tools: ["find", "click", "screenshot"],
    prompt: "You are a test agent. Do the task.",
    infer: true,
    startPage: "notebook",
    parameters: {},
    ...overrides,
  };
}

/** Build DualSessionOptions with sensible defaults. */
function makeDualOptions(
  overrides?: Partial<DualSessionOptions>,
): DualSessionOptions {
  return {
    client: {
      getClient: () => fakeSdkClient,
    } as unknown as CopilotClientSingleton,
    tools: [
      { name: "find", handler: vi.fn() },
      { name: "click", handler: vi.fn() },
      { name: "screenshot", handler: vi.fn() },
      { name: "paste", handler: vi.fn() },
    ] as unknown as import("@github/copilot-sdk").Tool[],
    agentConfigs: [
      makeAgentConfig({ name: "list-sources", description: "List sources", tools: ["find", "read", "screenshot"] }),
      makeAgentConfig({ name: "query", description: "Query notebook", tools: ["find", "click", "paste", "screenshot"] }),
    ],
    hooks: {},
    locale: "zh-TW",
    notebookAlias: "test-notebook",
    ...overrides,
  };
}

/**
 * Simulate the Planner calling submitPlan by intercepting createSession
 * and invoking the submitPlan tool handler directly.
 */
function mockPlannerResponse(plan: {
  reasoning: string;
  steps: Array<{ agentName: string; executorPrompt: string; tools: string[] }>;
}) {
  // When createSession is called, find the submitPlan tool and invoke its handler.
  mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
    const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
    if (submitPlan) {
      // Simulate the agent calling submitPlan
      await submitPlan.handler(plan);
    }
    return {
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait,
      disconnect: mockDisconnect,
    };
  });
}

/**
 * Simulate the Planner calling rejectInput by intercepting createSession
 * and invoking the rejectInput tool handler directly.
 */
function mockPlannerRejection(rejection: { category: string; reason: string }) {
  mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
    const rejectInput = opts.tools?.find((t) => t.name === "rejectInput");
    if (rejectInput) {
      await rejectInput.handler(rejection);
    }
    return {
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait,
      disconnect: mockDisconnect,
    };
  });
}

// ---------------------------------------------------------------------------
// T068D: runPlannerSession
// ---------------------------------------------------------------------------

describe("runPlannerSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendAndWait.mockResolvedValue(
      fakeAssistantMessage("Plan submitted."),
    );
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("captures plan via submitPlan tool and returns PlannerResult with kind=plan", async () => {
    const expectedPlan = {
      reasoning: "User wants to list sources",
      steps: [
        { agentName: "list-sources", executorPrompt: "列出來源", tools: ["find", "read", "screenshot"] },
      ],
    };
    mockPlannerResponse(expectedPlan);

    const result = await runPlannerSession(makeDualOptions(), "列出來源");

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("unexpected");
    expect(result.plan.reasoning).toBe("User wants to list sources");
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0].agentName).toBe("list-sources");
  });

  it("throws when Planner calls neither submitPlan nor rejectInput", async () => {
    // Default mock: createSession returns session without calling either tool.
    mockCreateSession.mockResolvedValue({
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait,
      disconnect: mockDisconnect,
    });

    await expect(
      runPlannerSession(makeDualOptions(), "列出來源"),
    ).rejects.toThrow("Planner did not submit a plan");
  });

  it("passes agent catalog in system message to the session", async () => {
    const expectedPlan = {
      reasoning: "test",
      steps: [{ agentName: "query", executorPrompt: "問問題", tools: ["find"] }],
    };
    mockPlannerResponse(expectedPlan);

    await runPlannerSession(makeDualOptions(), "問一個問題");

    // Verify createSession was called.
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("supports multi-step plans", async () => {
    const multiStepPlan = {
      reasoning: "Compound operation",
      steps: [
        { agentName: "list-sources", executorPrompt: "先列出來源", tools: ["find", "read"] },
        { agentName: "query", executorPrompt: "然後問問題", tools: ["find", "click", "paste"] },
      ],
    };
    mockPlannerResponse(multiStepPlan);

    const result = await runPlannerSession(makeDualOptions(), "列出來源然後問問題");

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("unexpected");
    expect(result.plan.steps).toHaveLength(2);
    expect(result.plan.steps[0].agentName).toBe("list-sources");
    expect(result.plan.steps[1].agentName).toBe("query");
  });
});

// ---------------------------------------------------------------------------
// T-SB01: Planner Input Gate (rejectInput tool)
// ---------------------------------------------------------------------------

describe("runPlannerSession — rejectInput (T-SB01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendAndWait.mockResolvedValue(
      fakeAssistantMessage("Rejected."),
    );
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("returns rejected PlannerResult when Planner calls rejectInput", async () => {
    mockPlannerRejection({
      category: "off_topic",
      reason: "This request is about weather, not NotebookLM.",
    });

    const result = await runPlannerSession(makeDualOptions(), "天氣如何？");

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unexpected");
    expect(result.category).toBe("off_topic");
    expect(result.reason).toBe("This request is about weather, not NotebookLM.");
  });

  it("all 6 rejection categories are accepted", async () => {
    for (const category of REJECTION_CATEGORIES) {
      vi.clearAllMocks();
      mockSendAndWait.mockResolvedValue(fakeAssistantMessage("Rejected."));
      mockDisconnect.mockResolvedValue(undefined);

      mockPlannerRejection({
        category,
        reason: `Rejected with category: ${category}`,
      });

      const result = await runPlannerSession(makeDualOptions(), "test input");

      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unexpected");
      expect(result.category).toBe(category);
    }
  });

  it("provides rejectInput tool alongside submitPlan to the session", async () => {
    mockPlannerRejection({ category: "harmful", reason: "test" });

    await runPlannerSession(makeDualOptions(), "test");

    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    const toolNames = createArg.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("submitPlan");
    expect(toolNames).toContain("rejectInput");
  });
});

describe("runDualSession — rejection early return (T-SB01)", () => {
  let callCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    callCount = 0;
    mockSendAndWait.mockResolvedValue(fakeAssistantMessage("Rejected."));
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("returns rejected SessionResult and skips Executor when Planner rejects", async () => {
    // Only planner session — calls rejectInput, never reaches executor.
    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      callCount++;
      if (callCount === 1) {
        const rejectInput = opts.tools?.find((t) => t.name === "rejectInput");
        if (rejectInput) {
          await rejectInput.handler({ category: "off_topic", reason: "Not a NotebookLM operation" });
        }
      }
      return {
        sessionId: `session-${callCount}`,
        sendAndWait: mockSendAndWait,
        disconnect: mockDisconnect,
      };
    });

    const result = await runDualSession(makeDualOptions(), "天氣如何？");

    expect(result.success).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.rejectionCategory).toBe("off_topic");
    expect(result.rejectionReason).toBe("Not a NotebookLM operation");
    // Only 1 session (planner) — executor should never be called.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it("submitPlan still works as before (no regression)", async () => {
    const plan = {
      reasoning: "User wants to list sources",
      steps: [{ agentName: "list-sources", executorPrompt: "列出來源", tools: ["find", "screenshot"] }],
    };

    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      callCount++;
      if (callCount === 1) {
        const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
        if (submitPlan) await submitPlan.handler(plan);
      }
      return {
        sessionId: `session-${callCount}`,
        sendAndWait: mockSendAndWait.mockResolvedValue(
          fakeAssistantMessage(callCount === 1 ? "Plan done." : "Found 3 sources."),
        ),
        disconnect: mockDisconnect,
      };
    });

    const result = await runDualSession(makeDualOptions(), "列出來源");

    expect(result.success).toBe(true);
    expect(result.rejected).toBeUndefined();
    expect(result.rejectionCategory).toBeUndefined();
    // Two sessions: planner + executor.
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("neither tool called → throws error (current behavior preserved)", async () => {
    mockCreateSession.mockResolvedValue({
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait.mockResolvedValue(fakeAssistantMessage("I can't help with that.")),
      disconnect: mockDisconnect,
    });

    const result = await runDualSession(makeDualOptions(), "天氣如何？");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Planner did not submit a plan");
    expect(result.rejected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T068E: runExecutorSession
// ---------------------------------------------------------------------------

describe("runExecutorSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSession.mockResolvedValue({
      sessionId: "executor-session",
      sendAndWait: mockSendAndWait,
      disconnect: mockDisconnect,
    });
    mockSendAndWait.mockResolvedValue(
      fakeAssistantMessage("Source list: 3 sources found."),
    );
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("looks up agent config and runs session with filtered tools", async () => {
    const step: ExecutionStep = {
      agentName: "list-sources",
      executorPrompt: "列出所有來源",
      tools: ["find", "screenshot"],
    };

    const result = await runExecutorSession(makeDualOptions(), step);

    expect(result.success).toBe(true);
    expect(result.result).toBe("Source list: 3 sources found.");
    // Verify createSession was called with filtered tools.
    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    // Should have find + screenshot (from step.tools, screenshot auto-included).
    expect(createArg.tools.length).toBeGreaterThanOrEqual(1);
  });

  it("returns error for unknown agent name", async () => {
    const step: ExecutionStep = {
      agentName: "nonexistent-agent",
      executorPrompt: "do something",
      tools: ["find"],
    };

    const result = await runExecutorSession(makeDualOptions(), step);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown agent: nonexistent-agent");
    // Should not call createSession at all.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("passes tool constraint as systemMessage and step prompt as sendAndWait prompt (T-HF04)", async () => {
    const step: ExecutionStep = {
      agentName: "query",
      executorPrompt: "向 NotebookLM 提問",
      tools: ["find", "click", "paste"],
    };

    await runExecutorSession(makeDualOptions(), step);

    // systemMessage (tool constraint + context + agent prompt) goes to createSession.
    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createArg = mockCreateSession.mock.calls[0][0];
    expect(createArg.systemMessage).toContain("禁止使用");
    expect(createArg.systemMessage).toContain("目標 Notebook:");

    // Only the step-level instruction goes to sendAndWait.
    expect(mockSendAndWait).toHaveBeenCalledOnce();
    const sentPrompt = mockSendAndWait.mock.calls[0][0].prompt;
    expect(sentPrompt).toBe("向 NotebookLM 提問");
  });
});

// ---------------------------------------------------------------------------
// T068F: runDualSession
// ---------------------------------------------------------------------------

describe("runDualSession", () => {
  let callCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    callCount = 0;
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("orchestrates planner → executor → returns aggregated result", async () => {
    const plan = {
      reasoning: "User wants to list sources",
      steps: [{ agentName: "list-sources", executorPrompt: "列出來源", tools: ["find", "screenshot"] }],
    };

    // First call: Planner session (calls submitPlan).
    // Second call: Executor session.
    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      callCount++;
      if (callCount === 1) {
        // Planner: call submitPlan.
        const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
        if (submitPlan) await submitPlan.handler(plan);
      }
      return {
        sessionId: `session-${callCount}`,
        sendAndWait: mockSendAndWait.mockResolvedValue(
          fakeAssistantMessage(callCount === 1 ? "Plan done." : "Found 3 sources."),
        ),
        disconnect: mockDisconnect,
      };
    });

    const result = await runDualSession(makeDualOptions(), "列出來源");

    expect(result.success).toBe(true);
    expect(result.result).toBe("Found 3 sources.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Two sessions: planner + executor.
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("handles multi-step plan and returns last step result", async () => {
    const plan = {
      reasoning: "Compound",
      steps: [
        { agentName: "list-sources", executorPrompt: "列出來源", tools: ["find"] },
        { agentName: "query", executorPrompt: "問問題", tools: ["find", "click"] },
      ],
    };

    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      callCount++;
      if (callCount === 1) {
        const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
        if (submitPlan) await submitPlan.handler(plan);
      }
      const messages = ["Plan done.", "Sources listed.", "Answer: TypeScript is great."];
      return {
        sessionId: `session-${callCount}`,
        sendAndWait: vi.fn().mockResolvedValue(fakeAssistantMessage(messages[callCount - 1] ?? "")),
        disconnect: mockDisconnect,
      };
    });

    const result = await runDualSession(makeDualOptions(), "列出來源然後問問題");

    expect(result.success).toBe(true);
    expect(result.result).toBe("Answer: TypeScript is great.");
    // Three sessions: planner + 2 executors.
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
  });

  it("propagates executor failure and stops", async () => {
    const plan = {
      reasoning: "Two steps",
      steps: [
        { agentName: "list-sources", executorPrompt: "列出來源", tools: ["find"] },
        { agentName: "query", executorPrompt: "問問題", tools: ["find"] },
      ],
    };

    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      callCount++;
      if (callCount === 1) {
        const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
        if (submitPlan) await submitPlan.handler(plan);
      }
      return {
        sessionId: `session-${callCount}`,
        sendAndWait: callCount === 2
          ? vi.fn().mockRejectedValue(new Error("Chrome crashed"))
          : vi.fn().mockResolvedValue(fakeAssistantMessage("ok")),
        disconnect: mockDisconnect,
      };
    });

    const result = await runDualSession(makeDualOptions(), "do stuff");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Step 1/2");
    expect(result.error).toContain("list-sources");
    expect(result.error).toContain("Chrome crashed");
    // Only 2 sessions: planner + first executor (fails, skips second).
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("returns error when planner fails", async () => {
    // Planner doesn't call submitPlan.
    mockCreateSession.mockResolvedValue({
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait.mockResolvedValue(fakeAssistantMessage("I can't help with that.")),
      disconnect: mockDisconnect,
    });

    const result = await runDualSession(makeDualOptions(), "天氣如何？");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Planner did not submit a plan");
  });
});
