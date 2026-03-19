# Runner Registry + register_all_notebooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce runner registry dispatch so `register_all_notebooks` routes through the formal scheduler → dispatcher → runner chain instead of bypassing it from the MCP tool layer.

**Architecture:** Add `runner` + `runnerInput` to AsyncTask. Refactor `createRunTask()` into a dispatcher that looks up runners from a registry. Extract current pipeline logic into `runPipelineTask`. Create `scanAllNotebooks` runner in `src/agent/scan-notebooks-runner.ts`. Collapse `register_all_notebooks` MCP tool to a thin submitter. Remove `scriptedGetNotebookUrl` and `scriptedExtractNotebookNames` from SCRIPT_REGISTRY/CATALOG (runner-internal only).

**Tech Stack:** TypeScript 5.x, `@github/copilot-sdk`, `puppeteer-core`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-runner-registry-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `runner` + `runnerInput` to `AsyncTask` |
| `src/state/task-store.ts` | Modify | Accept + persist new fields in `create()` |
| `src/daemon/scheduler.ts` | Modify | Pass new fields through `submit()` |
| `src/daemon/index.ts` | Modify | Refactor `createRunTask` into dispatcher + `runPipelineTask` |
| `src/agent/scan-notebooks-runner.ts` | **Create** | `scanAllNotebooks` runner |
| `src/scripts/operations.ts` | Modify | Add `scriptedExtractNotebookNames` |
| `src/scripts/index.ts` | Modify | Remove `getNotebookUrl` from REGISTRY/CATALOG |
| `src/agent/session-runner.ts` | Modify | Remove `notebookName` from Planner schema |
| `src/daemon/notebook-tools.ts` | Modify | Collapse `register_all_notebooks` to submitter, remove `generateAlias`/`deduplicateAlias`/inline orchestration |
| `tests/unit/state/task-store.test.ts` | Modify | Test new fields |
| `tests/unit/daemon/scheduler.test.ts` | Modify | Test `runner` passthrough |
| `tests/unit/daemon/index.test.ts` | Modify | Test dispatcher + unknown runner |
| `tests/unit/scripts/index.test.ts` | Modify | Update operation count (9 → 8) |
| `tests/unit/agent/scan-notebooks-runner.test.ts` | **Create** | Runner unit tests |

---

### Task 1: AsyncTask model — add `runner` + `runnerInput`

**Files:**
- Modify: `src/shared/types.ts:125-137`
- Modify: `src/state/task-store.ts:51-79`
- Test: `tests/unit/state/task-store.test.ts`

- [ ] **Step 1: Write failing test — TaskStore creates task with runner field**

```typescript
// tests/unit/state/task-store.test.ts — add to existing describe
it("creates task with runner and runnerInput fields", async () => {
  const task = await store.create({
    notebookAlias: "nb",
    command: "test",
    runner: "scanAllNotebooks",
    runnerInput: { foo: "bar" },
  });
  expect(task.runner).toBe("scanAllNotebooks");
  expect(task.runnerInput).toEqual({ foo: "bar" });
});

it("defaults runner to 'pipeline' when omitted", async () => {
  const task = await store.create({
    notebookAlias: "nb",
    command: "test",
  });
  expect(task.runner).toBe("pipeline");
  expect(task.runnerInput).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/state/task-store.test.ts -t "runner"`
Expected: FAIL — `runner` property does not exist on AsyncTask

- [ ] **Step 3: Add fields to AsyncTask interface**

In `src/shared/types.ts`, add after `notebookAlias`:
```typescript
export interface AsyncTask {
  taskId: string;
  notebookAlias: string;
  runner: string;                              // "pipeline" | "scanAllNotebooks"
  runnerInput: Record<string, unknown> | null;
  command: string;
  // ... rest unchanged
}
```

- [ ] **Step 4: Update TaskStore.create() params and defaults**

In `src/state/task-store.ts`, update `create()`:
```typescript
async create(params: {
  notebookAlias: string;
  command: string;
  context?: string;
  runner?: string;
  runnerInput?: Record<string, unknown>;
}): Promise<AsyncTask> {
  // ... existing setup ...
  const task: AsyncTask = {
    taskId,
    notebookAlias: params.notebookAlias,
    runner: params.runner ?? "pipeline",
    runnerInput: params.runnerInput ?? null,
    command: params.command,
    // ... rest unchanged
  };
```

- [ ] **Step 5: Fix any existing test fixtures that construct AsyncTask literals**

Grep for `taskId:` + `notebookAlias:` in test files. Add `runner: "pipeline"`, `runnerInput: null` to any inline AsyncTask objects. Files to check:
- `tests/unit/notification/notifier.test.ts`
- `tests/contract/mcp-tools/get-status.test.ts`
- `tests/unit/agent/hooks.test.ts`
- `tests/integration/mcp/notification.test.ts`

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: all pass (701+)

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/state/task-store.ts tests/
git commit -m "feat: add runner + runnerInput to AsyncTask model"
```

---

### Task 2: Scheduler — pass `runner` through `submit()`

**Files:**
- Modify: `src/daemon/scheduler.ts:80-115`
- Test: `tests/unit/daemon/scheduler.test.ts`

- [ ] **Step 1: Write failing test — submit passes runner to taskStore.create**

```typescript
it("passes runner and runnerInput to task store", async () => {
  const task = await scheduler.submit({
    notebookAlias: "nb",
    command: "test",
    runner: "scanAllNotebooks",
    runnerInput: { foo: "bar" },
  });
  expect(task.runner).toBe("scanAllNotebooks");
  expect(task.runnerInput).toEqual({ foo: "bar" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/daemon/scheduler.test.ts -t "runner"`
Expected: FAIL — `runner` not accepted by submit()

- [ ] **Step 3: Update Scheduler.submit() to accept and pass runner fields**

In `src/daemon/scheduler.ts`, update `submit()` params:
```typescript
async submit(params: {
  notebookAlias: string;
  command: string;
  context?: string;
  runner?: string;
  runnerInput?: Record<string, unknown>;
}): Promise<AsyncTask> {
  // ... existing checks ...
  const task = await this.taskStore.create({
    notebookAlias: params.notebookAlias,
    command: params.command,
    context: params.context,
    runner: params.runner,
    runnerInput: params.runnerInput,
  });
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/daemon/scheduler.ts tests/unit/daemon/scheduler.test.ts
git commit -m "feat: Scheduler.submit() accepts runner + runnerInput"
```

---

### Task 3: Dispatcher — refactor `createRunTask` into registry dispatch

**Files:**
- Modify: `src/daemon/index.ts:99-233`
- Test: `tests/unit/daemon/index.test.ts`

- [ ] **Step 1: Write failing test — unknown runner returns error**

```typescript
it("returns error for unknown runner", async () => {
  // Create a task with runner: "nonexistent" and verify createRunTask returns failure
  const task = createMockTask({ runner: "nonexistent" });
  const result = await runTask(task);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Unknown runner");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/daemon/index.test.ts -t "unknown runner"`
Expected: FAIL — current code doesn't check `task.runner`

- [ ] **Step 3: Extract `runPipelineTask` from `createRunTask` closure**

Refactor `src/daemon/index.ts`:
1. Define `TaskRunner` type (internal):
```typescript
type TaskRunner = (
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
) => Promise<SchedulerSessionResult>;
```

2. Extract pipeline logic (lines 142-216) into `runPipelineTask`:
```typescript
async function runPipelineTask(
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
): Promise<SchedulerSessionResult> {
  const { copilotClient, networkGate, cacheManager, uiMap, locale } = deps;

  // Pre-navigate check (current lines 142-149)
  const isHomepage = task.notebookAlias === "__homepage__";
  const currentUrl = tabHandle.page.url();
  const targetUrl = tabHandle.url;
  if (!isHomepage && !currentUrl.startsWith(targetUrl)) {
    await tabHandle.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Build tools (current line 152-155)
  const tools = buildToolsForTab(tabHandle, task.notebookAlias, {
    networkGate, cacheManager,
  });

  // Run pipeline (current lines 158-171)
  const result = await runPipeline(
    { client: copilotClient, tools, cdpSession: tabHandle.cdpSession,
      page: tabHandle.page, uiMap, locale,
      notebookAlias: task.notebookAlias, taskId: task.taskId, networkGate },
    task.command,
  );

  return {
    success: result.success,
    result: result.result as object | undefined,
    error: result.error
      ?? (result.rejected ? `Rejected (${result.rejectionCategory}): ${result.rejectionReason}` : undefined),
  };
}
```

3. Export `RunTaskDeps` so runners can type their `deps` param:
```typescript
export interface RunTaskDeps { /* existing fields unchanged */ }
```

4. Build runner registry:
```typescript
const RUNNER_REGISTRY: Record<string, TaskRunner> = {
  pipeline: runPipelineTask,
  // scanAllNotebooks: added in Task 6
};
```

4. Rewrite `createRunTask` as dispatcher:
```typescript
function createRunTask(deps: RunTaskDeps) {
  const log = logger.child({ module: "daemon:runTask" });

  return async (task: AsyncTask): Promise<SchedulerSessionResult> => {
    const startTime = Date.now();
    const runnerName = task.runner ?? "pipeline";
    const runner = RUNNER_REGISTRY[runnerName];

    if (!runner) {
      return { success: false, error: `Unknown runner: ${runnerName}` };
    }

    // 1. Resolve URL
    const isHomepage = task.notebookAlias === "__homepage__";
    const targetUrl = isHomepage
      ? NOTEBOOKLM_HOMEPAGE
      : (await deps.stateManager.getNotebook(task.notebookAlias))?.url;
    if (!targetUrl) {
      return { success: false, error: `Notebook not found: ${task.notebookAlias}` };
    }

    // 2. Acquire tab (unified resource management)
    let tabHandle;
    try {
      tabHandle = await deps.tabManager.acquireTab({ notebookAlias: task.notebookAlias, url: targetUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Tab pool at capacity: ${msg}` };
    }

    try {
      // 3. Viewport contract
      await tabHandle.cdpSession.send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false,
      });

      // 4. Dispatch to runner
      const result = await runner(task, tabHandle, deps);

      // 5. Operation log (T096)
      const durationMs = Date.now() - startTime;
      try {
        const now = new Date().toISOString();
        await deps.cacheManager.addOperation({
          id: randomUUID(), taskId: task.taskId, notebookAlias: task.notebookAlias,
          command: task.command, actionType: inferActionType(task.command),
          status: result.success ? "success" : "failed",
          resultSummary: result.success
            ? (typeof result.result === "object" && result.result !== null
                ? JSON.stringify(result.result).slice(0, 200) : "completed")
            : (result.error ?? "unknown error"),
          startedAt: new Date(startTime).toISOString(), completedAt: now, durationMs,
        });
      } catch { /* non-critical */ }

      return result;
    } finally {
      // 6. Release tab + cleanup
      await deps.tabManager.releaseTab(tabHandle.tabId);
      try {
        if (existsSync(TMP_DIR)) {
          for (const f of readdirSync(TMP_DIR)) unlinkSync(`${TMP_DIR}/${f}`);
        }
      } catch { /* non-critical */ }
    }
  };
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass — existing pipeline behavior unchanged, unknown runner test passes

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts tests/unit/daemon/index.test.ts
git commit -m "refactor: createRunTask → runner registry dispatcher"
```

---

### Task 4: Script cleanup — remove runner-internal scripts from REGISTRY/CATALOG

**Files:**
- Modify: `src/scripts/index.ts:19,209,268`
- Modify: `src/agent/session-runner.ts:331,344`
- Test: `tests/unit/scripts/index.test.ts`

- [ ] **Step 1: Remove `getNotebookUrl` from SCRIPT_REGISTRY and SCRIPT_CATALOG**

In `src/scripts/index.ts`:
- Remove import: `scriptedGetNotebookUrl,` (line 19)
- Remove from `SCRIPT_REGISTRY`: `getNotebookUrl: (ctx, p) => ...` (line 209)
- Remove from `SCRIPT_CATALOG`: `{ operation: "getNotebookUrl", ... }` (line 268)

- [ ] **Step 2: Remove `notebookName` from Planner schema**

In `src/agent/session-runner.ts`:
- Remove: `notebookName: z.string().optional()...` (line 331)
- Remove from handler type: `notebookName?: string` (line 333)
- Remove from params mapping: `if (s.notebookName) params.notebookName = s.notebookName;` (line 344)

- [ ] **Step 3: Update test — operation count 9 → 8**

In `tests/unit/scripts/index.test.ts`:
```typescript
it("returns 8 operations (destructive ops disabled)", () => {
  expect(getAvailableOperations()).toHaveLength(8);
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/scripts/index.ts src/agent/session-runner.ts tests/unit/scripts/index.test.ts
git commit -m "refactor: remove runner-internal scripts from REGISTRY/CATALOG"
```

---

### Task 5: New script — `scriptedExtractNotebookNames`

**Files:**
- Modify: `src/scripts/operations.ts`
- No REGISTRY/CATALOG entry (runner-internal)

- [ ] **Step 1: Add `scriptedExtractNotebookNames` to `operations.ts`**

After `scriptedGetNotebookUrl`, add:
```typescript
// =============================================================================
// 10. scriptedExtractNotebookNames — extract all notebook names from homepage
// =============================================================================

export async function scriptedExtractNotebookNames(
  ctx: ScriptContext,
): Promise<ScriptResult> {
  const { page, helpers } = ctx;
  const log: ScriptLogEntry[] = [];
  const t0 = Date.now();
  const fail = makeFail("extractNotebookNames", log, t0);

  try {
    // Step 0: Ensure homepage + wait for rows to stabilize
    const homeOk = await helpers.ensureHomepage(ctx, log, t0);
    if (!homeOk) return fail(0, "ensure_homepage", "Could not navigate to homepage");

    const stepStart0 = Date.now();
    const rowCount = await waitForRowsStable(page);
    log.push(createLogEntry(0, "rows_stable", "ok",
      `${rowCount} rows rendered in ${Date.now() - stepStart0}ms`, stepStart0));

    // Step 1: Extract names from .project-table-title
    const stepStart = Date.now();
    const names = await page.evaluate(`(() => {
      const titles = document.querySelectorAll('.project-table-title');
      return Array.from(titles).map(t => ({
        name: t.getAttribute('title') || (t.textContent || '').trim(),
      }));
    })()`) as Array<{ name: string }>;

    log.push(createLogEntry(1, "extract_names", "ok",
      `Extracted ${names.length} notebook names`, stepStart));

    return makeSuccess("extractNotebookNames", log, t0, JSON.stringify(names));
  } catch (err) {
    return fail(1, "exception", err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success

- [ ] **Step 3: Run all tests (no new tests needed — this is runner-internal, tested via runner tests in Task 7)**

Run: `npm test`
Expected: all pass, operation count unchanged (not in REGISTRY)

- [ ] **Step 4: Commit**

```bash
git add src/scripts/operations.ts
git commit -m "feat: scriptedExtractNotebookNames — runner-internal homepage scraper"
```

---

### Task 6: scan-notebooks-runner.ts

**Files:**
- Create: `src/agent/scan-notebooks-runner.ts`

- [ ] **Step 1: Create the runner file**

```typescript
/**
 * scanAllNotebooks runner — batch-scan homepage notebooks and register them.
 *
 * Formal runner dispatched via RUNNER_REGISTRY. Receives tabHandle from
 * dispatcher (already acquired, viewport set). Does NOT manage tab lifecycle.
 *
 * Flow: extractNotebookNames → per-notebook getNotebookUrl (script + recovery) → register
 */

import type { CDPSession, Page } from "puppeteer-core";
import type { TabHandle, AsyncTask, NotebookEntry } from "../shared/types.js";
import type { RunTaskDeps } from "../daemon/index.js";
import { buildScriptContext } from "./session-runner.js";
import { runRecoverySession } from "./recovery-session.js";
import { saveRepairLog } from "./repair-log.js";
import { scriptedExtractNotebookNames, scriptedGetNotebookUrl } from "../scripts/operations.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ module: "scan-notebooks-runner" });

// ---------------------------------------------------------------------------
// Alias generation (moved from notebook-tools.ts)
// ---------------------------------------------------------------------------

function generateAlias(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "notebook"
  );
}

function deduplicateAlias(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 50);
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 50);
}

const normalizeUrl = (u: string) =>
  u.split("?")[0].split("#")[0].replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ScanAllNotebooksResult {
  success: boolean;
  total: number;
  registered: Array<{ alias: string; url: string; title: string }>;
  skipped: Array<{ name: string; reason: string }>;
  recovered: Array<{ alias: string; url: string; title: string }>;
  errorReport: {
    scriptFailures: number;
    recoveryAttempts: number;
    recoverySuccesses: number;
    finalFailures: Array<{
      name: string;
      scriptStep: number;
      scriptError: string;
      recoveryError: string;
      repairLogPath: string;
    }>;
  };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Runner entry point
// ---------------------------------------------------------------------------

// RunTaskDeps type is defined in index.ts and passed by the dispatcher.
// This runner only uses a subset, but accepts the full type for registry compatibility.
export async function runScanAllNotebooksTask(
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
): Promise<{ success: boolean; result?: object; error?: string }> {
  const t0 = Date.now();

  // 1. Build ScriptContext (runner-internal, not leaked to tool layer)
  const ctx = buildScriptContext({
    cdpSession: tabHandle.cdpSession,
    page: tabHandle.page,
    uiMap: deps.uiMap,
  });

  // 2. Extract notebook names
  const extractResult = await scriptedExtractNotebookNames(ctx);
  if (extractResult.status !== "success" || !extractResult.result) {
    return { success: false, error: `Name extraction failed: ${extractResult.result}` };
  }

  const names = JSON.parse(extractResult.result) as Array<{ name: string }>;
  if (names.length === 0) {
    const result: ScanAllNotebooksResult = {
      success: true, total: 0, registered: [], skipped: [],
      recovered: [], errorReport: { scriptFailures: 0, recoveryAttempts: 0,
        recoverySuccesses: 0, finalFailures: [] }, durationMs: Date.now() - t0,
    };
    return { success: true, result };
  }

  log.info("Extracted notebook names", { count: names.length });

  // 3. Load existing state for dedup
  const state = await deps.stateManager.load();
  const existingUrls = new Set(
    Object.values(state.notebooks).map((nb) => normalizeUrl(nb.url)),
  );
  const existingAliases = new Set(Object.keys(state.notebooks));

  // 4. Per-notebook loop: script → immediate recovery on fail
  const registered: ScanAllNotebooksResult["registered"] = [];
  const skipped: ScanAllNotebooksResult["skipped"] = [];
  const recovered: ScanAllNotebooksResult["recovered"] = [];
  const errorReport: ScanAllNotebooksResult["errorReport"] = {
    scriptFailures: 0, recoveryAttempts: 0, recoverySuccesses: 0, finalFailures: [],
  };

  for (const { name } of names) {
    if (!name) {
      skipped.push({ name: "(empty)", reason: "empty name" });
      continue;
    }

    // Script attempt
    const scriptResult = await scriptedGetNotebookUrl(ctx, name);

    if (scriptResult.status === "success" && scriptResult.result) {
      const { url } = JSON.parse(scriptResult.result) as { name: string; url: string };
      const normalized = normalizeUrl(url);

      if (existingUrls.has(normalized)) {
        skipped.push({ name, reason: "already registered" });
        continue;
      }

      const alias = deduplicateAlias(generateAlias(name), existingAliases);
      existingAliases.add(alias);
      existingUrls.add(normalized);

      const now = new Date().toISOString();
      const entry: NotebookEntry = {
        alias, url: normalized, title: name, description: "",
        status: "ready", registeredAt: now, lastAccessedAt: now, sourceCount: 0,
      };
      await deps.stateManager.addNotebook(entry);
      registered.push({ alias, url: normalized, title: name });
      continue;
    }

    // Script failed → immediate recovery
    errorReport.scriptFailures++;
    log.warn("Script failed, attempting recovery", { name, step: scriptResult.failedAtStep });

    errorReport.recoveryAttempts++;
    try {
      const recoveryResult = await runRecoverySession({
        client: deps.copilotClient,
        cdp: tabHandle.cdpSession,
        page: tabHandle.page,
        scriptResult,
        goal: `Click notebook "${name}" to navigate to it and capture its URL, then go back to homepage.`,
      });

      if (recoveryResult.success) {
        // Browser state is the authority — read URL directly
        const currentUrl = tabHandle.page.url();
        if (currentUrl.includes("/notebook/")) {
          const normalized = normalizeUrl(currentUrl);

          if (!existingUrls.has(normalized)) {
            const alias = deduplicateAlias(generateAlias(name), existingAliases);
            existingAliases.add(alias);
            existingUrls.add(normalized);

            const now = new Date().toISOString();
            const entry: NotebookEntry = {
              alias, url: normalized, title: name, description: "",
              status: "ready", registeredAt: now, lastAccessedAt: now, sourceCount: 0,
            };
            await deps.stateManager.addNotebook(entry);
            recovered.push({ alias, url: normalized, title: name });
          } else {
            skipped.push({ name, reason: "already registered (found via recovery)" });
          }

          // Go back to homepage for next iteration
          await tabHandle.page.goBack();
          await new Promise((r) => setTimeout(r, 2000));
        }
        errorReport.recoverySuccesses++;
      } else {
        // Recovery also failed
        const repairLogPath = saveRepairLog(scriptResult, deps.uiMap, recoveryResult);

        errorReport.finalFailures.push({
          name,
          scriptStep: scriptResult.failedAtStep ?? -1,
          scriptError: scriptResult.log.find(l => l.status === "fail")?.detail ?? "unknown",
          recoveryError: recoveryResult.analysis ?? "no analysis",
          repairLogPath: repairLogPath ?? "",
        });
      }
    } catch (recErr) {
      const msg = recErr instanceof Error ? recErr.message : String(recErr);
      errorReport.finalFailures.push({
        name, scriptStep: scriptResult.failedAtStep ?? -1,
        scriptError: scriptResult.log.find(l => l.status === "fail")?.detail ?? "unknown",
        recoveryError: `Recovery exception: ${msg}`, repairLogPath: "",
      });
    }
  }

  const result: ScanAllNotebooksResult = {
    success: true,
    total: names.length,
    registered, skipped, recovered,
    errorReport,
    durationMs: Date.now() - t0,
  };

  log.info("Batch scan complete", {
    total: names.length, registered: registered.length,
    skipped: skipped.length, recovered: recovered.length,
    failed: errorReport.finalFailures.length,
  });

  return { success: true, result };
}
```

- [ ] **Step 2: Register in RUNNER_REGISTRY**

In `src/daemon/index.ts`, add import and registry entry:
```typescript
import { runScanAllNotebooksTask } from "../agent/scan-notebooks-runner.js";

const RUNNER_REGISTRY: Record<string, TaskRunner> = {
  pipeline: runPipelineTask,
  scanAllNotebooks: runScanAllNotebooksTask,
};
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add src/agent/scan-notebooks-runner.ts src/daemon/index.ts
git commit -m "feat: scanAllNotebooks runner — formal runner with per-notebook recovery"
```

---

### Task 7: Runner unit tests

**Files:**
- Create: `tests/unit/agent/scan-notebooks-runner.test.ts`

- [ ] **Step 1: Write unit tests for the runner**

Test cases:
1. Happy path — extract 3 names, all succeed, returns 3 registered
2. URL dedup — 2 names, 1 already registered → 1 registered + 1 skipped
3. Script failure + recovery success → appears in `recovered`
4. Script failure + recovery failure → appears in `errorReport.finalFailures`
5. Empty name list → returns success with total: 0
6. Alias dedup — 2 Chinese names both generate "notebook" → "notebook" + "notebook-2"

Use mocks for `buildScriptContext`, `scriptedExtractNotebookNames`, `scriptedGetNotebookUrl`, `runRecoverySession`, `stateManager`.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/unit/agent/scan-notebooks-runner.test.ts`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/agent/scan-notebooks-runner.test.ts
git commit -m "test: scan-notebooks-runner unit tests — happy path, dedup, recovery"
```

---

### Task 8: notebook-tools.ts — collapse to submitter

**Files:**
- Modify: `src/daemon/notebook-tools.ts:385-580`

- [ ] **Step 1: Replace `register_all_notebooks` implementation**

Delete the entire `registerAddAllNotebooks` function body (lines ~385-580) and replace with submitter:

```typescript
function registerAddAllNotebooks(
  server: NbctlMcpServer,
  deps: NotebookToolDeps,
): void {
  server.registerTool(
    "register_all_notebooks",
    {
      description:
        "Batch-register all notebooks in the NotebookLM account. " +
        "Scans the homepage, clicks each notebook to capture its URL, " +
        "and registers it. Skips already-registered notebooks. " +
        "Uses per-notebook recovery on script failures.",
    },
    async () => {
      try {
        if (!deps.scheduler || !deps.taskStore) {
          return errorResult("register_all_notebooks requires scheduler");
        }

        const task = await deps.scheduler.submit({
          notebookAlias: "__homepage__",
          command: "register_all_notebooks",
          runner: "scanAllNotebooks",
        });

        await deps.scheduler.waitForTask(task.taskId);

        const completed = await deps.taskStore.get(task.taskId);
        if (!completed || completed.status !== "completed") {
          return errorResult(completed?.error ?? "Task failed");
        }

        return jsonResult(completed.result ?? { success: false });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message);
      }
    },
  );
}
```

- [ ] **Step 2: Remove dead code from notebook-tools.ts**

Delete from `notebook-tools.ts`:
- `generateAlias()` function (moved to runner)
- `deduplicateAlias()` function (moved to runner)
- Any remaining imports only used by the old orchestration (`resolveLocale`, `loadUIMap`, `buildScriptContext`, `scriptedGetNotebookUrl`)

- [ ] **Step 3: Remove dynamic imports of session-runner and scripts from notebook-tools.ts**

Verify no `await import("../agent/session-runner.js")` or `await import("../scripts/operations.js")` remains.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: success

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/daemon/notebook-tools.ts
git commit -m "refactor: register_all_notebooks → thin submitter, no execution"
```

---

### Task 9: Remove duplicate `waitForRowsStable` from notebook-tools.ts

**Files:**
- Modify: `src/daemon/notebook-tools.ts` (verify no inline polling remains)

- [ ] **Step 1: Grep for any remaining inline row-count polling in notebook-tools.ts**

Run: `grep -n "tr\[tabindex\]\|waitForRows\|stableRounds" src/daemon/notebook-tools.ts`
Expected: 0 matches (all removed in Task 8)

- [ ] **Step 2: If any remain, delete them**

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 4: Commit (if changes made)**

```bash
git add src/daemon/notebook-tools.ts
git commit -m "cleanup: remove duplicate waitForRowsStable from notebook-tools"
```

---

### Task 10: Integration verification — real daemon test

**Files:** none (runtime verification)

- [ ] **Step 1: Clear existing notebook registrations for clean test**

Back up `~/.nbctl/state.json`, then clear `notebooks: {}`.

- [ ] **Step 2: Rebuild and restart daemon**

```bash
npm run build
# kill existing daemon
pkill -f "tsx src/daemon/launcher"
npx tsx src/daemon/launcher.ts &
```

- [ ] **Step 3: Call register_all_notebooks via MCP**

Use raw HTTP or reconnect MCP client. Verify:
- Task goes through scheduler (check daemon log for `task submitted`, `task started`)
- Runner dispatched as `scanAllNotebooks` (check log for runner name)
- Result returns with `registered: N, skipped: 0, failed: 0`

- [ ] **Step 4: Call again — verify dedup**

Expect: `registered: 0, skipped: N, failed: 0`

- [ ] **Step 5: ISO browser independent verification**

Open ISO browser, navigate to 2-3 registered notebook URLs, verify titles match.

- [ ] **Step 6: Commit any fixes found during integration**
