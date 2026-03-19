# Pipeline Cleanup & scan_notebooks Redesign

## Context

The pipeline grew organically and accumulated architectural debt:

1. **Duplicated session boilerplate** — `agent-session.ts` and `recovery-session.ts` share ~30 lines of identical code (event listeners, disconnect guards) that should be extracted
2. **Agent mode in pipeline is wrong abstraction** — `runPipeline` has a `mode: "agent"` dispatch path that doesn't fit the G2 model (Planner picks agent mode? No recovery for agent steps? Asymmetric guarantees)
3. **scan_notebooks doesn't work** — Single agent session tries to do everything (scroll + get all URLs) and fails; should be a dedicated MCP tool with purpose-built handler
4. **remove_notebook semantic bug** — Closes browser tabs (runtime side effect) when it should be pure local registry operation; doesn't clean up cache

## Design Principles

- **This is a specialized agent app, not a framework.** Don't add flexibility that doesn't serve concrete use cases.
- **Constraint over configuration.** `runSession`/`runPipeline` should be tight, not parameterized.
- **Existing paths stay untouched.** Changes are additive (new MCP tool, helper extraction) or subtractive (remove agent mode from pipeline). No behavioral changes to working code.

## S1: Shared Session Helpers

**Goal**: Eliminate duplicated code between agent-session.ts and recovery-session.ts without changing behavior.

**New file**: `src/agent/session-helpers.ts` (~50 lines)

### Extracted helpers

```typescript
// 1. Event listener setup — collect tool call log + agent messages
// Returns mutable arrays + counter that the caller owns
setupSessionEventListeners(session: CopilotSession): {
  toolCallLog: Array<{ tool: string; input: string; output: string }>;
  agentMessages: string[];
  getToolCallCount: () => number;
}

// 2. Disconnect guard — 5s timeout protection for scheduler safety
disconnectSession(session: CopilotSession): Promise<void>
```

### Not extracted

- **submitResult tool** — Schema differs too much between agent (`{success, result}`) and recovery (`{success, result?, analysis, suggestedPatch?}`). Extracting into a generic factory would be over-engineering. Each session type keeps its own `defineTool("submitResult", ...)`.
- **`createBrowserTools(cdp, page)`** — Already shared via `browser-tools-shared.ts`. Single-line call, no benefit from further extraction.

### Separate fix: recovery systemMessage mode

Recovery session currently uses `mode: "append"` (line 165). This should be changed to `mode: "replace"` — the recovery prompt is a complete recipe and does not need Copilot SDK defaults mixed in. This is a **behavioral change** (not part of the helper extraction) and should be a separate commit.

### Files changed

| File | Change |
|------|--------|
| `src/agent/session-helpers.ts` | **New** — shared helpers |
| `src/agent/agent-session.ts` | Import helpers, replace duplicated code |
| `src/agent/recovery-session.ts` | Import helpers, replace duplicated code. Separate commit: `mode: "append"` → `"replace"` |

### Verification

- `npm test` — all existing tests pass
- `npm run build` — TypeScript compiles

---

## S2: scan_notebooks — Dedicated MCP Tool

**Goal**: Remove agent mode from pipeline. Implement scan_notebooks as an independent MCP tool with purpose-built dual-session handler.

**Status**: **Needs spike** before finalizing script implementation details.

### 2a. Remove pipeline agent mode

Remove from existing code:

- `session-runner.ts` → `runPipeline()`: delete `if (mode === "agent")` dispatch block (lines 552-605, ~53 lines)
- `session-runner.ts` → `runPipeline()`: remove `const mode = step.mode ?? "script"` (line 538)
- `session-runner.ts` → `submitPlan` handler: remove mode construction `const mode = (s.mode === "agent" ? ...)` (line 350)
- `session-runner.ts` → `submitPlan` tool schema: remove `mode` field (line 329)
- `session-runner.ts` → Planner system prompt: remove mode-related instructions (line 299)
- `session-runner.ts` → Remove unused imports after agent block deletion: `runAgentSession`, `loadAgentConfig`, `AGENTS_DIR_USER`, `AGENTS_DIR_BUNDLED`, `join` (from `node:path`), `existsSync` (from `node:fs`)
- `scripts/index.ts` → `SCRIPT_CATALOG`: remove `scanNotebooks` entry. Also remove `mode` field from `ScriptCatalogEntry` interface and `modeStr` logic in `buildScriptCatalog()` (dead code after removal)
- `src/shared/types.ts` → `ExecutionStep`: remove `mode` field (dead type after pipeline cleanup)

After removal, `runPipeline` is pure G2: Planner → deterministic script → recovery on failure.

**Note**: `agent-session.ts` and `runAgentSession` are NOT deleted — they are still needed by S2c's dedicated handler.

### 2b. New MCP tool: replaces `register_all_notebooks` stub

`notebook-tools.ts:393` already has a `register_all_notebooks` stub marked "requires agent integration (post-MVP)". This is exactly what S2 implements.

**Decision**: Replace the existing `register_all_notebooks` stub with the real implementation. The MCP tool name stays `register_all_notebooks` (not `scan_notebooks`) since the end result is registering all discovered notebooks.

```typescript
server.registerTool("register_all_notebooks", {
  description: "Scan NotebookLM homepage to discover all notebooks, collect their URLs, and register them.",
  inputSchema: {},  // no parameters
})
```

### 2c. Dedicated handler: dual-session architecture

**New file**: `src/agent/scan-notebooks-handler.ts`

```
runScanNotebooks(client, cdp, page, ...)
  |
  | Phase 1: Agent Session — scan homepage
  |   prompt: scroll, screenshot, count all notebooks, output structured name list
  |   -> AgentSessionResult.result = JSON.parse -> nameList: string[]
  |   -> initialize objectList: Array<{ name, url }> (empty)
  |
  | Phase 2: for (name of nameList) — Ralph loop, max = nameList.length + 5
  |   |
  |   |  Script: scriptedGetNotebookUrl(ctx, { name })
  |   |    1. ensureHomepage
  |   |    2. findElementByText(page, name) -> click
  |   |    3. waitForNavigation -> page.url() confirm contains /notebook/
  |   |    4. navigate back to homepage
  |   |    -> return { url }
  |   |
  |   |  Script fails? -> Recovery agent (standard G2 flow)
  |   |
  |   |  Handler assembles { name, url } into objectList
  |   |  Check: is URL already in objectList? (duplicate name detection)
  |   |
  |   +- Loop ends when: all names have URLs, or iterations exhausted
  |
  | Phase 3: return objectList
  +-> { notebooks: [{ name, url }], total, scanned, missed }
```

### Key design decisions

1. **Phase 2 uses script + recovery (G2)** — Happy path = 0 LLM cost per notebook. Recovery agent only on failure. Reuses existing `ctx` injection and repair infrastructure.
2. **One notebook per iteration** — Failure isolation. If one notebook fails, others still succeed.
3. **+5 buffer** — Extra iterations for retry on failed notebooks.
4. **Homepage re-entry guaranteed by handler** — `ensureHomepage()` after each iteration.
5. **Agent prompts**: TBD after spike — either `.md` config files or handler-hardcoded.

### Known risks (spike required)

1. **Duplicate notebook names**: `findElementByText` hits first match. May click wrong notebook. Mitigation: check if returned URL is already in objectList → skip/retry.
2. **Click reorder**: After visiting a notebook and returning to homepage, the visited notebook moves to the top. This may actually help disambiguation — already-visited notebooks stack at top, next `findElementByText` hits the unvisited one.
3. **Script reliability**: Single-notebook script (find → click → get URL → back) needs real-world validation.
4. **Homepage scroll position reset**: After navigating back to homepage, scroll position resets to top. For notebooks that were only visible after scrolling in Phase 1, `findElementByText` may not find them without re-scrolling. Mitigation options: (a) rely on click reorder (visited notebooks move to top, unvisited ones may shift up naturally), (b) add scroll-to-target logic in script if `findElementByText` returns null.

### Spike plan

Before implementing `scriptedGetNotebookUrl`:
1. Use existing `findElementByText` on homepage to find a notebook by name
2. Test: click → navigate → get URL → back to homepage
3. Test: duplicate name scenario (if available)
4. Confirm DOM state after returning to homepage

### Verification

- `npm test` — all tests pass after agent mode removal
- `npm run build` — compiles
- After spike + implementation: `/test-real` scan-notebooks E2E + ISO Browser verification

---

## S3: remove_notebook → unregister_notebook Bug Fix

**Goal**: Fix semantic inconsistency. Make the operation a pure local registry cleanup.

### Current behavior (bug)

`remove_notebook` in `notebook-tools.ts:570-609` does:
1. Closes browser tab for the alias (runtime side effect — **should not do this**)
2. Removes from state registry (correct)
3. Does NOT clean up per-notebook cache (inconsistent)

### Expected behavior

`unregister_notebook`:
1. Remove registry entry from state
2. Clear default notebook reference if it matches
3. Clean up per-notebook cache (`sources.json`, `artifacts.json`, `operations.json`)
4. Do NOT close browser tabs
5. Do NOT affect remote NotebookLM data

### Changes

| File | Change |
|------|--------|
| `src/daemon/notebook-tools.ts` | Rename tool `remove_notebook` → `unregister_notebook`. Remove tab close logic (lines 592-597). Add cache cleanup call. Update description. |
| `src/state/cache-manager.ts` | Add `clearNotebook(alias)` method — deletes `<cacheDir>/<alias>/` directory via `rm(dir, { recursive: true })` |
| `src/state/state-manager.ts` | No change (existing `removeNotebook` is correct) |
| `tests/unit/daemon/notebook-tools.test.ts` | Update tool name `remove_notebook` → `unregister_notebook` |
| `tests/contract/mcp-tools/notebook-mgmt.test.ts` | Update tool name references |
| `tests/integration/daemon/notebook-crud.test.ts` | Update tool name references |

**Note**: `tests/unit/state/state-manager.test.ts` is NOT affected — it tests `StateManager.removeNotebook()` method which is unchanged.

### Related: rename_notebook cache orphan

`rename_notebook` (notebook-tools.ts:542) calls `stateManager.removeNotebook(oldAlias)` internally but does not clean up cache for the old alias. After S3, this leaves orphaned cache directories when notebooks are renamed. Fix: add `cacheManager.renameNotebook(oldAlias, newAlias)` or `clearNotebook(oldAlias)` in the rename handler. Track as follow-up if not addressed in S3.

### New description

```
"Remove a notebook from the local registry and clean up cached data. Does not affect the remote NotebookLM notebook or browser state."
```

### Verification

- `npm test` — updated tests pass
- Manual: unregister a notebook → confirm tab stays open, cache dir deleted, registry entry gone

---

## Execution Order

```
S1 (shared helpers)  — independent, zero risk
S3 (unregister bug)  — independent, zero risk
S2a (remove agent mode) — independent, subtractive
S2 spike — depends on S2a being done (clean pipeline)
S2b+c (scan_notebooks MCP tool) — depends on spike results
```

S1, S3, S2a can be done in parallel. S2 spike blocks S2b+c.

## Decisions Log

| Decision | Choice | Reason |
|----------|--------|--------|
| Keep or delete recovery-session.ts? | **Keep** | Two session types have distinct semantics. Mode switching is a last resort, not needed here. |
| Pipeline memory (Map\<string, string\>)? | **No** | Over-engineering for 2-3 step pipelines. Direct result passing is sufficient. |
| Tool filtering by agentConfig.tools? | **No** | Specialized app, not framework. All browser tools always available. |
| submitResultSchema config? | **No** | Each session type owns its schema. No mode switching. |
| systemMessage mode for recovery? | **"replace"** | "append" was a bug. Recovery prompt is a complete recipe, no need for SDK defaults. |
| Agent mode in pipeline? | **Remove** | Planner shouldn't pick agent mode. Agent-based operations get dedicated MCP tools. |
| scan_notebooks Phase 2? | **Script + recovery (G2)** | Happy path = 0 LLM. Reuses existing infrastructure. |
| Cache on unregister? | **Clean up** | Notebook may be deleted on remote. Orphan cache is useless. |
