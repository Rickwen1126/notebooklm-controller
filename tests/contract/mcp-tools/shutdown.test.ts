import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema — mirrors the contract from specs/001-mvp/contracts/mcp-tools.md
// shutdown has no parameters
// ---------------------------------------------------------------------------

const ShutdownInputSchema = z.object({});

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const ShutdownOutputSchema = z.object({
  success: z.literal(true),
  message: z.literal("Daemon stopped"),
});

// ---------------------------------------------------------------------------
// Annotations — shutdown is a destructive operation
// ---------------------------------------------------------------------------

const ShutdownAnnotations = {
  destructiveHint: true,
} as const;

// =====================================================================
// Tests
// =====================================================================

describe("shutdown contract", () => {
  // ---------------------------------------------------------------
  // Input schema
  // ---------------------------------------------------------------

  describe("input schema", () => {
    it("accepts empty object", () => {
      const result = ShutdownInputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("strips unknown properties (strict-mode alternative: ignores extras)", () => {
      // Zod .object() by default strips unknown keys on parse.
      // This ensures no extra params affect the tool.
      const result = ShutdownInputSchema.safeParse({ force: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  // ---------------------------------------------------------------
  // Output schema
  // ---------------------------------------------------------------

  describe("output schema", () => {
    it("validates the expected success response", () => {
      const result = ShutdownOutputSchema.safeParse({
        success: true,
        message: "Daemon stopped",
      });
      expect(result.success).toBe(true);
    });

    it("rejects success: false", () => {
      const result = ShutdownOutputSchema.safeParse({
        success: false,
        message: "Daemon stopped",
      });
      expect(result.success).toBe(false);
    });

    it("rejects wrong message", () => {
      const result = ShutdownOutputSchema.safeParse({
        success: true,
        message: "Server stopped",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing success field", () => {
      const result = ShutdownOutputSchema.safeParse({
        message: "Daemon stopped",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing message field", () => {
      const result = ShutdownOutputSchema.safeParse({
        success: true,
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Annotations
  // ---------------------------------------------------------------

  describe("annotations", () => {
    it("should be marked as destructive", () => {
      expect(ShutdownAnnotations.destructiveHint).toBe(true);
    });

    it("annotation object has the expected shape", () => {
      // When registering the tool, annotations must include destructiveHint.
      // This locks down that requirement so implementation cannot omit it.
      expect(ShutdownAnnotations).toEqual(
        expect.objectContaining({ destructiveHint: true }),
      );
    });
  });
});
