# G2 Script-first Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LLM Executor sessions with deterministic scripts. Happy path = 0 LLM. Failure = Recovery session (GPT-5-mini) completes task + logs repair data. Screenshots persisted for human verification.

**Architecture:** Planner LLM (gpt-4.1) parses NL → script function call (ctx injection, zero import) → (fail?) Recovery LLM (gpt-5-mini) completes + analyzes + patches. Scripts use CDP helpers + wait primitives + UIMap.

**Tech Stack:** TypeScript, puppeteer-core CDP, @github/copilot-sdk, zod, vitest

**Source of truth:** `spike/browser-capability/HANDOVER-v2.md` + `HANDOVER.md` Finding #58 + spike `.ts` files

---

## Key Decisions (confirmed with user)

1. **ExecutionStep** — 直接改 schema（`operation` + `params`），不新增 ScriptStep
2. **Agent Config `.md`** — 移除，不再被 Planner 或 Executor 使用
3. **測試策略** — 一次到位，不分段。最終驗收 = spike 等效 real test
4. **發布架構** — compiled core + editable scripts (ctx injection, 零 import) + editable UIMap JSON
5. **截圖持久化** — 每步存 `~/.nbctl/screenshots/`，real test 時人工視覺確認

---

## Critical Pitfalls (from HANDOVER-v2, must not forget)

1. **Viewport 800x600** — MUST set `Emulation.setDeviceMetricsOverride`（不是 `setViewport`）。Mobile layout 會壞掉所有 script。
2. **Menu items 是 plain BUTTON** — 不是 `[role=menuitem]`。用 `findElementByText()` 等待。
3. **Copilot SDK `defineTool` 不支援 `z.record()`** — 用展開的 optional fields。
4. **Recovery 10 tool call 限制** — 不加會無限循環。
5. **String-form `page.evaluate()`** — 避免 esbuild `__name` injection bug。
6. **截圖可能沒有滾動到底** — CDP 預設只截 viewport。注意 `captureBeyondViewport` 或分段截圖。
7. **addSource paste textarea** — `waitForVisible('textarea')` 會 match 搜尋框。必須用 `textarea[aria-label="貼上的文字"]`。
8. **「提交」按鈕歧義** — 頁面有 2 個，UIMap 用 `disambiguate: "y > 400"` 過濾。

---

## Publishing Architecture (ctx injection pattern)

### 原則
Script 和 UIMap 不能 compiled 進 binary。Repair agent 需要 runtime 可讀可改。

### ctx injection — 解決 import 路徑問題
Scripts 零 import，所有依賴透過 `ctx` 注入：

```typescript
// ScriptContext — 注入給每個 script 的依賴
interface ScriptContext {
  cdp: CDPSession;
  page: Page;
  uiMap: UIMap;
  helpers: {
    findElementByText: typeof findElementByText;
    dispatchClick: typeof dispatchClick;
    dispatchPaste: typeof dispatchPaste;
    dispatchType: typeof dispatchType;
    captureScreenshot: typeof captureScreenshot;
    pollForAnswer: typeof pollForAnswer;
    waitForGone: typeof waitForGone;
    waitForVisible: typeof waitForVisible;
    waitForEnabled: typeof waitForEnabled;
    waitForNavigation: typeof waitForNavigation;
    waitForCountChange: typeof waitForCountChange;
    ensureChatPanel: typeof ensureChatPanel;
    ensureSourcePanel: typeof ensureSourcePanel;
    ensureHomepage: typeof ensureHomepage;
  };
}
```

### 檔案結構
```
src/scripts/*.ts              ← TypeScript 開發（type safety）
  ↓ tsc
default-scripts/*.js          ← readable JS output（隨 package 發布）
  ↓ postinstall copy（不覆蓋已存在）
~/.nbctl/scripts/*.js         ← runtime 使用（repair agent 可改）

src/config/ui-maps/*.json     ← bundled UIMap
~/.nbctl/ui-maps/*.json       ← user override（repair agent 可改）
~/.nbctl/repair-logs/         ← error log + screenshot
~/.nbctl/screenshots/         ← 操作截圖（持久化）
```

### 動態載入
```typescript
async function loadScript(operation: string): Promise<ScriptFunction> {
  const userScript = join(NBCTL_HOME, "scripts", `${operation}.js`);
  const defaultScript = join(__dirname, "default-scripts", `${operation}.js`);
  if (existsSync(userScript)) return (await import(userScript)).default;
  return (await import(defaultScript)).default;
}
```

### MVP 做法
先在 `src/scripts/` 寫 TypeScript 用 ctx injection。build step 和 postinstall 後續加。功能先跑通。

---

## Impact Analysis

### 受影響的代碼路徑
```
MCP exec → exec-tools.ts (不改) → scheduler.submit() (不改)
  → createRunTask() in daemon/index.ts (改：傳 cdp+page，viewport override)
    → buildToolsForTab() (不改 — Recovery 還需要)
    → runDualSession() in session-runner.ts (核心改動)
      → runPlannerSession() (改：submitPlan schema 變)
        → buildPlannerCatalog() in agent-loader.ts (改：agent configs → script operations)
      → [刪] runExecutorSession()
      → [新] runScript() → deterministic DOM
      → [新] runRecoverySession() → LLM (只有失敗)
    → tabManager.releaseTab() (不改)
```

### 變更 × 影響 × 測試

| # | 變更 | 風險 | 現有測試影響 | 測試策略 |
|---|------|------|------------|---------|
| A | `ExecutionStep` schema 改 | HIGH | 7 個 test 用 `executorPrompt`+`tools` | 全部更新 mock step 結構 |
| B | `runPlannerSession` submitPlan schema | MEDIUM | 7 個 planner test | 更新 mock submitPlan 回傳 |
| C | `buildPlannerCatalog` → script catalog | LOW | `agent-loader.test.ts` | 更新預期輸出 |
| D | `runDualSession` 流程改寫 | HIGH | 7 個 dualSession test | 重寫：mock `runScript` + `runRecoverySession` |
| E | `runExecutorSession` 移除 | MEDIUM | 3 個 executor test | 刪除這些 test |
| F | `DualSessionOptions` 加 cdp, page | LOW | lifecycle + index test | 更新 mock |
| G | `daemon/index.ts` 傳 cdp+page | LOW | 16 個 index test | 更新 mock |
| H | Viewport override 加入 | LOW | 無 | 新增 1 test |
| I | `agents/*.md` 移除 | LOW | `agent-loader.test.ts` | 改為 script catalog test |
| J | UIMap JSON 更新 | LOW | 無直接 test | 新增 element 存在性 test |
| K | `loadUIMap` user-override | LOW | 無 | 新增 test |
| L | Screenshot persistence | LOW | 無 | 新增 test |

### 不受影響的模組（確認不動）
TabManager, Scheduler, TaskStore, Notifier, MCP server, exec-tools, notebook-tools, mcp-tools, CopilotClientSingleton, hooks, cdp-helpers (已有 dispatch*, captureScreenshot), SessionResult type (向後相容)

---

## File Structure

### 新增
| File | 職責 |
|------|------|
| `src/scripts/types.ts` | ScriptResult, ScriptLogEntry, FoundElement, PollOptions, ScriptContext |
| `src/scripts/find-element.ts` | `findElementByText()` — DOM query + match + disambiguate |
| `src/scripts/wait-primitives.ts` | 6 wait functions |
| `src/scripts/ensure.ts` | ensureChatPanel, ensureSourcePanel, ensureHomepage |
| `src/scripts/operations.ts` | 10 scripted operations（ctx injection pattern） |
| `src/scripts/index.ts` | `runScript()` dispatcher + `buildScriptCatalog()` |
| `src/agent/recovery-session.ts` | `runRecoverySession()` — browser tools + submitResult |
| `src/agent/repair-log.ts` | `saveRepairLog()` — JSON + screenshot 存檔 |

### 修改
| File | 改動 |
|------|------|
| `src/shared/config.ts` | 加 `RECOVERY_MODEL`, `REPAIR_LOGS_DIR`, `SCREENSHOTS_DIR`。移除 `EXECUTOR_MODEL` |
| `src/shared/types.ts` | 加 `RepairLog`, `RecoveryToolCall`。改 `ExecutionStep` schema |
| `src/config/ui-maps/zh-TW.json` | spike 驗證版（多 10 elements + 修正 selectors） |
| `src/shared/locale.ts` | `loadUIMap` 加 `~/.nbctl/ui-maps/` user-override |
| `src/agent/session-runner.ts` | `runDualSession` 流程改寫。移除 `runExecutorSession` |
| `src/agent/agent-loader.ts` | `buildPlannerCatalog` 改讀 script operations |
| `src/daemon/index.ts` | `createRunTask` 傳 cdp+page + viewport override |
| `src/agent/tools/browser-tools.ts` | 移除 `waitForContent`（被 pollForAnswer 取代） |

### 移除
| File | 原因 |
|------|------|
| `agents/*.md` (10 files) | Agent config 不再被 Planner/Executor 使用 |

---

## Chunk 1: Foundation — Types + Config + UIMap

### Task 1: Script types + ScriptContext

**Files:** Create `src/scripts/types.ts`, Test `tests/unit/scripts/types.test.ts`

- [ ] Create ScriptResult, ScriptLogEntry, FoundElement, PollOptions, ScriptContext, createLogEntry
- [ ] Write test for createLogEntry
- [ ] Run test, verify pass
- [ ] Commit: `feat: script types — ScriptResult, ScriptLogEntry, ScriptContext`

### Task 2: Config + shared types

**Files:** Modify `src/shared/config.ts`, Modify `src/shared/types.ts`

- [ ] config: Add `RECOVERY_MODEL="gpt-5-mini"`, `RECOVERY_TIMEOUT_MS=120000`, `REPAIR_LOGS_DIR`, `SCREENSHOTS_DIR`
- [ ] types: Add `RepairLog`, `RecoveryToolCall`. Change `ExecutionStep` to `{ operation: string; params: Record<string, string> }`
- [ ] Run `npm test` — ⚠️ `session-runner.test.ts` will break (ExecutionStep changed). This is expected, fixed in Task 12.
- [ ] Commit: `feat: config + types for G2 architecture`

### Task 3: UIMap update + user-override loading

**Files:** Modify `src/config/ui-maps/zh-TW.json`, Modify `src/shared/locale.ts`

- [ ] Replace zh-TW.json with spike's verified version (all elements + corrected selectors)
- [ ] `loadUIMap`: check `~/.nbctl/ui-maps/` first → bundled fallback → en fallback
- [ ] Run `npm test`
- [ ] Commit: `feat: UIMap — spike verified zh-TW + user-override loading`

---

## Chunk 2: CDP Helpers + Wait Primitives

### Task 4: findElementByText

**Files:** Create `src/scripts/find-element.ts`, Test `tests/unit/scripts/find-element.test.ts`

- [ ] Port from spike `phase-g-shared.ts:203-282`. 16 interactive selectors, text/placeholder/aria-label match, disambiguate filter (`y>400` etc.)
- [ ] Test: mock page.evaluate, verify disambiguate parsing + result filtering
- [ ] Commit: `feat: findElementByText — DOM query + match + disambiguate`

### Task 5: 6 Wait primitives

**Files:** Create `src/scripts/wait-primitives.ts`, Test `tests/unit/scripts/wait-primitives.test.ts`

- [ ] Port 6 primitives from spike. All Node-side polling (not page.evaluate loops):
  1. `pollForAnswer` — 3-layer: .thinking-message + hash stability + defense filters
  2. `waitForGone` — poll querySelector → null/hidden
  3. `waitForVisible` — poll getBoundingClientRect > 0
  4. `waitForEnabled` — poll findElementByText + !disabled
  5. `waitForNavigation` — poll page.url() change
  6. `waitForCountChange` — poll querySelectorAll.length
- [ ] Test: pollForAnswer stability logic + waitForGone timeout
- [ ] Commit: `feat: 6 wait primitives`

---

## Chunk 3: Scripts Module

### Task 6: Ensure helpers

**Files:** Create `src/scripts/ensure.ts`, Test `tests/unit/scripts/ensure.test.ts`

- [ ] Port ensureChatPanel (check `.chat-panel` visible, click 「對話」tab if not)
- [ ] Port ensureSourcePanel (check `.source-panel` visible, click 「來源」tab if not, handle collapse_content)
- [ ] Port ensureHomepage (check URL is homepage, navigate if not)
- [ ] Test: mock page, verify click-to-switch logic
- [ ] Commit: `feat: ensure helpers — ensureChatPanel, ensureSourcePanel, ensureHomepage`

### Task 7: 10 Script operations + dispatcher

**Files:** Create `src/scripts/operations.ts`, Create `src/scripts/index.ts`

All scripts use ctx injection pattern — receive `(ctx: ScriptContext, ...params)`, zero imports.

- [ ] 6 notebook-page scripts:
  - `scriptedQuery` — ensureChatPanel → find chat_input → click → paste → find submit (y>400) → click → pollForAnswer
  - `scriptedAddSource` — ensureSourcePanel → find add_source → click → find paste_source_type → click → waitForVisible(`textarea[aria-label="貼上的文字"]`) → paste → find insert → click → waitForCountChange
  - `scriptedListSources` — ensureSourcePanel → read .source-panel → parse
  - `scriptedRemoveSource` — ensureSourcePanel → find more_vert → click → findElementByText("移除來源") → click → waitForGone dialog
  - `scriptedRenameSource` — ensureSourcePanel → find more_vert → click → findElementByText("重新命名來源") → click → type → submit
  - `scriptedClearChat` — ensureChatPanel → find conversation_options → click → findElementByText("刪除對話記錄") → click → waitForGone dialog

- [ ] 4 homepage scripts:
  - `scriptedListNotebooks` — ensureHomepage → read notebook_rows → parse
  - `scriptedCreateNotebook` — ensureHomepage → find create_notebook → click → waitForNavigation
  - `scriptedRenameNotebook` — ensureHomepage → find more_vert → click → find edit_title → click → dialog → type → save
  - `scriptedDeleteNotebook` — ensureHomepage → find more_vert → click → find delete → click → waitForGone dialog

- [ ] `runScript()` dispatcher + `buildScriptCatalog()` for Planner
- [ ] Commit: `feat: 10 script operations + runScript dispatcher`

---

## Chunk 4: Recovery Session + Repair Log + Screenshot Persistence

### Task 8: Recovery session

**Files:** Create `src/agent/recovery-session.ts`, Test `tests/unit/agent/recovery-session.test.ts`

- [ ] Port from `phase-g2.ts:219-365`:
  - Browser tools: screenshot, find, click, paste, type, read, wait (same as existing browser-tools.ts patterns)
  - `submitResult` tool: captures result + analysis + suggestedPatch via closure
  - System message: 10 tool call limit + no quality judgment + no repeated questions
  - Event listener: captures toolCallLog (matched by toolCallId) + agentMessages
  - On failure (no submitResult): capture final screenshot
- [ ] Test: mock CopilotClient, verify submitResult capture + timeout handling
- [ ] Commit: `feat: runRecoverySession — GPT-5-mini completion + analysis + patch`

### Task 9: Repair log + screenshot persistence

**Files:** Create `src/agent/repair-log.ts`, Test `tests/unit/agent/repair-log.test.ts`

- [ ] Port `saveRepairLog` from `phase-g2.ts:371-424`:
  - JSON to `~/.nbctl/repair-logs/{timestamp}_{operation}_{failedSelector}.json`
  - PNG to same dir if finalScreenshot exists
- [ ] Screenshot persistence helper:
  - `saveScreenshot(base64, taskId, step)` → `~/.nbctl/screenshots/{taskId}-{step}-{timestamp}.png`
  - Auto-cleanup: keep last N files (default 200)
- [ ] Wire into script operations (capture at key points: after answer, after source add, on error)
- [ ] Test: verify file creation, structure, cleanup logic
- [ ] Commit: `feat: repair log + screenshot persistence`

---

## Chunk 5: Flow Integration — The Big Switch

> ⚠️ This chunk changes the core execution flow. Tests will break and must be updated atomically.

### Task 10: session-runner flow rewrite

**Files:**
- Modify: `src/agent/session-runner.ts`
- Modify: `src/agent/agent-loader.ts`
- Modify: `src/shared/types.ts` (ExecutionStep — already changed in Task 2)
- Delete: `agents/*.md` (10 files)
- Rewrite: `tests/unit/agent/session-runner.test.ts`
- Rewrite: `tests/integration/daemon/exec-e2e.test.ts`
- Modify: `tests/unit/agent/config/agent-loader.test.ts`

**Changes:**

- [ ] `DualSessionOptions`: add `cdpSession: CDPSession`, `page: Page`, `uiMap: UIMap`
- [ ] `runPlannerSession`: change submitPlan schema to `{ operation, params }`. Change system message to use `buildScriptCatalog()` instead of `buildPlannerCatalog()`.
- [ ] `runDualSession`: rewrite flow:
  ```
  Planner → plan.steps
    for each step:
      scriptResult = runScript(step.operation, step.params, ctx)
      if success → continue
      if fail → recoveryResult = runRecoverySession(...)
                saveRepairLog(scriptResult, uiMap, recoveryResult)
                if recovery.success → continue with recovery.result
                if recovery.fail → return error
  ```
- [ ] Delete `runExecutorSession` (no longer needed)
- [ ] `agent-loader.ts`: replace `buildPlannerCatalog(agentConfigs)` with `buildScriptCatalog()` from `src/scripts/index.ts`
- [ ] Delete `agents/*.md` — 10 agent config files no longer referenced
- [ ] Rewrite `session-runner.test.ts`:
  - `runSession` tests: **keep** (low-level primitive, unchanged)
  - `runPlannerSession` tests: **update** submitPlan mock to new schema
  - `runExecutorSession` tests: **delete** (function removed)
  - `runDualSession` tests: **rewrite** to mock `runScript` + `runRecoverySession`
  - New tests: script success → no recovery, script fail → recovery called, recovery fail → error propagated
- [ ] Rewrite `exec-e2e.test.ts`: mock `runScript` instead of mock `runTask`
- [ ] Update `agent-loader.test.ts` for new catalog format
- [ ] Run `npm test` — all tests must pass
- [ ] Commit: `feat: runDualSession — Planner → Script → Recovery (replaces Executor LLM)`

### Task 11: daemon/index.ts integration

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `tests/unit/daemon/index.test.ts`
- Modify: `tests/integration/daemon/lifecycle.test.ts`

- [ ] `createRunTask`: pass `tabHandle.cdpSession`, `tabHandle.page`, runtime `uiMap` to `runDualSession`
- [ ] Add viewport override after acquireTab:
  ```typescript
  await tabHandle.cdpSession.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  ```
- [ ] Remove `agentConfigs` from `runDualSession` call (no longer needed — scripts don't use agent configs)
- [ ] Update `buildToolsForTab` call — still needed for Recovery, pass to DualSessionOptions
- [ ] Update `index.test.ts` and `lifecycle.test.ts` mocks
- [ ] Run `npm test`
- [ ] Commit: `feat: createRunTask — CDP session + viewport override for scripts`

### Task 12: Dead code removal

**Files:** Modify `src/shared/config.ts`, Modify `src/agent/tools/browser-tools.ts`

- [ ] Remove `EXECUTOR_MODEL` from config (replaced by `RECOVERY_MODEL`)
- [ ] Remove `waitForContent` tool from browser-tools.ts (replaced by `pollForAnswer`)
- [ ] Clean up unused imports across all modified files
- [ ] Run `npm test && npm run lint`
- [ ] Commit: `chore: remove dead code — EXECUTOR_MODEL, waitForContent, agent configs`

---

## Chunk 6: Acceptance Testing

### Task 13: Real test — spike equivalent verification

**Goal:** 證明新架構跑通 spike 驗證過的所有操作。不信任文字結果，用截圖人工確認。

**前置:** Daemon 啟動（`--no-headless`），Chrome 可見。

- [ ] **Phase A: Happy path all-ops（spike S01-S12 等效）**
  用 MCP exec 呼叫（或 curl），逐步驗證：

  | Step | 操作 | 驗證方式 |
  |------|------|---------|
  | S01 | listSources | 回傳數量 = 截圖 source panel 數量 |
  | S02 | addSource (test text) | 截圖確認 source panel 多一個 |
  | S03 | listSources | 數量 = S01 + 1 |
  | S04 | renameSource | 截圖確認名稱改了 |
  | S05 | query "TypeScript 是什麼？" | 截圖確認 chat bubble 有回答 + 文字一致 |
  | S06 | clearChat | 截圖確認 chat 區清空 |
  | S07 | removeSource | 截圖確認 source panel 少一個 |
  | S08 | listSources | 數量 = S01 |
  | S09 | listNotebooks | 回傳數量 = 截圖 homepage 數量 |
  | S10 | createNotebook | 截圖確認新 notebook 出現 |
  | S11 | renameNotebook | 截圖確認名稱改了 |
  | S12 | deleteNotebook | 截圖確認 notebook 消失 |

- [ ] **Phase B: Recovery test**
  - Corrupt 1-2 個 UIMap selector（手動改 `~/.nbctl/ui-maps/zh-TW.json`）
  - 執行 query → script 失敗 → Recovery 接手完成
  - 確認 `~/.nbctl/repair-logs/` 有 error log + screenshot
  - 確認 suggestedPatch 合理

- [ ] **Phase C: Planner NL dispatch**
  - `exec(prompt="問 NotebookLM TypeScript 是什麼")` → Planner 選 query
  - `exec(prompt="加一個來源然後列出所有來源")` → Planner 拆 2 步
  - `exec(prompt="幫我訂披薩")` → Planner 拒絕（off_topic）

- [ ] **Phase D: 截圖驗證**
  - 每步都檢查 `~/.nbctl/screenshots/` 有持久化截圖
  - AI 用 Read 工具看截圖（multimodal），比對 script 回報的結果
  - ⚠️ 注意滾動問題：source panel 或 chat 可能需要 scroll 才看到全部

- [ ] **Phase E: 現有 infra 不退步**
  - `/test-real` Phase 0-4 全通過（MCP 連線, notebook CRUD, error handling, async polling）

- [ ] Commit: `test: spike-equivalent real test verification`

### Acceptance Criteria

```
✅ npm test — 所有 unit/integration test pass
✅ /test-real Phase 0-4 — daemon infra 不退步
✅ All-ops S01-S12 — 10 script operations 全通過（截圖確認）
✅ Recovery — corrupt selector → recovery 完成 + error log
✅ Planner NL — 單步 + 多步 + 拒絕 全正確
✅ 截圖持久化 — ~/.nbctl/screenshots/ 有檔案且內容正確
✅ 每步結果 = 截圖視覺確認（不信任純文字回報）
```

---

## Execution Order Summary

```
Chunk 1: Foundation (Task 1-3)         — 純新增，不破壞 ✅
Chunk 2: CDP + Wait (Task 4-5)         — 純新增，不破壞 ✅
Chunk 3: Scripts (Task 6-7)            — 純新增，不破壞 ✅
Chunk 4: Recovery + Screenshots (8-9)  — 純新增，不破壞 ✅
Chunk 5: Big Switch (Task 10-12)       — ⚠️ 核心改動，test 一次更新
Chunk 6: Acceptance (Task 13)          — Real test 驗收
```

Chunk 1-4 = 安全區（642 test 持續 pass）
Chunk 5 = 一次切換（改 session-runner + 更新所有 test）
Chunk 6 = 最終驗收（spike 等效 + 截圖確認）
