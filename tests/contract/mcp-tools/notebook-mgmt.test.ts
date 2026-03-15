import { describe, it, expect } from "vitest";
import { z } from "zod";

// ===========================================================================
// Shared schemas
// ===========================================================================

/** Alias: non-empty, alphanumeric + hyphens, 1-50 chars */
const AliasSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9-]+$/);

/** NotebookLM URL must match https://notebooklm.google.com/notebook/<id> */
const NotebookUrlSchema = z
  .string()
  .regex(/^https:\/\/notebooklm\.google\.com\/notebook\/[a-zA-Z0-9_-]+$/);

const NotebookStatusSchema = z.enum([
  "ready",
  "operating",
  "stale",
  "error",
]);

/** Standard MCP error shape for notebook management tools */
const ErrorOutputSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
});

// ===========================================================================
// register_notebook
// ===========================================================================

const AddNotebookInputSchema = z.object({
  url: NotebookUrlSchema,
  alias: AliasSchema,
});

const AddNotebookSuccessSchema = z.object({
  success: z.literal(true),
  alias: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  sourceCount: z.number(),
});

// ===========================================================================
// list_notebooks
// ===========================================================================

const ListNotebooksInputSchema = z.object({});

const NotebookEntrySchema = z.object({
  alias: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  status: NotebookStatusSchema,
  sourceCount: z.number(),
});

const ListNotebooksOutputSchema = z.array(NotebookEntrySchema);

// ===========================================================================
// set_default
// ===========================================================================

const SetDefaultInputSchema = z.object({
  alias: AliasSchema,
});

const SetDefaultSuccessSchema = z.object({
  success: z.literal(true),
  default: z.string(),
});

// ===========================================================================
// rename_notebook
// ===========================================================================

const RenameNotebookInputSchema = z.object({
  oldAlias: AliasSchema,
  newAlias: AliasSchema,
});

const RenameNotebookSuccessSchema = z.object({
  success: z.literal(true),
  oldAlias: z.string(),
  newAlias: z.string(),
});

// ===========================================================================
// remove_notebook
// ===========================================================================

const RemoveNotebookInputSchema = z.object({
  alias: AliasSchema,
});

const RemoveNotebookSuccessSchema = z.object({
  success: z.literal(true),
  removed: z.string(),
});

// =====================================================================
// Tests
// =====================================================================

describe("register_notebook contract", () => {
  // ---------------------------------------------------------------
  // Input schema: valid inputs
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts a valid URL and alias", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe(
          "https://notebooklm.google.com/notebook/abc123",
        );
        expect(result.data.alias).toBe("research");
      }
    });

    it("accepts alias with hyphens", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/xyz789",
        alias: "my-ml-papers",
      });
      expect(result.success).toBe(true);
    });

    it("accepts alias with numbers", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/n001",
        alias: "project42",
      });
      expect(result.success).toBe(true);
    });

    it("accepts single-char alias", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/n001",
        alias: "x",
      });
      expect(result.success).toBe(true);
    });

    it("accepts 50-char alias (max length)", () => {
      const alias = "a".repeat(50);
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/n001",
        alias,
      });
      expect(result.success).toBe(true);
    });

    it("accepts URL with underscores and hyphens in notebook ID", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc_def-123",
        alias: "test",
      });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Input schema: invalid inputs
  // ---------------------------------------------------------------

  describe("input schema — invalid inputs", () => {
    it("rejects non-NotebookLM URL", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://docs.google.com/document/d/abc123",
        alias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects URL without notebook ID", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/",
        alias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects URL with trailing slash", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123/",
        alias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects http (non-https) URL", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "http://notebooklm.google.com/notebook/abc123",
        alias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty alias", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects alias with spaces", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "my research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects alias with underscores", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "my_research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects alias with special characters", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "research@home",
      });
      expect(result.success).toBe(false);
    });

    it("rejects alias exceeding 50 chars", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
        alias: "a".repeat(51),
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing url", () => {
      const result = AddNotebookInputSchema.safeParse({
        alias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing alias", () => {
      const result = AddNotebookInputSchema.safeParse({
        url: "https://notebooklm.google.com/notebook/abc123",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: success response
  // ---------------------------------------------------------------

  describe("output — success response", () => {
    const sampleSuccess = {
      success: true as const,
      alias: "research",
      url: "https://notebooklm.google.com/notebook/abc123",
      title: "ML Research Notes",
      description: "Notes on transformer architectures",
      sourceCount: 5,
    };

    it("validates a well-formed success response", () => {
      const result = AddNotebookSuccessSchema.safeParse(sampleSuccess);
      expect(result.success).toBe(true);
    });

    it("rejects missing alias in response", () => {
      const { alias: _alias, ...rest } = sampleSuccess;
      const result = AddNotebookSuccessSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing sourceCount", () => {
      const { sourceCount: _sc, ...rest } = sampleSuccess;
      const result = AddNotebookSuccessSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects success: false", () => {
      const result = AddNotebookSuccessSchema.safeParse({
        ...sampleSuccess,
        success: false,
      });
      expect(result.success).toBe(false);
    });

    it("accepts zero sourceCount", () => {
      const result = AddNotebookSuccessSchema.safeParse({
        ...sampleSuccess,
        sourceCount: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Output: error responses
  // ---------------------------------------------------------------

  describe("output — error responses", () => {
    it("validates invalid URL error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Invalid NotebookLM URL format",
      });
      expect(result.success).toBe(true);
    });

    it("validates duplicate URL error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "URL already registered under alias 'research'",
      });
      expect(result.success).toBe(true);
    });

    it("validates duplicate alias error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Alias 'research' already in use",
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
  });
});

// =====================================================================

describe("list_notebooks contract", () => {
  // ---------------------------------------------------------------
  // Input schema
  // ---------------------------------------------------------------

  describe("input schema", () => {
    it("accepts empty object", () => {
      const result = ListNotebooksInputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("strips unknown properties", () => {
      const result = ListNotebooksInputSchema.safeParse({ filter: "active" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  // ---------------------------------------------------------------
  // Output: notebook list
  // ---------------------------------------------------------------

  describe("output — notebook list", () => {
    const sampleList = [
      {
        alias: "research",
        url: "https://notebooklm.google.com/notebook/abc123",
        title: "ML Research Notes",
        description: "Notes on transformer architectures",
        status: "ready" as const,
        sourceCount: 5,
      },
      {
        alias: "ml-papers",
        url: "https://notebooklm.google.com/notebook/def456",
        title: "Paper Summaries",
        description: "Collection of paper reviews",
        status: "stale" as const,
        sourceCount: 12,
      },
    ];

    it("validates a list of notebooks", () => {
      const result = ListNotebooksOutputSchema.safeParse(sampleList);
      expect(result.success).toBe(true);
    });

    it("validates empty list", () => {
      const result = ListNotebooksOutputSchema.safeParse([]);
      expect(result.success).toBe(true);
    });

    it("validates all NotebookStatus values", () => {
      const statuses = [
        "ready",
        "operating",
        "stale",
        "error",
      ] as const;
      for (const status of statuses) {
        const entry = { ...sampleList[0], status };
        const result = NotebookEntrySchema.safeParse(entry);
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid status value", () => {
      const bad = { ...sampleList[0], status: "unknown" };
      const result = NotebookEntrySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("rejects missing alias field", () => {
      const { alias: _alias, ...rest } = sampleList[0];
      const result = NotebookEntrySchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects non-number sourceCount", () => {
      const bad = { ...sampleList[0], sourceCount: "five" };
      const result = NotebookEntrySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });
  });
});

// =====================================================================

describe("set_default contract", () => {
  // ---------------------------------------------------------------
  // Input schema
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts a valid alias", () => {
      const result = SetDefaultInputSchema.safeParse({ alias: "research" });
      expect(result.success).toBe(true);
    });
  });

  describe("input schema — invalid inputs", () => {
    it("rejects empty alias", () => {
      const result = SetDefaultInputSchema.safeParse({ alias: "" });
      expect(result.success).toBe(false);
    });

    it("rejects missing alias", () => {
      const result = SetDefaultInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects alias exceeding 50 chars", () => {
      const result = SetDefaultInputSchema.safeParse({
        alias: "a".repeat(51),
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: success response
  // ---------------------------------------------------------------

  describe("output — success response", () => {
    it("validates a well-formed success response", () => {
      const result = SetDefaultSuccessSchema.safeParse({
        success: true,
        default: "research",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing default field", () => {
      const result = SetDefaultSuccessSchema.safeParse({ success: true });
      expect(result.success).toBe(false);
    });

    it("rejects success: false", () => {
      const result = SetDefaultSuccessSchema.safeParse({
        success: false,
        default: "research",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: error response
  // ---------------------------------------------------------------

  describe("output — error response", () => {
    it("validates notebook not registered error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Notebook 'research' is not registered",
      });
      expect(result.success).toBe(true);
    });
  });
});

// =====================================================================

describe("rename_notebook contract", () => {
  // ---------------------------------------------------------------
  // Input schema: valid inputs
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts valid oldAlias and newAlias", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research",
        newAlias: "ml-research",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.oldAlias).toBe("research");
        expect(result.data.newAlias).toBe("ml-research");
      }
    });

    it("accepts newAlias at max length (50 chars)", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "old",
        newAlias: "a".repeat(50),
      });
      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Input schema: invalid inputs
  // ---------------------------------------------------------------

  describe("input schema — invalid inputs", () => {
    it("rejects missing oldAlias", () => {
      const result = RenameNotebookInputSchema.safeParse({
        newAlias: "new-name",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing newAlias", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty newAlias", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research",
        newAlias: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects newAlias with spaces", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research",
        newAlias: "new name",
      });
      expect(result.success).toBe(false);
    });

    it("rejects newAlias exceeding 50 chars", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research",
        newAlias: "a".repeat(51),
      });
      expect(result.success).toBe(false);
    });

    it("rejects oldAlias with special characters", () => {
      const result = RenameNotebookInputSchema.safeParse({
        oldAlias: "research@home",
        newAlias: "new-name",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: success response
  // ---------------------------------------------------------------

  describe("output — success response", () => {
    it("validates a well-formed success response", () => {
      const result = RenameNotebookSuccessSchema.safeParse({
        success: true,
        oldAlias: "research",
        newAlias: "ml-research",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing oldAlias in response", () => {
      const result = RenameNotebookSuccessSchema.safeParse({
        success: true,
        newAlias: "ml-research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing newAlias in response", () => {
      const result = RenameNotebookSuccessSchema.safeParse({
        success: true,
        oldAlias: "research",
      });
      expect(result.success).toBe(false);
    });

    it("rejects success: false", () => {
      const result = RenameNotebookSuccessSchema.safeParse({
        success: false,
        oldAlias: "research",
        newAlias: "ml-research",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: error responses
  // ---------------------------------------------------------------

  describe("output — error responses", () => {
    it("validates old alias not found error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Alias 'research' not found",
      });
      expect(result.success).toBe(true);
    });

    it("validates new alias already in use error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Alias 'ml-research' already in use",
      });
      expect(result.success).toBe(true);
    });
  });
});

// =====================================================================

describe("remove_notebook contract", () => {
  // ---------------------------------------------------------------
  // Input schema
  // ---------------------------------------------------------------

  describe("input schema — valid inputs", () => {
    it("accepts a valid alias", () => {
      const result = RemoveNotebookInputSchema.safeParse({ alias: "research" });
      expect(result.success).toBe(true);
    });

    it("accepts alias with hyphens", () => {
      const result = RemoveNotebookInputSchema.safeParse({
        alias: "old-project-1",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("input schema — invalid inputs", () => {
    it("rejects empty alias", () => {
      const result = RemoveNotebookInputSchema.safeParse({ alias: "" });
      expect(result.success).toBe(false);
    });

    it("rejects missing alias", () => {
      const result = RemoveNotebookInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects alias with underscores", () => {
      const result = RemoveNotebookInputSchema.safeParse({
        alias: "old_project",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: success response
  // ---------------------------------------------------------------

  describe("output — success response", () => {
    it("validates a well-formed success response", () => {
      const result = RemoveNotebookSuccessSchema.safeParse({
        success: true,
        removed: "research",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing removed field", () => {
      const result = RemoveNotebookSuccessSchema.safeParse({ success: true });
      expect(result.success).toBe(false);
    });

    it("rejects success: false", () => {
      const result = RemoveNotebookSuccessSchema.safeParse({
        success: false,
        removed: "research",
      });
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Output: error response
  // ---------------------------------------------------------------

  describe("output — error response", () => {
    it("validates notebook not registered error", () => {
      const result = ErrorOutputSchema.safeParse({
        success: false,
        error: "Notebook 'research' is not registered",
      });
      expect(result.success).toBe(true);
    });
  });
});
