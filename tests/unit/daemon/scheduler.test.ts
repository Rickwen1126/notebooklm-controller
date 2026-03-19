import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Suppress logger output during tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/logger.js", () => {
  const noop = () => {};
  const childLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => childLogger };
  return { logger: childLogger };
});

// ---------------------------------------------------------------------------
// Mock config — short timeout for circuit breaker tests
// ---------------------------------------------------------------------------

vi.mock("../../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    MAX_TASK_TIMEOUT_MS: 100,
    CIRCUIT_BREAKER_THRESHOLD: 3,
  };
});

import { TaskStore } from "../../../src/state/task-store.js";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import type { SessionResult } from "../../../src/daemon/scheduler.js";
import type { AsyncTask } from "../../../src/shared/types.js";

describe("Scheduler", () => {
  let taskStore: TaskStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scheduler-test-"));
    taskStore = new TaskStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Helper: create a mock runTask function
  // -----------------------------------------------------------------------

  function createMockRunTask(options?: {
    delay?: number;
    result?: SessionResult;
    onCall?: (task: AsyncTask) => void;
  }) {
    const delay = options?.delay ?? 0;
    const result: SessionResult = options?.result ?? { success: true };

    return vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
      if (options?.onCall) {
        options.onCall(task);
      }
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return result;
    });
  }

  // -----------------------------------------------------------------------
  // Submit a task
  // -----------------------------------------------------------------------

  describe("submit", () => {
    it("creates AsyncTask in store and queues for execution", async () => {
      const runTask = createMockRunTask();
      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "my-notebook",
        command: "add-source https://example.com",
        context: "user wants to add a web page",
      });

      expect(task.taskId).toMatch(/^[0-9a-f]{8}$/);
      expect(task.notebookAlias).toBe("my-notebook");
      expect(task.command).toBe("add-source https://example.com");
      expect(task.context).toBe("user wants to add a web page");
      expect(task.status).toBe("queued");

      // Wait for async processing to complete.
      await scheduler.shutdown();

      // runTask should have been called with the task.
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask.mock.calls[0][0].taskId).toBe(task.taskId);

      // Task should be completed in the store.
      const stored = await taskStore.get(task.taskId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("completed");
    });

    it("passes runner and runnerInput to task store", async () => {
      const runTask = createMockRunTask();
      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "test",
        runner: "scanAllNotebooks",
        runnerInput: { foo: "bar" },
      });

      expect(task.runner).toBe("scanAllNotebooks");
      expect(task.runnerInput).toEqual({ foo: "bar" });

      await scheduler.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Cross-notebook parallel
  // -----------------------------------------------------------------------

  describe("cross-notebook parallel", () => {
    it("tasks for different notebooks run concurrently", async () => {
      const executionLog: string[] = [];

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        executionLog.push(`start:${task.notebookAlias}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionLog.push(`end:${task.notebookAlias}`);
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      await scheduler.submit({ notebookAlias: "nb-a", command: "cmd-a" });
      await scheduler.submit({ notebookAlias: "nb-b", command: "cmd-b" });

      await scheduler.shutdown();

      // Both tasks should have started before either finished.
      // The execution log should show interleaved starts.
      const startA = executionLog.indexOf("start:nb-a");
      const startB = executionLog.indexOf("start:nb-b");
      const endA = executionLog.indexOf("end:nb-a");
      const endB = executionLog.indexOf("end:nb-b");

      expect(startA).toBeLessThan(endA);
      expect(startB).toBeLessThan(endB);

      // Both should have started before either ended (parallel execution).
      expect(startA).toBeLessThan(endB);
      expect(startB).toBeLessThan(endA);

      expect(runTask).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Same-notebook serial
  // -----------------------------------------------------------------------

  describe("same-notebook serial", () => {
    it("tasks for same notebook queue sequentially", async () => {
      const executionOrder: string[] = [];

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        executionOrder.push(`start:${task.command}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        executionOrder.push(`end:${task.command}`);
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      await scheduler.submit({ notebookAlias: "same-nb", command: "first" });
      await scheduler.submit({ notebookAlias: "same-nb", command: "second" });
      await scheduler.submit({ notebookAlias: "same-nb", command: "third" });

      // Wait for all tasks to finish naturally (no cancellation).
      await scheduler.waitForIdle();

      // Each task should complete before the next starts.
      expect(executionOrder).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second",
        "start:third",
        "end:third",
      ]);

      expect(runTask).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------------
  // Cancel queued task
  // -----------------------------------------------------------------------

  describe("cancel queued task", () => {
    it("removes from queue and transitions to cancelled", async () => {
      // Use a slow runTask so tasks stay queued.
      let resolveFirst: (() => void) | undefined;
      const firstTaskPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        if (task.command === "blocking") {
          await firstTaskPromise;
        }
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      // Submit a blocking task first, then a second task that will be queued.
      await scheduler.submit({ notebookAlias: "nb", command: "blocking" });

      // Small delay to ensure the first task has started processing.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const secondTask = await scheduler.submit({
        notebookAlias: "nb",
        command: "to-cancel",
      });

      // Cancel the second (queued) task.
      const cancelled = await scheduler.cancel(secondTask.taskId);
      expect(cancelled.status).toBe("cancelled");

      // Queue should not contain the cancelled task.
      // Only the blocking task should run.
      expect(scheduler.getQueueSize()).toBe(0);

      // Unblock the first task and shutdown.
      resolveFirst!();
      await scheduler.shutdown();

      // runTask should only have been called once (the blocking task).
      expect(runTask).toHaveBeenCalledTimes(1);

      // Verify in store.
      const stored = await taskStore.get(secondTask.taskId);
      expect(stored!.status).toBe("cancelled");
    });
  });

  // -----------------------------------------------------------------------
  // Cancel running task
  // -----------------------------------------------------------------------

  describe("cancel running task", () => {
    it("signals stop at safe point", async () => {
      let resolveRunning: (() => void) | undefined;
      const runningPromise = new Promise<void>((resolve) => {
        resolveRunning = resolve;
      });

      const runTask = vi.fn(async (_task: AsyncTask): Promise<SessionResult> => {
        await runningPromise;
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "long-running",
      });

      // Wait for the task to start running.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel the running task.
      const cancelled = await scheduler.cancel(task.taskId);
      expect(cancelled.status).toBe("cancelled");

      // The cancellation flag should be set.
      const flag = scheduler.getCancellationFlag(task.taskId);
      expect(flag).toBeDefined();
      expect(flag!.cancelled).toBe(true);

      // Unblock the running task.
      resolveRunning!();
      await scheduler.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Task completion
  // -----------------------------------------------------------------------

  describe("task completion", () => {
    it("transitions to completed and calls onComplete callback", async () => {
      const completedTasks: AsyncTask[] = [];
      const onTaskComplete = vi.fn((task: AsyncTask) => {
        completedTasks.push(task);
      });

      const runTask = createMockRunTask({
        result: { success: true, result: { summary: "done" } },
      });

      const scheduler = new Scheduler({
        taskStore,
        runTask,
        onTaskComplete,
      });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "query something",
      });

      await scheduler.shutdown();

      expect(onTaskComplete).toHaveBeenCalledTimes(1);
      expect(completedTasks).toHaveLength(1);
      expect(completedTasks[0].taskId).toBe(task.taskId);
      expect(completedTasks[0].status).toBe("completed");

      // Verify in store.
      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // Task failure
  // -----------------------------------------------------------------------

  describe("task failure", () => {
    it("transitions to failed and calls onComplete callback", async () => {
      const completedTasks: AsyncTask[] = [];
      const onTaskComplete = vi.fn((task: AsyncTask) => {
        completedTasks.push(task);
      });

      const runTask = createMockRunTask({
        result: {
          success: false,
          error: "network timeout",
          errorScreenshot: "/tmp/screenshot.png",
        },
      });

      const scheduler = new Scheduler({
        taskStore,
        runTask,
        onTaskComplete,
      });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "add-source https://broken.com",
      });

      await scheduler.shutdown();

      expect(onTaskComplete).toHaveBeenCalledTimes(1);
      expect(completedTasks).toHaveLength(1);
      expect(completedTasks[0].taskId).toBe(task.taskId);
      expect(completedTasks[0].status).toBe("failed");
      expect(completedTasks[0].error).toBe("network timeout");

      // Verify in store.
      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("failed");
    });

    it("persists result to disk on success", async () => {
      const runTask = createMockRunTask({
        result: { success: true, result: { summary: "all done" } },
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "query something",
      });

      await scheduler.shutdown();

      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("completed");
      expect(stored!.result).toEqual({ summary: "all done" });
    });

    it("persists error and errorScreenshot to disk on failure", async () => {
      const runTask = createMockRunTask({
        result: {
          success: false,
          error: "timeout reached",
          errorScreenshot: "/tmp/err.png",
        },
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "failing-cmd",
      });

      await scheduler.shutdown();

      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("failed");
      expect(stored!.error).toBe("timeout reached");
      expect(stored!.errorScreenshot).toBe("/tmp/err.png");
    });

    it("handles thrown errors from runTask", async () => {
      const completedTasks: AsyncTask[] = [];
      const onTaskComplete = vi.fn((task: AsyncTask) => {
        completedTasks.push(task);
      });

      const runTask = vi.fn(async (): Promise<SessionResult> => {
        throw new Error("unexpected crash");
      });

      const scheduler = new Scheduler({
        taskStore,
        runTask,
        onTaskComplete,
      });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "crashing-command",
      });

      await scheduler.shutdown();

      expect(onTaskComplete).toHaveBeenCalledTimes(1);
      expect(completedTasks[0].status).toBe("failed");
      expect(completedTasks[0].error).toBe("unexpected crash");

      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("failed");
      expect(stored!.error).toBe("unexpected crash");
    });
  });

  // -----------------------------------------------------------------------
  // Queue ordering: FIFO within same notebook
  // -----------------------------------------------------------------------

  describe("queue ordering", () => {
    it("FIFO within same notebook", async () => {
      const executedCommands: string[] = [];

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        executedCommands.push(task.command);
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      await scheduler.submit({ notebookAlias: "nb", command: "alpha" });
      await scheduler.submit({ notebookAlias: "nb", command: "bravo" });
      await scheduler.submit({ notebookAlias: "nb", command: "charlie" });
      await scheduler.submit({ notebookAlias: "nb", command: "delta" });

      // Wait for all tasks to finish naturally (no cancellation).
      await scheduler.waitForIdle();

      expect(executedCommands).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // waitForTask (FR-177, T-HF02)
  // -----------------------------------------------------------------------

  describe("waitForTask", () => {
    it("resolves immediately if task is already completed", async () => {
      const runTask = vi.fn(async (): Promise<SessionResult> => ({ success: true }));
      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({ notebookAlias: "nb", command: "fast" });
      await scheduler.waitForIdle(); // let it finish

      // Should resolve immediately since task is done.
      await scheduler.waitForTask(task.taskId);
    });

    it("waits only for the specific task, not all queues", async () => {
      let resolveNbB: (() => void) | undefined;
      const blockNbB = new Promise<void>((r) => { resolveNbB = r; });

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        if (task.notebookAlias === "nb-b") await blockNbB;
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      const taskA = await scheduler.submit({ notebookAlias: "nb-a", command: "quick" });
      await scheduler.submit({ notebookAlias: "nb-b", command: "slow" });

      // waitForTask(taskA) should resolve even though nb-b is still blocked.
      await scheduler.waitForTask(taskA.taskId);

      const completedA = await taskStore.get(taskA.taskId);
      expect(completedA?.status).toBe("completed");

      // Clean up.
      resolveNbB!();
      await scheduler.waitForIdle();
    });

    it("resolves when a failed task completes", async () => {
      const runTask = vi.fn(async (): Promise<SessionResult> => ({
        success: false,
        error: "boom",
      }));
      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({ notebookAlias: "nb", command: "fail" });
      await scheduler.waitForTask(task.taskId);

      const result = await taskStore.get(task.taskId);
      expect(result?.status).toBe("failed");
    });

    it("resolves when a queued task is cancelled", async () => {
      let resolveBlock: (() => void) | undefined;
      const blockPromise = new Promise<void>((r) => { resolveBlock = r; });

      const runTask = vi.fn(async (): Promise<SessionResult> => {
        await blockPromise;
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      // Submit a blocking task first, then a second task that will be queued.
      await scheduler.submit({ notebookAlias: "nb", command: "blocking" });
      await new Promise((r) => setTimeout(r, 10)); // let first task start

      const task2 = await scheduler.submit({ notebookAlias: "nb", command: "will-cancel" });

      // Start waiting on task2 (which is queued, not running yet).
      const waitPromise = scheduler.waitForTask(task2.taskId);

      // Cancel task2 while it's still queued.
      await scheduler.cancel(task2.taskId);

      // waitForTask should resolve (not hang).
      await waitPromise;

      const cancelled = await taskStore.get(task2.taskId);
      expect(cancelled?.status).toBe("cancelled");

      // Clean up.
      resolveBlock!();
      await scheduler.waitForIdle();
    });
  });

  // -----------------------------------------------------------------------
  // getQueueSize
  // -----------------------------------------------------------------------

  describe("getQueueSize", () => {
    it("returns total number of queued tasks across all notebooks", async () => {
      let resolveBlock: (() => void) | undefined;
      const blockPromise = new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });

      const runTask = vi.fn(async (_task: AsyncTask): Promise<SessionResult> => {
        await blockPromise;
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      // Submit tasks. The first per notebook will start processing immediately.
      await scheduler.submit({ notebookAlias: "nb-a", command: "cmd-1" });
      await scheduler.submit({ notebookAlias: "nb-a", command: "cmd-2" });
      await scheduler.submit({ notebookAlias: "nb-b", command: "cmd-3" });
      await scheduler.submit({ notebookAlias: "nb-b", command: "cmd-4" });

      // Wait for processing loops to start.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // First tasks for each notebook are running, second tasks are queued.
      expect(scheduler.getQueueSize()).toBe(2);

      resolveBlock!();
      await scheduler.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  describe("shutdown", () => {
    it("cancels all pending tasks and waits for running to complete", async () => {
      let resolveBlock: (() => void) | undefined;
      const blockPromise = new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });

      const runTask = vi.fn(async (task: AsyncTask): Promise<SessionResult> => {
        if (task.command === "blocking") {
          await blockPromise;
        }
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      const t1 = await scheduler.submit({
        notebookAlias: "nb",
        command: "blocking",
      });

      // Wait for t1 to start running.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const t2 = await scheduler.submit({ notebookAlias: "nb", command: "pending-1" });
      const t3 = await scheduler.submit({ notebookAlias: "nb", command: "pending-2" });

      // Start shutdown while t1 is still blocking (t2, t3 are still queued).
      // Unblock t1 after starting shutdown so the processing loop can finish.
      const shutdownPromise = scheduler.shutdown();
      resolveBlock!();
      await shutdownPromise;

      // t1 should have completed (it was running when shutdown started).
      const storedT1 = await taskStore.get(t1.taskId);
      expect(storedT1!.status).toBe("completed");

      // t2 and t3 should be cancelled (they were queued when shutdown started).
      const storedT2 = await taskStore.get(t2.taskId);
      const storedT3 = await taskStore.get(t3.taskId);
      expect(storedT2!.status).toBe("cancelled");
      expect(storedT3!.status).toBe("cancelled");
    });

    it("rejects new submissions after shutdown begins", async () => {
      const runTask = createMockRunTask();
      const scheduler = new Scheduler({ taskStore, runTask });

      await scheduler.shutdown();

      await expect(
        scheduler.submit({ notebookAlias: "nb", command: "late" }),
      ).rejects.toThrowError(/shutting down/);
    });
  });

  // -----------------------------------------------------------------------
  // Circuit Breaker (T-HF12 / T-HF13 / T-HF14)
  // -----------------------------------------------------------------------

  describe("circuit breaker", () => {
    it("increments consecutiveTimeouts when a task times out", async () => {
      // runTask that never resolves — will be beaten by the 100ms timeout mock.
      const runTask = vi.fn(
        () => new Promise<SessionResult>(() => {}), // never settles
      );

      const scheduler = new Scheduler({ taskStore, runTask });

      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "slow-cmd",
      });

      await scheduler.waitForTask(task.taskId);

      const health = scheduler.getHealth();
      expect(health.consecutiveTimeouts).toBe(1);
      expect(health.degraded).toBe(false);

      // Task should be failed with timeout reason.
      const stored = await taskStore.get(task.taskId);
      expect(stored!.status).toBe("failed");
      expect(stored!.error).toBe("execution timeout");

      await scheduler.shutdown();
    });

    it("resets consecutiveTimeouts on successful task completion", async () => {
      let callCount = 0;
      const runTask = vi.fn(async (): Promise<SessionResult> => {
        callCount++;
        if (callCount === 1) {
          // First call: never settles → timeout.
          return new Promise(() => {});
        }
        // Second call: succeeds immediately.
        return { success: true };
      });

      const scheduler = new Scheduler({ taskStore, runTask });

      // First task will timeout.
      const t1 = await scheduler.submit({ notebookAlias: "nb", command: "timeout-cmd" });
      await scheduler.waitForTask(t1.taskId);
      expect(scheduler.getHealth().consecutiveTimeouts).toBe(1);

      // Second task succeeds — counter should reset.
      const t2 = await scheduler.submit({ notebookAlias: "nb", command: "ok-cmd" });
      await scheduler.waitForTask(t2.taskId);
      expect(scheduler.getHealth().consecutiveTimeouts).toBe(0);

      const storedT2 = await taskStore.get(t2.taskId);
      expect(storedT2!.status).toBe("completed");

      await scheduler.shutdown();
    });

    it("enters degraded state after 3 consecutive timeouts and rejects submit", async () => {
      const runTask = vi.fn(
        () => new Promise<SessionResult>(() => {}), // never settles
      );

      const scheduler = new Scheduler({ taskStore, runTask });

      // Submit 3 tasks sequentially (same notebook → serial queue).
      for (let i = 0; i < 3; i++) {
        const task = await scheduler.submit({
          notebookAlias: "nb",
          command: `timeout-${i}`,
        });
        await scheduler.waitForTask(task.taskId);
      }

      const health = scheduler.getHealth();
      expect(health.consecutiveTimeouts).toBe(3);
      expect(health.degraded).toBe(true);
      expect(health.healthy).toBe(false);

      // New submissions should be rejected.
      await expect(
        scheduler.submit({ notebookAlias: "nb", command: "rejected" }),
      ).rejects.toThrowError(/degraded/);

      await scheduler.shutdown();
    });

    it("resetHealth clears degraded state and allows new submissions", async () => {
      const runTask = vi.fn(
        () => new Promise<SessionResult>(() => {}), // never settles
      );

      const scheduler = new Scheduler({ taskStore, runTask });

      // Trip the circuit breaker.
      for (let i = 0; i < 3; i++) {
        const task = await scheduler.submit({
          notebookAlias: "nb",
          command: `timeout-${i}`,
        });
        await scheduler.waitForTask(task.taskId);
      }

      expect(scheduler.getHealth().degraded).toBe(true);

      // Reset should restore normal operation.
      scheduler.resetHealth();

      const health = scheduler.getHealth();
      expect(health.consecutiveTimeouts).toBe(0);
      expect(health.degraded).toBe(false);
      expect(health.healthy).toBe(true);

      // Verify submit does not throw after reset.
      // (The task will timeout again since runTask still never settles, but submit itself works.)
      const task = await scheduler.submit({
        notebookAlias: "nb",
        command: "after-reset",
      });
      expect(task.status).toBe("queued");

      await scheduler.waitForTask(task.taskId);
      await scheduler.shutdown();
    });
  });
});
