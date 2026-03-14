## 2026-03-15 01:00 — /test-real Phase 0 通過，Phase 1 發現大量問題

**Goal**: 跑 /test-real 真實驗證，發現並修復問題

**Done (this session, uncommitted)**:

### 修復完成
1. **SDK 型別修正**（5 個 build errors）— systemMessage, hooks, Tool generic, ToolResultType
2. **launcher.ts** — CLI entry point + `--no-headless` flag + import guard
3. **package.json** — build script 加 `cp -r src/config`、start 改用 `tsx`
4. **Chrome 自動化偵測** — `ignoreDefaultArgs: ["--enable-automation"]` + `--disable-blink-features=AutomationControlled`
5. **Google session 驗證** — daemon 啟動時自動導航 NotebookLM 檢查登入狀態
6. **reauth 導航** — 切 headed 後自動導航到 NotebookLM + 回報 loggedIn 狀態
7. **googleSession mutable** — 用 `{ valid: boolean }` reference，reauth 後 get_status 即時更新
8. **未登入保留 tab** — session check 未登入時不關 tab，讓使用者看到登入頁面
9. **exec 支援 homepage** — `__homepage__` 特殊 alias，允許無 notebook 時操作首頁
10. **add_notebook → register_notebook** — 重新命名，語義正確

### /test-real 結果

**Phase 0: Pre-flight ✅ PASS**
- daemon running, agent healthy, 10 agents loaded, google session valid

**Phase 1: Notebook 管理 — 部分完成，發現問題**
- `exec("建立筆記本 nbctl-test")` ✅ agent 成功操作 NotebookLM 建立筆記本
- 但有多個 🔴 問題（見下方）

### 發現的問題

**🔴 FIX NOW（影響後續測試）**:

1. **Viewport 800x600** — Puppeteer 預設 viewport，應該 `defaultViewport: null` + `--window-size=1440,900`
   - 影響：agent 操作準確度、截圖品質、UI 元素定位
   - 修法：TabManager.launch 加 `defaultViewport: null` + `--window-size=1440,900`

2. **exec result string spreading** — `...completed.result` 當 result 是 string 時展開成 `{0:"已", 1:"成",...}`
   - 影響：response 不可讀、MCP client 拿到垃圾資料
   - 修法：exec-tools.ts 判斷 result type，string 包成 `{ message: result }`

3. **Notebook 標題輸入錯誤** — 建出 "Untitled noteCtrl+Anbctl-testbook" 而非 "nbctl-test"
   - 可能原因：agent prompt 不夠明確、type/paste 機制問題、Ctrl+A selectAll 失敗
   - 需診斷：檢查 manage-notebook agent prompt + daemon log

**🟡 ACCUMULATE（非阻塞，之後修）**:

4. **create_notebook typed tool** — 建立筆記本應該是 typed MCP tool，不是靠 exec 自然語言
   - 行為：建立 → 拿 URL → 自動 register → 回傳完整資訊
   - 目前用 exec + `__homepage__` workaround

5. **Chrome flag 警告** — `--disable-blink-features=AutomationControlled` 顯示不受支援警告
   - 純 cosmetic，不 block

6. **Node 25 ESM** — 必須用 `tsx` 跑 daemon，`node` 無法解析 `vscode-jsonrpc/node`

7. **test-real checklist 缺多筆記本同步測試** — Phase 3 只測 async 同一 notebook

**State**: Build ✅ + 642 tests ✅。所有改動未 commit。Daemon 在獨立 terminal 運行中。

**Next**:
- [ ] 🔴 修 viewport（defaultViewport: null + window-size）
- [ ] 🔴 修 exec result spreading
- [ ] 🔴 診斷 notebook 標題錯誤
- [ ] 重啟 daemon，繼續 Phase 1（register → list → set_default → rename）
- [ ] Phase 2-5
- [ ] commit 所有改動

**Decisions**:
- exec 支援 `__homepage__` 無 notebook 操作（暫時方案）
- register_notebook = 納管已存在的；create_notebook = typed tool 待做
- test-real 需增加多筆記本 concurrent 測試 phase
