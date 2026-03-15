---
description: "Run real operation tests against live daemon via direct HTTP + ISO Browser independent verification."
---

# Real Operation Test (G2 Script-first)

直接對 daemon 送 HTTP 請求驗證完整 stack：curl → daemon → Planner → Script → Chrome → NotebookLM。
每步操作完成後，用 **iso-browser 獨立進 NotebookLM 頁面親自驗證**（DOM 讀取 + scroll + 視覺確認）。

## 使用方式

```
/test-real                    # 完整 checklist
/test-real quick              # 只跑 Phase 0 + Phase 1（infra smoke）
/test-real from:3             # 從 Phase 3 開始
```

## 執行前提

- Daemon 已啟動：`npx tsx src/daemon/launcher.ts` 或 `npx nbctl`（`--no-headless` 方便觀察）
- Daemon port 在 `~/.nbctl/state.json` 的 `daemon.port`，或預設 19224
- ISO Browser 已安裝：`npm install --prefix ~/.claude/skills/iso-browser`

---

## HTTP Helper

所有 MCP 操作透過這個 helper 執行。先建立 session，後續帶 session ID：

```bash
# 1. 建立 session（拿 SESSION_ID）
SESSION_RESP=$(curl -si http://127.0.0.1:19224/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-real","version":"1.0"}}}')
SESSION_ID=$(echo "$SESSION_RESP" | grep -i "mcp-session-id" | sed 's/.*mcp-session-id: //' | tr -d '\r')

# 2. 呼叫 tool
mcp_call() {
  local id=$1 tool=$2 args=$3
  curl -s http://127.0.0.1:19224/mcp -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
    | grep "^data:" | sed 's/^data: //'
}
```

## ISO Browser 驗證 Protocol

**每個 exec 操作完成後**，用 iso-browser 獨立進同一個 NotebookLM 頁面驗證結果。
不信任 daemon 的文字回報 — 親自用 DOM 讀取確認。

```bash
ISO=~/.claude/skills/iso-browser/scripts

# 啟動（首次需登入 Google）
ISO_PORT=$($ISO/start.js)

# 導航到 notebook
$ISO/nav.js "https://notebooklm.google.com/notebook/<ID>" --port $ISO_PORT

# DOM 讀取驗證
$ISO/eval.js --port $ISO_PORT 'document.querySelectorAll(".source-panel [class*=source]").length'
$ISO/eval.js --port $ISO_PORT 'document.querySelector("h1")?.textContent'
$ISO/eval.js --port $ISO_PORT 'document.querySelector(".to-user-container .message-content")?.textContent?.slice(0,200)'

# 截圖
$ISO/screenshot.js --port $ISO_PORT
```

**驗證原則**：
1. daemon exec 回傳結果 → 記下文字結果
2. iso-browser 進同一頁面 → DOM 讀取實際狀態
3. 比對兩者是否一致
4. 可以 scroll、切 tab、讀特定 selector — 比截圖精準

---

## Phase 0: Pre-flight

### 0.1 Daemon 可連線
```bash
curl -si http://127.0.0.1:19224/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
```
**成功**：HTTP 200，response header 有 `mcp-session-id`

| 失敗 | 診斷 | 處置 |
|------|------|------|
| Connection refused | daemon 未啟動 | `npx tsx src/daemon/launcher.ts` |
| 404 / wrong port | port 不對 | 查 `~/.nbctl/state.json` daemon.port |
| Not Acceptable | 缺 Accept header | 加 `-H "Accept: application/json, text/event-stream"` |

### 0.2 get_status
```bash
mcp_call 2 "get_status" "{}"
```
**成功**：`{ running: true, browserConnected: true, agentHealth: { degraded: false } }`

### 0.3 list_agents（現在回傳 script operations）
```bash
mcp_call 3 "list_agents" "{}"
```
**成功**：`{ operations: ["query","addSource","listSources",...], catalog: "..." }`
**驗證**：operations 包含 10 個操作名稱

### 0.4 ISO Browser 可連線
```bash
ISO_PORT=$($ISO/start.js)
$ISO/nav.js "https://notebooklm.google.com" --port $ISO_PORT
$ISO/eval.js --port $ISO_PORT 'document.title'
```
**成功**：title 包含 "NotebookLM"（已登入 Google）
**失敗**：跳轉到 accounts.google.com → 需要先在 iso-browser 登入 Google

**Phase 0 通過標準**：MCP session + daemon running + 10 operations loaded + iso-browser 可訪問 NotebookLM

---

## Phase 1: Notebook 管理

### 1.1 list_notebooks（初始狀態）
```bash
mcp_call 10 "list_notebooks" "{}"
```
記錄現有 notebooks，確認 `nbctl-test` 不存在（或先 remove）

### 1.2 register_notebook
```bash
mcp_call 11 "register_notebook" '{"url":"https://notebooklm.google.com/notebook/<ID>","alias":"nbctl-test"}'
```
**成功**：`{ success: true }`

如果沒有現成 notebook：
```bash
mcp_call 11 "exec" '{"prompt":"建立一本新的筆記本叫 nbctl-test"}'
```
拿回 URL 再 register_notebook

### 1.3 list_notebooks（驗證）
```bash
mcp_call 12 "list_notebooks" "{}"
```
**成功**：陣列包含 `nbctl-test`

### 1.4 set_default
```bash
mcp_call 13 "set_default" '{"alias":"nbctl-test"}'
```
**成功**：`{ success: true, default: "nbctl-test" }`

**Phase 1 通過標準**：notebook CRUD + 預設設定正常

---

## Phase 2: G2 All-Ops Happy Path（S01-S12 等效）

> G2 架構：Planner LLM → deterministic Script → 0 LLM execution cost。
> 每步操作後用 iso-browser 獨立驗證。

### S01: listSources（baseline）
```bash
mcp_call 20 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test"}'
```
**驗證**：記錄初始 source 數量
**ISO 驗證**：
```bash
$ISO/nav.js "<notebook-url>" --port $ISO_PORT
$ISO/eval.js --port $ISO_PORT '(() => { const p = document.querySelector(".source-panel"); return p ? p.querySelectorAll("[class*=source-item], [class*=source-card], li, [role=listitem]").length : 0 })()'
```

### S02: addSource（加入測試文字來源）
```bash
mcp_call 21 "exec" '{"prompt":"加入一個文字來源，內容是：G2 測試來源。TypeScript 是一種靜態型別的程式語言。","notebook":"nbctl-test"}'
```
**成功**：`{ success: true }`
**ISO 驗證**：source panel 數量 = S01 + 1

### S03: listSources（驗證 +1）
```bash
mcp_call 22 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test"}'
```
**驗證**：數量 = S01 + 1
**ISO 驗證**：eval source count 一致

### S04: renameSource
```bash
mcp_call 23 "exec" '{"prompt":"把第一個來源重新命名為 G2-Test-Renamed","notebook":"nbctl-test"}'
```
**ISO 驗證**：
```bash
$ISO/eval.js --port $ISO_PORT 'document.querySelector(".source-panel")?.textContent?.includes("G2-Test-Renamed")'
```

### S05: query
```bash
mcp_call 24 "exec" '{"prompt":"問 NotebookLM：TypeScript 是什麼？","notebook":"nbctl-test"}'
```
**成功**：answer 文字非空
**ISO 驗證**：
```bash
$ISO/eval.js --port $ISO_PORT '(() => { const el = document.querySelector(".to-user-container .message-content"); return el ? el.textContent.trim().slice(0, 200) : null })()'
```
確認 chat 區有回答

### S06: clearChat
```bash
mcp_call 25 "exec" '{"prompt":"清除對話記錄","notebook":"nbctl-test"}'
```
**ISO 驗證**：
```bash
$ISO/eval.js --port $ISO_PORT 'document.querySelectorAll(".message-content").length'
```
確認 = 0（對話已清空）

### S07: removeSource
```bash
mcp_call 26 "exec" '{"prompt":"移除第一個來源","notebook":"nbctl-test"}'
```
**ISO 驗證**：source count = S01（回到 baseline）

### S08: listSources（驗證 -1）
```bash
mcp_call 27 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test"}'
```
**驗證**：數量 = S01

### S09: listNotebooks（homepage）
```bash
mcp_call 28 "exec" '{"prompt":"列出所有筆記本"}'
```
**ISO 驗證**：
```bash
$ISO/nav.js "https://notebooklm.google.com" --port $ISO_PORT
$ISO/eval.js --port $ISO_PORT 'document.querySelectorAll("tr[tabindex]").length'
```

### S10: createNotebook
```bash
mcp_call 29 "exec" '{"prompt":"建立一本新的筆記本"}'
```
**成功**：回傳新 notebook URL
**ISO 驗證**：navigate 到 homepage，確認多一本 notebook

### S11: renameNotebook
```bash
mcp_call 30 "exec" '{"prompt":"把最新的筆記本重新命名為 G2-Test-Notebook"}'
```
**ISO 驗證**：
```bash
$ISO/nav.js "https://notebooklm.google.com" --port $ISO_PORT
$ISO/eval.js --port $ISO_PORT 'document.body.textContent.includes("G2-Test-Notebook")'
```

### S12: deleteNotebook
```bash
mcp_call 31 "exec" '{"prompt":"刪除名為 G2-Test-Notebook 的筆記本"}'
```
**ISO 驗證**：homepage 上不再有 G2-Test-Notebook

**Phase 2 通過標準**：10 scripted operations 全通過 + ISO Browser 獨立驗證全一致

---

## Phase 3: Recovery Test

> 手動 corrupt UIMap → script 失敗 → Recovery LLM 接手完成 → repair log 產生

### 3.1 Corrupt UIMap
```bash
# 備份原始 UIMap
cp ~/.nbctl/ui-maps/zh-TW.json ~/.nbctl/ui-maps/zh-TW.json.bak 2>/dev/null
# 從 bundled copy 建立 user override，改壞 chat_input
mkdir -p ~/.nbctl/ui-maps
cp src/config/ui-maps/zh-TW.json ~/.nbctl/ui-maps/zh-TW.json
# 用 sed 改壞 chat_input 的 text
```
手動修改 `~/.nbctl/ui-maps/zh-TW.json` 把 `chat_input.text` 改成 `"BROKEN_SELECTOR"`

### 3.2 執行 query（預期 script 失敗 → Recovery 接手）
```bash
mcp_call 40 "exec" '{"prompt":"問 NotebookLM：TypeScript 有什麼優勢？","notebook":"nbctl-test"}'
```
**成功**：回傳 answer（Recovery 完成了操作）
**超時**：180 秒（script 失敗 + Recovery session）

### 3.3 驗證 repair log
```bash
ls -la ~/.nbctl/repair-logs/
```
**成功**：有 `*_query_chat_input.json` 檔案
**驗證**：JSON 包含 `analysis` 欄位 + `suggestedPatch`

### 3.4 ISO 驗證 Recovery 結果
用 iso-browser 進 notebook，確認 chat 區有回答

### 3.5 還原 UIMap
```bash
rm ~/.nbctl/ui-maps/zh-TW.json  # 移除 corrupt override，回到 bundled
# 或還原備份
mv ~/.nbctl/ui-maps/zh-TW.json.bak ~/.nbctl/ui-maps/zh-TW.json 2>/dev/null
```

**Phase 3 通過標準**：corrupt selector → script fail → Recovery 完成 + repair log 有 analysis + patch

---

## Phase 4: Planner NL Dispatch

### 4.1 單步操作
```bash
mcp_call 50 "exec" '{"prompt":"問 NotebookLM TypeScript 是什麼","notebook":"nbctl-test"}'
```
**驗證**：Planner 選 `query` operation

### 4.2 多步組合
```bash
mcp_call 51 "exec" '{"prompt":"先加一個文字來源「Hello World」然後列出所有來源","notebook":"nbctl-test"}'
```
**驗證**：Planner 拆成 2 步（addSource + listSources）

### 4.3 拒絕 off-topic
```bash
mcp_call 52 "exec" '{"prompt":"幫我訂披薩","notebook":"nbctl-test"}'
```
**成功**：`rejected: true, rejectionCategory: "off_topic"`

**Phase 4 通過標準**：單步 + 多步 + 拒絕 全正確

---

## Phase 5: Async 操作 + Polling

### 5.1 Async Submit
```bash
mcp_call 60 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test","async":true}'
```
**成功**：立即回傳 `{ taskId: "...", status: "queued", next_action: "Call get_status..." }`

### 5.2 Poll 直到完成
```bash
TASK_ID="<從上一步取得>"
mcp_call 61 "get_status" "{\"taskId\":\"$TASK_ID\"}"
```
**成功**：status 從 queued → running → completed

### 5.3 Cancel 測試
```bash
mcp_call 62 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test","async":true}'
mcp_call 63 "cancel_task" '{"taskId":"<taskId>"}'
```
**成功**：`{ status: "cancelled" }`

**Phase 5 通過標準**：async submit + polling + cancel 正常

---

## Phase 6: Error Handling

```bash
# 6.1 不存在的 notebook
mcp_call 70 "exec" '{"prompt":"截圖","notebook":"nonexistent-notebook-xyz"}'
# 成功：{ success: false, error: "Notebook not found: ..." }

# 6.2 空 prompt
mcp_call 71 "exec" '{"prompt":""}'
# 成功：{ success: false, error: "'prompt' parameter is required" }
```

**Phase 6 通過標準**：所有 error case 回傳結構化 error，不 crash

---

## Phase 7: Cleanup

```bash
# 7.1 清除 S02 加的來源（如果還在）
mcp_call 80 "exec" '{"prompt":"移除所有測試來源","notebook":"nbctl-test"}'

# 7.2 移除 test notebook
mcp_call 81 "remove_notebook" '{"alias":"nbctl-test"}'

# 7.3 驗證移除
mcp_call 82 "list_notebooks" "{}"
# 成功：不含 nbctl-test

# 7.4 停止 ISO Browser
$ISO/stop.js --port $ISO_PORT
```

---

## 執行方式

Claude Code 用 **Bash tool** 跑 curl + **iso-browser CLI** 跑 DOM 驗證。

每個步驟流程：
1. 組出 curl 指令 → Bash tool 執行
2. 解析 `data:` SSE line → JSON
3. 驗證關鍵欄位
4. **iso-browser nav + eval 獨立驗證**（DOM 讀取，不只看文字回報）
5. 記錄結果

---

## 結果記錄

```
=== /test-real Results ===
Phase 0: Pre-flight            ✅ PASS (Xs)
Phase 1: Notebook Mgmt         ✅ PASS (Xs)
Phase 2: All-Ops Happy Path    ✅ PASS (Xs)  [S01-S12, 10 operations]
Phase 3: Recovery Test         ✅ PASS (Xs)  [corrupt → recovery → repair log]
Phase 4: Planner NL Dispatch   ✅ PASS (Xs)  [single + multi + reject]
Phase 5: Async + Tasks         ✅ PASS (Xs)
Phase 6: Error Handling        ✅ PASS (Xs)
Phase 7: Cleanup               ✅ PASS (Xs)

Total: {N}/{N} steps passed
Duration: {total}s
ISO Verification: {N}/{N} consistent
Issues: {list}
```

| 標記 | 意義 | 動作 |
|------|------|------|
| FIX NOW | 影響後續、資料正確性 | 立即修復 → 重跑 Phase |
| ACCUMULATE | 非阻塞、UX 改善 | 記錄 → 批次修復 |
| FLAKY | 時好時壞 | 重試一次再判斷 |

### 超時預設

| 操作 | 超時 |
|------|------|
| initialize / list_notebooks / get_status | 10s |
| register_notebook / set_default / remove_notebook | 30s |
| exec sync（listSources / clearChat / rename） | 90s |
| exec sync（query） | 90s |
| exec sync（addSource） | 120s |
| exec sync + Recovery | 180s |
| exec async submit | 10s（應立即回傳） |
| iso-browser eval | 10s |
