# 快速上手：NotebookLM Controller

**對象**：使用 AI coding tool（如 Claude Code）的開發者
**前提**：已安裝 Node.js 22+、Google Chrome

## 安裝

```bash
npm install -g nbctl
```

## 第一次啟動

```bash
# 啟動 daemon（首次會開啟 Chrome 視窗讓你登入 Google）
nbctl start
# → { "success": true, "port": 19224, "mode": "headed",
#     "hint": "Complete Google login in the browser window." }

# 完成 Google 登入後，daemon 自動切為 headless 模式
# 後續啟動不需要再登入
```

## 納管既有 Notebook

```bash
# 將已有的 NotebookLM notebook 加入管理
nbctl add https://notebooklm.google.com/notebook/abc123 --name research
# → { "success": true, "id": "research", "title": "...", "sources": [...] }

# 批次納管帳號中所有 notebook（互動式）
nbctl add-all
# → 逐一展示並讓你選擇是否納管

# 查看所有已納管 notebook
nbctl list
```

## 餵入來源

```bash
# 將 git repo 加入 notebook 作為來源
nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb research
# → { "success": true, "sourceAdded": "my-project (repo)", "wordCount": 12345 }

# 將網頁內容加入來源（爬取後轉換為文字）
nbctl exec "把 https://example.com/article 的內容爬下來加入來源" --nb research

# 將 PDF 加入來源
nbctl exec "把 ~/papers/paper.pdf 加入來源" --nb research
```

## 向 Notebook 提問

```bash
# 直接向 notebook 提問
nbctl exec "這個專案的認證流程是怎麼運作的？" --nb research
# → { "success": true, "answer": "...", "citations": [...] }

# 設定預設 notebook，之後不用帶 --nb
nbctl use research
nbctl exec "列出所有 API endpoint"
```

## 非同步操作

```bash
# 耗時操作使用 --async，立即返回 taskId
nbctl exec "產生 audio overview" --nb research --async
# → { "taskId": "abc123", "status": "queued", "hint": "Use 'nbctl status abc123'..." }

# 查詢任務狀態
nbctl status abc123
# → { "taskId": "abc123", "status": "completed", "result": {...} }

# 查看所有任務
nbctl status --all
```

## 搭配 Claude Code 使用

```bash
# 安裝 Claude Code 專屬的通知 adapter
nbctl install-hooks --tool claude-code
# → 自動設定 hooks，非同步操作完成後結果自動注入 Claude Code 對話

# 匯出 AI Skill Template，讓 Claude Code 學會使用 nbctl
nbctl export-skill
# → 將 skill 內容加入你的 .claude/skills/ 目錄
```

## 常用管理指令

```bash
# Notebook 管理
nbctl open research          # 標記 notebook 為 active
nbctl close research         # 釋放 Chrome instance（保留註冊）
nbctl rename research my-research  # 變更別名
nbctl remove old-notebook    # 從管理中移除

# 任務管理
nbctl cancel abc123          # 取消排隊或執行中的任務
nbctl status                 # Daemon 狀態總覽
nbctl status --recent        # 近期已完成的任務

# 其他
nbctl reauth                 # Google session 過期時重新認證
nbctl skills                 # 列出 agent 可用的操作技能
nbctl stop                   # 關閉 daemon
```

## 目錄結構

```
~/.nbctl/
├── profiles/chrome/    # Chrome session（cookies 等）
├── state.json          # Notebook Registry
├── cache/              # 每個 notebook 的來源/操作紀錄
├── tasks/              # 非同步任務狀態
├── inbox/              # 通知收件匣
├── hooks/              # Adapter hook 腳本
├── skills/             # Agent 操作技能定義
└── logs/               # 操作日誌
```

## 完整工作流範例

```bash
# 1. 啟動
nbctl start

# 2. 納管 notebook
nbctl add https://notebooklm.google.com/notebook/abc --name myproject

# 3. 餵入程式碼
nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb myproject

# 4. 提問
nbctl exec "這個專案用了哪些框架？" --nb myproject

# 5. 將回答存檔
nbctl exec "摘要這個專案的架構，結果存到 ~/notes/arch.md" --nb myproject

# 6. 產生 Audio Overview（非同步）
nbctl exec "產生 audio overview" --nb myproject --async

# 7. 查看結果
nbctl status --recent

# 8. 結束
nbctl stop
```
