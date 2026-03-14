## 2026-03-14 13:30 — Review Point 1.5 Code Review + Tour 完成

**Goal**: Code alignment 後跑完整 code review + architecture tour + step-by-step review

**Done**:
- **Code alignment**（前一 session）：types.ts, tab-manager.ts, notebook-tools.ts, mcp-tools.ts, index.ts, session-runner.ts, agent-loader.ts, 10 agent configs, 27 test files。555 tests passing。
- **Tour 03**（Sky Eye: Review 1.5 Tab Pool + Notebook-First）— 7 steps 跳 7 個模組邊界。使用者已 review 並加入 4 個 Finding（A-D）。
- **Code Review tour**（review-tab-pool-alignment-20260314）— 0 critical（3 個已修）、4 suggestions、3 good practices。
- **Tour 02 更新**（Sky Eye: Phase 3→5.5）— Step 4/5/9 大幅重寫反映新架構。Step 9 風險清單更新為 11 項。
- **Step-by-step Tour 02 review**（使用者用手機逐步過）— 發現 `waitForIdle()` → `waitForTask()` 未追蹤，已加 T067.1。
- **tasks.md 加入 Review 1.5 Hotfix 區塊** — 11 個項目（2 Bug + 3 Architecture + 6 Tech Debt），Phase 6 前須修完 Bug + Architecture。

**Decisions**:
- Planner 階段白佔 tab 可接受（1-2 秒，lifecycle 更簡單）
- T-HF05 acquireTab race：MVP 階段 scheduler per-notebook FIFO 降低發生機率，但架構上應修
- Tech Debt（T-HF06-11）可 defer 到 Phase 6 之後

**State**: Branch `001-mvp`。Code 已對齊新 spec。555 tests passing, lint clean。尚未 commit。tasks.md 已更新 Hotfix 區塊。

**Next**:
- [ ] Commit 所有 code alignment + tour + review 變更
- [ ] 修 T-HF01（tabHandle.url bug）+ T-HF02（waitForTask）
- [ ] 修 T-HF03-05（Architecture 項目）
- [ ] 進入 Phase 6

---

## 2026-03-14 12:00 — Code 對齊 Review Point 1.5: Tab Pool + Notebook-First

**Goal**: 根據 Review Point 1.5 更新後的 spec/plan，把 code 對齊新架構

**Done**:
- **Type Schema** (`src/shared/types.ts`):
  - 移除 `NotebookStatus."closed"` 和 `NotebookEntry.active`
  - `TabHandle` 加 `state: "active" | "idle"` + `releasedAt: string | null`
  - `AgentConfig` 加 `startPage: "homepage" | "notebook"`
  - `DaemonStatusResult.tabManager` → `tabPool: { usedSlots, maxSlots, idleSlots }`
- **Tab Pool** (`src/tab-manager/`):
  - `TabManager.acquireTab()`: 三級優先（affinity → idle reuse → new tab）
  - `TabManager.releaseTab()`: 標記 idle，保留 tab 供重用
  - `listIdleTabs()` / `listActiveTabs()` helper methods
  - `tab-handle.ts`: 初始 `state: "active"`, `releasedAt: null`
- **MCP Tools** (`src/daemon/notebook-tools.ts`):
  - 砍掉 `open_notebook` + `close_notebook`（YAGNI，8 → 6 tools）
  - `add_notebook` 移除 `active: true`
  - `list_notebooks` 移除 `active` 欄位
- **get_status** (`src/daemon/mcp-tools.ts`):
  - `tabManager` → `tabPool`，用 `tab.state` filter 計算 usedSlots/idleSlots
  - `activeNotebooks` 改為所有已註冊 notebooks
- **Daemon Wiring** (`src/daemon/index.ts`):
  - `createRunTask()` 改用 `acquireTab()`/`releaseTab()` + try/finally
  - 傳 `notebookAlias` + `tabUrl` 給 `runDualSession()`
  - 需要 `stateManager.getNotebook()` 取得 notebook URL
- **Agent Config** (`src/agent/agent-loader.ts`):
  - 解析 `startPage` 欄位，預設 `"notebook"`
- **Session Runner** (`src/agent/session-runner.ts`):
  - `DualSessionOptions` 加 `notebookAlias` + `tabUrl`
  - Executor systemMessage 注入 canonical notebook context
  - FR-179 pre-navigate hint（O(1) URL exact match → prompt hint）
- **Agent Config Files** (`agents/*.md`):
  - 10 個 agents 全部加 `startPage`（manage-notebook/sync-notebook = homepage，其餘 = notebook）
- **Tests**: 27 個 test 檔案更新，545 tests 全通過，lint 0 errors
- Code review 完成：3 個 Critical issues 已修正（index.ts acquireTab/releaseTab wiring）

**Decisions**:
- `acquireTab` affinity path 不 navigate（弱親和，避免不必要 navigation）
- `startPage` 預設 `"notebook"`（多數 agents 在 notebook 操作）
- `activeNotebooks` 改為所有已註冊 notebooks（不再依賴 `active` flag）

**State**: Branch `001-mvp`。Code 已對齊新 spec。545 tests passing, lint clean。尚未 commit。

**Next**:
- [ ] Commit code alignment changes
- [ ] 補 acquireTab/releaseTab 單元測試（review 建議 I2）
- [ ] Code tour 更新

---

## 2026-03-14 11:39 — Review Point 1.5: Notebook-First + Tab Pool Spec 修正

**Goal**: 根據 Review Point 1.5 決策修正 spec/plan artifacts（Notebook-First + Tab Pool 架構）

**Done**:
- 修正 4 個 spec/plan 檔案（spec.md, data-model.md, contracts/mcp-tools.md, plan.md）
  - 砍掉 `open_notebook` / `close_notebook` MCP tools (YAGNI)
  - Tab pool acquire/release 語義貫穿所有 artifacts
  - Pool 滿 = producer-consumer（不向使用者暴露錯誤）
  - Canonical notebook context 顯式注入 Planner/Executor prompt
  - Sync exec 改 per-task wait（waitForTask，非 global waitForIdle）
  - NotebookEntry 移除 `active` 欄位、NotebookStatus 移除 `"closed"`
  - DaemonStatusResult `tabManager` → `tabPool: { usedSlots, maxSlots, idleSlots }`
- 從 spike HANDOVER 回灌 Finding #48: Executor pre-navigate（FR-179）
  - 系統 O(1) 錨點判斷（tab.url exact match），結果作為 **hint** 注入 prompt，不是 assertion
  - Agent 保留自主驗證權（可信任 hint 或自行觀測確認）
  - AgentConfig 加 `startPage: "homepage" | "notebook"` 欄位
- Commits: `2bc4bd6` (spec/plan 主修正) + `25a58f5` (FR-179 pre-navigate)
- Memory 更新：`project_notebook_vs_tab_architecture.md` 中 open/close 從「降級」改為「砍掉」

**Decisions**:
- Finding #49 Weak Affinity 不進 spec — 是 acquireTab 內部實作細節，現有描述已涵蓋語義
- Phase 5.5 code review 暫不繼續 — spec/plan 剛改核心語義，review 舊 code 意義不大。先改 code 對齊新 spec → 再 review
- 既有 code review tour 的 bug 清單可作為參考，改 code 時順便檢查

**State**: Branch `001-mvp` at `25a58f5`。4 個 spec/plan 檔案已 committed。Code 尚未對齊新 spec。

**Next**:
- [ ] 根據新 spec/plan diff 整理需要調整的 tasks（新增/修改 tab-manager、session-runner、notebook-tools 等）
- [ ] 實作 tasks，把 code 對齊新架構
- [ ] 對齊完成後跑 code review + code tour

---

## 2026-03-13 16:59 — Phase 2 Code Review Bug Fixes + AUDIT Pass

**Goal**: Cross-reference architecture tour + code review tour findings, fix all bugs, write AUDIT document

**Done**:
- Fixed 7 bugs from code review tour (3 critical + 4 suggestions):
  - 🔴1: `mcp-server.ts` JSON.parse try/catch → -32700 JSON-RPC spec compliance
  - 🔴2: `state-tools.ts` writeFile path traversal → `resolve()` + `relative(NBCTL_HOME)` boundary check + 2 tests
  - 🔴3: `task-store.ts` `update()` method + `scheduler.ts` result/error persist → 3 tests
  - 🟡4: `types.ts` + `network-gate.ts` recentLatencyMs → `number | null`, returns `null`
  - 🟡5: `tab-manager.ts` switchMode active-tab guard (`tabs.size > 0`) → 2 tests
  - 🟡6: `hooks.ts` SCREAMING_SNAKE → pattern variable naming
  - 🟡7: `state-tools.ts` updateCache add required field validation → 2 tests
- Added 3 deferred tasks to `specs/001-mvp/tasks.md` Phase 3:
  - T041.2: autoRestart vs `_handleUnexpectedExit` + `started` dual-state convergence
  - T041.3: MCP multi-session behavior verification
  - T041.4: StateManager write mutex
- Written AUDIT document: `.audit/AUDIT-notebooklm-controller-v1@20260313.md` — **PASS**
- All 235 tests passing, lint clean

**Decisions**:
- TaskStore `update()` as separate method (not extending `transition()` signature) — cleaner separation
- Path traversal fix uses `resolve()` + `relative()` pattern (not regex or allowlist)
- 3 items from AUDIT "未標記但應追蹤" pending user confirmation: FR-051 logging, session-runner response validation, disconnect() hang timeout

**State**: On branch `001-mvp`. All fixes committed-ready (unstaged). AUDIT passed. Spike browser capability work ongoing in parallel.

**Next**:
- [ ] User to confirm whether 3 "未標記但應追蹤" items should be added to tasks.md
- [ ] Commit all Phase 2 review fixes
- [ ] Continue spike browser capability Phase B → Phase 3
