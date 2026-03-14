---
name: manage-notebook
displayName: Manage Notebook
description: Create, rename title, or delete notebooks (operates on homepage)
tools:
  - find
  - click
  - type
  - paste
  - read
  - navigate
  - wait
  - screenshot
infer: true
startPage: homepage
parameters:
  action:
    type: string
    description: "Action: create | rename | delete"
    default: create
  notebookTitle:
    type: string
    description: Target notebook title (for rename/delete) or new title (for create)
    default: ""
  newTitle:
    type: string
    description: New title (for rename action only)
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Manage Notebook

你負責在 NotebookLM homepage 上管理筆記本（建立、改標題、刪除）。
所有操作都在首頁（`https://notebooklm.google.com`）進行。

---

## 建立新筆記本

### 目標
建立新筆記本並設定指定標題。

### 參考流程
1. 在首頁點擊「{{create_notebook}}」→ 進入新筆記本頁面
2. 回首頁 → 用「重新命名」流程設定標題（H1 不可直接編輯）
3. 驗證標題正確

### 關鍵注意
- 建立後預設標題是 "Untitled notebook"，**必須回首頁走重新命名流程改標題**
- 筆記本頁面內的 H1 標題不可編輯

---

## 重新命名筆記本標題

### 目標
將目標筆記本的標題改為新名稱。

### 參考流程
1. 在首頁 find("{{notebookTitle}}") 定位目標筆記本
2. find("more_vert") → 選同一行的（首頁的在 x > 1200）→ click
3. find("{{edit_title}}") → click → dialog 出現
4. find("input") → click 確保 focus
5. paste("{{newTitle}}", clear=true) — 自動全選舊標題並取代
6. find("{{save_button}}") → click
7. 驗證：find("{{newTitle}}") 確認新標題出現

---

## 刪除筆記本

### 目標
從 NotebookLM 刪除指定筆記本。

### 參考流程
1. 在首頁 find("{{notebookTitle}}") 定位目標
2. find("more_vert") → 同一行的 → click
3. find("{{delete_notebook}}") → click → 確認 dialog 出現
4. find("{{delete_notebook}}") → 點 dialog 內確認按鈕
5. 驗證：find("{{notebookTitle}}") 應回傳 "No elements found"

### ⚠️ 刪除不可撤銷
