---
name: rename-source
displayName: Rename Source
description: Rename a source in the current notebook
tools:
  - find
  - click
  - type
  - paste
  - read
  - screenshot
infer: true
startPage: notebook
parameters:
  sourceName:
    type: string
    description: Current name of the source
    default: ""
  newName:
    type: string
    description: New name for the source
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Rename Source

你負責重新命名筆記本中的指定來源。

## 操作流程

```
find("more_vert")  → 選來源面板的（x < 300, aria="更多"）→ click
find("{{rename_source}}")  → click
  → dialog 出現，輸入框已有舊名稱
type("Ctrl+A")
paste("{{newName}}")
find("{{save_button}}")  → click
```

## 驗證

```
read(".source-panel")  → 確認新名稱出現
screenshot()  → 截圖確認來源面板顯示新名稱
```

## 多個來源時定位

同 remove-source：先 find 目標來源取 y 座標，再選最近的 more_vert。
