# MCP Tools Contract: NotebookLM Controller

**Transport**: stdio（內嵌於 daemon 程序）
**Server name**: `notebooklm-controller`
**Server version**: `1.0.0`

## Tool: `notebooklm_exec`

對指定 notebook 執行自然語言指令。

### Input Schema

```json
{
  "notebookId": {
    "type": "string",
    "description": "Target notebook ID. If omitted, uses active notebook."
  },
  "command": {
    "type": "string",
    "description": "Natural language command for the agent (e.g., '把這個 repo 加入來源', '這篇論文的方法論是什麼？')"
  }
}
```

**Required**: `command`
**Optional**: `notebookId`

### Response

Success:
```json
{
  "content": [{
    "type": "text",
    "text": "{ \"success\": true, \"answer\": \"...\", \"citations\": [...] }"
  }]
}
```

Error:
```json
{
  "content": [{
    "type": "text",
    "text": "{ \"success\": false, \"error\": \"No active notebook. Use 'nbctl use <id>' to select one.\" }"
  }],
  "isError": true
}
```

### Behavior

1. 若提供 `notebookId` 且非當前 active notebook → 先切換（進入 operation queue）
2. 指令進入 operation queue 序列化執行
3. Agent 解讀自然語言，自主決定呼叫哪些 tools
4. 回傳結構化 JSON 結果

---

## Tool: `notebooklm_list_notebooks`

列出所有已註冊的 notebook。

### Input Schema

```json
{}
```

無參數。

### Response

```json
{
  "content": [{
    "type": "text",
    "text": "[{ \"id\": \"research\", \"url\": \"...\", \"title\": \"...\", \"description\": \"...\", \"status\": \"ready\", \"active\": true, \"sourceCount\": 5 }]"
  }]
}
```

### Behavior

1. 即時讀取記憶體中的 Notebook Registry（不進入 queue）
2. 回傳完整 notebook 清單含 description 欄位

---

## MCP Client Configuration

### Claude Code `.mcp.json`

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "nbctl",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

`nbctl mcp` 子命令啟動 MCP server mode（stdio transport），
連接到已執行中的 daemon（透過 HTTP API on localhost:19224）。

### Fallback: Daemon not running

當 daemon 未執行時，所有 tool call 回傳：
```json
{
  "content": [{
    "type": "text",
    "text": "{ \"error\": \"Controller daemon is not running. Start with 'nbctl start'.\" }"
  }],
  "isError": true
}
```
