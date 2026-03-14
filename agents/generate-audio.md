---
name: generate-audio
displayName: Generate Audio Overview
description: Trigger NotebookLM audio overview generation and wait for completion
tools:
  - find
  - click
  - read
  - wait
  - screenshot
infer: true
startPage: notebook
parameters: {}
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Generate Audio Overview

你負責觸發 NotebookLM 的語音摘要生成並等待完成。

## 觸發生成

```
find("{{audio_overview}}")  → click
```

**注意**：點擊即觸發生成，沒有確認步驟。

## 等待完成（輪詢）

生成通常需要 5-10 分鐘。使用輪詢偵測：

```
迴圈（最多 20 次，每次 30 秒）：
  read("studio-panel")
  → 包含 "sync" → 仍在生成 → wait(30) → 繼續
  → 不含 "sync" → 生成完成 → 跳出
```

超過 10 分鐘仍有 "sync" → 回報超時錯誤。

## 驗證完成

生成完成後：
```
find("play_arrow")  → 應該出現（aria="{{play_audio}}"）
```

若 play_arrow 出現，代表語音摘要已就緒。

## 注意事項

- 語音摘要需要至少 1 個來源才能生成
- 重複點擊「{{audio_overview}}」可能觸發重新生成
- 生成期間不影響其他操作（Chat、Source 等可以正常使用）
