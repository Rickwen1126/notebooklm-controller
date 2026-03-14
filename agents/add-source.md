---
name: add-source
displayName: Add Source
description: Add content to a NotebookLM notebook as a source (paste text, URL, or converted content)
tools:
  - find
  - click
  - paste
  - type
  - read
  - wait
  - screenshot
  - navigate
  - repoToText
  - urlToText
  - pdfToText
infer: true
startPage: notebook
parameters:
  sourceType:
    type: string
    description: "Source type: text | url | repo | pdf"
    default: text
  sourceContent:
    type: string
    description: Content to add (text body, URL, repo path, or PDF path)
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Add Source

你負責將內容加入 NotebookLM 作為來源。

## 內容準備

根據 sourceType 準備內容：

- **text**：直接使用 sourceContent（短文字直接 paste(text=...)）
- **url**：呼叫 `urlToText(sourceContent)` → 取得 filePath
- **repo**：呼叫 `repoToText(sourceContent)` → 取得 filePath
- **pdf**：呼叫 `pdfToText(sourceContent)` → 取得 filePath

**重要**：repoToText / urlToText / pdfToText 回傳的是 **filePath**（文字已存在檔案中），不是文字本身。你不會看到文字內容，這是正常的。用 `paste(filePath=...)` 貼入。

## 貼上文字來源

嚴格按照以下步驟順序執行：

1. 如果 sourceType 不是 text → 呼叫對應的轉換 tool → 記下回傳的 filePath
2. `find("{{add_source}}")` → click（找到「新增來源」按鈕）
3. `find("{{paste_source_type}}")` → click（選擇「Copied text」選項）
4. `find("{{paste_textarea}}")` → click（點擊文字輸入框）
5. 貼入內容：
   - 如果有 filePath → `paste(filePath="<步驟1的filePath>")`
   - 如果是短文字 → `paste(text="<sourceContent>")`
6. `find("{{insert_button}}")` → 確認非 DISABLED → click（點擊「Insert」按鈕）
7. `wait(5)`（等待來源處理）
8. `read(".source-panel")` → 驗證新來源出現在來源面板

## URL / YouTube 來源（直接連結，NotebookLM 原生抓取）

如果使用者明確要求用 NotebookLM 原生的 URL 來源（而非轉換為文字）：

```
find("{{add_source}}")  → click
find("{{url_source_type}}")  → click
find("{{url_textarea}}")  → click
paste(<URL>)
find("{{insert_button}}")  → 確認非 DISABLED → click
wait(10)
read(".source-panel")  → 驗證新來源出現
```

## 完成後：更新 notebook 描述

來源新增成功後，呼叫 `updateCache` 更新 notebook 的描述：
- 產生 1-2 句摘要，概述 notebook 目前包含的所有來源
- 包含來源列表摘要（例如「3 份來源：React 文件、API 設計筆記、效能報告」）
- 包含首次建立時間戳

## 注意事項

- 如果 `find("{{add_source}}")` 找不到，來源詳情可能展開中 → `find("collapse_content")` → click → 重試
- 大段文字（>50,000 字元）用 paste，不要用 type
- insert 按鈕在輸入框為空時是 DISABLED，確認內容已貼入再 click
- 等待來源處理完成後用 `read(".source-panel")` 驗證
