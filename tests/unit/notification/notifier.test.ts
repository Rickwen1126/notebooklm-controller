import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../../../src/notification/notifier.js";
import type { AsyncTask } from "../../../src/shared/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Suppress logger output during tests.
vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, child: () => childLogger };
  return { logger: childLogger };
});

/** Helper: create a minimal AsyncTask for testing. */
function makeTask(overrides: Partial<AsyncTask> = {}): AsyncTask {
  return {
    taskId: "task-001",
    notebookAlias: "my-notebook",
    command: "add-source",
    context: "user asked to add a repo",
    status: "completed",
    result: { summary: "done" },
    error: null,
    errorScreenshot: null,
    history: [],
    createdAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

/** Helper: create a mock MCP Server with a notification method. */
function makeMockServer(
  notificationImpl?: (...args: unknown[]) => Promise<void>,
): Server {
  return {
    notification: notificationImpl ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as Server;
}

describe("Notifier", () => {
  let notifier: Notifier;

  beforeEach(() => {
    notifier = new Notifier(null);
  });

  // ---------------------------------------------------------------------------
  // Sends notification to connected MCP server instance
  // ---------------------------------------------------------------------------

  it("sends notification to connected MCP server instance", async () => {
    const mockNotification = vi.fn().mockResolvedValue(undefined);
    const server = makeMockServer(mockNotification);
    notifier.setServer(server);

    const task = makeTask();
    notifier.notify(task);

    // Allow the internal promise to settle.
    await vi.waitFor(() => {
      expect(mockNotification).toHaveBeenCalledOnce();
    });

    expect(mockNotification).toHaveBeenCalledWith({
      method: "notifications/task-completed",
      params: expect.objectContaining({
        taskId: "task-001",
        status: "completed",
        notebook: "my-notebook",
        command: "add-source",
        result: { summary: "done" },
        originalContext: "user asked to add a repo",
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // Fire-and-forget: does not throw on send failure
  // ---------------------------------------------------------------------------

  it("fire-and-forget: does not throw on send failure", () => {
    const server = makeMockServer(
      vi.fn().mockRejectedValue(new Error("transport broken")),
    );
    notifier.setServer(server);

    const task = makeTask();

    // Must not throw.
    expect(() => notifier.notify(task)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Handles client disconnection gracefully (logs warning, doesn't crash)
  // ---------------------------------------------------------------------------

  it("handles client disconnection gracefully (logs warning, doesn't crash)", () => {
    // Server is null — simulates no client connected.
    const notifierNoServer = new Notifier(null);
    const task = makeTask();

    expect(() => notifierNoServer.notify(task)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Builds correct TaskNotificationPayload from AsyncTask
  // ---------------------------------------------------------------------------

  it("builds correct TaskNotificationPayload from AsyncTask", async () => {
    const mockNotification = vi.fn().mockResolvedValue(undefined);
    const server = makeMockServer(mockNotification);
    notifier.setServer(server);

    const task = makeTask({
      taskId: "task-xyz",
      notebookAlias: "research",
      command: "generate-audio",
      context: null,
      status: "failed",
      result: null,
      error: "timeout",
    });

    notifier.notify(task);

    await vi.waitFor(() => {
      expect(mockNotification).toHaveBeenCalledOnce();
    });

    const callArgs = mockNotification.mock.calls[0]![0] as {
      method: string;
      params: Record<string, unknown>;
    };
    const payload = callArgs.params;

    expect(payload).toEqual({
      taskId: "task-xyz",
      status: "failed",
      notebook: "research",
      result: {},
      originalContext: null,
      command: "generate-audio",
      timestamp: expect.any(String),
    });

    // Verify timestamp is a valid ISO 8601 string.
    expect(() => new Date(payload.timestamp as string)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Notification method is "notifications/task-completed"
  // ---------------------------------------------------------------------------

  it('notification method is "notifications/task-completed"', async () => {
    const mockNotification = vi.fn().mockResolvedValue(undefined);
    const server = makeMockServer(mockNotification);
    notifier.setServer(server);

    notifier.notify(makeTask());

    await vi.waitFor(() => {
      expect(mockNotification).toHaveBeenCalledOnce();
    });

    const callArgs = mockNotification.mock.calls[0]![0] as {
      method: string;
    };
    expect(callArgs.method).toBe("notifications/task-completed");
  });

  // ---------------------------------------------------------------------------
  // setServer updates the server reference
  // ---------------------------------------------------------------------------

  it("setServer updates the server reference so subsequent notify calls use it", async () => {
    const task = makeTask();

    // Initially null — notify should not crash.
    notifier.notify(task);

    // Now set a server and verify it receives the notification.
    const mockNotification = vi.fn().mockResolvedValue(undefined);
    const server = makeMockServer(mockNotification);
    notifier.setServer(server);

    notifier.notify(task);

    await vi.waitFor(() => {
      expect(mockNotification).toHaveBeenCalledOnce();
    });
  });
});
