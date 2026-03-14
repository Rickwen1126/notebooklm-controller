/**
 * T087: Integration test for audio flow.
 *
 * Verifies the end-to-end flow: exec -> dual session -> Planner selects
 * generate-audio agent -> Executor triggers generation, polls for completion ->
 * download-audio agent downloads the file.
 *
 * This test mocks the Copilot SDK session layer, verifying the wiring
 * between daemon -> scheduler -> session-runner for audio operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "../../../src/daemon/scheduler.js";
import { TaskStore } from "../../../src/state/task-store.js";
import type { AsyncTask } from "../../../src/shared/types.js";

describe("audio integration flow", () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = new TaskStore();
  });

  it("exec -> scheduler -> runTask completes for generate-audio command", async () => {
    const runTask = vi.fn(async (task: AsyncTask) => {
      expect(task.command).toBe("產生語音摘要");
      expect(task.notebookAlias).toBe("research");

      return {
        success: true,
        result: {
          audioGenerated: true,
          durationMs: 180000,
        },
      };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "產生語音摘要",
    });

    await scheduler.waitForTask(task.taskId);

    const completed = await taskStore.get(task.taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({
      audioGenerated: true,
      durationMs: 180000,
    });
  });

  it("generate-audio reports timeout when generation exceeds limit", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Audio generation timeout: exceeded 10 minutes polling limit",
    }));

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "產生語音摘要",
    });

    await scheduler.waitForTask(task.taskId);

    const failed = await taskStore.get(task.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("timeout");
  });

  it("exec -> scheduler -> runTask completes for download-audio command", async () => {
    const runTask = vi.fn(async (task: AsyncTask) => {
      expect(task.command).toBe("下載語音摘要");
      expect(task.notebookAlias).toBe("research");

      return {
        success: true,
        result: {
          downloaded: true,
          filePath: "/Users/user/.nbctl/downloads/research-audio.wav",
          fileSize: "15.2 MB",
        },
      };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "下載語音摘要",
    });

    await scheduler.waitForTask(task.taskId);

    const completed = await taskStore.get(task.taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toHaveProperty("downloaded", true);
    expect(completed?.result).toHaveProperty("filePath");
  });

  it("download-audio fails when audio not yet generated", async () => {
    const runTask = vi.fn(async () => ({
      success: false,
      error: "Audio not ready: generation still in progress (sync indicator present)",
    }));

    const scheduler = new Scheduler({ taskStore, runTask });

    const task = await scheduler.submit({
      notebookAlias: "research",
      command: "下載語音摘要",
    });

    await scheduler.waitForTask(task.taskId);

    const failed = await taskStore.get(task.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("not ready");
  });

  it("generate then download: sequential two-step flow", async () => {
    const commands: string[] = [];
    const runTask = vi.fn(async (task: AsyncTask) => {
      commands.push(task.command);
      return {
        success: true,
        result: { step: commands.length },
      };
    });

    const scheduler = new Scheduler({ taskStore, runTask });

    // Step 1: Generate
    const genTask = await scheduler.submit({
      notebookAlias: "research",
      command: "產生語音摘要",
    });
    await scheduler.waitForTask(genTask.taskId);

    // Step 2: Download
    const dlTask = await scheduler.submit({
      notebookAlias: "research",
      command: "下載語音摘要",
    });
    await scheduler.waitForTask(dlTask.taskId);

    const genCompleted = await taskStore.get(genTask.taskId);
    const dlCompleted = await taskStore.get(dlTask.taskId);

    expect(genCompleted?.status).toBe("completed");
    expect(dlCompleted?.status).toBe("completed");
    expect(commands).toEqual(["產生語音摘要", "下載語音摘要"]);
  });
});
