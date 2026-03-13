---
name: list-sources
displayName: List Sources
description: List all sources in the current notebook
tools:
  - read
  - find
  - screenshot
infer: true
parameters: {}
---

{{NOTEBOOKLM_KNOWLEDGE}}

# List Sources

你負責列出當前筆記本的所有來源。

## 操作

```
read(".source-panel")
→ 回傳來源面板內容，包含所有來源名稱和狀態
```

## 回傳格式

解析 read 結果，提取每個來源的名稱。來源面板結構：
- 每個來源是一個 list item，包含圖標 + 名稱
- 勾選狀態（checkbox checked/unchecked）

## 取得來源數量

如果只需要數量：
```
read(".source-panel")
→ 計算來源項目數
```
