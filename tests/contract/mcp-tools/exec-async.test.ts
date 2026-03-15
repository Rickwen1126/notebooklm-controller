import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema — mirrors the contract from specs/001-mvp/contracts/mcp-tools.md
// exec: natural-language command execution against a notebook
// ---------------------------------------------------------------------------

const ExecInputSchema = z.object({
  prompt: z.string().min(1),
  notebook: z.string().optional(),
  async: z.boolean().default(false),
  context: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

/** Async mode: task queued for background execution */
const AsyncSubmitResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.literal("queued"),
  notebook: z.string().min(1),
  hint: z.string().min(1),
});

/** Sync mode: generic success result (shape varies by operation) */
const SyncResultSchema = z.object({
  success: z.boolean(),
  answer: z.string().optional(),
  citations: z.array(z.unknown()).optional(),
});

/** Error response */
const ErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
});

// =====================================================================
// Tests
// =====================================================================

describe("exec contract — async mode", () => {
  // ---------------------------------------------------------------
  // Input schema: valid inputs
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts a minimal exec input (prompt only)", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "summarize the notebook",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prompt).toBe("summarize the notebook");
        expect(result.data.async).toBe(false); // default applied
        expect(result.data.notebook).toBeUndefined();
        expect(result.data.context).toBeUndefined();
      }
    });

    it("accepts full input with all fields", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "add this URL as a source",
        notebook: "research",
        async: true,
        context: "https://example.com/paper.pdf",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prompt).toBe("add this URL as a source");
        expect(result.data.notebook).toBe("research");
        expect(result.data.async).toBe(true);
        expect(result.data.context).toBe("https://example.com/paper.pdf");
      }
    });

    it("async defaults to false when omitted", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "list sources",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.async).toBe(false);
      }
    });

    it("accepts notebook as optional", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "generate audio overview",
        async: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notebook).toBeUndefined();
      }
    });

    it("accepts context as optional", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "ask a question",
        notebook: "ml-papers",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context).toBeUndefined();
      }
    });

    it("accepts async explicitly set to false", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "get notebook info",
        async: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.async).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------
  // Input schema: invalid inputs
  // ---------------------------------------------------------------

  describe("input schema — invalid inputs", () => {
    it("rejects missing prompt", () => {
      const result = ExecInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty prompt", () => {
      const result = ExecInputSchema.safeParse({ prompt: "" });
      expect(result.success).toBe(false);
    });

    it("rejects prompt as number", () => {
      const result = ExecInputSchema.safeParse({ prompt: 42 });
      expect(result.success).toBe(false);
    });

    it("rejects notebook as number", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "test",
        notebook: 123,
      });
      expect(result.success).toBe(false);
    });

    it("rejects async as string", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "test",
        async: "true",
      });
      expect(result.success).toBe(false);
    });

    it("rejects context as number", () => {
      const result = ExecInputSchema.safeParse({
        prompt: "test",
        context: 999,
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: AsyncSubmitResult (async=true mode)
  // ---------------------------------------------------------------

  describe("output — AsyncSubmitResult shape", () => {
    const sampleAsync = {
      taskId: "task-abc123",
      status: "queued" as const,
      notebook: "research",
      hint: "Task queued. Use get_status({ taskId: 'task-abc123' }) to check progress.",
    };

    it("validates a well-formed AsyncSubmitResult", () => {
      const result = AsyncSubmitResultSchema.safeParse(sampleAsync);
      expect(result.success).toBe(true);
    });

    it("requires taskId", () => {
      const { taskId: _taskId, ...rest } = sampleAsync;
      const result = AsyncSubmitResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty taskId", () => {
      const result = AsyncSubmitResultSchema.safeParse({
        ...sampleAsync,
        taskId: "",
      });
      expect(result.success).toBe(false);
    });

    it("requires status to be 'queued'", () => {
      const result = AsyncSubmitResultSchema.safeParse({
        ...sampleAsync,
        status: "running",
      });
      expect(result.success).toBe(false);
    });

    it("rejects status as 'completed'", () => {
      const result = AsyncSubmitResultSchema.safeParse({
        ...sampleAsync,
        status: "completed",
      });
      expect(result.success).toBe(false);
    });

    it("requires notebook", () => {
      const { notebook: _notebook, ...rest } = sampleAsync;
      const result = AsyncSubmitResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty notebook", () => {
      const result = AsyncSubmitResultSchema.safeParse({
        ...sampleAsync,
        notebook: "",
      });
      expect(result.success).toBe(false);
    });

    it("requires hint", () => {
      const { hint: _hint, ...rest } = sampleAsync;
      const result = AsyncSubmitResultSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects empty hint", () => {
      const result = AsyncSubmitResultSchema.safeParse({
        ...sampleAsync,
        hint: "",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: Sync result (async=false mode)
  // ---------------------------------------------------------------

  describe("output — sync result shape", () => {
    it("validates success with answer and citations", () => {
      const result = SyncResultSchema.safeParse({
        success: true,
        answer: "The notebook contains 3 sources about ML.",
        citations: [{ source: "paper1.pdf", page: 3 }],
      });
      expect(result.success).toBe(true);
    });

    it("validates success without optional fields", () => {
      const result = SyncResultSchema.safeParse({
        success: true,
      });
      expect(result.success).toBe(true);
    });

    it("validates success with answer only", () => {
      const result = SyncResultSchema.safeParse({
        success: true,
        answer: "Done.",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.citations).toBeUndefined();
      }
    });

    it("validates success with empty citations array", () => {
      const result = SyncResultSchema.safeParse({
        success: true,
        answer: "No relevant citations found.",
        citations: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts success: false (operation failed but valid shape)", () => {
      const result = SyncResultSchema.safeParse({
        success: false,
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing success field", () => {
      const result = SyncResultSchema.safeParse({
        answer: "some answer",
      });
      expect(result.success).toBe(false);
    });

    it("rejects success as string", () => {
      const result = SyncResultSchema.safeParse({
        success: "true",
        answer: "some answer",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: Error response
  // ---------------------------------------------------------------

  describe("output — error response", () => {
    it("validates no target notebook error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "No target notebook: specify 'notebook' or set a default",
      });
      expect(result.success).toBe(true);
    });

    it("validates notebook not found error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Notebook 'research' is not registered",
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
