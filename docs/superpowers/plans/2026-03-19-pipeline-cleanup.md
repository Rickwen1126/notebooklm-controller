# Pipeline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared session helpers, remove agent mode from pipeline, and fix unregister_notebook semantics.

**Architecture:** Three independent sections (S1, S2a, S3) that can be done in parallel. S2b+c (register_all_notebooks implementation) is blocked by a spike and NOT part of this plan.

**Tech Stack:** TypeScript 5.x, Vitest, @github/copilot-sdk, puppeteer-core

**Spec:** `docs/superpowers/specs/2026-03-19-pipeline-cleanup-design.md`

---

## File Map

| File | Action | Section |
|------|--------|---------|
| `src/agent/session-helpers.ts` | **Create** — shared event listener + disconnect helper | S1 |
| `src/agent/agent-session.ts` | Modify — use shared helpers | S1 |
| `src/agent/recovery-session.ts` | Modify — use shared helpers + fix `mode: "append"` → `"replace"` | S1 |
| `tests/unit/agent/session-helpers.test.ts` | **Create** — unit tests for helpers | S1 |
| `src/agent/session-runner.ts` | Modify — remove agent mode dispatch, imports, planner mode | S2a |
| `src/scripts/index.ts` | Modify — remove scanNotebooks entry + mode from catalog | S2a |
| `src/shared/types.ts` | Modify — remove `mode` from ExecutionStep | S2a |
| `tests/unit/agent/session-runner.test.ts` | Modify — remove `mode` from mockPlannerResponse | S2a |
| `src/daemon/notebook-tools.ts` | Modify — rename tool, remove tab close, add cache cleanup | S3 |
| `src/state/cache-manager.ts` | Modify — add `clearNotebook(alias)` method | S3 |
| `tests/unit/state/cache-manager.test.ts` | Modify — add clearNotebook tests | S3 |
| `tests/unit/daemon/notebook-tools.test.ts` | Modify — rename tool, update assertions | S3 |
| `tests/contract/mcp-tools/notebook-mgmt.test.ts` | Modify — rename tool references | S3 |
| `tests/integration/daemon/notebook-crud.test.ts` | Modify — rename tool, remove tab close assertion | S3 |

---

## Chunk 1: S1 — Shared Session Helpers

### Task 1: Create session-helpers.ts with tests

**Files:**
- Create: `src/agent/session-helpers.ts`
- Create: `tests/unit/agent/session-helpers.test.ts`

- [ ] **Step 1: Write failing tests for `setupSessionEventListeners`**

```typescript
// tests/unit/agent/session-helpers.test.ts
import { describe, it, expect, vi } from "vitest";
import { setupSessionEventListeners, disconnectSession } from "../../../src/agent/session-helpers.js";

function makeFakeSession() {
  const listeners: Array<(event: any) => void> = [];
  return {
    on: vi.fn((cb: (event: any) => void) => { listeners.push(cb); }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    emit(event: any) { listeners.forEach((cb) => cb(event)); },
  };
}

describe("setupSessionEventListeners", () => {
  it("captures tool.execution_start and tool.execution_complete", () => {
    const session = makeFakeSession();
    const { toolCallLog, getToolCallCount } = setupSessionEventListeners(session as any);

    session.emit({
      type: "tool.execution_start",
      data: { toolCallId: "call-1", toolName: "screenshot", arguments: {} },
    });
    expect(getToolCallCount()).toBe(1);

    session.emit({
      type: "tool.execution_complete",
      data: { toolCallId: "call-1", success: true, result: { content: "Screenshot captured." } },
    });
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0]).toEqual({
      tool: "screenshot",
      input: "{}",
      output: "Screenshot captured.",
    });
  });

  it("captures assistant.message events", () => {
    const session = makeFakeSession();
    const { agentMessages } = setupSessionEventListeners(session as any);

    session.emit({ type: "assistant.message", data: { content: "I found 3 notebooks." } });
    expect(agentMessages).toEqual(["I found 3 notebooks."]);
  });

  it("ignores empty assistant messages", () => {
    const session = makeFakeSession();
    const { agentMessages } = setupSessionEventListeners(session as any);

    session.emit({ type: "assistant.message", data: { content: "  " } });
    expect(agentMessages).toHaveLength(0);
  });

  it("truncates long inputs and outputs", () => {
    const session = makeFakeSession();
    const { toolCallLog } = setupSessionEventListeners(session as any);
    const longText = "x".repeat(500);

    session.emit({
      type: "tool.execution_start",
      data: { toolCallId: "call-1", toolName: "paste", arguments: { text: longText } },
    });
    session.emit({
      type: "tool.execution_complete",
      data: { toolCallId: "call-1", success: true, result: { content: longText } },
    });

    expect(toolCallLog[0].input.length).toBeLessThanOrEqual(200);
    expect(toolCallLog[0].output.length).toBeLessThanOrEqual(300);
  });
});

describe("disconnectSession", () => {
  it("disconnects successfully", async () => {
    const session = makeFakeSession();
    await disconnectSession(session as any);
    expect(session.disconnect).toHaveBeenCalled();
  });

  it("swallows disconnect errors", async () => {
    const session = makeFakeSession();
    session.disconnect.mockRejectedValue(new Error("hang"));
    await expect(disconnectSession(session as any)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/agent/session-helpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session-helpers.ts**

```typescript
// src/agent/session-helpers.ts
/**
 * Shared helpers for agent and recovery sessions.
 * Eliminates duplicated event listener setup and disconnect guard.
 */

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";

export interface SessionEventCapture {
  toolCallLog: Array<{ tool: string; input: string; output: string }>;
  agentMessages: string[];
  getToolCallCount: () => number;
}

/**
 * Attach event listeners to a CopilotSession to capture tool calls and messages.
 * Returns mutable arrays that the caller owns.
 */
export function setupSessionEventListeners(session: CopilotSession): SessionEventCapture {
  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;

  const pendingByCallId = new Map<string, { tool: string; input: string }>();

  session.on((event: SessionEvent) => {
    if (event.type === "tool.execution_start") {
      toolCallCount++;
      const d = event.data as { toolCallId: string; toolName: string; arguments?: Record<string, unknown> };
      pendingByCallId.set(d.toolCallId, {
        tool: d.toolName,
        input: JSON.stringify(d.arguments ?? {}).slice(0, 200),
      });
    } else if (event.type === "tool.execution_complete") {
      const d = event.data as { toolCallId: string; success: boolean; result?: { content: string } };
      const pending = pendingByCallId.get(d.toolCallId);
      toolCallLog.push({
        tool: pending?.tool ?? "unknown",
        input: pending?.input ?? "{}",
        output: (d.result?.content ?? "(no content)").slice(0, 300),
      });
      pendingByCallId.delete(d.toolCallId);
    } else if (event.type === "assistant.message") {
      const d = event.data as { content?: string };
      if (d.content?.trim()) agentMessages.push(d.content.slice(0, 300));
    }
  });

  return { toolCallLog, agentMessages, getToolCallCount: () => toolCallCount };
}

/**
 * Disconnect a CopilotSession with 5-second timeout guard.
 * Swallows errors — scheduler must never block on disconnect.
 */
export async function disconnectSession(session: CopilotSession): Promise<void> {
  try {
    await Promise.race([
      session.disconnect(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 5_000)),
    ]);
  } catch {
    // swallow — scheduler safety
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/agent/session-helpers.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/session-helpers.ts tests/unit/agent/session-helpers.test.ts
git commit -m "feat: shared session helpers — event listener + disconnect guard"
```

### Task 2: Refactor agent-session.ts to use shared helpers

**Files:**
- Modify: `src/agent/agent-session.ts:127-193`
- Test: `tests/unit/agent/agent-session.test.ts`

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run tests/unit/agent/agent-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 2: Replace duplicated code in agent-session.ts**

In `src/agent/agent-session.ts`:

Add import at top:
```typescript
import { setupSessionEventListeners, disconnectSession } from "./session-helpers.js";
```

Replace lines 106-108 (manual tracking variables):
```typescript
// REMOVE these three lines:
  const toolCallLog: Array<{ tool: string; input: string; output: string }> = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;
```

Replace lines 127-151 (event listener block) with:
```typescript
    const { toolCallLog, agentMessages, getToolCallCount } = setupSessionEventListeners(session);
```

Replace lines 186-193 (disconnect guard in finally block) with:
```typescript
    if (session) {
      await disconnectSession(session);
    }
```

Update all references to `toolCallCount` → `getToolCallCount()` (search and replace within file):
- In iteration `log.info("Agent iteration", ...)`: `toolCalls: toolCallCount` → `toolCalls: getToolCallCount()`
- In `log.info("Agent completed via submitResult", ...)`: same
- In `log.warn("Agent reached max iterations", ...)`: same
- In the `AgentSessionResult` construction: `toolCalls: toolCallCount` → `toolCalls: getToolCallCount()`

Note: All line numbers above are pre-edit positions. After removing ~25 lines of event listener code, they shift significantly. Use code context, not line numbers.

- [ ] **Step 3: Run tests to verify no regression**

Run: `npx vitest run tests/unit/agent/agent-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-session.ts
git commit -m "refactor: agent-session uses shared session helpers"
```

### Task 3: Refactor recovery-session.ts to use shared helpers + fix mode

**Files:**
- Modify: `src/agent/recovery-session.ts:147-210`
- Test: `tests/unit/agent/recovery-session.test.ts`

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run tests/unit/agent/recovery-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 2: Replace duplicated code in recovery-session.ts**

In `src/agent/recovery-session.ts`:

Add import at top:
```typescript
import { setupSessionEventListeners, disconnectSession } from "./session-helpers.js";
```

Replace lines 147-149 (manual tracking variables):
```typescript
// REMOVE these three lines:
  const toolCallLog: RecoveryToolCall[] = [];
  const agentMessages: string[] = [];
  let toolCallCount = 0;
```

Replace lines 170-193 (event listener block) with:
```typescript
    const { toolCallLog, agentMessages, getToolCallCount } = setupSessionEventListeners(session);
```

Replace lines 200-209 (disconnect guard in finally block) with:
```typescript
    if (session) {
      await disconnectSession(session);
    }
```

Update references to `toolCallCount` → `getToolCallCount()` at line ~237.

Note: `toolCallLog` type changes from `RecoveryToolCall[]` to `Array<{ tool, input, output }>`. These types are structurally identical (both have the same 3 string fields), so no behavioral change. The `RecoveryResult.toolCallLog` type can accept either.

- [ ] **Step 3: Run tests to verify no regression**

Run: `npx vitest run tests/unit/agent/recovery-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Commit the helper refactor**

```bash
git add src/agent/recovery-session.ts
git commit -m "refactor: recovery-session uses shared session helpers"
```

- [ ] **Step 5: Fix systemMessage mode "append" → "replace" (separate commit)**

In `src/agent/recovery-session.ts`, line 165:
```typescript
// BEFORE:
systemMessage: { mode: "append" as const, content: systemMessage },
// AFTER:
systemMessage: { mode: "replace" as const, content: systemMessage },
```

- [ ] **Step 6: Run tests to verify**

Run: `npx vitest run tests/unit/agent/recovery-session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Add test to verify recovery session uses "replace" mode**

In `tests/unit/agent/recovery-session.test.ts`, add:

```typescript
  it("creates session with systemMessage mode 'replace'", async () => {
    await runRecoverySession(makeOptions());
    expect(mockCreateSession).toHaveBeenCalled();
    const createArgs = mockCreateSession.mock.calls[0][0];
    expect(createArgs.systemMessage.mode).toBe("replace");
  });
```

Run: `npx vitest run tests/unit/agent/recovery-session.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit the mode fix**

```bash
git add src/agent/recovery-session.ts tests/unit/agent/recovery-session.test.ts
git commit -m "fix: recovery session systemMessage mode 'append' → 'replace'"
```

- [ ] **Step 9: Full test suite + build**

Run: `npm test && npm run build`
Expected: All pass, build succeeds

---

## Chunk 2: S2a — Remove Pipeline Agent Mode

### Task 4: Remove agent mode from session-runner.ts

**Files:**
- Modify: `src/agent/session-runner.ts`
- Test: `tests/unit/agent/session-runner.test.ts`

- [ ] **Step 1: Run existing session-runner tests to confirm green baseline**

Run: `npx vitest run tests/unit/agent/session-runner.test.ts`
Expected: PASS

- [ ] **Step 2: Remove unused imports from session-runner.ts**

At top of `src/agent/session-runner.ts`, remove these imports:

```typescript
// REMOVE:
import { runAgentSession } from "./agent-session.js";
import { loadAgentConfig } from "./agent-loader.js";
import { AGENTS_DIR_USER, AGENTS_DIR_BUNDLED } from "../shared/config.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
```

Keep all other imports (especially `DEFAULT_SESSION_TIMEOUT_MS`, `PLANNER_MODEL`, `DEFAULT_AGENT_MODEL`).

- [ ] **Step 3: Remove mode from submitPlan tool schema (line 329)**

In the `submitPlanTool` definition, remove:
```typescript
// REMOVE this line from the z.object steps array:
        mode: z.string().optional().describe("Execution mode: 'script' (default) or 'agent' (LLM with browser tools)"),
```

- [ ] **Step 4: Remove mode from submitPlan handler (line 339-351)**

In the handler, remove `mode` from the type annotation and the step construction:

```typescript
// BEFORE (line 339):
    handler: async (args: { reasoning: string; steps: Array<{ operation: string; mode?: string; question?: string; ...
// AFTER:
    handler: async (args: { reasoning: string; steps: Array<{ operation: string; question?: string; ...

// BEFORE (lines 350-351):
        const mode = (s.mode === "agent" ? "agent" : "script") as "script" | "agent";
        return { operation: s.operation, params, mode };
// AFTER:
        return { operation: s.operation, params };
```

- [ ] **Step 5: Remove mode from Planner system prompt (lines 297-300)**

```typescript
// BEFORE:
Call the submitPlan tool to submit an execution plan. Each step contains:
- operation: the name of the operation to run
- mode: "script" (default) or "agent" — **must match the mode listed in Available Operations**. If an operation has \`mode: agent\`, you MUST set mode to "agent".
- params: a JSON object with the required parameters for that operation
// AFTER:
Call the submitPlan tool to submit an execution plan. Each step contains:
- operation: the name of the operation to run
- params: a JSON object with the required parameters for that operation
```

- [ ] **Step 6: Remove mode dispatch + agent block from runPipeline (lines 538-605)**

In `runPipeline`, replace lines 537-605:

```typescript
// BEFORE:
    for (const [i, step] of plan.steps.entries()) {
      const mode = step.mode ?? "script";
      log.info("Executing step", {
        stepIndex: i + 1,
        totalSteps: plan.steps.length,
        operation: step.operation,
        mode,
      });
      ...
      if (mode === "agent") {
        // ... ~53 lines of agent dispatch ...
      }

// AFTER:
    for (const [i, step] of plan.steps.entries()) {
      log.info("Executing step", {
        stepIndex: i + 1,
        totalSteps: plan.steps.length,
        operation: step.operation,
      });
```

Delete the entire `if (mode === "agent") { ... }` block (lines 552-605). Keep the script path (lines 607+) unchanged.

- [ ] **Step 7: Update session-runner test — remove mode from mockPlannerResponse**

In `tests/unit/agent/session-runner.test.ts`, line 176:

```typescript
// BEFORE:
        mode: s.mode,
// REMOVE this line
```

Also remove the `agent-session.js` mock if present (line 53):
```typescript
// REMOVE if exists:
vi.mock("../../../src/agent/agent-session.js", () => ({
  runAgentSession: vi.fn().mockResolvedValue({ success: true, result: "agent result", toolCalls: 3, toolCallLog: [], agentMessages: [], durationMs: 100 }),
}));
```

- [ ] **Step 8: Run session-runner tests**

Run: `npx vitest run tests/unit/agent/session-runner.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/agent/session-runner.ts tests/unit/agent/session-runner.test.ts
git commit -m "refactor: remove agent mode dispatch from pipeline"
```

### Task 5: Remove mode from types.ts and script catalog

**Files:**
- Modify: `src/shared/types.ts:234-238`
- Modify: `src/scripts/index.ts:237-284`

- [ ] **Step 1: Remove mode from ExecutionStep type**

In `src/shared/types.ts`, line 238:
```typescript
// REMOVE:
  /** Execution mode: "script" (deterministic, 0 LLM) or "agent" (LLM + browser tools). Default: "script". */
  mode?: "script" | "agent";
```

- [ ] **Step 2: Remove scanNotebooks entry from SCRIPT_CATALOG**

In `src/scripts/index.ts`, line 269:
```typescript
// REMOVE:
  // --- Agent-mode operations (LLM + browser tools) ---
  { operation: "scanNotebooks", description: "Scan NotebookLM homepage and list all notebooks with names and URLs (uses LLM vision)", params: {}, startPage: "homepage", mode: "agent" },
```

- [ ] **Step 3: Remove mode from ScriptCatalogEntry interface**

In `src/scripts/index.ts`, lines 242-243:
```typescript
// REMOVE:
  /** Execution mode. Default "script" (deterministic). "agent" = LLM + browser tools. */
  mode?: "script" | "agent";
```

- [ ] **Step 4: Remove modeStr from buildScriptCatalog**

In `src/scripts/index.ts`, lines 281-282:
```typescript
// BEFORE:
    const modeStr = entry.mode === "agent" ? `\n    mode: agent` : "";
    return `  - operation: ${entry.operation}\n    description: ${entry.description}\n    startPage: ${entry.startPage}${modeStr}${paramStr}`;
// AFTER:
    return `  - operation: ${entry.operation}\n    description: ${entry.description}\n    startPage: ${entry.startPage}${paramStr}`;
```

- [ ] **Step 5: Run full test suite + build**

Run: `npm test && npm run build`
Expected: All pass, build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/scripts/index.ts
git commit -m "refactor: remove mode field from ExecutionStep and script catalog"
```

---

## Chunk 3: S3 — unregister_notebook Bug Fix

### Task 6: Add clearNotebook method to CacheManager

**Files:**
- Modify: `src/state/cache-manager.ts`
- Modify: `tests/unit/state/cache-manager.test.ts` (or create if not exists)

- [ ] **Step 1: Write failing test for clearNotebook**

Check if `tests/unit/state/cache-manager.test.ts` exists. If not, create it. Add:

```typescript
describe("clearNotebook", () => {
  it("deletes the notebook cache directory", async () => {
    // Setup: create a notebook cache with some data
    await cacheManager.addSource({
      id: "src-1",
      notebookAlias: "test-nb",
      name: "Test Source",
      type: "text",
      addedAt: new Date().toISOString(),
      removedAt: null,
    } as any);

    // Verify files exist
    const sources = await cacheManager.listSources("test-nb");
    expect(sources).toHaveLength(1);

    // Act
    await cacheManager.clearNotebook("test-nb");

    // Assert: directory gone, listing returns empty
    const sourcesAfter = await cacheManager.listSources("test-nb");
    expect(sourcesAfter).toHaveLength(0);
  });

  it("is a no-op for non-existent notebook", async () => {
    // Should not throw
    await expect(cacheManager.clearNotebook("nonexistent")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/state/cache-manager.test.ts -t "clearNotebook"`
Expected: FAIL — `clearNotebook` is not a function

- [ ] **Step 3: Implement clearNotebook**

In `src/state/cache-manager.ts`, add import at top:
```typescript
import { mkdir, readFile, writeFile, rename, chmod, stat, rm } from "node:fs/promises";
```

Add method after the `listOperations` method (around line 135):

```typescript
  // ---------------------------------------------------------------------------
  // clearNotebook — delete entire notebook cache directory
  // ---------------------------------------------------------------------------

  async clearNotebook(alias: string): Promise<void> {
    const dir = join(this.baseDir, alias);
    try {
      await rm(dir, { recursive: true });
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return; // directory doesn't exist — no-op
      }
      throw err;
    }
  }
```

Note: `isNodeError` helper should already exist in the file. If not, add:
```typescript
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/state/cache-manager.test.ts -t "clearNotebook"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/cache-manager.ts tests/unit/state/cache-manager.test.ts
git commit -m "feat: CacheManager.clearNotebook() — delete per-notebook cache dir"
```

### Task 7: Rename remove_notebook → unregister_notebook and fix behavior

**Files:**
- Modify: `src/daemon/notebook-tools.ts:566-609`
- Modify: `tests/unit/daemon/notebook-tools.test.ts`
- Modify: `tests/contract/mcp-tools/notebook-mgmt.test.ts`
- Modify: `tests/integration/daemon/notebook-crud.test.ts`

- [ ] **Step 1: Run existing notebook-tools tests to confirm green baseline**

Run: `npx vitest run tests/unit/daemon/notebook-tools.test.ts`
Expected: PASS

- [ ] **Step 2: Update notebook-tools.ts — rename + fix behavior**

In `src/daemon/notebook-tools.ts`, replace the `registerRemoveNotebook` function (lines 566-609):

```typescript
function registerUnregisterNotebook(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "unregister_notebook",
    {
      description:
        "Remove a notebook from the local registry and clean up cached data. " +
        "Does not affect the remote NotebookLM notebook or browser state.",
      inputSchema: {
        alias: z.string().describe("Alias of the notebook to unregister"),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (args: { alias?: string }) => {
      try {
        const alias = args.alias ?? "";

        const state = await deps.stateManager.load();
        if (!state.notebooks[alias]) {
          return errorResult(`Notebook not found: "${alias}"`);
        }

        // Remove from state (also clears default if it matches)
        await deps.stateManager.removeNotebook(alias);

        // Clean up per-notebook cache
        await deps.cacheManager.clearNotebook(alias);

        return jsonResult({ success: true, unregistered: alias });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}
```

Also update the function call site in `registerNotebookTools()` (search for `registerRemoveNotebook(server, deps)` and rename to `registerUnregisterNotebook(server, deps)`).

Update the file header comment (line 11):
```typescript
// BEFORE:
 * T055: remove_notebook   — remove a notebook from state and close its tab
// AFTER:
 * T055: unregister_notebook — remove a notebook from local registry and cache
```

- [ ] **Step 3: Update unit test — notebook-tools.test.ts**

In `tests/unit/daemon/notebook-tools.test.ts`:

Replace all `"remove_notebook"` → `"unregister_notebook"` (lines 121, 402, 405, 411, 429, 436, 446).

Update the `describe` block (line 405-449):

```typescript
  describe("unregister_notebook", () => {
    it("unregisters the notebook and cleans cache", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );

      const handler = server.getHandler("unregister_notebook");
      const result = parseResult(
        await handler({ alias: "research" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.unregistered).toBe("research");
      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith("research");
      expect(deps.cacheManager.clearNotebook).toHaveBeenCalledWith("research");
    });

    it("does NOT close tabs", async () => {
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ research: makeEntry("research") }),
      );
      (deps.tabManager.listTabs as ReturnType<typeof vi.fn>).mockReturnValue([
        { tabId: "tab-1", notebookAlias: "research" },
      ]);

      const handler = server.getHandler("unregister_notebook");
      await handler({ alias: "research" });

      expect(deps.tabManager.closeTab).not.toHaveBeenCalled();
    });

    it("returns error for non-existent notebook", async () => {
      const handler = server.getHandler("unregister_notebook");
      const result = parseResult(
        await handler({ alias: "nonexistent" }),
      ) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });

    it("has destructiveHint annotation", () => {
      const tool = server.tools.get("unregister_notebook")!;
      const options = tool.options as { annotations?: { destructiveHint?: boolean } };
      expect(options.annotations?.destructiveHint).toBe(true);
    });
  });
```

**IMPORTANT**: Update `cacheManager` mock in `makeDeps()` / test setup:

In `tests/unit/daemon/notebook-tools.test.ts`, find the `cacheManager` mock (currently `cacheManager: {} as unknown as ...`) and update:
```typescript
cacheManager: {
  clearNotebook: vi.fn().mockResolvedValue(undefined),
} as unknown as NotebookToolDeps["cacheManager"],
```

- [ ] **Step 4: Run unit tests**

Run: `npx vitest run tests/unit/daemon/notebook-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Update contract test — notebook-mgmt.test.ts**

In `tests/contract/mcp-tools/notebook-mgmt.test.ts`:
- Replace all `"remove_notebook"` → `"unregister_notebook"` (lines 97, 673)
- Rename `RemoveNotebookInputSchema` → `UnregisterNotebookInputSchema`
- Rename `RemoveNotebookSuccessSchema` → `UnregisterNotebookSuccessSchema`
- Update success schema: change `removed: z.string()` → `unregistered: z.string()`
- Update describe block name: `"remove_notebook contract"` → `"unregister_notebook contract"`

- [ ] **Step 6: Update integration test — notebook-crud.test.ts**

In `tests/integration/daemon/notebook-crud.test.ts`:
- Replace all `"remove_notebook"` → `"unregister_notebook"` (lines 5, 172, 424, 427, 429, 449, 451)
- Update `cacheManager` in deps setup (find `cacheManager: {}` and add `clearNotebook: vi.fn().mockResolvedValue(undefined)`)
- Update result assertion: `result.removed` → `result.unregistered`

Replace the "closes tab if open" test (line 449-474) with:

```typescript
    it("unregister_notebook does NOT close tab even if one is open", async () => {
      // Setup: a registered notebook with an open tab
      deps.tabManager.listTabs.mockReturnValue([
        { tabId: "tab-1", notebookAlias: "test-nb" },
      ]);
      (deps.stateManager.load as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeState({ "test-nb": makeEntry("test-nb") }),
      );

      const handler = server.getHandler("unregister_notebook");
      await handler({ alias: "test-nb" });

      // Tab should NOT be closed — unregister is pure local registry operation
      expect(deps.tabManager.closeTab).not.toHaveBeenCalled();
      // But state should be removed
      expect(deps.stateManager.removeNotebook).toHaveBeenCalledWith("test-nb");
      expect(deps.cacheManager.clearNotebook).toHaveBeenCalledWith("test-nb");
    });
```

- [ ] **Step 7: Run all tests + build**

Run: `npm test && npm run build`
Expected: All pass, build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/daemon/notebook-tools.ts tests/unit/daemon/notebook-tools.test.ts tests/contract/mcp-tools/notebook-mgmt.test.ts tests/integration/daemon/notebook-crud.test.ts
git commit -m "fix: rename remove_notebook → unregister_notebook, pure registry cleanup"
```

---

## Final Verification

- [ ] **Run full test suite**: `npm test`
- [ ] **Build**: `npm run build`
- [ ] **Git log review**: Verify 7 clean commits, no unintended changes

Expected commits:
1. `feat: shared session helpers — event listener + disconnect guard`
2. `refactor: agent-session uses shared session helpers`
3. `refactor: recovery-session uses shared session helpers`
4. `fix: recovery session systemMessage mode 'append' → 'replace'`
5. `refactor: remove agent mode dispatch from pipeline`
6. `refactor: remove mode field from ExecutionStep and script catalog`
7. `feat: CacheManager.clearNotebook() — delete per-notebook cache dir`
8. `fix: rename remove_notebook → unregister_notebook, pure registry cleanup`
