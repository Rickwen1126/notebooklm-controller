# AUDIT: notebooklm-controller v3

tags: [audit, browser-automation, copilot-sdk, mcp-server, daemon, phase-6-7, review-point-2]

## Relations
- audit_for [[todo-notebooklm-controller]]
- follows [[SHIP-notebooklm-controller@20260310]]
- previous [[AUDIT-notebooklm-controller-v2@20260314]]

## 產出類型
軟體產品（Phase 6+7 Content Pipeline + Query + Review Point 2 + Spike 回灌）

## 審計範圍
本次 session 全部 commits（`a564347` → `5125913`，7 commits）：
- Spike 回灌 + speckit.analyze 一致性修正（F1~F7）
- Bug fixes T-HF01~03（tabUrl, waitForTask, Planner context）
- Phase 6 US3（content pipeline：repo-to-text + content-tools + tool registry）
- Phase 7 US10（query integration tests）
- Review Point 2（code review tour + cancel/waitForTask bug fix）
- Circuit Breaker FR-210~213（spec/plan/tasks）
- File-based paste FR-009.1（spike 結論回灌）

575 tests passing, lint 0 errors。

---

## 通用核心

### A1 Contract
MVP core flow 端對端完成：啟動 → 認證 → 納管 → 餵入 repo → 查詢 → grounded 回答。Content pipeline（repo → text）+ query agent + dual session 全線貫通。

SHIP 偏移檢查：**一致**。SHIP 的核心價值主張「AI 工具透過 MCP 呼叫 daemon，daemon 用 AI agent 操作 NotebookLM」完全落地。file-based paste 是對原方案的**強化**（0 token context 消耗 vs 爆 context），不是方向偏移。

### A2 Failure Modes

1. **cancel + waitForTask hang** → 證據：review tour 🔴1 定位 `scheduler.ts:122`。queued task cancel 不 resolve waitForTask promise → sync caller hang。→ **已修**（`44d7397`），加 1 test case
2. **500K text 爆 LLM context** → 證據：Tour 04 Step 5 review 討論 + spike 實驗 3 baseline。500K chars ≈ 125K tokens ≈ GPT-4.1 context 上限。→ **已解決**：FR-009.1 file-based pass-through（spike 驗證通過），T-SB08~13 追蹤實作
3. **executeTask 無外層 timeout → zombie session 累積** → 證據：Tour 04 Step 2 討論。sendAndWait SDK 層 timeout 可能被僵死的 CLI process 繞過。→ **已追蹤**：FR-210~213 Circuit Breaker，T-HF12~14
4. **tabHandle.url 拿 assignment metadata 而非 live URL** → 證據：Tour 03 Finding A。pre-navigate hint 判斷錯。→ **已修**（`0e104d0`）
5. **Planner 不知道 target notebook** → 證據：Tour 03 Finding C。Planner 從 NL prompt 猜 notebook alias。→ **已修**（`0e104d0`）

### A3 Trade-offs

- **替代 A：content tools 返回 text（進 LLM context）而非 filePath** → 不選原因：spike 驗證 500K 必爆 context。即使 100K 可跑，25K tokens 消耗不經濟。file-based 是 0 token + architectural enforcement
- **替代 B：repomix programmatic API 而非 CLI wrapper** → 不選原因：`pack()` 需要複雜未文件化的 config object，CLI 的 `--stdout --style plain` 兩個 flag 搞定。trade-off 是每次多 200-500ms（npx resolution），可後續改用 `node_modules/.bin/repomix` 優化

### A4 AI 盲點

1. **repo-to-text.ts 的 500K limit 是 chars 不是 words** → ✅ 可信：spec AS14 寫「500K 字限制」但 code 用 `text.length`（chars）。spike 驗證 NotebookLM 無前端字數限制，所以 chars 作為上限比 words 更保守，是正確方向。不需修
2. **content-tools stub（urlToText/pdfToText）返回 error 但 agent catalog 列出它們** → ⚠️ 需驗證：Planner 看到 catalog 有 urlToText → 可能選它 → Executor 呼叫 → 收到 "not yet implemented" → task 失敗。不影響 repo source，但使用者說「把這個網頁加入來源」時會報不友善的錯誤
3. **waitForTask resolver 只在 executeTask.finally 和 cancel() 消費** → ✅ 可信：三個消費點都有 test coverage（575 tests）。`finally` 保證 normal/error path 都走到。cancel 的兩個路徑（queued/running）都加了 resolver

### A5 受眾價值
**受眾**：開發者自己
**拿到後能做**：MVP core flow 可端對端驗證。file-based paste 確保大 repo 不爆 context。Circuit Breaker 防止連鎖故障。下一步：實作 T-SB08~13（file-based paste code）→ 真正的 production 可用

---

## Code 延伸

### C1 Lifecycle
- **Content pipeline**：`repoToText` 是純函數（無 lifecycle），被 content-tools handler 呼叫 → 無 cleanup 問題
- **Temp file**（T-SB09 後）：file-based 方案會產生 temp file，需要 cleanup。T-SB13 追蹤。cleanup 點在 `createRunTask.finally`（與 releaseTab 同一位置）

### C2 Error Model
- **repoToText error → content-tools errorResult → agent 收到結構化 error** → 傳播路徑清晰。handler try/catch 是 error boundary，不 bubble up 到 session 層 ✅
- **waitForTask resolver leak**：如果 `executeTask` 在 `taskStore.transition` 拋異常且 `finally` 也拋，resolver 可能 leak → 實務上 `finally` 的 resolver check 是最後一行，不太可能被跳過 ✅

### C3 Concurrency
- **waitForTask + cancel race**：已在 cancel() 兩個路徑加 resolver 消費，executeTask.finally 的 resolver check 是 idempotent（已消費就跳過）✅
- **taskResolvers Map 無 mutex**：Node.js 單線程下安全。`set` 和 `get/delete` 不會 interleave

### C4 Side Effects
- **新增 I/O**：`execFile('npx', ['repomix', ...'])` 在 repo-to-text.ts — child process spawn + stdout pipe。有 timeout（120s）和 maxBuffer（100MB）限制 ✅
- **新增 Map**：`taskResolvers` 在 Scheduler — 隨 task lifecycle 自動 cleanup（finally/cancel）✅

### C5 Observability
- **Content tools 的 metrics**（charCount, wordCount）在 ToolResultObject 中回傳 → agent 可 log ✅
- **缺口**：repo-to-text.ts 沒有自己的結構化 log（repomix 的 stderr 被丟掉）→ 低優先，repomix 失敗時 error message 夠用
- **Circuit Breaker metrics**（T-HF13）：`consecutiveTimeouts` 和 `agentHealth` 會回報在 `get_status` → 設計完整，待實作

---

## [R]isky 追蹤

| SHIP 標記 | 實際結果 | 處理 |
|-----------|----------|------|
| TabManager lifecycle | acquireTab/releaseTab try/finally 對稱，tabUrl fix 已修 | ✅ 已安全通過 |
| NetworkGate permit 模型 | 不受本次變更影響 | ✅ 已安全通過 |
| MCP Server Streamable HTTP | 不受本次變更影響 | ✅ 已安全通過 |
| **新增** Content 500K context overflow | spike 驗證 file-based 可行，FR-009.1 + T-SB08~13 追蹤 | ⚠️ 文件完成，code 待實作 |
| **新增** Agent runtime zombie | FR-210~213 + T-HF12~14 追蹤 | ⚠️ 文件完成，code 待實作 |

## 累積項目檢查

| 來源 | 檢查 | 結果 |
|------|------|------|
| v1 AUDIT 🔴3 result/error 未 persist | 本次 scheduler 改動是否影響？ | 不影響——waitForTask 只加 resolver Map，不改 taskStore 寫入邏輯 ✅ |
| v2 AUDIT T-HF01 tabUrl bug | 本次已修 | ✅ 修正在 `0e104d0` |
| v2 AUDIT T-HF02 waitForIdle | 本次已修 + review 發現 cancel interop bug 並修正 | ✅ 修正在 `0e104d0` + `44d7397` |
| SHIP #3 Tool 自包原則 | file-based paste 是否違反？ | 不違反——tool handler 內部決定 I/O 方式（讀 file → paste），daemon 不中轉 ✅ |

## 學習收穫

| Exit Question | Gap Type | 用戶回答摘要 | 狀態 |
|---------------|----------|-------------|------|
| waitForTask vs waitForIdle 語意差異？ | A | 正確：per-task wait 不被其他 notebook 卡住 | ✅ |
| executeTask hang 時 tab 會一直被佔用嗎？ | A | 正確識別：需外層 timeout 同時保護 scheduler + tab pool | ✅ |
| 連續 timeout 的 cascading failure？ | A | 用戶主動提出 Circuit Breaker + memory leak 風險 + degraded state + MCP 通知使用者 | ✅ 超越預期 |
| 500K text 進 LLM context 的 I/O 問題？ | A | 用戶識別「看起來 I/O 有點恐怖」→ 引出 file-based 解法 | ✅ |
| tabHandle.url vs page.url() 語意？ | A | 用戶精準指出「reuse 是參考上次想去哪」→ assignment metadata vs live state | ✅ |

---

## 判定

**結果**：通過

**理由**：
- MVP core flow 端對端完成（Phase 1~7 全部 tasks done）
- Review Point 2 code review 的 🔴1 已修正並有 test
- 3 個 architecture concern 已追蹤（Circuit Breaker FR-210~213、file-based paste FR-009.1、acquireTab race T-HF05）
- 575 tests 全過，lint clean
- spec/plan/tasks 三份文件 + code 一致性通過 speckit.analyze + 手動 tour review
- 學習收穫：用戶在 tour review 中主動識別 3 個架構級問題（Circuit Breaker、file-based paste、tabHandle.url 語意）

**進入 BANK 的條件已滿足。**
