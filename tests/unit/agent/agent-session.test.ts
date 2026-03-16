import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendAndWait = vi.fn();
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockCreateSession = vi.fn();
const mockOn = vi.fn();

const fakeSdkClient = { createSession: mockCreateSession };

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {},
  defineTool: (name: string, opts: { handler: (...args: unknown[]) => unknown }) => ({
    name, handler: opts.handler,
  }),
}));

vi.mock("../../../src/agent/browser-tools-shared.js", () => ({
  createBrowserTools: () => [{ name: "screenshot" }, { name: "find" }],
}));

import { runAgentSession } from "../../../src/agent/agent-session.js";
import type { AgentSessionOptions } from "../../../src/agent/agent-session.js";
import type { CopilotClientSingleton } from "../../../src/agent/client.js";
import type { AgentConfig } from "../../../src/shared/types.js";

function makeAgentConfig(): AgentConfig {
  return {
    name: "scan-notebooks",
    displayName: "Scan Notebooks",
    description: "Scan all notebooks",
    tools: ["screenshot", "find", "click", "read", "wait"],
    prompt: "You are a notebook scanner.",
    infer: true,
    startPage: "homepage",
    parameters: {},
  };
}

function makeOptions(overrides: Partial<AgentSessionOptions> = {}): AgentSessionOptions {
  return {
    client: { getClient: () => fakeSdkClient } as unknown as CopilotClientSingleton,
    cdp: { send: vi.fn().mockResolvedValue({ data: "screenshot" }) } as any,
    page: { evaluate: vi.fn(), url: vi.fn().mockReturnValue("https://notebooklm.google.com") } as any,
    agentConfig: makeAgentConfig(),
    goal: "List all notebooks",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSession.mockResolvedValue({
    sessionId: "agent-session",
    sendAndWait: mockSendAndWait,
    disconnect: mockDisconnect,
    on: mockOn,
  });
  mockSendAndWait.mockResolvedValue(undefined);
});

describe("runAgentSession", () => {
  it("captures result when submitResult is called", async () => {
    mockCreateSession.mockImplementation(async (opts: any) => {
      const submitResult = opts.tools?.find((t: any) => t.name === "submitResult");
      if (submitResult) {
        await submitResult.handler({ success: true, result: "Found 5 notebooks" });
      }
      return { sessionId: "agent", sendAndWait: mockSendAndWait, disconnect: mockDisconnect, on: mockOn };
    });

    const result = await runAgentSession(makeOptions());
    expect(result.success).toBe(true);
    expect(result.result).toBe("Found 5 notebooks");
  });

  it("returns failure when submitResult not called", async () => {
    const result = await runAgentSession(makeOptions());
    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
  });

  it("handles session error gracefully", async () => {
    mockCreateSession.mockRejectedValue(new Error("SDK error"));
    const result = await runAgentSession(makeOptions());
    expect(result.success).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
