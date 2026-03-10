# MCP Tool Definitions: NotebookLM Controller

**Branch**: `001-mvp` | **Date**: 2026-03-10 | **Spec**: [spec.md](../spec.md)
**Transport**: Streamable HTTP, `127.0.0.1:19224`
**Protocol**: MCP (Model Context Protocol), `@modelcontextprotocol/sdk`

> 取代先前的 `http-api.yaml`（REST HTTP API）。MCP Server 介面下，
> 所有操作透過 MCP tool call 進行，不再有 REST endpoint。

---

## 操作指令

### `exec`

將自然語言指令傳送給 notebook 的 agent session。

**Input Schema**:
```typescript
{
  prompt: z.string().describe("自然語言指令"),
  notebook: z.string().optional().describe("目標 notebook alias（未提供時使用 default）"),
  async: z.boolean().default(false).describe("true 時立即返回 taskId，不等待完成"),
  context: z.string().optional().describe("操作情境描述（僅 async 模式，出現在完成通知中）"),
}
```

**Output** (sync mode):
```json
{ "success": true, "answer": "...", "citations": [...] }
```
or operation-specific result (sourceAdded, screenshot, etc.)

**Output** (async mode):
```json
{ "taskId": "abc123", "status": "queued", "notebook": "research",
  "hint": "呼叫 get_status tool（taskId='abc123'）查詢結果。" }
```

**Error**:
```json
{ "success": false, "error": "No target notebook. 指定 notebook 參數或呼叫 set_default tool。" }
```

---

## 狀態查詢

### `get_status`

查詢 daemon 狀態或特定任務狀態。三種模式：

**Input Schema**:
```typescript
{
  taskId: z.string().optional().describe("查詢特定任務"),
  all: z.boolean().optional().describe("列出所有近期任務"),
  recent: z.boolean().optional().describe("列出近期已完成但未推送的任務"),
  notebook: z.string().optional().describe("篩選特定 notebook 的任務"),
  limit: z.number().default(20).describe("任務列表數量上限"),
}
```

**Output** (no params — daemon status):
```json
{
  "running": true,
  "tabManager": { "activeTabs": 3, "maxTabs": 10 },
  "network": { "status": "healthy", "backoffRemainingMs": null },
  "activeNotebooks": ["research", "ml-papers"],
  "defaultNotebook": "research",
  "pendingTasks": 2, "runningTasks": 1
}
```

**Output** (taskId):
```json
{
  "taskId": "abc123", "status": "completed",
  "notebookAlias": "research", "command": "...",
  "result": {...}, "history": [...]
}
```

**Output** (all/recent):
```json
[
  { "taskId": "abc123", "notebook": "research", "status": "completed",
    "command": "...", "createdAt": "..." },
  ...
]
```

---

## Notebook 管理

### `add_notebook`

納管既有 NotebookLM notebook。

**Input Schema**:
```typescript
{
  url: z.string().describe("NotebookLM notebook URL"),
  alias: z.string().describe("使用者指定的唯一別名"),
}
```

**Output**: `{ "success": true, "id": "research", "url": "...", "title": "...", "description": "...", "sources": [...] }`
**Error**: `{ "success": false, "error": "Invalid NotebookLM URL..." }` 或 `"URL already registered as '...'"` 或 `"Alias '...' already in use"`

### `add_all_notebooks`

批次納管帳號中所有 notebook（互動式）。

**Input Schema**: `{}`（無參數）

**Output**: `{ "success": true, "added": 5, "skipped": 3, "notebooks": [...] }`

### `list_notebooks`

列出所有已註冊 notebook。

**Input Schema**: `{}`（無參數）

**Output**:
```json
[
  { "id": "research", "url": "...", "title": "...", "description": "...",
    "status": "ready", "active": true, "sourceCount": 5 },
  ...
]
```

### `open_notebook`

標記已註冊 notebook 為 active。

**Input Schema**:
```typescript
{
  alias: z.string().describe("Notebook 別名"),
}
```

**Output**: `{ "success": true, "id": "research", "url": "...", "status": "ready" }`
**Error**: `{ "success": false, "error": "Notebook '<alias>' not registered..." }`

### `close_notebook`

關閉 notebook 的 tab，保留註冊資訊。

**Input Schema**:
```typescript
{
  alias: z.string().describe("Notebook 別名"),
}
```

**Output**: `{ "success": true }`

### `set_default`

設定預設 notebook。

**Input Schema**:
```typescript
{
  alias: z.string().describe("Notebook 別名"),
}
```

**Output**: `{ "success": true, "default": "research" }`

### `rename_notebook`

變更 notebook 別名。

**Input Schema**:
```typescript
{
  oldAlias: z.string().describe("現有別名"),
  newAlias: z.string().describe("新別名"),
}
```

**Output**: `{ "success": true, "oldAlias": "research", "newAlias": "my-research" }`
**Error**: `{ "success": false, "error": "Alias '...' already in use." }`

### `remove_notebook`

從管理中移除 notebook（不刪除 NotebookLM 上的筆記本）。

**Input Schema**:
```typescript
{
  alias: z.string().describe("Notebook 別名"),
}
```

**Output**: `{ "success": true, "removed": "ml-papers" }`

---

## 任務管理

### `cancel_task`

取消排隊或執行中的任務。

**Input Schema**:
```typescript
{
  taskId: z.string().describe("任務 ID"),
}
```

**Output** (queued → cancelled):
```json
{ "taskId": "abc123", "status": "cancelled", "cancelledAt": "..." }
```

**Output** (running → cancelled):
```json
{ "taskId": "abc123", "status": "cancelled", "cancelledAt": "...",
  "hint": "Agent will stop at next safe point." }
```

**Error** (terminal state):
```json
{ "success": false, "error": "Task already in terminal state: completed" }
```

---

## 認證與系統

### `reauth`

重新認證 Google session（headed mode）。

**Input Schema**: `{}`（無參數）

**Output**: `{ "success": true, "message": "Re-authenticated successfully" }`

### `list_agents`

列出所有已載入的 agent config。

**Input Schema**: `{}`（無參數）

**Output**:
```json
[
  { "name": "add-source", "version": "1.0.0", "description": "..." },
  ...
]
```

### `shutdown`

關閉 daemon（關閉所有 tab + Chrome + 釋放資源）。

**Input Schema**: `{}`（無參數）

**Output**: `{ "success": true, "message": "Daemon stopped" }`

---

## MCP Notification

非同步操作完成後，daemon 透過 MCP notification 推送結果至連線中的 client。

**Notification method**: `notifications/task-completed`

**Payload**:
```json
{
  "taskId": "abc123",
  "status": "completed",
  "notebook": "research",
  "result": { "success": true, "sourceAdded": "my-project (repo)" },
  "originalContext": "把 repo 加入來源",
  "command": "把 ~/code/my-project 的程式碼加入來源",
  "timestamp": "2026-02-12T10:30:00Z"
}
```

**行為**:
- Fire-and-forget：不補發。
- Client 斷線時結果保留在 task store，可透過 `get_status` tool 查詢。
- 失敗操作標記為 urgent 優先推送。

---

## 共用型別

### ErrorResponse

所有 tool 的錯誤回應格式：
```json
{ "success": false, "error": "<錯誤描述>" }
```

### NotebookStatus

```typescript
type NotebookStatus = "ready" | "operating" | "closed" | "stale" | "error";
```

### TaskStatus

```typescript
type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
```
