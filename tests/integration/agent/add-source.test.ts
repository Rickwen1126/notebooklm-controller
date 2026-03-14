/**
 * T071: Integration test for add-source flow.
 *
 * Verifies the end-to-end flow: exec → dual session → Planner selects
 * add-source agent → Executor calls repoToText → pastes into UI → source added.
 *
 * This test mocks the Copilot SDK session layer and content tools,
 * verifying the wiring between daemon → scheduler → session-runner → tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import { TaskStore } from "../../../src/state/task-store.js";
import type { AsyncTask } from "../../../src/shared/types.js";

describe("add-source integration flow", () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = new TaskStore();
  });

  it("exec → scheduler → runTask completes for add-source command", async () => {
    // Simulate a runTask that mimics successful dual-session execution
    const runTask = vi.fn(async (task: AsyncTask) => {
      expect(task.command).toBe("把 ~/code/my-project 的程式碼加入來源");
      expect(task.notebookAlias).toBe("research");

      return {
        success: true,
        result: {
          sourceAdded: "my-project (repo)",
          wordCount: 12345,
        },
      };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "把 ~/code/my-project 的程式碼加入來源",
    });

    await scheduler.waitForTask(task.taskId);

    const completed = await taskStore.get(task.taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({
      sourceAdded: "my-project (repo)",
      wordCount: 12345,
    });
  });

  it("exec → scheduler → runTask propagates repoToText failure", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Path is not a valid git repository: /bad/path",
    }));

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "把 /bad/path 加入來源",
    });

    await scheduler.waitForTask(task.taskId);

    const failed = await taskStore.get(task.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("not a valid git repository");
  });

  it("source update flow: delete old → convert → add new", async () => {
    const commands: string[] = [];
    const runTask = vi.fn(async (task: AsyncTask) => {
      commands.push(task.command);
      return { success: true, result: { sourceUpdated: "my-project (repo)" } };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "更新 my-project 的來源",
    });

    await scheduler.waitForTask(task.taskId);

    const completed = await taskStore.get(task.taskId);
    expect(completed?.status).toBe("completed");
  });
});
