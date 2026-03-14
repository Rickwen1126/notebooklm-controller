/**
 * Scheduler — per-notebook task queues with cross-notebook parallelism.
 *
 * - Each notebook gets its own FIFO queue processed sequentially.
 * - Different notebooks process in parallel (independent queues).
 * - The `runTask` function is injected so this module stays testable
 *   without coupling to session-runner internals.
 */

import { logger } from "../shared/logger.js";
import type { TaskStore } from "../state/task-store.js";
import type { AsyncTask } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by the injected runTask function. */
export interface SessionResult {
  success: boolean;
  result?: object;
  error?: string;
  errorScreenshot?: string;
}

/** Dependencies injected into the Scheduler. */
export interface SchedulerDeps {
  taskStore: TaskStore;
  runTask: (task: AsyncTask) => Promise<SessionResult>;
  onTaskComplete?: (task: AsyncTask) => void;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const log = logger.child({ module: "scheduler" });

export class Scheduler {
  private readonly taskStore: TaskStore;
  private readonly runTask: (task: AsyncTask) => Promise<SessionResult>;
  private readonly onTaskComplete?: (task: AsyncTask) => void;

  /** Per-notebook FIFO queues. */
  private readonly queues = new Map<string, AsyncTask[]>();

  /** Set of notebook aliases whose processing loop is currently active. */
  private readonly processing = new Set<string>();

  /** Map of currently-running taskId → cancellation flag. */
  private readonly cancellationFlags = new Map<string, { cancelled: boolean }>();

  /** Promises for currently-running processing loops (used by shutdown). */
  private readonly loopPromises = new Map<string, Promise<void>>();

  /** Per-task completion resolvers (used by waitForTask). */
  private readonly taskResolvers = new Map<string, () => void>();

  private shuttingDown = false;

  constructor(deps: SchedulerDeps) {
    this.taskStore = deps.taskStore;
    this.runTask = deps.runTask;
    this.onTaskComplete = deps.onTaskComplete;
  }

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  async submit(params: {
    notebookAlias: string;
    command: string;
    context?: string;
  }): Promise<AsyncTask> {
    if (this.shuttingDown) {
      throw new Error("Scheduler is shutting down; cannot accept new tasks");
    }

    const task = await this.taskStore.create({
      notebookAlias: params.notebookAlias,
      command: params.command,
      context: params.context,
    });

    log.info("task submitted", {
      taskId: task.taskId,
      notebookAlias: params.notebookAlias,
    });

    // Enqueue into the per-notebook queue.
    const queue = this.queues.get(params.notebookAlias) ?? [];
    queue.push(task);
    this.queues.set(params.notebookAlias, queue);

    // Start the processing loop for this notebook if not already running.
    this.ensureProcessing(params.notebookAlias);

    return task;
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  async cancel(taskId: string): Promise<AsyncTask> {
    // Check if the task is queued in any notebook queue.
    for (const [alias, queue] of this.queues.entries()) {
      const idx = queue.findIndex((t) => t.taskId === taskId);
      if (idx !== -1) {
        // Remove from queue and transition to cancelled.
        queue.splice(idx, 1);
        if (queue.length === 0) {
          this.queues.delete(alias);
        }

        const updated = await this.taskStore.transition(
          taskId,
          "cancelled",
          "cancelled by user",
        );

        // Resolve waitForTask() if anyone is waiting (FR-177 + cancel interop).
        const resolver = this.taskResolvers.get(taskId);
        if (resolver) {
          this.taskResolvers.delete(taskId);
          resolver();
        }

        log.info("queued task cancelled", { taskId });
        return updated;
      }
    }

    // Check if the task is currently running.
    const flag = this.cancellationFlags.get(taskId);
    if (flag) {
      flag.cancelled = true;

      const updated = await this.taskStore.transition(
        taskId,
        "cancelled",
        "cancelled by user (was running)",
      );

      // Resolve waitForTask() — executeTask.finally will also try but find
      // the resolver already consumed, which is fine (idempotent).
      const resolver = this.taskResolvers.get(taskId);
      if (resolver) {
        this.taskResolvers.delete(taskId);
        resolver();
      }

      log.info("running task cancel signalled", { taskId });
      return updated;
    }

    // Task is not queued or running — check if it exists in the store.
    const task = await this.taskStore.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Task exists but is already in a terminal state.
    throw new Error(
      `Task ${taskId} is in terminal state '${task.status}'; cannot cancel`,
    );
  }

  // -------------------------------------------------------------------------
  // getQueueSize
  // -------------------------------------------------------------------------

  getQueueSize(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // getCancellationFlag (for testing / external cancellation checks)
  // -------------------------------------------------------------------------

  getCancellationFlag(taskId: string): { cancelled: boolean } | undefined {
    return this.cancellationFlags.get(taskId);
  }

  // -------------------------------------------------------------------------
  // waitForIdle — wait for all processing loops to finish (no cancellation)
  // -------------------------------------------------------------------------

  async waitForIdle(): Promise<void> {
    const activeLoops = Array.from(this.loopPromises.values());
    if (activeLoops.length > 0) {
      await Promise.all(activeLoops);
    }
  }

  // -------------------------------------------------------------------------
  // waitForTask — wait for a specific task to reach terminal state (FR-177)
  // -------------------------------------------------------------------------

  async waitForTask(taskId: string): Promise<void> {
    // Check if already in terminal state.
    const task = await this.taskStore.get(taskId);
    if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
      return;
    }

    // Register a resolver that will be called when this task finishes.
    return new Promise<void>((resolve) => {
      this.taskResolvers.set(taskId, resolve);
    });
  }

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // The processing loops check `shuttingDown` before dequeuing the next
    // task and will cancel remaining queued items themselves.  We just need
    // to wait for all active loops to drain.
    const activeLoops = Array.from(this.loopPromises.values());
    if (activeLoops.length > 0) {
      await Promise.all(activeLoops);
    }

    log.info("scheduler shutdown complete");
  }

  // -------------------------------------------------------------------------
  // Internal: processing loop
  // -------------------------------------------------------------------------

  private ensureProcessing(notebookAlias: string): void {
    if (this.processing.has(notebookAlias)) {
      return;
    }

    this.processing.add(notebookAlias);

    const loopPromise = this.processQueue(notebookAlias).finally(() => {
      this.processing.delete(notebookAlias);
      this.loopPromises.delete(notebookAlias);
    });

    this.loopPromises.set(notebookAlias, loopPromise);
  }

  private async processQueue(notebookAlias: string): Promise<void> {
    while (true) {
      const queue = this.queues.get(notebookAlias);
      if (!queue || queue.length === 0) {
        // Clean up empty queue entry.
        this.queues.delete(notebookAlias);
        break;
      }

      // If shutting down, cancel all remaining queued tasks and exit.
      if (this.shuttingDown) {
        for (const queued of queue) {
          try {
            await this.taskStore.transition(
              queued.taskId,
              "cancelled",
              "scheduler shutdown",
            );
          } catch {
            // Task may have already transitioned; ignore.
          }
        }
        queue.length = 0;
        this.queues.delete(notebookAlias);
        break;
      }

      const task = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(notebookAlias);
      }

      await this.executeTask(task);
    }
  }

  private async executeTask(task: AsyncTask): Promise<void> {
    const cancellationFlag = { cancelled: false };
    this.cancellationFlags.set(task.taskId, cancellationFlag);

    try {
      // Transition to running.
      const runningTask = await this.taskStore.transition(
        task.taskId,
        "running",
      );

      log.info("task started", {
        taskId: task.taskId,
        notebookAlias: task.notebookAlias,
      });

      // Check if already cancelled before we even start.
      if (cancellationFlag.cancelled) {
        // Already transitioned to cancelled in cancel().
        log.info("task cancelled before execution", { taskId: task.taskId });
        const cancelled = await this.taskStore.get(task.taskId);
        if (cancelled && this.onTaskComplete) {
          this.onTaskComplete(cancelled);
        }
        return;
      }

      // Run the task.
      const result = await this.runTask(runningTask);

      // After runTask completes, check if it was cancelled while running.
      if (cancellationFlag.cancelled) {
        // Already transitioned to cancelled in cancel().
        log.info("task cancelled during execution", { taskId: task.taskId });
        const cancelled = await this.taskStore.get(task.taskId);
        if (cancelled && this.onTaskComplete) {
          this.onTaskComplete(cancelled);
        }
        return;
      }

      // Transition based on result and persist outcome fields.
      let finalTask: AsyncTask;
      if (result.success) {
        finalTask = await this.taskStore.transition(
          task.taskId,
          "completed",
        );
        if (result.result) {
          finalTask = await this.taskStore.update(task.taskId, {
            result: result.result,
          });
        }
      } else {
        finalTask = await this.taskStore.transition(
          task.taskId,
          "failed",
          result.error ?? "unknown error",
        );
        const updateFields: { error: string; errorScreenshot?: string } = {
          error: result.error ?? "unknown error",
        };
        if (result.errorScreenshot) {
          updateFields.errorScreenshot = result.errorScreenshot;
        }
        finalTask = await this.taskStore.update(task.taskId, updateFields);
      }

      log.info("task finished", {
        taskId: task.taskId,
        status: finalTask.status,
      });

      if (this.onTaskComplete) {
        this.onTaskComplete(finalTask);
      }
    } catch (err: unknown) {
      // Unexpected error during execution.
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      log.error("task execution error", {
        taskId: task.taskId,
        error: errorMessage,
      });

      try {
        await this.taskStore.transition(
          task.taskId,
          "failed",
          errorMessage,
        );
        const failedTask = await this.taskStore.update(task.taskId, {
          error: errorMessage,
        });

        if (this.onTaskComplete) {
          this.onTaskComplete(failedTask);
        }
      } catch {
        // Transition may fail if task was already cancelled; ignore.
      }
    } finally {
      this.cancellationFlags.delete(task.taskId);

      // Resolve any waitForTask() callers waiting on this task.
      const resolver = this.taskResolvers.get(task.taskId);
      if (resolver) {
        this.taskResolvers.delete(task.taskId);
        resolver();
      }
    }
  }
}
