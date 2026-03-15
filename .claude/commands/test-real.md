---
description: "Run real operation tests against live daemon via direct HTTP. No Claude Code MCP connection needed — pure curl JSON-RPC."
---

# Real Operation Test

直接對 daemon 送 HTTP 請求驗證完整 stack：curl → daemon → agent → Chrome → NotebookLM。
不需要 Claude Code MCP 連線，MCP 就是 JSON-RPC over HTTP，curl 就夠了。

## 使用方式

```
/test-real                    # 完整 checklist
/test-real quick              # 只跑 Phase 0 + Phase 1（infra smoke）
/test-real from:3             # 從 Phase 3 開始
```

## 執行前提

- Daemon 已啟動：`npx tsx src/daemon/launcher.ts` 或 `npx nbctl`
- Daemon port 在 `~/.nbctl/state.json` 的 `daemon.port`，或預設 19224

---

## HTTP Helper

所有操作透過這個 helper 執行。先建立 session，後續帶 session ID：

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

實際執行時，Claude Code 用 Bash tool 直接跑這些 curl，解析回傳的 JSON。

---

## Phase 0: Pre-flight

### 0.1 Daemon 可連線
```bash
curl -s http://127.0.0.1:19224/mcp -X POST \
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

### 0.3 list_agents
```bash
mcp_call 3 "list_agents" "{}"
```
**成功**：>= 8 個 agent configs

**Phase 0 通過標準**：session 建立 + daemon running + browser connected + agents loaded

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

## Phase 2: Content Pipeline（exec 真實操作）

> exec 呼叫會跑 agent，需要等待。sync 模式直接等結果。

### 2.1 加入 Repo 來源
```bash
mcp_call 20 "exec" '{"prompt":"把 /Users/rickwen/code/notebooklm-controller 的程式碼加入來源","notebook":"nbctl-test"}'
```
**成功**：`{ success: true, ... }`
**超時**：120 秒（repomix + paste + NotebookLM 處理）

### 2.2 截圖確認來源
```bash
mcp_call 21 "exec" '{"prompt":"截圖","notebook":"nbctl-test"}'
```
**成功**：回傳 base64 截圖，視覺確認來源面板有新來源

### 2.3 列出來源
```bash
mcp_call 22 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test"}'
```
**成功**：包含剛加入的 repo 來源

### 2.4 Query
```bash
mcp_call 23 "exec" '{"prompt":"這個專案用什麼技術棧？列出主要 npm 套件","notebook":"nbctl-test"}'
```
**成功**：answer 提到 TypeScript、puppeteer、copilot-sdk 等
**超時**：90 秒

### 2.5 Input Gate
```bash
mcp_call 24 "exec" '{"prompt":"幫我訂一份披薩","notebook":"nbctl-test"}'
```
**成功**：`rejected: true, rejectionCategory: "off_topic"`

**Phase 2 通過標準**：repo source 加入 + query 有 grounded answer + off-topic 被拒絕

---

## Phase 3: Async 操作 + Polling

> async=true 立即回傳 taskId，由 Claude Code（或 curl loop）主動 poll。
> **注意：daemon 不會 push notification**（MCP SSE stateless client 限制，待研究）。
> 結果只能透過 get_status polling 取得。

### 3.1 Async Submit
```bash
mcp_call 30 "exec" '{"prompt":"列出所有來源","notebook":"nbctl-test","async":true}'
```
**成功**：立即回傳 `{ taskId: "...", status: "queued", next_action: "Call get_status..." }`

### 3.2 Poll 直到完成
```bash
# 拿到 taskId 後，每 15-20 秒 poll 一次
TASK_ID="<從上一步取得>"
mcp_call 31 "get_status" "{\"taskId\":\"$TASK_ID\"}"
```
**成功**：status 從 queued → running → completed
**超時**：60 秒

### 3.3 Cancel 測試
```bash
# Submit async task
mcp_call 32 "exec" '{"prompt":"截圖","notebook":"nbctl-test","async":true}'
# 取出 taskId，立刻 cancel
mcp_call 33 "cancel_task" '{"taskId":"<taskId>"}'
```
**成功**：`{ status: "cancelled" }`

**Phase 3 通過標準**：async submit + next_action 指引正確 + polling 拿到結果 + cancel 正常

---

## Phase 4: Error Handling

```bash
# 4.1 不存在的 notebook
mcp_call 40 "exec" '{"prompt":"截圖","notebook":"nonexistent-notebook-xyz"}'
# 成功：{ success: false, error: "Notebook not found: ..." }

# 4.2 空 prompt
mcp_call 41 "exec" '{"prompt":""}'
# 成功：{ success: false, error: "'prompt' parameter is required" }

# 4.3 重複 URL 註冊（用已存在的 URL）
mcp_call 42 "register_notebook" '{"url":"<nbctl-test 的 URL>","alias":"nbctl-test-dup"}'
# 成功：error（URL already registered）
```

**Phase 4 通過標準**：所有 error case 回傳結構化 error，不 crash

---

## Phase 5: Cleanup

```bash
# 5.1 移除 test notebook
mcp_call 50 "remove_notebook" '{"alias":"nbctl-test"}'
# 成功：{ success: true, removed: "nbctl-test" }

# 5.2 驗證移除
mcp_call 51 "list_notebooks" "{}"
# 成功：不含 nbctl-test
```

**不需要呼叫 shutdown**（daemon 繼續跑，其他 notebook 不受影響）

---

## 執行方式

Claude Code 用 **Bash tool** 直接跑 curl，解析 JSON，驗證欄位。

每個步驟流程：
1. 組出 curl 指令
2. `Bash` tool 執行
3. 解析 `data:` SSE line → JSON
4. 驗證關鍵欄位
5. 記錄結果

不需要等 LLM tool call round-trip，直接跑完整個 phase。

---

## 結果記錄

```
=== /test-real Results ===
Phase 0: Pre-flight        ✅ PASS (Xs)
Phase 1: Notebook Mgmt     ✅ PASS (Xs)
Phase 2: Content Pipeline  ✅ PASS (Xs)
Phase 3: Async + Tasks     ✅ PASS (Xs)
Phase 4: Error Handling    ✅ PASS (Xs)
Phase 5: Cleanup           ✅ PASS (Xs)

Total: {N}/{N} steps passed
Duration: {total}s
Issues: 🔴 {n} / 🟡 {n} / ⚠️ {n}
```

| 標記 | 意義 | 動作 |
|------|------|------|
| 🔴 FIX NOW | 影響後續、資料正確性 | 立即修復 → 重跑 Phase |
| 🟡 ACCUMULATE | 非阻塞、UX 改善 | 記錄 → 批次修復 |
| ⚠️ FLAKY | 時好時壞 | 重試一次再判斷 |

### 超時預設

| 操作 | 超時 |
|------|------|
| initialize / list_notebooks / get_status | 10s |
| register_notebook / set_default / remove_notebook | 30s |
| exec sync（截圖/列表/query） | 90s |
| exec sync（加來源） | 120s |
| exec async submit | 10s（應立即回傳） |

---

## 與舊版差異

舊版需要：Claude Code 作為 MCP client + daemon 連線 + tool call round-trip
新版只需要：daemon 啟動 + curl

MCP = JSON-RPC over HTTP，任何 HTTP client 都可以當 MCP client。
curl 測試比透過 Claude Code 快 5-10x，且完全不依賴 LLM 變數。
