import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema — mirrors the contract from specs/001-mvp/contracts/mcp-tools.md
// cancel_task: cancel a queued or running async task
// ---------------------------------------------------------------------------

const CancelTaskInputSchema = z.object({
  taskId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

/** ISO 8601 date-time string */
const ISODateTimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  "Must be an ISO 8601 date-time string",
);

/** Success: task cancelled from queued state (clean cancel, no hint needed) */
const CancelledFromQueuedSchema = z.object({
  taskId: z.string().min(1),
  status: z.literal("cancelled"),
  cancelledAt: ISODateTimeSchema,
});

/** Success: task cancelled from running state (includes hint about partial work) */
const CancelledFromRunningSchema = z.object({
  taskId: z.string().min(1),
  status: z.literal("cancelled"),
  cancelledAt: ISODateTimeSchema,
  hint: z.string().min(1),
});

/** Error: task is in a terminal state and cannot be cancelled */
const ErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
});

// =====================================================================
// Tests
// =====================================================================

describe("cancel_task contract", () => {
  // ---------------------------------------------------------------
  // Input schema: valid inputs
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts a valid taskId", () => {
      const result = CancelTaskInputSchema.safeParse({
        taskId: "task-abc123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taskId).toBe("task-abc123");
      }
    });

    it("accepts UUID-style taskId", () => {
      const result = CancelTaskInputSchema.safeParse({
        taskId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("accepts single-char taskId", () => {
      const result = CancelTaskInputSchema.safeParse({ taskId: "x" });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Input schema: invalid inputs
  // ---------------------------------------------------------------

  describe("input schema — invalid inputs", () => {
    it("rejects missing taskId", () => {
      const result = CancelTaskInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty taskId", () => {
      const result = CancelTaskInputSchema.safeParse({ taskId: "" });
      expect(result.success).toBe(false);
    });

    it("rejects taskId as number", () => {
      const result = CancelTaskInputSchema.safeParse({ taskId: 42 });
      expect(result.success).toBe(false);
    });

    it("rejects taskId as boolean", () => {
      const result = CancelTaskInputSchema.safeParse({ taskId: true });
      expect(result.success).toBe(false);
    });

    it("rejects taskId as null", () => {
      const result = CancelTaskInputSchema.safeParse({ taskId: null });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: cancelled from queued state
  // ---------------------------------------------------------------

  describe("output — cancelled from queued state", () => {
    const sampleQueued = {
      taskId: "task-abc123",
      status: "cancelled" as const,
      cancelledAt: "2026-03-13T10:05:00Z",
    };

    it("validates a well-formed queued→cancelled response", () => {
      const result = CancelledFromQueuedSchema.safeParse(sampleQueued);
      expect(result.success).toBe(true);
    });

    it("requires taskId", () => {
      const { taskId: _taskId, ...rest } = sampleQueued;
      const result = CancelledFromQueuedSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty taskId", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        taskId: "",
      });
      expect(result.success).toBe(false);
    });

    it("requires status to be 'cancelled'", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        status: "completed",
      });
      expect(result.success).toBe(false);
    });

    it("rejects status as 'queued'", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        status: "queued",
      });
      expect(result.success).toBe(false);
    });

    it("requires cancelledAt", () => {
      const { cancelledAt: _cancelledAt, ...rest } = sampleQueued;
      const result = CancelledFromQueuedSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("requires cancelledAt to be ISO 8601 format", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        cancelledAt: "March 13, 2026",
      });
      expect(result.success).toBe(false);
    });

    it("accepts cancelledAt with milliseconds", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        cancelledAt: "2026-03-13T10:05:00.123Z",
      });
      expect(result.success).toBe(true);
    });

    it("accepts cancelledAt with timezone offset", () => {
      const result = CancelledFromQueuedSchema.safeParse({
        ...sampleQueued,
        cancelledAt: "2026-03-13T10:05:00+08:00",
      });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Output: cancelled from running state (adds hint)
  // ---------------------------------------------------------------

  describe("output — cancelled from running state", () => {
    const sampleRunning = {
      taskId: "task-def456",
      status: "cancelled" as const,
      cancelledAt: "2026-03-13T10:10:30Z",
      hint: "Task was running; partial results may exist. Check notebook state.",
    };

    it("validates a well-formed running→cancelled response", () => {
      const result = CancelledFromRunningSchema.safeParse(sampleRunning);
      expect(result.success).toBe(true);
    });

    it("requires hint field", () => {
      const { hint: _hint, ...rest } = sampleRunning;
      const result = CancelledFromRunningSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty hint", () => {
      const result = CancelledFromRunningSchema.safeParse({
        ...sampleRunning,
        hint: "",
      });
      expect(result.success).toBe(false);
    });

    it("requires taskId", () => {
      const { taskId: _taskId, ...rest } = sampleRunning;
      const result = CancelledFromRunningSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("requires status to be 'cancelled'", () => {
      const result = CancelledFromRunningSchema.safeParse({
        ...sampleRunning,
        status: "running",
      });
      expect(result.success).toBe(false);
    });

    it("requires cancelledAt in ISO format", () => {
      const result = CancelledFromRunningSchema.safeParse({
        ...sampleRunning,
        cancelledAt: "not-a-date",
      });
      expect(result.success).toBe(false);
    });

    it("a queued response also passes the running schema if hint is added", () => {
      // Verify running schema is a superset of queued schema + hint
      const queuedWithHint = {
        taskId: "task-abc123",
        status: "cancelled" as const,
        cancelledAt: "2026-03-13T10:05:00Z",
        hint: "Extra info for running cancellation.",
      };
      const result = CancelledFromRunningSchema.safeParse(queuedWithHint);
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Output: error response (terminal state)
  // ---------------------------------------------------------------

  describe("output — error response", () => {
    it("validates terminal state error (completed)", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Task 'task-abc123' is already completed and cannot be cancelled",
      });
      expect(result.success).toBe(true);
    });

    it("validates terminal state error (failed)", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Task 'task-abc123' is already failed and cannot be cancelled",
      });
      expect(result.success).toBe(true);
    });

    it("validates terminal state error (already cancelled)", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Task 'task-abc123' is already cancelled",
      });
      expect(result.success).toBe(true);
    });

    it("validates task not found error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Task 'task-xyz' not found",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty error message", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects error with success: true", () => {
      const result = ErrorOutputSchema.safeParse({
        success: true,
        error: "something went wrong",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing error field", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing success field", () => {
      const result = ErrorOutputSchema.safeParse({
        error: "something went wrong",
      });
      expect(result.success).toBe(false);
    });
  });
});
