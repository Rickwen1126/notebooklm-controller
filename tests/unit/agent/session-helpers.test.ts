import { describe, it, expect, vi } from "vitest";
import { setupSessionEventListeners, disconnectSession } from "../../../src/agent/session-helpers.js";

function makeFakeSession() {
  const listeners: Array<(event: any) => void> = [];
  return {
    on: vi.fn((cb: (event: any) => void) => { listeners.push(cb); }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    emit(event: any) { listeners.forEach((cb) => cb(event)); },
  };
}

describe("setupSessionEventListeners", () => {
  it("captures tool.execution_start and tool.execution_complete", () => {
    const session = makeFakeSession();
    const { toolCallLog, getToolCallCount } = setupSessionEventListeners(session as any);

    session.emit({
      type: "tool.execution_start",
      data: { toolCallId: "call-1", toolName: "screenshot", arguments: {} },
    });
    expect(getToolCallCount()).toBe(1);

    session.emit({
      type: "tool.execution_complete",
      data: { toolCallId: "call-1", success: true, result: { content: "Screenshot captured." } },
    });
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0]).toEqual({
      tool: "screenshot",
      input: "{}",
      output: "Screenshot captured.",
    });
  });

  it("captures assistant.message events", () => {
    const session = makeFakeSession();
    const { agentMessages } = setupSessionEventListeners(session as any);

    session.emit({ type: "assistant.message", data: { content: "I found 3 notebooks." } });
    expect(agentMessages).toEqual(["I found 3 notebooks."]);
  });

  it("ignores empty assistant messages", () => {
    const session = makeFakeSession();
    const { agentMessages } = setupSessionEventListeners(session as any);

    session.emit({ type: "assistant.message", data: { content: "  " } });
    expect(agentMessages).toHaveLength(0);
  });

  it("truncates long inputs and outputs", () => {
    const session = makeFakeSession();
    const { toolCallLog } = setupSessionEventListeners(session as any);
    const longText = "x".repeat(500);

    session.emit({
      type: "tool.execution_start",
      data: { toolCallId: "call-1", toolName: "paste", arguments: { text: longText } },
    });
    session.emit({
      type: "tool.execution_complete",
      data: { toolCallId: "call-1", success: true, result: { content: longText } },
    });

    expect(toolCallLog[0].input.length).toBeLessThanOrEqual(200);
    expect(toolCallLog[0].output.length).toBeLessThanOrEqual(300);
  });
});

describe("disconnectSession", () => {
  it("disconnects successfully", async () => {
    const session = makeFakeSession();
    await disconnectSession(session as any);
    expect(session.disconnect).toHaveBeenCalled();
  });

  it("swallows disconnect errors", async () => {
    const session = makeFakeSession();
    session.disconnect.mockRejectedValue(new Error("hang"));
    await expect(disconnectSession(session as any)).resolves.toBeUndefined();
  });
});
