## 2026-03-15 15:12 — G2 spike 全部驗證通過

**Goal**: Script-first + Recovery agent 架構整合到主線

**Done (this session, commits `4bbd3ac..9569066`)**:

### 已完成實驗 ✅

1-37 同前（略，見 archive）

38. **Viewport 修正** — `Emulation.setDeviceMetricsOverride` 是正解。`setViewport` 留 persistent override，`Browser.setWindowBounds` 只改物理邊框。800x600 觸發 mobile tab view。（Finding #60）
39. **ensureChatPanel + ensureHomepage** — 所有 script 自帶起跑點驗證（`ensureSourcePanel` 已有）
40. **Menu render 修正** — NotebookLM menu items 是 plain BUTTON 不是 `[role=menuitem]`，改用 `findElementByText("移除來源"/"刪除")` 等待
41. **addSource paste textarea 修正** — `waitForVisible('textarea[aria-label="貼上的文字"]')` 取代 generic `textarea`（原本 match 到搜尋框）
42. **All-ops happy path 11/12 PASS** — S12 是 test harness notebook 定位問題
43. **Recovery 驗證 9/10** — 所有 element-based script 正確在失敗點回報 failedSelector
44. **🎉 NL Planner 10/10 PASS** — 4 單步 + 3 組合 + 3 拒絕，全部正確

### 未完成 / 待處理 ❌

1. **Content pipeline 改善** — URL crawl4AI / PDF markdown / repo 分段
2. **generateAudio + downloadAudio scripts** — 特殊案例
3. **spike → main 整合** — scripts + wait primitives + recovery + planner port 到 `src/`
4. **發布架構** — `~/.nbctl/scripts/` + `~/.nbctl/ui-maps/` 動態載入 + `.bak` 備份

**Decisions**:
- ✅ Viewport: 用 `Emulation.setDeviceMetricsOverride` 不是 `setViewport`（persistent 殘留）
- ✅ Script 起跑點：每個 script 自帶 ensure（ensureChatPanel/ensureSourcePanel/ensureHomepage）
- ✅ Menu wait：用 `findElementByText` 等已知 menu item text，不用 CSS role selector
- ✅ Copilot SDK `defineTool` 不支援 `z.record()` — 用展開的 optional fields
- ~~NotebookLM UI 改了三欄→tab~~ — **誤判，是 viewport 800x600 觸發 mobile view**

**State**: Branch `001-mvp`（未 commit）。678 unit tests ✅ (44 files)。0 lint errors。

**Next**:
- [ ] Commit all G2 changes（一個大 commit 或分 chunk commit）
- [ ] Task 13: Acceptance testing — real daemon + Chrome 驗收 S01-S12 + Recovery + Planner NL
- [ ] 發布架構實作（`~/.nbctl/` 動態載入 + install 腳本）
- [ ] Content pipeline（crawl4AI / PDF / repo 分段）
- [ ] generateAudio + downloadAudio（特殊案例）
- [ ] 移除 `agents/*.md`（10 files，已不被引用）

**User Notes**:
- Viewport 800x600 陷阱已撞多次，`Emulation.setDeviceMetricsOverride` 是正解 — 記到 memory
- 用戶指出 script 需要起跑點驗證 + `ensureHomepage` 也要加 — 已全面加入
- 用戶要求視覺+DOM 排查不要推論 — 發現是 viewport 問題不是 Google 改 UI
- Copilot SDK 不支援 `z.record()` — 需要記住，production 也不能用
- S12 是 test harness 問題（notebook 排序），production 有 Planner 指定 notebook 不會有此問題

---

## 2026-03-15 16:41 — G2 Script-first Integration (Chunks 1-5 完成)

**Goal**: 將 spike 的 Script-first + Recovery 架構整合到主線 `src/`

**Done**:
- T1-T6 (Chunks 1-3): 新增 `src/scripts/` 模組 — types, find-element, wait-primitives, ensure, operations, index
- T7: 10 scripted operations (query, addSource, listSources, removeSource, renameSource, clearChat, listNotebooks, createNotebook, renameNotebook, deleteNotebook) + runScript dispatcher + buildScriptCatalog
- T8: `src/agent/recovery-session.ts` — GPT-5-mini Recovery session (browser tools + submitResult + 10-call limit)
- T9: `src/agent/repair-log.ts` — saveRepairLog + saveScreenshot + cleanupScreenshots
- T10 (Big Switch): `session-runner.ts` 完全改寫 — Planner → Script → Recovery 流程。submitPlan schema 改為 `{ operation, params }`。刪除 `runExecutorSession`。32 tests rewritten。
- T11: `daemon/index.ts` — 傳 cdpSession+page+uiMap 給 runDualSession。加 viewport override (1440x900)。移除 agentConfigs 依賴。
- T12: Dead code removal — EXECUTOR_MODEL → RECOVERY_MODEL, mcp-tools list_agents 改用 script catalog

**Decisions**:
- ExecutionStep 直接改 schema（`{ operation, params }`），不新增 ScriptStep
- DualSessionOptions 加 cdpSession/page/uiMap，移除 agentConfigs/executorModel/tabUrl
- `agents/*.md` 尚未刪除（仍在 repo 但不被引用，留給用戶確認後刪除）
- `waitForContent` browser tool 保留（Recovery agent 可能用到，非急）

**State**: Branch `001-mvp`（未 commit）。678 tests ✅ across 44 files。0 lint errors。Plan Chunks 1-5 完成，Chunk 6 (acceptance testing) 待用戶驗收。
