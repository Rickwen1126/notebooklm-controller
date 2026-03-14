---
description: "Run real operation tests against live daemon via MCP. Tests the full stack: MCP client → daemon → agent → Chrome → NotebookLM."
---

# Real Operation Test

使用 Claude Code 本身作為 MCP client，對真實的 daemon 執行完整操作驗證。
每一步都是真實的 MCP tool call，不是 mock。

## 使用方式

```
/test-real                    # 完整 checklist
/test-real quick              # 只跑 Phase 0 + Phase 1（infra smoke）
/test-real from:3             # 從 Phase 3 開始（跳過已驗證的步驟）
```

## 執行前提

- Daemon 已啟動（`npx nbctl`）且 MCP 已連線（Claude Code 能看到 nbctl tools）
- 如果 daemon 未啟動，本 skill 會指引你啟動

---

## Phase 0: Pre-flight（環境檢查）

### 0.1 Daemon 連線
**操作**：呼叫 `get_status`（不帶參數）
**成功**：回傳 `{ running: true, browserConnected: true }`
**超時**：5 秒無回應

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| Tool not found | daemon 未啟動或 MCP 未連線 | 確認 `npx nbctl` 已啟動，確認 `.mcp.json` 設定正確，重新連線 |
| `browserConnected: false` | Chrome 啟動失敗 | 檢查 Chrome 是否安裝、port 是否被佔用、log 輸出 |
| `running: false` | daemon 異常 | 檢查 `~/.nbctl/daemon.pid`，殺掉殘留 process，重啟 |
| Timeout | daemon hang 或 MCP transport 問題 | 檢查 daemon stdout/stderr log |

### 0.2 Agent 健康
**操作**：確認 `get_status` 回傳的 `agentHealth.degraded === false`
**失敗**：daemon 之前有連續 timeout → 呼叫 `reauth` 或重啟 daemon

### 0.3 Agent Configs 載入
**操作**：呼叫 `list_agents`
**成功**：回傳 >= 8 個 agent configs（add-source, query, manage-notebook, list-sources, rename-source, remove-source, generate-audio, download-audio）
**失敗**：agents/ 目錄缺失或 YAML parse error → 檢查 agents/*.md 檔案

### 0.4 Google Session
**操作**：呼叫 `exec(prompt="截圖", notebook="__any__")`
**成功**：回傳截圖（不是 Google 登入頁面）
**注意**：如果沒有任何 notebook 納管，先跳到 Phase 1

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| 截圖顯示 Google 登入頁面 | Session 過期 | 呼叫 `reauth` → 使用者在瀏覽器中完成登入 → 重試 |
| `reauth` 失敗 | userDataDir 損壞 | 刪除 `~/.nbctl/profiles/` → 重啟 daemon → 重新登入 |

**Phase 0 通過標準**：daemon running + Chrome connected + agents loaded + session valid

---

## Phase 1: Notebook 管理 Tools

### 1.1 add_notebook
**操作**：準備一個真實的 NotebookLM notebook URL（使用者提供或用已知的 test notebook）
```
add_notebook(url="https://notebooklm.google.com/notebook/{id}", alias="nbctl-test-{timestamp}")
```
**成功**：`{ success: true, id: "nbctl-test-..." }`
**超時**：30 秒

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| Invalid URL format | URL 不是 NotebookLM 格式 | 確認 URL 格式 `https://notebooklm.google.com/notebook/<id>` |
| URL already registered | 重複納管 | 用不同 alias 或先 `remove_notebook` |
| Tab 開啟失敗 | Chrome tab 問題 | `get_status` 確認 tabPool 狀態，可能需重啟 daemon |
| 頁面載入超時 | 網路或 NotebookLM 服務問題 | 確認網路連線，確認 notebooklm.google.com 可訪問 |

**如果使用者沒有現成的 test notebook**：
1. 呼叫 `exec(prompt="建立一本新的筆記本叫 nbctl-test")` 讓 agent 建立
2. 記錄回傳的 URL 供後續使用
3. 注意：這本身就是一個 real operation test（exec → Planner → manage-notebook agent → 建立新筆記本）

### 1.2 list_notebooks
**操作**：`list_notebooks`
**成功**：回傳陣列中包含剛註冊的 `nbctl-test-...`
**驗證**：alias 正確、URL 正確、status 為 ready

### 1.3 set_default
**操作**：`set_default(alias="nbctl-test-...")`
**成功**：`{ success: true, default: "nbctl-test-..." }`
**驗證**：後續 `exec` 不帶 notebook 參數時自動使用此 notebook

### 1.4 rename_notebook
**操作**：`rename_notebook(oldAlias="nbctl-test-...", newAlias="nbctl-test-renamed")`
**成功**：`{ success: true }`
**驗證**：`list_notebooks` 顯示新 alias
**回復**：rename 回原名（或用新名繼續後續 test）

### 1.5 get_status（帶 notebook 資訊）
**操作**：`get_status`
**驗證**：`openNotebooks` 包含 test notebook、`tabPool` 數據正確

**Phase 1 通過標準**：notebook 可納管、列表、重命名、設定預設

---

## Phase 2: Content Pipeline（exec 真實操作）

### 2.1 加入 Repo 來源
**操作**：
```
exec(prompt="把 {本專案路徑} 的程式碼加入來源", notebook="nbctl-test-...")
```
用本專案自己（`/Users/rickwen/code/notebooklm-controller`）作為 test repo。
**成功**：`{ success: true, ... }` — task completed
**超時**：120 秒（repomix 轉換 + agent paste + NotebookLM 處理）
**截圖驗證**：呼叫 `exec(prompt="截圖")` → 確認來源面板出現新來源

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| repomix 失敗 | 路徑不是 git repo 或 repomix 未安裝 | 確認路徑、`npx repomix --version` |
| Planner 選錯 agent | Planner routing 問題 | 檢查 Planner systemMessage、agent catalog |
| Executor paste 失敗 | NotebookLM UI 變化 | 截圖診斷 → 可能需更新 agent prompt 或 UI map |
| 500K limit exceeded | repo 太大 | 用更小的 test repo 或 fixture |
| Task timeout | agent 卡住 | `get_status(taskId)` 查看狀態、截圖查看卡在哪 |
| `agentHealth: degraded` | 連續 timeout 觸發 circuit breaker | 重啟 daemon |

### 2.2 查詢來源狀態
**操作**：
```
exec(prompt="列出所有來源")
```
**成功**：回傳包含剛加入的 repo 來源
**截圖驗證**：來源面板可見

### 2.3 向 Notebook 提問
**操作**：
```
exec(prompt="這個專案使用什麼技術棧？用了哪些主要的 npm 套件？")
```
**成功**：回傳包含 `answer` 文字（提到 TypeScript、puppeteer、copilot-sdk 等）
**超時**：90 秒（等 Gemini 回答）
**截圖驗證**：聊天區域有回答內容

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| Notebook has no sources | 來源尚未處理完成 | 等待 30 秒重試（NotebookLM 處理來源需要時間） |
| Answer timeout | Gemini 回應慢 | 增加 wait 時間、重試 |
| 空回答 | chat area 讀取 selector 失效 | 截圖確認 UI 狀態，可能需更新 read selector |
| 回答品質差（無法提到 TypeScript） | 來源未被正確解析 | 確認來源是否 ready、來源內容是否正確 |

### 2.4 URL 來源（如果 urlToText 已實作）
**操作**：
```
exec(prompt="把 https://example.com 的內容加入來源")
```
**成功**：來源新增成功
**注意**：example.com 內容極簡，可改用其他 public URL

### 2.5 Input Gate 驗證
**操作**：
```
exec(prompt="幫我訂一份披薩")
```
**成功**：回傳 rejected（Planner rejectInput tool）
**驗證**：`rejectionCategory` 為 `off_topic`

| 失敗情境 | 診斷 | 處置 |
|----------|------|------|
| Planner 嘗試執行而非拒絕 | Planner prompt 不夠明確 | 更新 Planner systemMessage 的規則 #5 |
| 沒有 rejectInput 而是 throw | rejectInput tool 未正確注入 | 檢查 runPlannerSession 的 tool 陣列 |

**Phase 2 通過標準**：repo source 可加入、可查詢、可提問取得 grounded answer、非 NotebookLM 請求被拒絕

---

## Phase 3: Async 操作 + Task 管理

### 3.1 Async Submit
**操作**：
```
exec(prompt="列出所有來源", notebook="nbctl-test-...", async=true)
```
**成功**：立即回傳 `{ taskId: "...", status: "queued" }`（不等完成）

### 3.2 Task 追蹤
**操作**：`get_status(taskId="剛拿到的 taskId")`
**成功**：status 為 `queued` / `running` / `completed`
**輪詢**：每 5 秒查一次，最多 60 秒

### 3.3 Task 取消（可選）
**操作**：先提交一個 async task，立即呼叫 `cancel_task(taskId)`
**成功**：task 變為 cancelled
**注意**：queued 狀態可直接取消，running 狀態需等安全點

### 3.4 MCP Notification（觀察）
**說明**：async task 完成後 daemon 應推送 MCP notification。
Claude Code 作為 MCP client 應收到通知。
**驗證方式**：觀察 Claude Code 是否收到操作完成的通知訊息

**Phase 3 通過標準**：async submit + task tracking + cancel 正常

---

## Phase 4: Error Handling + Edge Cases

### 4.1 不存在的 Notebook
**操作**：`exec(prompt="截圖", notebook="completely-nonexistent-notebook")`
**成功**：回傳清楚的 error message（Notebook not found）

### 4.2 空 Prompt
**操作**：`exec(prompt="")`
**成功**：回傳 error（prompt required）

### 4.3 無預設 Notebook 且未指定
**前置**：先移除 default（如果有）
**操作**：`exec(prompt="截圖")`（不帶 notebook）
**成功**：回傳 error（No target notebook）

### 4.4 重複 URL 註冊
**操作**：用已註冊的 URL 再次 `add_notebook`
**成功**：回傳 error（URL already registered）

**Phase 4 通過標準**：所有 error case 回傳結構化 error，不 crash

---

## Phase 5: Cleanup

### 5.1 移除 Test Notebook
**操作**：`remove_notebook(alias="nbctl-test-...")`
**成功**：`{ success: true, removed: "..." }`
**驗證**：`list_notebooks` 不再包含 test notebook

### 5.2 Daemon 關閉
**操作**：`shutdown`
**成功**：daemon 乾淨關閉
**驗證**：daemon process 不再存在

### 5.3 重新啟動驗證（可選）
**操作**：重啟 daemon → `list_notebooks`
**驗證**：test notebook 已移除、其他 notebook 仍在（State 持久化正確）

---

## 結果記錄

每個 Phase 完成後記錄：

```
Phase {N}: {PASS/FAIL}
  ✅ step 1.1: description (Xs)
  ✅ step 1.2: description (Xs)
  🔴 step 1.3: description — FAILED: {reason}
      → 診斷: {what was found}
      → 處置: 🔧 fix now / 📝 accumulate
  ✅ step 1.4: description (Xs)
```

### 失敗標記

| 標記 | 意義 | 動作 |
|------|------|------|
| 🔴 FIX NOW | 影響後續測試、安全問題、資料正確性 | 立即修復 → 重跑該 Phase |
| 🟡 ACCUMULATE | 非阻塞問題、UX 改善、edge case | 記錄 → 全部測完後批次修復 |
| ⏱️ TIMEOUT | 操作超時 | 記錄超時時間 + 截圖 → 判斷是環境問題還是 code 問題 |
| ⚠️ FLAKY | 時好時壞 | 重試一次 → 仍失敗標 🔴，通過標 ⚠️ 記錄 |

### 超時預設值

| 操作 | 超時 | 超時處置 |
|------|------|---------|
| get_status / list_notebooks / list_agents | 10s | daemon 可能 hang → 重啟 |
| add_notebook / set_default / rename / remove | 30s | Tab 問題 → 檢查 tabPool |
| exec sync（截圖/列表） | 60s | Agent 卡住 → 截圖診斷 |
| exec sync（加來源） | 120s | repomix + paste 流程長 → 正常偏慢 |
| exec sync（查詢） | 90s | Gemini 回應慢 → 可能需重試 |
| exec async submit | 10s | 應立即回傳 → 如果慢是 scheduler 問題 |
| reauth | 120s | 使用者需手動登入 |

### 截圖收集

每個涉及 NotebookLM UI 操作的步驟後：
1. 呼叫 `exec(prompt="截圖")` 取得當前畫面
2. 確認截圖非白屏（base64 長度 > 1000）
3. 視覺確認關鍵 UI 狀態（來源面板、聊天區域、error dialog 等）
4. 如果步驟失敗，截圖是最重要的診斷資料

---

## 完成後

所有 Phase 通過後輸出：

```
=== Real Operation Test Results ===
Phase 0: Pre-flight        ✅ PASS (Xs)
Phase 1: Notebook Mgmt     ✅ PASS (Xs)
Phase 2: Content Pipeline   ✅ PASS (Xs)
Phase 3: Async + Tasks     ✅ PASS (Xs)
Phase 4: Error Handling    ✅ PASS (Xs)
Phase 5: Cleanup           ✅ PASS (Xs)

Total: {N}/{N} steps passed
Duration: {total}s
Issues found: {count} (🔴 {n} / 🟡 {n} / ⚠️ {n})
```

如果有 🔴 issues：
1. 列出所有 🔴 issues + 診斷結果
2. 詢問使用者：「要現在修還是先記錄？」
3. 修完後重跑失敗的 Phase

如果有 🟡 issues：
1. 列出所有 🟡 issues
2. 建議修復順序
3. 可以在下次 session 處理
