# 快速上手：NotebookLM Controller

**對象**：使用 AI coding tool（如 Claude Code）的開發者
**前提**：已安裝 Node.js 22+、Google Chrome
**版本**：v2 — 對齊 spec v6（MCP Server + Single Browser Multi-tab）

## 安裝

```bash
npm install -g nbctl
```

## 第一次啟動

```bash
# 啟動 daemon（首次會開啟 Chrome 視窗讓你登入 Google）
npx nbctl
# → { "success": true, "mcp": "127.0.0.1:19224", "mode": "headed",
#     "hint": "Complete Google login in the browser window." }

# 完成 Google 登入後，daemon 自動持久化 session
# 後續啟動自動以 headless 模式運作
```

## 設定 MCP Client

所有操作透過 MCP protocol 進行。以 Claude Code 為例：

```jsonc
// .mcp.json 或 Claude Code MCP 設定
{
  "mcpServers": {
    "nbctl": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:19224/mcp"
    }
  }
}
```

連線後 AI 工具自動透過 `tools/list` 發現所有可用 tool。

## 納管既有 Notebook

透過 MCP tools 操作（以下以 tool call 語法表示）：

```
# 將已有的 NotebookLM notebook 加入管理
→ add_notebook(url="https://notebooklm.google.com/notebook/abc123", alias="research")
← { "success": true, "id": "research", "title": "...", "sources": [...] }

# 批次納管帳號中所有 notebook（互動式）
→ add_all_notebooks()
← 逐一展示並讓使用者選擇是否納管

# 查看所有已納管 notebook
→ list_notebooks()
← [{ "id": "research", "url": "...", "status": "ready", "active": true, "description": "..." }, ...]
```

## 餵入來源

```
# 將 git repo 加入 notebook 作為來源
→ exec(prompt="把 ~/code/my-project 的程式碼加入來源", notebook="research")
← { "success": true, "sourceAdded": "my-project (repo)", "wordCount": 12345 }

# 將網頁內容加入來源（爬取後轉換為文字）
→ exec(prompt="把 https://example.com/article 的內容爬下來加入來源", notebook="research")

# 將 PDF 加入來源
→ exec(prompt="把 ~/papers/paper.pdf 加入來源", notebook="research")
```

## 向 Notebook 提問

```
# 直接向 notebook 提問
→ exec(prompt="這個專案的認證流程是怎麼運作的？", notebook="research")
← { "success": true, "answer": "...", "citations": [...] }

# 設定預設 notebook，之後不用帶 notebook 參數
→ set_default(alias="research")
→ exec(prompt="列出所有 API endpoint")
```

## 非同步操作

```
# 耗時操作使用 async，立即返回 taskId
→ exec(prompt="產生 audio overview", notebook="research", async=true)
← { "taskId": "abc123", "status": "queued", "hint": "呼叫 get_status(taskId='abc123') 查詢結果。" }

# 操作完成後 daemon 自動透過 MCP notification 推送結果至 client

# 也可主動查詢任務狀態
→ get_status(taskId="abc123")
← { "taskId": "abc123", "status": "completed", "result": {...} }

# 查看所有任務
→ get_status(all=true)
```

## 常用管理操作

```
# Notebook 管理
→ open_notebook(alias="research")         # 標記為 active
→ close_notebook(alias="research")        # 關閉 tab（保留註冊）
→ rename_notebook(oldAlias="research", newAlias="my-research")
→ remove_notebook(alias="old-notebook")   # 從管理中移除

# 任務管理
→ cancel_task(taskId="abc123")            # 取消排隊或執行中的任務
→ get_status()                            # Daemon 狀態總覽

# 其他
→ reauth()                                # Google session 過期時重新認證
→ list_skills()                           # 列出 agent 可用的操作技能
→ shutdown()                              # 關閉 daemon
```

## 目錄結構

```
~/.nbctl/
├── profiles/          # Chrome userDataDir（session + cookies，共享認證）
├── state.json         # Notebook Registry + default notebook + daemon PID
├── cache/             # 每個 notebook 的來源/操作紀錄
├── tasks/             # 非同步任務狀態
├── skills/            # Agent 操作技能定義（可覆寫）
└── logs/              # 操作日誌
```

## 完整工作流範例

```
# 1. 啟動 daemon
$ npx nbctl

# 2. 設定 MCP client（Claude Code .mcp.json）
# 3. AI 工具自動發現 tools

# 4. 納管 notebook
→ add_notebook(url="https://notebooklm.google.com/notebook/abc", alias="myproject")

# 5. 餵入程式碼
→ exec(prompt="把 ~/code/my-project 的程式碼加入來源", notebook="myproject")

# 6. 提問
→ exec(prompt="這個專案用了哪些框架？", notebook="myproject")

# 7. 將回答存檔
→ exec(prompt="摘要這個專案的架構，結果存到 ~/notes/arch.md", notebook="myproject")

# 8. 產生 Audio Overview（非同步）
→ exec(prompt="產生 audio overview", notebook="myproject", async=true)

# 9. MCP notification 自動推送完成結果

# 10. 結束
→ shutdown()
```
