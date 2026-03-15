import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../../../src/notification/notifier.js";
import type { AsyncTask } from "../../../src/shared/types.js";
import type { NbctlMcpServer } from "../../../src/daemon/mcp-server.js";

// Suppress logger output during tests.
vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
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

/** Helper: create a mock NbctlMcpServer that wraps N session servers. */
function makeMockMcpServer(
  notificationImpls: Array<(...args: unknown[]) => Promise<void>> = [
    vi.fn().mockResolvedValue(undefined),
  ],
): { mcpServer: NbctlMcpServer; notifications: ReturnType<typeof vi.fn>[] } {
  const notifications = notificationImpls.map((impl) =>
    typeof impl === "function" && (impl as ReturnType<typeof vi.fn>).mock
      ? (impl as ReturnType<typeof vi.fn>)
      : vi.fn().mockImplementation(impl),
  );

  const sessionServers = notifications.map((notif) => ({
    server: { notification: notif },
  }));

  const mcpServer = {
    getSessionServers: vi.fn(() => sessionServers[Symbol.iterator]()),
  } as unknown as NbctlMcpServer;

  return { mcpServer, notifications };
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
    const { mcpServer } = makeMockMcpServer([mockNotification]);
    notifier.setServer(mcpServer);

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
    const { mcpServer } = makeMockMcpServer([
      vi.fn().mockRejectedValue(new Error("transport broken")),
    ]);
    notifier.setServer(mcpServer);

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
    const { mcpServer } = makeMockMcpServer([mockNotification]);
    notifier.setServer(mcpServer);

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
    const { mcpServer } = makeMockMcpServer([mockNotification]);
    notifier.setServer(mcpServer);

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
    const { mcpServer } = makeMockMcpServer([mockNotification]);
    notifier.setServer(mcpServer);

    notifier.notify(task);

    await vi.waitFor(() => {
      expect(mockNotification).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // Broadcasts to all active sessions
  // ---------------------------------------------------------------------------

  it("broadcasts to all active sessions when multiple clients are connected", async () => {
    const notif1 = vi.fn().mockResolvedValue(undefined);
    const notif2 = vi.fn().mockResolvedValue(undefined);
    const { mcpServer } = makeMockMcpServer([notif1, notif2]);
    notifier.setServer(mcpServer);

    notifier.notify(makeTask());

    await vi.waitFor(() => {
      expect(notif1).toHaveBeenCalledOnce();
      expect(notif2).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // No sessions: drops notification with warning (no crash)
  // ---------------------------------------------------------------------------

  it("drops notification gracefully when no active sessions", () => {
    const mcpServer = {
      getSessionServers: vi.fn(() => [][Symbol.iterator]()),
    } as unknown as NbctlMcpServer;
    notifier.setServer(mcpServer);

    expect(() => notifier.notify(makeTask())).not.toThrow();
  });
});
