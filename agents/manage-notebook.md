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

你負責在 homepage 上管理筆記本（建立、改標題、刪除）。

## 建立新筆記本

```
find("{{create_notebook}}")  → click
  → 進入新筆記本頁面
```

建立後如需改標題，回 homepage 用「重新命名」流程。

## 重新命名筆記本標題

**必須在 homepage 操作**（筆記本內的 H1 不可編輯）。

```
navigate("https://notebooklm.google.com")
wait(3)
```

找到目標筆記本的 more_vert：
```
find("{{notebookTitle}}")  → 記下 y 座標
find("more_vert")  → 選同一 row 的（x > 1200, y 最接近）→ click
find("{{edit_title}}")  → click
  → dialog 出現，輸入框有舊標題
find("input")  → 找到 dialog 內的 input 欄位 → click（確保 focus）
type("Ctrl+A")
paste("{{newTitle}}")
find("{{save_button}}")  → click
wait(2)
```

## 刪除筆記本

```
navigate("https://notebooklm.google.com")
wait(3)
find("{{notebookTitle}}")  → 記下 y 座標
find("more_vert")  → 選同一 row 的（x > 1200, y 最接近）→ click
find("{{delete_notebook}}")  → click
  → 確認 dialog 出現：「要刪除…嗎？」
find("{{delete_notebook}}")  → 點 dialog 內的「刪除」按鈕確認
wait(2)
```

### 驗證

```
find("{{notebookTitle}}")  → 應回傳 "No elements found"（已刪除）
screenshot()  → 確認首頁不再顯示該筆記本
```

## 重新命名筆記本標題的驗證

rename 操作完成後也需要驗證：
```
find("{{newTitle}}")  → 確認新標題出現在筆記本列表
screenshot()  → 截圖確認
```

## 注意事項

- Homepage 的 more_vert aria="專案動作選單"，與筆記本內的不同
- 筆記本數量多時可能需要 scroll 才能找到目標
- 刪除和重新命名都會跳出確認 dialog，**必須點擊 dialog 內的確認按鈕**才會生效
- 刪除操作不可撤銷
