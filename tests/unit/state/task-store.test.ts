import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore } from "../../../src/state/task-store.js";

describe("TaskStore", () => {
  let store: TaskStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "task-store-test-"));
    store = new TaskStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe("create", () => {
    it("creates a new task with queued status and initial history entry", async () => {
      const task = await store.create({
        notebookAlias: "my-notebook",
        command: "add-source https://example.com",
      });

      expect(task.taskId).toMatch(/^[0-9a-f]{8}$/);
      expect(task.notebookAlias).toBe("my-notebook");
      expect(task.command).toBe("add-source https://example.com");
      expect(task.context).toBeNull();
      expect(task.status).toBe("queued");
      expect(task.result).toBeNull();
      expect(task.error).toBeNull();
      expect(task.errorScreenshot).toBeNull();
      expect(task.createdAt).toBeTruthy();

      // History should have exactly one entry
      expect(task.history).toHaveLength(1);
      expect(task.history[0].from).toBeNull();
      expect(task.history[0].to).toBe("queued");
      expect(task.history[0].reason).toBeNull();
      expect(task.history[0].timestamp).toBeTruthy();
    });

    it("stores optional context", async () => {
      const task = await store.create({
        notebookAlias: "nb",
        command: "query",
        context: "user wants a summary",
      });

      expect(task.context).toBe("user wants a summary");
    });

    it("defaults runner to 'pipeline' when omitted", async () => {
      const task = await store.create({
        notebookAlias: "my-notebook",
        command: "add-source https://example.com",
      });

      expect(task.runner).toBe("pipeline");
      expect(task.runnerInput).toBeNull();
    });

    it("stores provided runner and runnerInput", async () => {
      const task = await store.create({
        notebookAlias: "my-notebook",
        command: "scan",
        runner: "scanAllNotebooks",
        runnerInput: { force: true },
      });

      expect(task.runner).toBe("scanAllNotebooks");
      expect(task.runnerInput).toEqual({ force: true });
    });

    it("persists runner and runnerInput to disk and reads them back", async () => {
      const created = await store.create({
        notebookAlias: "nb",
        command: "cmd",
        runner: "customRunner",
        runnerInput: { key: "value" },
      });

      const fetched = await store.get(created.taskId);
      expect(fetched).not.toBeNull();
      expect(fetched!.runner).toBe("customRunner");
      expect(fetched!.runnerInput).toEqual({ key: "value" });
    });
  });

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  describe("get", () => {
    it("retrieves a task by ID", async () => {
      const created = await store.create({
        notebookAlias: "nb",
        command: "test-cmd",
      });

      const fetched = await store.get(created.taskId);
      expect(fetched).not.toBeNull();
      expect(fetched!.taskId).toBe(created.taskId);
      expect(fetched!.notebookAlias).toBe("nb");
      expect(fetched!.command).toBe("test-cmd");
    });

    it("returns null for non-existent task ID", async () => {
      const result = await store.get("deadbeef");
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getAll
  // -----------------------------------------------------------------------

  describe("getAll", () => {
    it("returns all tasks sorted newest first", async () => {
      await store.create({ notebookAlias: "a", command: "cmd1" });
      await store.create({ notebookAlias: "b", command: "cmd2" });
      const newest = await store.create({ notebookAlias: "a", command: "cmd3" });

      const all = await store.getAll();
      expect(all).toHaveLength(3);
      // Newest first — newest was created last
      expect(all[0].taskId).toBe(newest.taskId);
    });

    it("filters by notebook alias", async () => {
      await store.create({ notebookAlias: "alpha", command: "cmd1" });
      await store.create({ notebookAlias: "beta", command: "cmd2" });
      await store.create({ notebookAlias: "alpha", command: "cmd3" });

      const filtered = await store.getAll({ notebook: "alpha" });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t) => t.notebookAlias === "alpha")).toBe(true);
    });

    it("respects limit option", async () => {
      await store.create({ notebookAlias: "nb", command: "cmd1" });
      await store.create({ notebookAlias: "nb", command: "cmd2" });
      await store.create({ notebookAlias: "nb", command: "cmd3" });

      const limited = await store.getAll({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("returns empty array when directory does not exist", async () => {
      const emptyStore = new TaskStore(join(tempDir, "nonexistent"));
      const result = await emptyStore.getAll();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getRecent (completed/failed tasks)
  // -----------------------------------------------------------------------

  describe("getRecent", () => {
    it("returns only completed and failed tasks", async () => {
      const t1 = await store.create({ notebookAlias: "nb", command: "cmd1" });
      const t2 = await store.create({ notebookAlias: "nb", command: "cmd2" });
      await store.create({ notebookAlias: "nb", command: "cmd3" });

      await store.transition(t1.taskId, "running");
      await store.transition(t1.taskId, "completed");

      await store.transition(t2.taskId, "running");
      await store.transition(t2.taskId, "failed", "timeout");

      // Third task stays queued — should NOT appear in recent
      const recent = await store.getRecent();
      expect(recent).toHaveLength(2);

      const statuses = recent.map((t) => t.status);
      expect(statuses).toContain("completed");
      expect(statuses).toContain("failed");
    });

    it("filters recent tasks by notebook alias", async () => {
      const t1 = await store.create({ notebookAlias: "alpha", command: "c1" });
      const t2 = await store.create({ notebookAlias: "beta", command: "c2" });

      await store.transition(t1.taskId, "running");
      await store.transition(t1.taskId, "completed");
      await store.transition(t2.taskId, "running");
      await store.transition(t2.taskId, "completed");

      const recent = await store.getRecent({ notebook: "alpha" });
      expect(recent).toHaveLength(1);
      expect(recent[0].notebookAlias).toBe("alpha");
    });
  });

  // -----------------------------------------------------------------------
  // transition — state machine
  // -----------------------------------------------------------------------

  describe("transition", () => {
    it("queued → running (valid)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      const updated = await store.transition(task.taskId, "running");

      expect(updated.status).toBe("running");
      expect(updated.history).toHaveLength(2);
      expect(updated.history[1].from).toBe("queued");
      expect(updated.history[1].to).toBe("running");
    });

    it("queued → cancelled (valid)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      const updated = await store.transition(
        task.taskId,
        "cancelled",
        "user cancelled",
      );

      expect(updated.status).toBe("cancelled");
      expect(updated.history[1].reason).toBe("user cancelled");
    });

    it("running → completed (valid)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      await store.transition(task.taskId, "running");
      const updated = await store.transition(task.taskId, "completed");

      expect(updated.status).toBe("completed");
      expect(updated.history).toHaveLength(3);
    });

    it("running → failed (valid)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      await store.transition(task.taskId, "running");
      const updated = await store.transition(
        task.taskId,
        "failed",
        "network error",
      );

      expect(updated.status).toBe("failed");
      expect(updated.history[2].reason).toBe("network error");
    });

    it("running → cancelled (valid)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      await store.transition(task.taskId, "running");
      const updated = await store.transition(task.taskId, "cancelled");

      expect(updated.status).toBe("cancelled");
    });

    it("completed → running (invalid — should throw)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      await store.transition(task.taskId, "running");
      await store.transition(task.taskId, "completed");

      await expect(
        store.transition(task.taskId, "running"),
      ).rejects.toThrowError(/Invalid transition: completed → running/);
    });

    it("failed → running (invalid — should throw)", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });
      await store.transition(task.taskId, "running");
      await store.transition(task.taskId, "failed");

      await expect(
        store.transition(task.taskId, "running"),
      ).rejects.toThrowError(/Invalid transition: failed → running/);
    });

    it("throws when task does not exist", async () => {
      await expect(
        store.transition("00000000", "running"),
      ).rejects.toThrowError(/Task not found/);
    });
  });

  // -----------------------------------------------------------------------
  // cleanup — TTL-based removal
  // -----------------------------------------------------------------------

  describe("cleanup", () => {
    it("removes tasks older than the specified TTL", async () => {
      // Create a task and manually backdate its createdAt
      const task = await store.create({ notebookAlias: "nb", command: "old" });

      // Read, backdate, and re-write the task file
      const fetched = await store.get(task.taskId);
      expect(fetched).not.toBeNull();

      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      fetched!.createdAt = oldDate.toISOString();

      // Write the backdated task directly via the file system
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      const { join: joinPath } = await import("node:path");
      await writeFileFs(
        joinPath(tempDir, `${task.taskId}.json`),
        JSON.stringify(fetched, null, 2) + "\n",
      );

      // Create a recent task that should survive
      const recentTask = await store.create({
        notebookAlias: "nb",
        command: "recent",
      });

      const removed = await store.cleanup(); // default 24h TTL
      expect(removed).toBe(1);

      // Old task should be gone, recent should remain
      expect(await store.get(task.taskId)).toBeNull();
      expect(await store.get(recentTask.taskId)).not.toBeNull();
    });

    it("returns 0 when no tasks are expired", async () => {
      await store.create({ notebookAlias: "nb", command: "fresh" });
      const removed = await store.cleanup();
      expect(removed).toBe(0);
    });

    it("accepts custom TTL", async () => {
      const task = await store.create({ notebookAlias: "nb", command: "cmd" });

      // Backdate by 2 seconds
      const fetched = await store.get(task.taskId);
      fetched!.createdAt = new Date(Date.now() - 2000).toISOString();

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      const { join: joinPath } = await import("node:path");
      await writeFileFs(
        joinPath(tempDir, `${task.taskId}.json`),
        JSON.stringify(fetched, null, 2) + "\n",
      );

      // With 1 second TTL, the 2-second-old task should be removed
      const removed = await store.cleanup(1000);
      expect(removed).toBe(1);
    });
  });
});
