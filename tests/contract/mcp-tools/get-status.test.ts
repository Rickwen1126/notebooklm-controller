import { describe, it, expect } from "vitest";
import { z } from "zod";
import type {
  DaemonStatusResult,
  AsyncTask,
} from "../../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Input schema — mirrors the contract from specs/001-mvp/contracts/mcp-tools.md
// ---------------------------------------------------------------------------

const GetStatusInputSchema = z.object({
  taskId: z.string().optional(),
  all: z.boolean().optional(),
  recent: z.boolean().optional(),
  notebook: z.string().optional(),
  limit: z.number().default(20),
});

// ---------------------------------------------------------------------------
// Output schemas — Zod equivalents of the TypeScript interfaces in types.ts
// ---------------------------------------------------------------------------

const NetworkHealthSchema = z.object({
  status: z.enum(["healthy", "throttled", "disconnected"]),
  backoffUntil: z.string().nullable(),
  backoffRemainingMs: z.number().nullable(),
  lastCheckedAt: z.string(),
  recentLatencyMs: z.number().nullable(),
});

const DaemonStatusResultSchema = z.object({
  running: z.boolean(),
  tabPool: z.object({
    usedSlots: z.number(),
    maxSlots: z.number(),
    idleSlots: z.number(),
  }),
  network: NetworkHealthSchema,
  activeNotebooks: z.array(z.string()),
  defaultNotebook: z.string().nullable(),
  pendingTasks: z.number(),
  runningTasks: z.number(),
});

const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const TaskStatusChangeSchema = z.object({
  from: TaskStatusSchema.nullable(),
  to: TaskStatusSchema,
  timestamp: z.string(),
  reason: z.string().nullable(),
});

const AsyncTaskSchema = z.object({
  taskId: z.string(),
  notebookAlias: z.string(),
  command: z.string(),
  context: z.string().nullable(),
  runner: z.string(),
  runnerInput: z.record(z.unknown()).nullable(),
  status: TaskStatusSchema,
  result: z.object({}).passthrough().nullable(),
  error: z.string().nullable(),
  errorScreenshot: z.string().nullable(),
  history: z.array(TaskStatusChangeSchema),
  createdAt: z.string(),
});

const TaskSummarySchema = z.object({
  taskId: z.string(),
  notebook: z.string(),
  status: TaskStatusSchema,
  command: z.string(),
  createdAt: z.string(),
});

// =====================================================================
// Tests
// =====================================================================

describe("get_status contract", () => {
  // ---------------------------------------------------------------
  // Input schema: valid inputs
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts daemon status query (no params)", () => {
      const result = GetStatusInputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20); // default applied
      }
    });

    it("accepts taskId only", () => {
      const result = GetStatusInputSchema.safeParse({ taskId: "abc123" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taskId).toBe("abc123");
      }
    });

    it("accepts all=true", () => {
      const result = GetStatusInputSchema.safeParse({ all: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.all).toBe(true);
      }
    });

    it("accepts recent=true with notebook filter", () => {
      const result = GetStatusInputSchema.safeParse({
        recent: true,
        notebook: "research",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recent).toBe(true);
        expect(result.data.notebook).toBe("research");
      }
    });

    it("accepts explicit limit override", () => {
      const result = GetStatusInputSchema.safeParse({ all: true, limit: 50 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
      }
    });

    it("allows all optional fields to be omitted", () => {
      const result = GetStatusInputSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taskId).toBeUndefined();
        expect(result.data.all).toBeUndefined();
        expect(result.data.recent).toBeUndefined();
        expect(result.data.notebook).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------
  // Input schema: invalid inputs
  // ---------------------------------------------------------------

  describe("input schema — invalid inputs", () => {
    it("rejects taskId as number", () => {
      const result = GetStatusInputSchema.safeParse({ taskId: 42 });
      expect(result.success).toBe(false);
    });

    it("rejects limit as string", () => {
      const result = GetStatusInputSchema.safeParse({ limit: "twenty" });
      expect(result.success).toBe(false);
    });

    it("rejects all as string", () => {
      const result = GetStatusInputSchema.safeParse({ all: "yes" });
      expect(result.success).toBe(false);
    });

    it("rejects notebook as number", () => {
      const result = GetStatusInputSchema.safeParse({ notebook: 123 });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: DaemonStatusResult (no params mode)
  // ---------------------------------------------------------------

  describe("output — DaemonStatusResult shape", () => {
    const sampleDaemonStatus: DaemonStatusResult = {
      running: true,
      tabPool: { usedSlots: 3, maxSlots: 10, idleSlots: 2 },
      network: {
        status: "healthy",
        backoffUntil: null,
        backoffRemainingMs: null,
        lastCheckedAt: "2026-03-13T10:00:00Z",
        recentLatencyMs: 120,
      },
      activeNotebooks: ["research", "ml-papers"],
      defaultNotebook: "research",
      pendingTasks: 2,
      runningTasks: 1,
    };

    it("validates a well-formed DaemonStatusResult", () => {
      const result = DaemonStatusResultSchema.safeParse(sampleDaemonStatus);
      expect(result.success).toBe(true);
    });

    it("rejects missing running field", () => {
      const { running: _running, ...rest } = sampleDaemonStatus;
      const result = DaemonStatusResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects invalid network status enum", () => {
      const bad = {
        ...sampleDaemonStatus,
        network: { ...sampleDaemonStatus.network, status: "unknown" },
      };
      const result = DaemonStatusResultSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("accepts defaultNotebook as null", () => {
      const withNull = { ...sampleDaemonStatus, defaultNotebook: null };
      const result = DaemonStatusResultSchema.safeParse(withNull);
      expect(result.success).toBe(true);
    });

    it("accepts empty activeNotebooks array", () => {
      const empty = { ...sampleDaemonStatus, activeNotebooks: [] };
      const result = DaemonStatusResultSchema.safeParse(empty);
      expect(result.success).toBe(true);
    });

    it("accepts network with backoff values set", () => {
      const throttled = {
        ...sampleDaemonStatus,
        network: {
          status: "throttled" as const,
          backoffUntil: "2026-03-13T10:05:00Z",
          backoffRemainingMs: 30000,
          lastCheckedAt: "2026-03-13T10:04:30Z",
          recentLatencyMs: null,
        },
      };
      const result = DaemonStatusResultSchema.safeParse(throttled);
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Output: AsyncTask (taskId mode)
  // ---------------------------------------------------------------

  describe("output — AsyncTask shape (taskId mode)", () => {
    const sampleTask: AsyncTask = {
      taskId: "abc123",
      notebookAlias: "research",
      command: "add repo as source",
      context: "adding code for review",
      runner: "pipeline",
      runnerInput: null,
      status: "completed",
      result: { success: true, sourceAdded: "my-project (repo)" },
      error: null,
      errorScreenshot: null,
      history: [
        {
          from: null,
          to: "queued",
          timestamp: "2026-03-13T10:00:00Z",
          reason: null,
        },
        {
          from: "queued",
          to: "running",
          timestamp: "2026-03-13T10:00:05Z",
          reason: null,
        },
        {
          from: "running",
          to: "completed",
          timestamp: "2026-03-13T10:01:00Z",
          reason: null,
        },
      ],
      createdAt: "2026-03-13T10:00:00Z",
    };

    it("validates a well-formed AsyncTask", () => {
      const result = AsyncTaskSchema.safeParse(sampleTask);
      expect(result.success).toBe(true);
    });

    it("rejects invalid task status", () => {
      const bad = { ...sampleTask, status: "pending" };
      const result = AsyncTaskSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("accepts result as null (queued task)", () => {
      const queued = { ...sampleTask, status: "queued", result: null };
      const result = AsyncTaskSchema.safeParse(queued);
      expect(result.success).toBe(true);
    });

    it("accepts error and errorScreenshot for failed task", () => {
      const failed = {
        ...sampleTask,
        status: "failed",
        result: null,
        error: "Timeout waiting for element",
        errorScreenshot: "data:image/png;base64,abc123...",
      };
      const result = AsyncTaskSchema.safeParse(failed);
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Output: Task summary list (all/recent mode)
  // ---------------------------------------------------------------

  describe("output — task summary list (all/recent mode)", () => {
    const sampleSummaries = [
      {
        taskId: "abc123",
        notebook: "research",
        status: "completed" as const,
        command: "add repo as source",
        createdAt: "2026-03-13T10:00:00Z",
      },
      {
        taskId: "def456",
        notebook: "ml-papers",
        status: "running" as const,
        command: "summarize notebook",
        createdAt: "2026-03-13T10:05:00Z",
      },
    ];

    it("validates a list of task summaries", () => {
      const schema = z.array(TaskSummarySchema);
      const result = schema.safeParse(sampleSummaries);
      expect(result.success).toBe(true);
    });

    it("validates empty list", () => {
      const schema = z.array(TaskSummarySchema);
      const result = schema.safeParse([]);
      expect(result.success).toBe(true);
    });

    it("rejects summary with missing taskId", () => {
      const bad = [{ notebook: "research", status: "completed", command: "x", createdAt: "2026-03-13T10:00:00Z" }];
      const schema = z.array(TaskSummarySchema);
      const result = schema.safeParse(bad);
      expect(result.success).toBe(false);
    });
  });
});
