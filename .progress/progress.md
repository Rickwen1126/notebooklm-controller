## 2026-03-15 14:31 — G2 全操作 spike + NotebookLM UI 大改發現

**Goal**: Script-first + Recovery agent 架構整合到主線

**Done (this session, commits `4bbd3ac..9c69b63`)**:

### 已完成實驗 ✅

1-21 同前（略，見 archive）

22. **Phase G/G2 spike 完成** — `phase-g.ts`(CLI), `phase-g-scripts.ts`(12 scripts), `phase-g-shared.ts`(helpers+wait primitives), `phase-g-supervisor.ts`(Phase G 原版), `phase-g2.ts`(G2 recovery-on-fail)
23. **G2 5/5 PASS** — happy path query(18.1s avg, 0 LLM), happy path addSource(5.9s), corrupt chat_input recovery(96s), corrupt submit_button recovery(89s), speed 3 runs
24. **`.thinking-message` DOM signal** — pollForAnswer 加入 Layer 1（ref: notebooklm-skill ask_question.py 同模式）
25. **Recovery error log enrichment** — 用正確 SDK event types（`data.toolCallId` match, `data.arguments`, `data.result.content`），toolCallLog + agentMessages + finalScreenshot
26. **6 wait primitives** — waitForGone, waitForVisible, waitForEnabled, waitForNavigation, waitForCountChange, pollForAnswer
27. **10 新 scripts** — listSources, removeSource, renameSource, clearChat, listNotebooks, createNotebook, renameNotebook, deleteNotebook（generateAudio/downloadAudio 待寫）
28. **發布架構決策** — compiled core + editable scripts/ui-maps in `~/.nbctl/`，`.bak` 備份，`repair --reset`
29. **All-ops happy path 第一輪** — 11/12 PASS（S12 deleteNotebook 因 menu render timing 失敗）
30. **Hardcode wait 改 wait primitives** — dialog/menu 全改 waitForVisible/waitForGone
31. **🚨 NotebookLM UI 大改發現** — Google 改了 layout：三欄並列 → tab 切換（來源/對話/工作室）。所有 script 的面板假設都壞了

### 未完成 / 待處理 ❌

1. **🚨 UI map + scripts 全面更新** — NotebookLM UI 從三欄改成 tab 式：
   - 「來源」「對話」「工作室」是 tab，一次只顯示一個
   - 所有 script 的 `find chat_input` 需要先切到「對話」tab
   - source panel 操作需要先切到「來源」tab
   - `ensureSourcePanel` 已做 tab 切換，但 query/clearChat 沒有 `ensureConversationPanel`
   - UI map `zh-TW.json` 需要重新驗證所有 element
2. **Content pipeline 改善** — URL crawl4AI / PDF markdown / repo 分段
3. **Tab pool 一致性** — create_notebook URL 提取應走 acquireTab/releaseTab
4. **Planner + 多步驟組合測試** — G2 有 Planner 但未接上
5. **generateAudio + downloadAudio scripts** — 特殊案例，需 CDP download + 長等待

**Decisions**:
- ✅ G2 三層架構：Planner(gpt-4.1) → Script(無LLM) → Recovery(gpt-5-mini, 失敗才觸發)
- ✅ Recovery = 一個 agent 做三件事：接手完成 + 分析失敗 + 輸出 suggestedPatch
- ✅ Recovery prompt 必須限制：「10 個 tool call 內必須 submitResult」+「不判斷答案品質」
- ✅ Error log 用 SDK 正確型別：`tool.execution_start → data.arguments`，`tool.execution_complete → data.result.content`
- ✅ 發布架構：compiled core + editable `~/.nbctl/scripts/` + `~/.nbctl/ui-maps/`，repair 前 `.bak` 備份
- ✅ hardcode wait(N) 全面改 wait primitives（waitForVisible/waitForGone/waitForEnabled）
- Google 改了 NotebookLM UI layout（三欄→tab），script 需要全面更新

**State**: Branch `001-mvp` at `9c69b63`。spike 檔案已 commit。NotebookLM UI 已確認改版。

**Next**:
- [ ] 重新做 UI map 驗證（screenshot + DOM 查所有 tab 下的元素）
- [ ] 所有 script 加 tab 切換邏輯（query → 切「對話」tab，source ops → 切「來源」tab）
- [ ] All-ops happy path 重跑 12/12 PASS
- [ ] Planner + 多步驟組合測試
- [ ] spike → main 整合

**User Notes**:
- 用戶指出 hardcode wait 不可靠，要求改用 wait primitives — 已全面修正
- 用戶要求用視覺+DOM 排查 S12 失敗，不要用推論 — 實際排查發現 Google 改了 UI layout
- 發布架構：scripts 不能是 binary，必須 runtime 可讀可改，用戶記到 HANDOVER
