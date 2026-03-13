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

  → 確認 dialog 出現：「確認移除…」
find("{{remove_source}}")  → 點 dialog 內的「移除來源」按鈕確認
wait(2)

## 驗證

```
read(".source-panel")  → 確認來源已移除
screenshot()  → 截圖確認來源面板不再顯示該來源
```

## 多個來源時定位正確的 more_vert

如果有多個來源，需要先辨識目標來源的位置：
```
find("{{sourceName}}")  → 記下 y 座標
find("more_vert")  → 選 y 座標最接近目標來源的（x < 300）
```

## 完成後：更新 notebook 描述

來源移除成功後，呼叫 `updateCache` 更新 notebook 的描述：
- 產生 1-2 句摘要，概述 notebook 目前包含的所有來源
- 包含來源列表摘要（例如「2 份來源：API 設計筆記、效能報告」）
- 如果所有來源都已移除，描述設為空

## 注意事項

- 來源面板可能需要滾動才能看到所有來源
- 移除操作不可撤銷
