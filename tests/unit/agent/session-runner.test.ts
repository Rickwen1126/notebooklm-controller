import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — declare mock fns that vi.mock factories reference.
// vi.mock factories are hoisted above all imports, so only vi.hoisted vars
// are accessible inside them.
// ---------------------------------------------------------------------------

const {
  mockSendAndWait,
  mockDisconnect,
  mockCreateSession,
  mockRunScript,
  mockRunRecoverySession,
} = vi.hoisted(() => ({
  mockSendAndWait: vi.fn(),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  mockCreateSession: vi.fn(),
  mockRunScript: vi.fn(),
  mockRunRecoverySession: vi.fn(),
}));

const fakeSdkClient = {
  createSession: mockCreateSession,
};

// ---------------------------------------------------------------------------
// vi.mock — module-level mocks (hoisted to top of file).
// ---------------------------------------------------------------------------

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {},
  defineTool: (name: string, opts: { handler: (...args: unknown[]) => unknown }) => ({
    name,
    handler: opts.handler,
  }),
}));

vi.mock("../../../src/scripts/index.js", () => ({
  buildScriptCatalog: () => "mock catalog",
  runScript: mockRunScript,
}));

vi.mock("../../../src/agent/recovery-session.js", () => ({
  runRecoverySession: mockRunRecoverySession,
}));

vi.mock("../../../src/agent/repair-log.js", () => ({
  saveRepairLog: vi.fn(),
  saveScreenshot: vi.fn(),
}));

vi.mock("../../../src/agent/agent-session.js", () => ({
  runAgentSession: vi.fn(),
}));

vi.mock("../../../src/agent/agent-loader.js", () => ({
  loadAgentConfig: vi.fn().mockResolvedValue(null),
}));

// Import module under test after mocks are established.
import {
  runSession,
  runPlannerSession,
  runPipeline,
  REJECTION_CATEGORIES,
} from "../../../src/agent/session-runner.js";
import type {
  SessionRunnerOptions,
  PipelineOptions,
} from "../../../src/agent/session-runner.js";
import type { CopilotClientSingleton } from "../../../src/agent/client.js";
import type { Tool } from "@github/copilot-sdk";
import type { CDPSession, Page } from "puppeteer-core";
import type { UIMap } from "../../../src/shared/types.js";
import type { ScriptResult } from "../../../src/scripts/types.js";
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

/** Build PipelineOptions with sensible defaults (G2 shape). */
function makeDualOptions(
  overrides?: Partial<PipelineOptions>,
): PipelineOptions {
  return {
    client: { getClient: () => fakeSdkClient } as unknown as CopilotClientSingleton,
    tools: [{ name: "find" }, { name: "click" }] as unknown as Tool[],
    cdpSession: {} as unknown as CDPSession,
    page: { url: () => "https://notebooklm.google.com/notebook/abc" } as unknown as Page,
    uiMap: { locale: "zh-TW", verified: true, elements: {}, selectors: {} } as UIMap,
    locale: "zh-TW",
    notebookAlias: "test-notebook",
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

/** Build a successful ScriptResult. */
function makeScriptSuccess(result = "done"): ScriptResult {
  return {
    operation: "query",
    status: "success",
    result,
    log: [],
    totalMs: 100,
    failedAtStep: null,
    failedSelector: null,
  };
}

/** Build a failed ScriptResult. */
function makeScriptFail(): ScriptResult {
  return {
    operation: "query",
    status: "fail",
    result: null,
    log: [],
    totalMs: 50,
    failedAtStep: 2,
    failedSelector: "submit_button",
  };
}

/**
 * Simulate the Planner calling submitPlan by intercepting createSession
 * and invoking the submitPlan tool handler directly.
 */
function mockPlannerResponse(plan: {
  reasoning: string;
  steps: Array<{ operation: string; params: Record<string, string> }>;
}) {
  mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
    const submitPlan = opts.tools?.find((t) => t.name === "submitPlan");
    if (submitPlan) {
      // Convert params Record to expanded fields (matching real submitPlan schema)
      const expandedSteps = plan.steps.map((s) => ({
        operation: s.operation,
        mode: s.mode,
        question: s.params.question,
        content: s.params.content,
        newName: s.params.newName,
        sourceType: s.params.sourceType,
        sourcePath: s.params.sourcePath,
        sourceUrl: s.params.sourceUrl,
        sourceName: s.params.sourceName,
      }));
      await submitPlan.handler({ reasoning: plan.reasoning, steps: expandedSteps });
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
// Tests: runSession (UNCHANGED — kept as-is)
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
// runPlannerSession — updated for G2 schema { operation, params }
// ===========================================================================

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
      reasoning: "User wants to query the notebook",
      steps: [
        { operation: "query", params: { question: "What is TypeScript?" } },
      ],
    };
    mockPlannerResponse(expectedPlan);

    const result = await runPlannerSession(makeDualOptions(), "What is TypeScript?");

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("unexpected");
    expect(result.plan.reasoning).toBe("User wants to query the notebook");
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0].operation).toBe("query");
    expect(result.plan.steps[0].params).toEqual({ question: "What is TypeScript?" });
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

  it("passes script catalog in system message to the session", async () => {
    const expectedPlan = {
      reasoning: "test",
      steps: [{ operation: "query", params: { question: "問問題" } }],
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
        { operation: "listSources", params: {} },
        { operation: "query", params: { question: "問問題" } },
      ],
    };
    mockPlannerResponse(multiStepPlan);

    const result = await runPlannerSession(makeDualOptions(), "列出來源然後問問題");

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("unexpected");
    expect(result.plan.steps).toHaveLength(2);
    expect(result.plan.steps[0].operation).toBe("listSources");
    expect(result.plan.steps[1].operation).toBe("query");
  });
});

// ---------------------------------------------------------------------------
// Planner Input Gate (rejectInput tool)
// ---------------------------------------------------------------------------

describe("runPlannerSession — rejectInput", () => {
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

// ===========================================================================
// runPipeline — G2: Planner -> Script -> Recovery
// ===========================================================================

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendAndWait.mockResolvedValue(fakeAssistantMessage("Plan submitted."));
    mockDisconnect.mockResolvedValue(undefined);
    mockRunScript.mockReset();
    mockRunRecoverySession.mockReset();
  });

  it("script success → no recovery", async () => {
    // Planner submits a single-step plan
    const plan = {
      reasoning: "User wants to query",
      steps: [{ operation: "query", params: { question: "What is TS?" } }],
    };
    mockPlannerResponse(plan);

    // Script succeeds
    mockRunScript.mockResolvedValue(makeScriptSuccess("TypeScript is a superset of JavaScript."));

    const result = await runPipeline(makeDualOptions(), "What is TypeScript?");

    expect(result.success).toBe(true);
    expect(result.result).toBe("TypeScript is a superset of JavaScript.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // runScript called once
    expect(mockRunScript).toHaveBeenCalledOnce();
    // Recovery should NOT be called
    expect(mockRunRecoverySession).not.toHaveBeenCalled();
  });

  it("script fail → recovery called and succeeds", async () => {
    const plan = {
      reasoning: "User wants to query",
      steps: [{ operation: "query", params: { question: "test" } }],
    };
    mockPlannerResponse(plan);

    // Script fails
    mockRunScript.mockResolvedValue(makeScriptFail());

    // Recovery succeeds
    mockRunRecoverySession.mockResolvedValue({
      success: true,
      result: "Recovered answer",
      analysis: "Submit button selector changed",
      suggestedPatch: null,
      toolCalls: 3,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: null,
      durationMs: 5000,
    });

    const result = await runPipeline(makeDualOptions(), "test query");

    expect(result.success).toBe(true);
    expect(result.result).toBe("Recovered answer");
    expect(mockRunScript).toHaveBeenCalledOnce();
    expect(mockRunRecoverySession).toHaveBeenCalledOnce();
  });

  it("script fail → recovery also fails → error propagated", async () => {
    const plan = {
      reasoning: "User wants to query",
      steps: [{ operation: "query", params: { question: "test" } }],
    };
    mockPlannerResponse(plan);

    // Script fails
    mockRunScript.mockResolvedValue(makeScriptFail());

    // Recovery also fails
    mockRunRecoverySession.mockResolvedValue({
      success: false,
      result: null,
      analysis: "Page completely broken",
      suggestedPatch: null,
      toolCalls: 10,
      toolCallLog: [],
      agentMessages: [],
      finalScreenshot: "base64screenshot",
      durationMs: 8000,
    });

    const result = await runPipeline(makeDualOptions(), "test query");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Step 1/1");
    expect(result.error).toContain("query");
    expect(result.error).toContain("recovery also failed");
    expect(result.errorScreenshot).toBe("base64screenshot");
    expect(mockRunScript).toHaveBeenCalledOnce();
    expect(mockRunRecoverySession).toHaveBeenCalledOnce();
  });

  it("planner rejection → no script/recovery", async () => {
    mockPlannerRejection({
      category: "off_topic",
      reason: "Not a NotebookLM operation",
    });

    const result = await runPipeline(makeDualOptions(), "天氣如何？");

    expect(result.success).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.rejectionCategory).toBe("off_topic");
    expect(result.rejectionReason).toBe("Not a NotebookLM operation");
    // Neither script nor recovery should be called
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockRunRecoverySession).not.toHaveBeenCalled();
  });

  it("multi-step plan → all scripts succeed", async () => {
    const plan = {
      reasoning: "Compound operation",
      steps: [
        { operation: "listSources", params: {} },
        { operation: "query", params: { question: "summarize" } },
      ],
    };
    mockPlannerResponse(plan);

    // Both scripts succeed
    mockRunScript
      .mockResolvedValueOnce(makeScriptSuccess("3 sources found"))
      .mockResolvedValueOnce(makeScriptSuccess("Summary: TypeScript is great."));

    const result = await runPipeline(makeDualOptions(), "列出來源然後問問題");

    expect(result.success).toBe(true);
    // Last step result is returned
    expect(result.result).toBe("Summary: TypeScript is great.");
    expect(mockRunScript).toHaveBeenCalledTimes(2);
    expect(mockRunRecoverySession).not.toHaveBeenCalled();
  });

  it("planner fails → error", async () => {
    // Planner doesn't call submitPlan
    mockCreateSession.mockResolvedValue({
      sessionId: "planner-session",
      sendAndWait: mockSendAndWait.mockResolvedValue(fakeAssistantMessage("I can't help with that.")),
      disconnect: mockDisconnect,
    });

    const result = await runPipeline(makeDualOptions(), "天氣如何？");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Planner did not submit a plan");
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockRunRecoverySession).not.toHaveBeenCalled();
  });
});
