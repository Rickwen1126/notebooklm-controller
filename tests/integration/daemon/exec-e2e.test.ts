/**
 * T068K: Integration test for exec end-to-end flow.
 *
 * Verifies the full wiring: exec MCP tool -> scheduler -> dual session
 * (mock runTask) -> task complete notification.
 *
 * Uses mock-based approach consistent with existing integration tests
 * (notification.test.ts, notebook-crud.test.ts).
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

vi.mock("../../../src/shared/config.js", () => ({
  MAX_TABS: 10,
  MAX_TASK_TIMEOUT_MS: 300_000,
  CIRCUIT_BREAKER_THRESHOLD: 3,
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

import { registerExecTools } from "../../../src/daemon/exec-tools.js";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import { Notifier } from "../../../src/notification/notifier.js";
import type {
  AsyncTask,
  TaskNotificationPayload,
  TaskStatus,
  NotebookEntry,
} from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock factories
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

function createMockStateManager() {
  const notebooks: Record<string, NotebookEntry> = {
    "my-notebook": {
      alias: "my-notebook",
      url: "https://notebooklm.google.com/notebook/abc123",
      title: "My Notebook",
      description: "Test notebook",
      status: "ready",
      registeredAt: "2026-01-01T00:00:00Z",
      lastAccessedAt: "2026-01-01T00:00:00Z",
      sourceCount: 3,
    },
  };

  return {
    load: vi.fn(async () => ({
      version: 1,
      defaultNotebook: "my-notebook",
      pid: 123,
      port: 19224,
      startedAt: "2026-01-01T00:00:00Z",
      notebooks: { ...notebooks },
    })),
    getNotebook: vi.fn(
      async (alias: string) => notebooks[alias] ?? undefined,
    ),
  };
}

function createMockMcpServer() {
  const tools = new Map<
    string,
    { options: unknown; handler: (...args: unknown[]) => unknown }
  >();
  return {
    registerTool: vi.fn(
      (
        name: string,
        options: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        tools.set(name, { options, handler });
      },
    ),
    notification: vi.fn().mockResolvedValue(undefined),
    tools,
    getHandler(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" not registered`);
      return tool.handler;
    },
  };
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T068K: exec end-to-end integration", () => {
  let mockServer: ReturnType<typeof createMockMcpServer>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let stateManager: ReturnType<typeof createMockStateManager>;
  let notifier: Notifier;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockMcpServer();
    taskStore = createMockTaskStore();
    stateManager = createMockStateManager();
    notifier = new Notifier(mockServer as any);
  });

  // -----------------------------------------------------------------------
  // 1. Full sync flow: exec tool -> scheduler -> runTask -> completed
  // -----------------------------------------------------------------------

  it("exec tool -> scheduler -> runTask -> completed result (sync mode)", async () => {
    const runTask = vi.fn(async (_task: AsyncTask) => ({
      success: true,
      result: {
        answer: "NotebookLM uses OAuth 2.0 for auth",
        citations: [{ source: "auth-module" }],
      },
    }));

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
      onTaskComplete: (task) => notifier.notify(task),
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    const result = parseResult(
      await execHandler({
        prompt: "What is the auth flow?",
        notebook: "my-notebook",
      }),
    );

    // Verify the result came through
    expect(result.success).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(result.notebook).toBe("my-notebook");
    expect(result.answer).toBe("NotebookLM uses OAuth 2.0 for auth");

    // Verify runTask was called
    expect(runTask).toHaveBeenCalledOnce();
    const taskArg = runTask.mock.calls[0][0] as AsyncTask;
    expect(taskArg.command).toBe("What is the auth flow?");
    expect(taskArg.notebookAlias).toBe("my-notebook");

    // Verify notification was sent
    expect(mockServer.notification).toHaveBeenCalledOnce();
    const notifCall = mockServer.notification.mock.calls[0][0];
    expect(notifCall.method).toBe("notifications/task-completed");
    expect(notifCall.params).toMatchObject({
      status: "completed",
      notebook: "my-notebook",
    });
  });

  // -----------------------------------------------------------------------
  // 2. Async mode: exec returns taskId immediately
  // -----------------------------------------------------------------------

  it("exec tool in async mode returns taskId immediately", async () => {
    const runTask = vi.fn(async () => {
      // Simulate a slow task
      await new Promise((r) => setTimeout(r, 50));
      return { success: true, result: { done: true } };
    });

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
      onTaskComplete: (task) => notifier.notify(task),
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    const result = parseResult(
      await execHandler({
        prompt: "Generate audio overview",
        notebook: "my-notebook",
        async: true,
      }),
    );

    // Immediate response with taskId
    expect(result.status).toBe("queued");
    expect(result.taskId).toBeDefined();
    expect(result.notebook).toBe("my-notebook");
    expect(result.hint).toBeDefined();

    // Wait for the background task to finish
    await scheduler.waitForIdle();

    // Notification should have been sent after completion
    expect(mockServer.notification).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // 3. Failed task propagates error
  // -----------------------------------------------------------------------

  it("failed runTask propagates error through exec tool", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Browser tab crashed",
    }));

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
      onTaskComplete: (task) => notifier.notify(task),
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    const result = parseResult(
      await execHandler({
        prompt: "Add source from repo",
        notebook: "my-notebook",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Browser tab crashed");

    // Failure notification is also sent
    expect(mockServer.notification).toHaveBeenCalledOnce();
    const notifCall = mockServer.notification.mock.calls[0][0];
    expect(notifCall.params).toMatchObject({ status: "failed" });
  });

  // -----------------------------------------------------------------------
  // 4. Default notebook resolution
  // -----------------------------------------------------------------------

  it("exec resolves default notebook when none specified", async () => {
    const runTask = vi.fn(async () => ({
      success: true,
      result: { answer: "resolved via default" },
    }));

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    const result = parseResult(
      await execHandler({
        prompt: "List sources",
        // no notebook specified — should use default
      }),
    );

    expect(result.success).toBe(true);
    expect(result.notebook).toBe("my-notebook");
  });

  // -----------------------------------------------------------------------
  // 5. Missing notebook returns error
  // -----------------------------------------------------------------------

  it("exec returns error when no notebook specified and no default", async () => {
    // Override stateManager to have no default
    stateManager.load.mockResolvedValue({
      version: 1,
      defaultNotebook: null,
      pid: 123,
      port: 19224,
      startedAt: "2026-01-01T00:00:00Z",
      notebooks: {},
    });

    const runTask = vi.fn(async () => ({
      success: true,
      result: {},
    }));

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    const result = parseResult(
      await execHandler({ prompt: "Some question" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No target notebook");
    expect(runTask).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. cancel_task integration with exec
  // -----------------------------------------------------------------------

  it("cancel_task cancels a queued task", async () => {
    // Make runTask hang so the task stays queued or running
    let resolveTask!: () => void;
    const taskPromise = new Promise<void>((r) => {
      resolveTask = r;
    });

    const runTask = vi.fn(async () => {
      await taskPromise;
      return { success: true, result: {} };
    });

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    // Submit a task in async mode
    const execHandler = mockServer.getHandler("exec");
    const submitResult = parseResult(
      await execHandler({
        prompt: "Long running task",
        notebook: "my-notebook",
        async: true,
      }),
    );
    const _taskId = submitResult.taskId as string;

    // Submit another task to the same notebook (it will be queued behind the first)
    const submitResult2 = parseResult(
      await execHandler({
        prompt: "Second task (will be queued)",
        notebook: "my-notebook",
        async: true,
      }),
    );
    const taskId2 = submitResult2.taskId as string;

    // Cancel the second (queued) task
    const cancelHandler = mockServer.getHandler("cancel_task");
    const cancelResult = parseResult(
      await cancelHandler({ taskId: taskId2 }),
    );

    expect(cancelResult.status).toBe("cancelled");
    expect(cancelResult.taskId).toBe(taskId2);

    // Let the first task complete
    resolveTask();
    await scheduler.waitForIdle();
  });

  // -----------------------------------------------------------------------
  // 7. Notification payload shape verification
  // -----------------------------------------------------------------------

  it("notification payload has correct TaskNotificationPayload shape", async () => {
    const runTask = vi.fn(async () => ({
      success: true,
      result: { summary: "sources synced" },
    }));

    const scheduler = new Scheduler({
      taskStore: taskStore as any,
      runTask,
      onTaskComplete: (task) => notifier.notify(task),
    });

    registerExecTools(mockServer as never, {
      scheduler,
      stateManager: stateManager as any,
      taskStore: taskStore as any,
    });

    const execHandler = mockServer.getHandler("exec");
    await execHandler({
      prompt: "Sync notebook",
      notebook: "my-notebook",
      context: "daily sync",
    });

    expect(mockServer.notification).toHaveBeenCalledOnce();

    const call = mockServer.notification.mock.calls[0][0];
    const params = call.params as TaskNotificationPayload;

    expect(params.taskId).toBeDefined();
    expect(params.status).toBe("completed");
    expect(params.notebook).toBe("my-notebook");
    expect(params.result).toEqual({ summary: "sources synced" });
    expect(params.originalContext).toBe("daily sync");
    expect(params.command).toBe("Sync notebook");
    expect(typeof params.timestamp).toBe("string");
  });
});
