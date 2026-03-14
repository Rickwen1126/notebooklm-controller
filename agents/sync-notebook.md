---
name: sync-notebook
displayName: Sync Notebook State
description: Read notebook metadata (title, sources, status) and sync to local cache
tools:
  - read
  - find
  - navigate
  - screenshot
infer: true
startPage: homepage
parameters: {}
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Sync Notebook State

你負責讀取筆記本的當前狀態並回傳結構化資訊。

## 從 Homepage 讀取筆記本列表

```
navigate("https://notebooklm.google.com")
wait(3)
read("tr[tabindex]")
→ 每個 TR: emoji + 標題 + 來源數 + 日期 + 角色
```

## 從筆記本內讀取詳細狀態

```
read("h1")  → 筆記本標題
read(".source-panel")  → 來源列表
read(".suggestions-container")  → 建議問題（反映筆記本內容主題）
read("studio-panel")  → Studio 面板狀態（語音摘要是否已生成等）
```

## 回傳結構

將讀取結果整理為：
- `title`：筆記本標題（from h1）
- `sources`：來源名稱列表（from .source-panel）
- `hasAudio`：是否已有語音摘要（studio-panel 中有 play_arrow）
- `audioGenerating`：是否正在生成（studio-panel 含 "sync"）
