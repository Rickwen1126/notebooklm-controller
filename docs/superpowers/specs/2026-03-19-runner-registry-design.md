# Runner Registry + register_all_notebooks Refactoring

## Problem

`register_all_notebooks` 在 MCP tool layer (`notebook-tools.ts`) 直接做 execution orchestration：acquireTab、setViewport、buildScriptContext、DOM query、script loop、state writeback。這繞過了 scheduler → dispatcher → runner 的正式執行鏈，同時把 runner 內部的 `buildScriptContext` export 給外層手工組裝，破壞 execution context ownership。

**違反清單：**
1. MCP tool layer 直接做 execution orchestration
2. 繞過 scheduler 與正式 task lifecycle（queue、cancel、waitForTask、health gate）
3. 繞過 runner dispatch
4. 繞過 Recovery agent 能力（script fail 直接 skip）
5. 將 runner 內部 execution context export 給外層手工注入
6. 重複實作 UI automation 邏輯（`waitForRowsStable` 寫兩次）
7. DOM query inline 在 tool handler，不在 `src/scripts/`

## Goal

1. 引入 `runner: string` + `runnerInput` 到 task model
2. `createRunTask()` 變成 runner registry dispatcher
3. `register_all_notebooks` 退回 submitter（validate → submit → wait → format）
4. 新建 `scanAllNotebooks` runner 作為正式特化 runner
5. 所有 DOM 操作搬進 `src/scripts/operations.ts` 作為正式 scripted operation
6. `buildScriptContext` 保留 export 但只限 runner family 使用

## Non-Goals

- 不修 `create_notebook` 的類似問題（existing tech debt，不在 scope）
- 不建 `buildScriptContext` 獨立 module（等 runner family 長到 3+ 再抽）
- 不實作 script-repair 能力（A 方案），只預留 error report 結構

---

## Section 1: Task Model — `runner` + `runnerInput`

```typescript
// src/shared/types.ts
export interface AsyncTask {
  taskId: string;
  notebookAlias: string;
  runner: string;                              // NEW: "pipeline" | "scanAllNotebooks"
  runnerInput: Record<string, unknown> | null;  // NEW: structured input for specialized runners
  command: string;
  context: string | null;
  status: TaskStatus;
  result: object | null;
  error: string | null;
  errorScreenshot: string | null;
  history: TaskStatusChange[];
  createdAt: string;
}
```

- `runner` 預設 `"pipeline"`（backward compatible）
- `runnerInput` 預設 `null`
- 影響範圍：`TaskStore.create()`、`Scheduler.submit()`、task JSON 持久化

**`Scheduler.submit()` 新簽名：**
```typescript
async submit(params: {
  notebookAlias: string;
  command: string;
  context?: string;
  runner?: string;                          // NEW — defaults to "pipeline"
  runnerInput?: Record<string, unknown>;    // NEW — defaults to null
}): Promise<AsyncTask>
```

**`TaskStore.create()` 對應更新：**
接受並透傳 `runner` + `runnerInput`，寫入 task JSON。
預設值在 `create()` 裡補：`runner ?? "pipeline"`、`runnerInput ?? null`。

**測試影響：**
現有測試中構造 `AsyncTask` fixture 的地方需補 `runner: "pipeline"`（或依賴 `TaskStore.create()` 預設值）。`Scheduler` 測試不受影響 — `SchedulerDeps.runTask` 簽名不變。

## Section 2: Runner Registry Dispatch

```typescript
// src/daemon/index.ts

type TaskRunner = (
  task: AsyncTask,
  tabHandle: TabHandle,
  deps: RunTaskDeps,
) => Promise<SchedulerSessionResult>;

const RUNNER_REGISTRY: Record<string, TaskRunner> = {
  pipeline: runPipelineTask,
  scanAllNotebooks: runScanAllNotebooksTask,
};
```

**Scheduler 介面不變：**
`SchedulerDeps.runTask` 維持 `(task: AsyncTask) => Promise<SessionResult>`。所有 runner dispatch 邏輯封裝在 `createRunTask()` 閉包內。`TaskRunner` 是 dispatcher 內部型別，Scheduler 不知道它的存在。

**Dispatcher 職責（`createRunTask` 重構後）：**
1. 查 `task.runner`，從 registry 找 runner（unknown → fail fast）
2. Resolve URL：`__homepage__` → `NOTEBOOKLM_HOMEPAGE`，其他 → state 查 notebook URL
3. `tabManager.acquireTab()` — 統一 tab 資源管理
4. `setDeviceMetricsOverride(1920×1080)` — 統一 viewport contract
5. 呼叫 runner，傳入 `(task, tabHandle, deps)`
6. Record `OperationLogEntry` via `cacheManager.addOperation()`（同現有 T096 行為）
7. `finally { tabManager.releaseTab() + cleanup TMP_DIR temp files }`

**Runner 不碰 tab lifecycle：**
Runner 拿到已準備好的 `tabHandle`，只操作 `tabHandle.page` / `tabHandle.cdpSession`。不 acquire，不 release。

**`runPipelineTask`：**
現有 `createRunTask` 裡面的邏輯（pre-navigate check → runPipeline），搬進 named function。Operation log 和 tab lifecycle 留在 dispatcher。

## Section 3: scan-notebooks-runner.ts

新檔案 `src/agent/scan-notebooks-runner.ts`。正式 runner，不是 MCP tool 內嵌流程。

### 職責

1. 從 dispatcher 拿到已準備好的 `tabHandle`
2. 內部建 ScriptContext（`buildScriptContext` 是 runner family 共用的 internal helper）
3. 呼叫 `scriptedExtractNotebookNames(ctx)` 萃取 notebook names
4. 逐本執行：script → fail? → 即時 recovery → 下一本
5. 成功的寫 `stateManager.addNotebook()`
6. 回傳結構化結果 + 錯誤報告

### 流程

```
tabHandle (from dispatcher)
    ↓
buildScriptContext(tabHandle.cdpSession, tabHandle.page, uiMap)
    ↓
scriptedExtractNotebookNames(ctx) → names[]
    ↓
for each name:
  ├─ scriptedGetNotebookUrl(ctx, name)
  ├─ success → extract URL from browser → stateManager.addNotebook() → registered[]
  ├─ skip (URL already exists) → skipped[]
  └─ fail → 立即 runRecoverySession()
       ├─ recovery success → extract URL from browser → recovered[]
       └─ recovery fail → finalFailed[] + saveRepairLog()
    ↓
return ScanAllNotebooksResult
```

**為什麼不做 batched/delayed recovery：**
Recovery agent 需要在首頁點擊 notebook，跟 script 做的事一樣。如果累積 5 本再批次 recovery，每次 recovery 都要先回首頁再找 notebook，連續 5 次 agent 操作首頁的失敗率遠高於一本一本各自 recovery。逐本即時 recovery 讓 agent 在 script 剛失敗的當下狀態（可能已經在首頁或已 scroll 到目標附近）嘗試修復，context 最新鮮、成功率最高。

### Recovery 銜接

每本失敗的 `scriptedGetNotebookUrl` 回傳 `ScriptResult`（含 `failedAtStep`, `failedSelector`, `log`）。這些直接餵進 `runRecoverySession()` — 跟 pipeline 裡 script fail 進 recovery 完全一樣。Recovery agent 拿到 screenshot + script log，用 browser tools 嘗試完成操作。

Recovery 需要 `CopilotClientSingleton`，透過 `deps.copilotClient` 取得（已在 `RunTaskDeps` 中）。呼叫方式：`runRecoverySession({ client: deps.copilotClient, cdp: tabHandle.cdpSession, page: tabHandle.page, ... })`。

### Recovery 結果權威來源

Recovery 成功後，結構化結果（URL）以 **browser state 為權威來源**：
- URL = `tabHandle.page.url()`（直接從瀏覽器讀）
- 不信任 agent 自然語言輸出作為結構化結果

Agent 的 recovery response 用於：
- 分析：什麼操作失敗、為什麼
- 補充說明：agent 觀察到的 UI 狀態
- Patch 建議：`suggestedPatch`（UIMap 修正建議）

這跟現有 `runRecoverySession` 的設計一致 — recovery result 裡的 `analysis` 和 `suggestedPatch` 是 metadata，不是操作結果。

### Scripted Operations — registry 與 catalog 分離

所有 UI automation primitive 集中在 `src/scripts/operations.ts`，runner 裡 0 行 DOM 操作。

**核心原則：script execution registry 與 planner-visible catalog 必須分離。**

- `SCRIPT_REGISTRY`（`index.ts`）= Planner 可 dispatch 的操作 + `runScript()` 路由
- `SCRIPT_CATALOG`（`index.ts`）= Planner system prompt 看到的操作清單
- Runner-internal scripts = 從 `operations.ts` 直接 import，**不進 SCRIPT_REGISTRY、不進 SCRIPT_CATALOG**

這兩者不綁定。一個 script 可以：
- 在 `operations.ts` 裡有實作（UI automation primitive）
- 被 runner 直接 import 呼叫
- 但不暴露給 Planner 或一般 agent

**`scriptedExtractNotebookNames`（新增）：**
- 住在 `operations.ts`，跟 `scriptedListNotebooks` 同級
- 用 `waitForRowsStable` + `.project-table-title[title]` query
- 回傳 `ScriptResult`，result 是 `JSON.stringify(names)`（`names: Array<{ name: string }>`）
- `sourceCount` 不萃取 — 現有 code 取出來也存 `0`，是 dead data
- **不進 `SCRIPT_REGISTRY`、不進 `SCRIPT_CATALOG`** — runner-internal operation

**`scriptedGetNotebookUrl`（已有）：**
- 保留在 `operations.ts`
- **保留在 `SCRIPT_REGISTRY` 和 `SCRIPT_CATALOG`** — 一般用途操作，Planner 可透過 `exec` dispatch（例如使用者說「get the URL for notebook named X」）
- scanAllNotebooks runner 也直接 import 呼叫（雙重用途：Planner-accessible + runner-internal）

**`generateAlias` + `deduplicateAlias` 遷移：**
從 `notebook-tools.ts` 搬到 `scan-notebooks-runner.ts`。`create_notebook` 有自己的 inline alias 生成（line 150-155），是 existing tech debt，不在此次統一 scope。

## Section 4: notebook-tools.ts — submitter only

`register_all_notebooks` 從 ~150 行 orchestrator 退回 ~20 行 submitter：

```typescript
async () => {
  // Submit
  const task = await deps.scheduler.submit({
    notebookAlias: "__homepage__",
    command: "register_all_notebooks",
    runner: "scanAllNotebooks",
  });

  // Wait
  await deps.scheduler.waitForTask(task.taskId);

  // Format result
  const completed = await deps.taskStore.get(task.taskId);
  if (!completed || completed.status !== "completed") {
    return errorResult(completed?.error ?? "Task failed");
  }
  return jsonResult(completed.result ?? { success: false });
}
```

不碰 tabManager、page、buildScriptContext、DOM query、stateManager.addNotebook。不 import session-runner 或 scripts。

## Section 5: buildScriptContext 邊界

- 保留在 `session-runner.ts`，保持 export
- **可以 import：** runner（`session-runner.ts`、`scan-notebooks-runner.ts`）
- **不可 import：** MCP tool layer（`notebook-tools.ts`、`exec-tools.ts`、`mcp-tools.ts`）
- 邊界由 convention + code review 守
- 不建獨立 module — 等 runner family 長到 3+ 再抽

## Section 6: 結果結構 + 錯誤報告

```typescript
interface ScanAllNotebooksResult {
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
```

- `recovered` 獨立列出不合併 `registered` — 使用者需要知道哪些靠 recovery 救回來的
- `errorReport.finalFailures` = 未來 script-repair (A 方案) 的 input

## `__homepage__` 語意

`__homepage__` 代表「操作對象是整個帳號」。碰巧映射到首頁 tab，但 URL 解析是 dispatcher 的事。

所有 homepage 操作（`createNotebook`、`scanAllNotebooks` 等）共用 `__homepage__` queue，序列化執行。這是有意的 — 並行的 homepage 操作會互相衝突。

如果未來 `__homepage__` 被濫用成「任何需要首頁 tab 的操作都塞進來」，那時再考慮拆分 queue domain。
