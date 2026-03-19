/**
 * Task store — persists AsyncTask objects as individual JSON files.
 *
 * Each task is stored at `<tasksDir>/<taskId>.json` using atomic writes
 * (write to temp file then rename) to avoid partial-read corruption.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TASKS_DIR, DIR_PERMISSION, FILE_PERMISSION } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { AsyncTask, TaskStatus, TaskStatusChange } from "../shared/types.js";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const;

// ---------------------------------------------------------------------------
// Default TTL (24 hours)
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

const log = logger.child({ module: "task-store" });

export class TaskStore {
  private readonly tasksDir: string;

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir ?? TASKS_DIR;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(params: {
    notebookAlias: string;
    command: string;
    context?: string;
    runner?: string;
    runnerInput?: Record<string, unknown>;
  }): Promise<AsyncTask> {
    await this.ensureDir();

    const taskId = randomBytes(4).toString("hex");
    const now = new Date().toISOString();

    const initialChange: TaskStatusChange = {
      from: null,
      to: "queued",
      timestamp: now,
      reason: null,
    };

    const task: AsyncTask = {
      taskId,
      notebookAlias: params.notebookAlias,
      runner: params.runner ?? "pipeline",
      runnerInput: params.runnerInput ?? null,
      command: params.command,
      context: params.context ?? null,
      status: "queued",
      result: null,
      error: null,
      errorScreenshot: null,
      history: [initialChange],
      createdAt: now,
    };

    await this.writeTask(task);
    log.info("task created", { taskId, notebookAlias: params.notebookAlias });
    return task;
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(taskId: string): Promise<AsyncTask | null> {
    const filePath = this.taskPath(taskId);
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as AsyncTask;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  async getAll(options?: {
    notebook?: string;
    limit?: number;
  }): Promise<AsyncTask[]> {
    const tasks = await this.readAllTasks();

    let filtered = tasks;
    if (options?.notebook) {
      filtered = filtered.filter((t) => t.notebookAlias === options.notebook);
    }

    // Sort newest first
    filtered.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    if (options?.limit !== undefined && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  // -------------------------------------------------------------------------
  // getRecent — completed or failed tasks (undelivered notifications)
  // -------------------------------------------------------------------------

  async getRecent(options?: {
    notebook?: string;
    limit?: number;
  }): Promise<AsyncTask[]> {
    const tasks = await this.readAllTasks();

    let filtered = tasks.filter(
      (t) => t.status === "completed" || t.status === "failed",
    );

    if (options?.notebook) {
      filtered = filtered.filter((t) => t.notebookAlias === options.notebook);
    }

    // Sort newest first
    filtered.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    if (options?.limit !== undefined && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  // -------------------------------------------------------------------------
  // transition
  // -------------------------------------------------------------------------

  async transition(
    taskId: string,
    to: TaskStatus,
    reason?: string,
  ): Promise<AsyncTask> {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid transition: ${task.status} → ${to} (task ${taskId})`,
      );
    }

    const change: TaskStatusChange = {
      from: task.status,
      to,
      timestamp: new Date().toISOString(),
      reason: reason ?? null,
    };

    task.status = to;
    task.history.push(change);

    await this.writeTask(task);
    log.info("task transitioned", { taskId, from: change.from, to });
    return task;
  }

  // -------------------------------------------------------------------------
  // update — persist additional fields on an existing task
  // -------------------------------------------------------------------------

  async update(
    taskId: string,
    fields: Partial<Pick<AsyncTask, "result" | "error" | "errorScreenshot">>,
  ): Promise<AsyncTask> {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (fields.result !== undefined) task.result = fields.result;
    if (fields.error !== undefined) task.error = fields.error;
    if (fields.errorScreenshot !== undefined) task.errorScreenshot = fields.errorScreenshot;

    await this.writeTask(task);
    return task;
  }

  // -------------------------------------------------------------------------
  // cleanup — remove tasks older than ttlMs
  // -------------------------------------------------------------------------

  async cleanup(ttlMs?: number): Promise<number> {
    const ttl = ttlMs ?? DEFAULT_TTL_MS;
    const cutoff = Date.now() - ttl;
    const tasks = await this.readAllTasks();

    let removed = 0;
    for (const task of tasks) {
      if (new Date(task.createdAt).getTime() < cutoff) {
        try {
          await unlink(this.taskPath(task.taskId));
          removed++;
        } catch {
          // File may have already been removed; ignore.
        }
      }
    }

    if (removed > 0) {
      log.info("cleanup completed", { removed, ttlMs: ttl });
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private taskPath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true, mode: DIR_PERMISSION });
  }

  /** Atomic write: write to temp file, then rename into place. */
  private async writeTask(task: AsyncTask): Promise<void> {
    await this.ensureDir();

    const dest = this.taskPath(task.taskId);
    const tmp = join(
      this.tasksDir,
      `.tmp-${task.taskId}-${Date.now()}.json`,
    );

    await writeFile(tmp, JSON.stringify(task, null, 2) + "\n", {
      mode: FILE_PERMISSION,
    });
    await rename(tmp, dest);
  }

  /** Read all task JSON files from the tasks directory. */
  private async readAllTasks(): Promise<AsyncTask[]> {
    let entries: string[];
    try {
      entries = await readdir(this.tasksDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const tasks: AsyncTask[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) {
        continue;
      }
      try {
        const raw = await readFile(join(this.tasksDir, entry), "utf-8");
        tasks.push(JSON.parse(raw) as AsyncTask);
      } catch {
        // Skip corrupted files silently.
      }
    }
    return tasks;
  }
}
