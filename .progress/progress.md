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

**Done (continued)**:
- 13 commits on `001-mvp` (d6fe180..e0ea444)
- NetworkGate per-operation acquirePermit
- `/test-real` skill 更新：8 phases + ISO Browser 獨立 DOM 驗證
- `z.record()` runtime crash 修復 → expanded optional fields
- Viewport 1440→1920（homepage list view more_vert 在 x=1507 超出 1440px）
- openSourceMenu / openNotebookMenu: `ok:false` when menu 沒 render + waitForVisible 取代 hardcode sleep
- renameNotebook: find+click atomic（menu 會因 focus loss 自動關閉）
- Real test 迭代到 11/12 pass（S11 renameNotebook script false positive 待修）

**Decisions**:
- submitPlan 不能用 `z.record()` → expanded optional fields（Copilot SDK `_zod` error）
- ISO Browser 獨立驗證 = 標準驗收方式
- Viewport 1920x1080（homepage list 需要 > 1500px 寬）
- Menu 等待用 waitForVisible/waitForEnabled，不用 hardcode sleep loop
- Menu item find+click 必須 atomic（不分兩步，避免 focus loss 關 menu）

**Done (continued)**:
- S11 renameNotebook false positive 根因：`findElementByText("儲存")` match 到 notebook 名稱「儲存庫操作」(y=3828) 在 dialog save button (y=595) 之前 → dialog 內搜尋修復
- Angular Material input 需要 native value setter + dispatchEvent('input')，CDP `Input.insertText` 不觸發 change detection
- **所有 dialog button 搜尋 scope 到 overlay container**：insert, remove confirm, save, delete confirm（5 處）
- CLAUDE.md 更新：viewport contract, SDK z.record 限制, dialog scope 規則, G2 架構

**Done (continued)**:
- Merged 001-mvp → main
- `agents/*.md` 刪除（11 files）
- Spec 對齊：implementation status section 加到 spec.md（15 DONE / 4 PARTIAL / 3 NOT STARTED）
- `runDualSession` → `runPipeline`, `DualSessionOptions` → `PipelineOptions`
- i18n 修復：所有 hardcoded 中文 → UIMap elements（ensure.ts + operations.ts 7 處）
- Locale config override：`~/.nbctl/config.json` { "locale": "zh-TW" }
- Dialog overlay：`querySelector` → `querySelectorAll`（多 overlay 疊加問題，7 處）
- Tab URL 驗證：createRunTask acquire tab 後檢查 URL，不 match 就 navigate（S12 delete 後 query 不再 fail）
- Real test 全部重跑：S01-S12 ✅, Phase 4 ✅ (S12 後 query 也 pass), Phase 5-6 ✅

**Done (continued)**:
- Content pipeline 整合完成：`src/scripts/index.ts` preprocessAddSource + submitPlan fields
- Real test CP02 (URL source: Wikipedia TypeScript) ✅, CP04 (plain text regression) ✅
- Content size limit 500K → 5M chars（三個 converter 都改了）
- 686 tests pass (8 new for content pipeline)

**Discoveries:**
- CP01 repo source (1.9M chars): repomix 轉換成功 (1.8s) 但 paste 1.9M chars 到 textarea hang — 需要分段上傳
- NotebookLM textarea 的 `Input.insertText` 大量文字 paste 可能 hang 或超時

**State**: Branch `main` at `c65311a`。686 tests ✅。Content pipeline code done, real test partial (URL ✅, text ✅, repo hang, PDF untested)。

**Next**:
- [ ] 自動分段上傳：內容 > N chars 自動切 chunk，分批 paste 成多個來源，命名 `{name} (part 1/3)`
- [ ] CP01 repo source 驗證（分段後）
- [ ] CP03 PDF source 驗證

**User Notes**:
- 用戶要求 500K → 5MB 解放限制
- 用戶要求自動分段上傳：超過上限自動切成多個來源，分批 paste，妥善命名（e.g. 15MB → 3 個 5MB parts）
- 分段適用於 repo/URL/PDF 所有類型
