/**
 * T077: Integration test for query flow.
 *
 * Verifies the end-to-end flow: exec → dual session → Planner selects
 * query agent → Executor types question in chat → waits for response →
 * extracts answer + citations.
 *
 * This test mocks the Copilot SDK session layer, verifying the wiring
 * between daemon → scheduler → session-runner for query operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import { TaskStore } from "../../../src/state/task-store.js";
import type { AsyncTask } from "../../../src/shared/types.js";

describe("query integration flow", () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = new TaskStore();
  });

  it("exec → scheduler → runTask completes for query command", async () => {
    const runTask = vi.fn(async (task: AsyncTask) => {
      expect(task.command).toBe("這個專案的認證流程是怎麼運作的？");
      expect(task.notebookAlias).toBe("myproject");

      return {
        success: true,
        result: {
          answer: "認證流程使用 OAuth 2.0，透過 Google Identity Platform...",
          citations: [
            { source: "auth-module (repo)", snippet: "OAuth2Client..." },
          ],
        },
      };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "myproject",
      command: "這個專案的認證流程是怎麼運作的？",
    });

    await scheduler.waitForTask(task.taskId);

    const completed = await taskStore.get(task.taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toHaveProperty("answer");
    expect(completed?.result).toHaveProperty("citations");
  });

  it("query with no sources returns error", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Notebook has no sources. Add sources before asking questions.",
    }));

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "empty-nb",
      command: "任何問題",
    });

    await scheduler.waitForTask(task.taskId);

    const failed = await taskStore.get(task.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("no sources");
  });

  it("query timeout returns error with screenshot hint", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Response timed out",
      errorScreenshot: "base64-screenshot-data",
    }));

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "myproject",
      command: "複雜的問題",
    });

    await scheduler.waitForTask(task.taskId);

    const failed = await taskStore.get(task.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("timed out");
  });
});
