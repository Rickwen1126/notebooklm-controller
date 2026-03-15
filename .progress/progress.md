## 2026-03-15 11:04 — /test-real 全面通過 + 模型分離 + waitForContent

**Goal**: 跑 /test-real 真實驗證 → 修所有 bug → 多 agent 並行 → 模型優化 → 穩定化

**Done (this session, 13 commits `93fb327..15ec45f`)**:

### 已完成實驗 ✅

1. **Build + Daemon 啟動** — SDK 型別修正 5 處、launcher CLI、tsx ESM workaround
2. **Chrome 自動化** — 反偵測（ignoreDefaultArgs + disable AutomationControlled）、viewport 1440x900、restore dialog 消除（Preferences exit_type=Normal）
3. **Google Session 驗證** — daemon 啟動時導航 NotebookLM 檢查登入、未登入保留 tab、reauth 導航 + loggedIn 即時更新
4. **create_notebook typed tool** — agent 建立+命名、click-navigate 提取 URL、自動 register
5. **paste(clear=true)** — JS `document.activeElement.select()` 取代不可靠的鍵盤 SelectAll
6. **Goal-oriented prompt 架構** — happy path 當參考不當指令、UI map 參數是高信心參考、觀察→行動→驗證 loop
7. **Planner WHAT-not-HOW** — Planner systemMessage 明確規則：executorPrompt 只描述目標
8. **模型分離** — Planner=gpt-4.1（分類夠用）、Executor=gpt-5-mini（需推理+視覺）
9. **waitForContent tool** — 瀏覽器端 hash polling 到穩定，取代 wait(15)+read()，查詢等待從 15s→4-7s
10. **Debug logging** — NBCTL_DEBUG=1 記錄 tool args/result、log file 寫入 ~/.nbctl/logs/daemon.log
11. **多 agent 並行** — 2 notebook 同時 add-source + query 全部成功
12. **Input gate** — Rejected(off_topic) + Rejected(ambiguous) 正確回傳
13. **shutdown 移除** — MCP 不暴露破壞性 daemon 生命週期操作
14. **register_notebook 改名** — add_notebook → register_notebook（語義正確）

### 未完成 / 待實驗 ❌

1. **Script-first + Agent-as-supervisor** — 確定性 script 跑 happy path，agent 只做啟動/驗證/修復。預估 100s→15-20s。用戶有其他想法在實驗中
2. **Content pipeline 改善** — URL 用 crawl4AI 轉 markdown（目前用 readability）、PDF 轉 markdown（目前純文字）、repo 超限自動分段（目前直接拒絕）
3. **Tab pool 一致性** — create_notebook URL 提取應走 acquireTab/releaseTab
4. **Untracked tabs 攔截** — NotebookLM click 開新 tab（target=_blank），pool 不知道
5. **URL normalize** — 已修 register_notebook 的比較，但全系統 URL 處理需統一
6. **agent prompt 自我修復驗證** — GPT-5-mini 有 retry 能力，但需更多場景測試
7. **多筆記本 concurrent 加入 test-real checklist**
8. **Patchright 替代 puppeteer** — 參考 notebooklm-mcp 專案，反偵測更好

**Decisions**:
- Planner 用 gpt-4.1 夠用，Executor 用 gpt-5-mini 推理能力值得成本
- prompt 風格：goal + reference flow + verified UI labels，不是 rigid script
- waitForContent 用瀏覽器端 hash polling（djb2），穩定後才傳回文字（零 LLM 呼叫）
- 下一步方向：Script-first + Agent-as-supervisor 混合架構

**State**: Branch `001-mvp` at `15ec45f`。640 tests ✅。13 commits this session。

**Next**:
- [ ] Script-first + Agent-as-supervisor 架構設計（用戶在實驗）
- [ ] Content pipeline: crawl4AI / PDF markdown / repo 分段
- [ ] Tab pool + untracked tabs
- [ ] 更多 agent prompt 場景測試

**User Notes**:
- 用戶認為 LLM 負責啟動工具跟監督紀錄而已，所有流程跑 script，LLM 負責最後驗證跟修復 script 的工作。這樣專案兼具速度和 agent 應付不穩定的價值
- 要明確紀錄實驗項目（做了跟沒做的部分）
- notebooklm-skill / notebooklm-mcp 兩個專案已研究，核心只做 query，用 Patchright + session pool
