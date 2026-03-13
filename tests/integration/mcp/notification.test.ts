/**
 * T061: MCP notification integration test
 *
 * Verifies the end-to-end flow: async task completes in Scheduler
 * → Notifier pushes a `notifications/task-completed` MCP notification
 * with the correct TaskNotificationPayload shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    child: () => childLogger,
  };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

import { Notifier } from "../../../src/notification/notifier.js";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import type {
  AsyncTask,
  TaskNotificationPayload,
  TaskStatus,
} from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock TaskStore — tracks task state in-memory
// ---------------------------------------------------------------------------

function createMockTaskStore() {
  const tasks = new Map<string, AsyncTask>();
  let counter = 0;

  return {
    create: vi.fn(
      async (params: {
        notebookAlias: string;
        command: string;
        context?: string;
      }) => {
        const task: AsyncTask = {
          taskId: `task-${++counter}`,
          notebookAlias: params.notebookAlias,
          command: params.command,
          context: params.context ?? null,
          status: "queued",
          result: null,
          error: null,
          errorScreenshot: null,
          history: [
            {
              from: null,
              to: "queued",
              timestamp: new Date().toISOString(),
              reason: null,
            },
          ],
          createdAt: new Date().toISOString(),
        };
        tasks.set(task.taskId, task);
        return task;
      },
    ),
    get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    transition: vi.fn(
      async (taskId: string, status: string, reason?: string) => {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const prev = task.status;
        task.status = status as TaskStatus;
        task.history.push({
          from: prev,
          to: status as TaskStatus,
          timestamp: new Date().toISOString(),
          reason: reason ?? null,
        });
        return task;
      },
    ),
    update: vi.fn(async (taskId: string, updates: Partial<AsyncTask>) => {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      Object.assign(task, updates);
      return task;
    }),
    getAll: vi.fn(async () => []),
    getRecent: vi.fn(async () => []),
  };
}

// ---------------------------------------------------------------------------
// Mock MCP Server — just needs a `notification` method
// ---------------------------------------------------------------------------

function createMockMcpServer() {
  return {
    notification: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T061: MCP notification integration", () => {
  let mockServer: ReturnType<typeof createMockMcpServer>;
  let notifier: Notifier;
  let taskStore: ReturnType<typeof createMockTaskStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockMcpServer();
    notifier = new Notifier(mockServer as any);
    taskStore = createMockTaskStore();
  });

  // -------------------------------------------------------------------------
  // 1. Notification is pushed when async task completes
  // -------------------------------------------------------------------------

  it("notification is pushed when async task completes", async () => {
    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask: async () => ({
        success: true,
        result: { answer: "test" },
      }),
      onTaskComplete: (task) => notifier.notify(task),
    });

    await scheduler.submit({
      notebookAlias: "my-notebook",
      command: "add_source",
      context: "some context",
    });

    await scheduler.waitForIdle();

    // notification() must have been called exactly once
    expect(mockServer.notification).toHaveBeenCalledOnce();

    // Verify the notification payload
    const call = mockServer.notification.mock.calls[0][0];
    expect(call.method).toBe("notifications/task-completed");
    expect(call.params).toMatchObject({
      taskId: expect.any(String),
      status: "completed",
      notebook: "my-notebook",
    });
  });

  // -------------------------------------------------------------------------
  // 2. Notification is pushed when async task fails
  // -------------------------------------------------------------------------

  it("notification is pushed when async task fails", async () => {
    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask: async () => ({
        success: false,
        error: "something broke",
      }),
      onTaskComplete: (task) => notifier.notify(task),
    });

    await scheduler.submit({
      notebookAlias: "fail-notebook",
      command: "generate_podcast",
    });

    await scheduler.waitForIdle();

    expect(mockServer.notification).toHaveBeenCalledOnce();

    const call = mockServer.notification.mock.calls[0][0];
    expect(call.method).toBe("notifications/task-completed");
    expect(call.params).toMatchObject({
      taskId: expect.any(String),
      status: "failed",
      notebook: "fail-notebook",
    });
  });

  // -------------------------------------------------------------------------
  // 3. Notification handles server disconnect gracefully
  // -------------------------------------------------------------------------

  it("notification handles server disconnect gracefully", async () => {
    // Make notification reject to simulate a disconnected MCP client
    mockServer.notification.mockRejectedValue(
      new Error("transport closed"),
    );

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask: async () => ({
        success: true,
        result: { answer: "ok" },
      }),
      onTaskComplete: (task) => notifier.notify(task),
    });

    await scheduler.submit({
      notebookAlias: "disconnect-test",
      command: "add_source",
    });

    // Scheduler should complete without throwing even though notification fails
    await scheduler.waitForIdle();

    // notification was attempted
    expect(mockServer.notification).toHaveBeenCalledOnce();

    // The task itself still completed in the store
    const task = await taskStore.get("task-1");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 4. No notification when server is null
  // -------------------------------------------------------------------------

  it("no notification when server is null", async () => {
    const nullNotifier = new Notifier(null);

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask: async () => ({
        success: true,
        result: { done: true },
      }),
      onTaskComplete: (task) => nullNotifier.notify(task),
    });

    await scheduler.submit({
      notebookAlias: "null-server-test",
      command: "add_source",
    });

    // Should not crash even though there is no MCP server
    await scheduler.waitForIdle();

    // mockServer.notification should never have been called
    // (we created a different Notifier with null, the mockServer is untouched)
    expect(mockServer.notification).not.toHaveBeenCalled();

    // Task still completed successfully
    const task = await taskStore.get("task-1");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 5. Notification payload matches TaskNotificationPayload shape
  // -------------------------------------------------------------------------

  it("notification payload matches TaskNotificationPayload shape", async () => {
    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask: async () => ({
        success: true,
        result: { summary: "all good" },
      }),
      onTaskComplete: (task) => notifier.notify(task),
    });

    await scheduler.submit({
      notebookAlias: "shape-test",
      command: "generate_podcast",
      context: "verify payload shape",
    });

    await scheduler.waitForIdle();

    expect(mockServer.notification).toHaveBeenCalledOnce();

    const call = mockServer.notification.mock.calls[0][0];
    const params = call.params as TaskNotificationPayload;

    // Every field of TaskNotificationPayload must be present
    expect(params).toHaveProperty("taskId");
    expect(params).toHaveProperty("status");
    expect(params).toHaveProperty("notebook");
    expect(params).toHaveProperty("result");
    expect(params).toHaveProperty("originalContext");
    expect(params).toHaveProperty("command");
    expect(params).toHaveProperty("timestamp");

    // Verify types and values
    expect(typeof params.taskId).toBe("string");
    expect(params.status).toBe("completed");
    expect(params.notebook).toBe("shape-test");
    expect(params.result).toEqual({ summary: "all good" });
    expect(params.originalContext).toBe("verify payload shape");
    expect(params.command).toBe("generate_podcast");
    expect(typeof params.timestamp).toBe("string");

    // Timestamp should be a valid ISO 8601 string
    const parsed = new Date(params.timestamp);
    expect(parsed.toISOString()).toBe(params.timestamp);
  });
});
