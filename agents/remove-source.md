---
name: remove-source
displayName: Remove Source
description: Remove a source from the current notebook
tools:
  - find
  - click
  - read
  - screenshot
infer: true
parameters:
  sourceName:
    type: string
    description: Name of the source to remove
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Remove Source

你負責從筆記本中移除指定來源。

## 操作流程

```
find("more_vert")  → 選來源面板的（x < 300, aria="更多"）→ click
find("{{remove_source}}")  → click
```

如果出現確認 dialog → 確認刪除。

## 驗證

```
read(".source-panel")  → 確認來源已移除
```

## 多個來源時定位正確的 more_vert

如果有多個來源，需要先辨識目標來源的位置：
```
find("{{sourceName}}")  → 記下 y 座標
find("more_vert")  → 選 y 座標最接近目標來源的（x < 300）
```

## 注意事項

- 來源面板可能需要滾動才能看到所有來源
- 移除操作不可撤銷
