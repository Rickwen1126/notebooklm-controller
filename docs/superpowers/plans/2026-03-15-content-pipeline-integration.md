# Content Pipeline Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire existing content converters (repoToText, urlToText, pdfToText) into the G2 addSource script so users can say "add my repo as a source" and it just works.

**Architecture:** Preprocessing in the script dispatch layer (`src/scripts/index.ts`). When `addSource` receives a `sourceType` param (repo/url/pdf), it calls the appropriate converter, reads the temp file, and passes the text content to `scriptedAddSource`. The Planner gets new optional fields (`sourcePath`, `sourceUrl`, `sourceType`) in submitPlan. No changes to session-runner or scriptedAddSource itself.

**Tech Stack:** Existing `src/content/` modules (repomix, @mozilla/readability, pdf-parse), readFileSync for temp files.

**Source of truth:** `src/content/repo-to-text.ts`, `url-to-text.ts`, `pdf-to-text.ts` (already implemented + tested)

---

## Key Decisions

1. **Preprocessing at dispatch, not script** — `scriptedAddSource` stays pure DOM (paste text). Content conversion happens before it's called.
2. **File-based content** — converters write to `~/.nbctl/tmp/`. Dispatch reads the file and passes text to script. Content never enters LLM context.
3. **Planner knows source types** — catalog describes repo/url/pdf options so Planner can extract path/url from NL prompt.
4. **No new operations** — still `addSource`, just with extra params. Keeps Planner simple.

---

## File Structure

### Modify
| File | Change |
|------|--------|
| `src/scripts/index.ts` | addSource dispatch: detect sourceType → call converter → read file → pass content |
| `src/agent/session-runner.ts` | submitPlan: add `sourcePath`, `sourceUrl`, `sourceType` optional fields |
| `tests/unit/scripts/index.test.ts` | New file: test addSource preprocessing for each source type |

### No changes needed
| File | Why |
|------|-----|
| `src/scripts/operations.ts` | `scriptedAddSource(ctx, content)` unchanged — it just pastes text |
| `src/content/*.ts` | Already implemented + tested |
| `src/agent/tools/content-tools.ts` | Still used by Recovery agent, unchanged |

---

## Chunk 1: Script Dispatch Preprocessing

### Task 1: addSource preprocessing in index.ts

**Files:**
- Modify: `src/scripts/index.ts`
- Create: `tests/unit/scripts/index.test.ts`

- [ ] Write the preprocessing logic in `SCRIPT_REGISTRY.addSource`:

```typescript
// In src/scripts/index.ts — updated addSource dispatch
import { readFileSync } from "node:fs";
import { repoToText } from "../content/repo-to-text.js";
import { urlToText } from "../content/url-to-text.js";
import { pdfToText } from "../content/pdf-to-text.js";
import { logger } from "../shared/logger.js";

const contentLog = logger.child({ module: "content-pipeline" });

/**
 * Preprocess addSource params: if sourceType is specified,
 * run the appropriate converter and return text content.
 * Returns the content string to paste.
 */
async function preprocessAddSource(params: Record<string, string>): Promise<string> {
  const sourceType = params.sourceType ?? "text";

  if (sourceType === "text") {
    return params.content ?? "";
  }

  if (sourceType === "repo") {
    const path = params.sourcePath;
    if (!path) throw new Error("sourcePath is required for sourceType=repo");
    contentLog.info("Converting repo to text", { path });
    const result = await repoToText(path);
    contentLog.info("Repo converted", { charCount: result.charCount, wordCount: result.wordCount });
    return readFileSync(result.filePath, "utf-8");
  }

  if (sourceType === "url") {
    const url = params.sourceUrl;
    if (!url) throw new Error("sourceUrl is required for sourceType=url");
    contentLog.info("Converting URL to text", { url });
    const result = await urlToText(url);
    contentLog.info("URL converted", { charCount: result.charCount, wordCount: result.wordCount });
    return readFileSync(result.filePath, "utf-8");
  }

  if (sourceType === "pdf") {
    const path = params.sourcePath;
    if (!path) throw new Error("sourcePath is required for sourceType=pdf");
    contentLog.info("Converting PDF to text", { path });
    const result = await pdfToText(path);
    contentLog.info("PDF converted", { charCount: result.charCount, wordCount: result.wordCount, pageCount: result.pageCount });
    return readFileSync(result.filePath, "utf-8");
  }

  throw new Error(`Unknown sourceType: ${sourceType}`);
}
```

- [ ] Update `SCRIPT_REGISTRY.addSource` to use preprocessing:

```typescript
addSource: async (ctx, p) => {
  try {
    const content = await preprocessAddSource(p);
    return scriptedAddSource(ctx, content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      operation: "addSource",
      status: "fail" as const,
      result: null,
      log: [{ step: 0, action: "content_preprocessing", status: "fail" as const, detail: msg, durationMs: 0 }],
      totalMs: 0,
      failedAtStep: 0,
      failedSelector: null,
    };
  }
},
```

- [ ] Update `SCRIPT_CATALOG` entry for addSource:

```typescript
{
  operation: "addSource",
  description: "Add a source to the notebook. Supports: plain text (content param), git repo (sourceType=repo + sourcePath), URL webpage (sourceType=url + sourceUrl), PDF file (sourceType=pdf + sourcePath). Content is automatically converted to text.",
  params: {
    content: "(for text) The text content to add",
    sourceType: "(optional) text | repo | url | pdf. Default: text",
    sourcePath: "(for repo/pdf) Absolute path to the repo or PDF file",
    sourceUrl: "(for url) The URL to fetch and convert",
  },
  startPage: "notebook",
},
```

- [ ] Write tests in `tests/unit/scripts/index.test.ts`:

```typescript
// Test 1: addSource with sourceType=text passes content through
// Test 2: addSource with sourceType=repo calls repoToText + reads file
// Test 3: addSource with sourceType=url calls urlToText + reads file
// Test 4: addSource with sourceType=pdf calls pdfToText + reads file
// Test 5: addSource with missing sourcePath for repo returns fail
// Test 6: addSource with unknown sourceType returns fail
// Test 7: buildScriptCatalog includes source type description
```

Mock the content modules (`repoToText`, `urlToText`, `pdfToText`) and `scriptedAddSource` — only test the preprocessing logic.

- [ ] Run `npx vitest run tests/unit/scripts/index.test.ts` — all pass
- [ ] Run `npm test` — 678+ tests pass, no regressions
- [ ] Commit: `feat: addSource content pipeline — repo/url/pdf preprocessing at dispatch`

---

## Chunk 2: Planner submitPlan Fields

### Task 2: Add source-related fields to submitPlan

**Files:**
- Modify: `src/agent/session-runner.ts:311-335` (submitPlan tool definition)
- Modify: `tests/unit/agent/session-runner.test.ts` (mockPlannerResponse)

- [ ] Add `sourcePath`, `sourceUrl`, `sourceType` to submitPlan z.object:

```typescript
// In the submitPlan defineTool parameters:
steps: z.array(z.object({
  operation: z.string().describe("Name of the scripted operation to run"),
  question: z.string().optional().describe("For query: the question to ask"),
  content: z.string().optional().describe("For addSource: the text content (for plain text sources)"),
  newName: z.string().optional().describe("For renameSource/renameNotebook: new name"),
  sourceType: z.string().optional().describe("For addSource: text | repo | url | pdf (default: text)"),
  sourcePath: z.string().optional().describe("For addSource with repo/pdf: absolute file path"),
  sourceUrl: z.string().optional().describe("For addSource with url: the URL to fetch"),
})),
```

- [ ] Update handler to convert new fields to params:

```typescript
handler: async (args) => {
  const steps: ExecutionStep[] = args.steps.map((s) => {
    const params: Record<string, string> = {};
    if (s.question) params.question = s.question;
    if (s.content) params.content = s.content;
    if (s.newName) params.newName = s.newName;
    if (s.sourceType) params.sourceType = s.sourceType;
    if (s.sourcePath) params.sourcePath = s.sourcePath;
    if (s.sourceUrl) params.sourceUrl = s.sourceUrl;
    return { operation: s.operation, params };
  });
  // ...
}
```

- [ ] Update `mockPlannerResponse` in test to include new fields in expanded step conversion
- [ ] Run `npm test` — all pass
- [ ] Commit: `feat: Planner submitPlan supports sourceType/sourcePath/sourceUrl`

---

## Chunk 3: Acceptance Testing

### Task 3: Real operation test with content pipeline

**No code changes** — verify end-to-end with running daemon.

- [ ] Test repo source:
```bash
mcp_call "exec" '{"prompt":"把 /Users/rickwen/code/notebooklm-controller 的程式碼加入來源","notebook":"nbctl-test"}'
```
Expected: Planner picks `addSource` with `sourceType=repo`, `sourcePath=/Users/rickwen/code/notebooklm-controller`. Script converts via repomix → paste.

- [ ] Test URL source:
```bash
mcp_call "exec" '{"prompt":"把 https://example.com 的內容加入來源","notebook":"nbctl-test"}'
```
Expected: Planner picks `sourceType=url`, `sourceUrl=https://example.com`.

- [ ] Test PDF source:
```bash
mcp_call "exec" '{"prompt":"把 /path/to/paper.pdf 加入來源","notebook":"nbctl-test"}'
```

- [ ] ISO Browser verification for each: source panel shows new source
- [ ] Commit: `test: content pipeline real operation verification`

---

## Execution Order

```
Chunk 1 (Task 1): Script dispatch preprocessing     — core logic
Chunk 2 (Task 2): Planner submitPlan fields          — Planner can pass params
Chunk 3 (Task 3): Real test                          — end-to-end verification
```

Total estimated: 3 tasks. Chunk 1 is the bulk of the work. Chunk 2 is a small schema change. Chunk 3 is manual verification.
