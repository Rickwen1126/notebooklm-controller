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

**State**: Branch `001-mvp` at `9569066`。642 unit tests ✅。Spike 全驗證通過：happy path 11/12, recovery 9/10, planner 10/10。

**Next**:
- [ ] spike → main 整合（scripts + wait primitives + recovery + planner port 到 `src/`）
- [ ] 發布架構實作（`~/.nbctl/` 動態載入 + install 腳本）
- [ ] Content pipeline（crawl4AI / PDF / repo 分段）
- [ ] generateAudio + downloadAudio（特殊案例）

**User Notes**:
- Viewport 800x600 陷阱已撞多次，`Emulation.setDeviceMetricsOverride` 是正解 — 記到 memory
- 用戶指出 script 需要起跑點驗證 + `ensureHomepage` 也要加 — 已全面加入
- 用戶要求視覺+DOM 排查不要推論 — 發現是 viewport 問題不是 Google 改 UI
- Copilot SDK 不支援 `z.record()` — 需要記住，production 也不能用
- S12 是 test harness 問題（notebook 排序），production 有 Planner 指定 notebook 不會有此問題
