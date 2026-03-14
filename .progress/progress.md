## 2026-03-15 01:30 — /test-real Phase 0 PASS, Phase 1 partially tested, 12 fixes committed

**Goal**: 跑 /test-real 真實驗證，發現並修復問題

**Done (this session, commit `93fb327`)**:

### 修復（12 項）
1. SDK 型別修正（systemMessage → SystemMessageConfig, hooks, Tool generic, ToolResultType）
2. launcher.ts CLI entry point + `--no-headless` + import guard
3. package.json build 加 `cp -r src/config`、start 改 `tsx`
4. Chrome 自動化偵測 — ignoreDefaultArgs + disable AutomationControlled
5. Google session 啟動驗證 — 導航 NotebookLM 檢查登入 + 未登入保留 tab
6. reauth 導航 — 切 headed 後自動導航 + 回報 loggedIn + 更新 googleSession
7. googleSession mutable reference — reauth 後 get_status 即時反映
8. exec __homepage__ — 無 notebook 時支援首頁操作（建立筆記本）
9. exec result spreading — string 包成 `{ message }` 不再展開成字元
10. register_notebook 改名 — add_notebook → register_notebook
11. viewport — defaultViewport: null + window-size 1440x900
12. 鍵盤快捷鍵 — type("SelectAll") 平台無關 + Ctrl/Cmd 自動偵測

### /test-real 結果

**Phase 0: Pre-flight ✅ PASS**
- daemon running, agent healthy, 10 agents loaded, google session valid

**Phase 1: Notebook 管理 — 部分測試**
- ✅ exec("建立筆記本") 成功操作 NotebookLM 首頁
- 🔴 notebook 標題錯誤（已修 agent prompt + type tool）
- ⏸️ 重啟 daemon 後需重跑 Phase 1

**Phase 2-5**: 尚未測試

### 待處理（🟡 ACCUMULATE）
- create_notebook typed MCP tool（目前用 exec + __homepage__ workaround）
- Chrome --disable-blink-features 警告橫幅（cosmetic）
- Node 25 ESM 必須用 tsx（vscode-jsonrpc resolution）
- test-real checklist 缺多筆記本 concurrent 測試 phase
- plan.md 中的 add_notebook 引用需全面更新為 register_notebook

**State**: Branch `001-mvp` at `93fb327`。642 tests, 38 files, lint ✅。

**Next**:
- [ ] 重啟 daemon（新 build）
- [ ] 重跑 Phase 1（建立 nbctl-test + register + list + set_default + rename）
- [ ] Phase 2: Content Pipeline（加來源 + 查詢 + input gate）
- [ ] Phase 3: Async + Tasks
- [ ] Phase 4: Error Handling
- [ ] Phase 5: Cleanup
