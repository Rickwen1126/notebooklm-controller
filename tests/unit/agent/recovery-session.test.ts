import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock SDK
const mockSendAndWait = vi.fn();
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockCreateSession = vi.fn();
const mockOn = vi.fn();

const fakeSdkClient = {
  createSession: mockCreateSession,
};

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {},
  defineTool: (name: string, opts: { handler: (...args: unknown[]) => unknown }) => ({
    name,
    handler: opts.handler,
  }),
}));

import { runRecoverySession } from "../../../src/agent/recovery-session.js";
import type { RecoverySessionOptions } from "../../../src/agent/recovery-session.js";
import type { ScriptResult } from "../../../src/scripts/types.js";
import type { CopilotClientSingleton } from "../../../src/agent/client.js";

function makeScriptResult(overrides: Partial<ScriptResult> = {}): ScriptResult {
  return {
    operation: "query",
    status: "fail",
    result: null,
    log: [
      { step: 1, action: "find_chat_input", status: "ok", detail: "Found", durationMs: 10 },
      { step: 2, action: "click_submit", status: "fail", detail: "Not found", durationMs: 5 },
    ],
    totalMs: 15,
    failedAtStep: 2,
    failedSelector: "submit_button",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<RecoverySessionOptions> = {}): RecoverySessionOptions {
  return {
    client: { getClient: () => fakeSdkClient } as unknown as CopilotClientSingleton,
    cdp: {
      send: vi.fn().mockResolvedValue({ data: "base64screenshot" }),
    } as unknown as import("puppeteer-core").CDPSession,
    page: {
      evaluate: vi.fn().mockResolvedValue([]),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com/notebook/abc"),
    } as unknown as import("puppeteer-core").Page,
    scriptResult: makeScriptResult(),
    goal: "Ask NotebookLM: What is TypeScript?",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSession.mockResolvedValue({
    sessionId: "recovery-session",
    sendAndWait: mockSendAndWait,
    disconnect: mockDisconnect,
    on: mockOn,
  });
  mockSendAndWait.mockResolvedValue(undefined);
});

describe("runRecoverySession", () => {
  it("captures result when submitResult is called via tool", async () => {
    // Simulate the session calling submitResult via tool handler
    mockCreateSession.mockImplementation(async (opts: { tools?: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
      const submitResult = opts.tools?.find((t) => t.name === "submitResult");
      if (submitResult) {
        await submitResult.handler({
          success: true,
          result: "TypeScript is a typed superset of JavaScript",
          analysis: "Script failed because chat_input selector changed",
          suggestedPatch: {
            elementKey: "chat_input",
            oldValue: "BROKEN",
            newValue: "開始輸入",
            confidence: 0.9,
          },
        });
      }
      return {
        sessionId: "recovery-session",
        sendAndWait: mockSendAndWait,
        disconnect: mockDisconnect,
        on: mockOn,
      };
    });

    const result = await runRecoverySession(makeOptions());

    expect(result.success).toBe(true);
    expect(result.result).toBe("TypeScript is a typed superset of JavaScript");
    expect(result.analysis).toContain("chat_input");
    expect(result.suggestedPatch).toEqual({
      elementKey: "chat_input",
      oldValue: "BROKEN",
      newValue: "開始輸入",
      confidence: 0.9,
    });
    expect(result.finalScreenshot).toBeNull(); // no screenshot on success
  });

  it("captures final screenshot when submitResult is not called", async () => {
    // Session runs but doesn't call submitResult (failure)
    const result = await runRecoverySession(makeOptions());

    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
    expect(result.finalScreenshot).toBe("base64screenshot");
  });

  it("handles session error gracefully", async () => {
    mockCreateSession.mockRejectedValue(new Error("SDK error"));

    const result = await runRecoverySession(makeOptions());

    expect(result.success).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("creates session with systemMessage mode 'replace'", async () => {
    await runRecoverySession(makeOptions());
    expect(mockCreateSession).toHaveBeenCalled();
    const createArgs = mockCreateSession.mock.calls[0][0];
    expect(createArgs.systemMessage.mode).toBe("replace");
  });
});
