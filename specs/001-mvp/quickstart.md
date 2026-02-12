# 快速上手：NotebookLM Controller

## 前置條件

1. Node.js 22+ 已安裝
2. iso-browser Chrome 已安裝並執行（port 19223）
3. 已在 iso-browser 中登入 Google 帳號

## 安裝

```bash
npm install -g notebooklm-controller
```

## 基本工作流

### 1. 啟動 daemon

```bash
nbctl start
# → { "success": true, "port": 19224 }
```

### 2. 登入 Google（首次使用）

```bash
nbctl login
# 瀏覽器會導航到 Google 登入頁面，手動完成登入
```

### 3. 納管既有 notebook

```bash
# 納管單一 notebook
nbctl add https://notebooklm.google.com/notebook/abc123 --name research
# → { "success": true, "id": "research", "title": "...", "description": "..." }

# 批次納管
nbctl add-all
# → 交互式選擇要納管的 notebook
```

### 4. 切換到 notebook

```bash
nbctl use research
# → { "success": true, "active": "research" }
```

### 5. 餵入資料

```bash
# 餵入程式碼
nbctl exec "把 ~/code/my-project 的程式碼加入來源"

# 餵入 PDF
nbctl exec "把 ~/papers/attention.pdf 加入來源"

# 餵入網頁
nbctl exec "把 https://example.com/article 的內容爬下來加入來源"
```

### 6. 查詢知識

```bash
nbctl exec "這個專案的認證流程是怎麼運作的？"
# → { "success": true, "answer": "...", "citations": [...] }

# 追問
nbctl exec "那這個認證方式有什麼安全風險？"
```

### 7. 產生 Audio Overview

```bash
nbctl exec "產生 audio overview"
# 等待...
nbctl exec "下載 audio 到 ~/podcast/ep01.wav"
```

### 8. 管理

```bash
nbctl list        # 列出所有 notebook
nbctl status      # daemon 狀態
nbctl stop        # 停止 daemon
```

## MCP 整合

在 Claude Code 的 `.mcp.json` 中加入：

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "nbctl",
      "args": ["mcp"]
    }
  }
}
```

之後 Claude Code 可直接呼叫 NotebookLM 查詢功能。
