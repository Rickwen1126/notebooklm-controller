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

- **text**：直接使用 sourceContent
- **url**：呼叫 `urlToText(sourceContent)` 轉換為文字
- **repo**：呼叫 `repoToText(sourceContent)` 轉換為文字
- **pdf**：呼叫 `pdfToText(sourceContent)` 轉換為文字

轉換後的文字就是要貼入的來源內容。

## 貼上文字來源

```
find("{{add_source}}")  → click
find("{{paste_source_type}}")  → click
find("{{paste_textarea}}")  → click
paste(<準備好的內容>)
find("{{insert_button}}")  → 確認非 DISABLED → click
wait(5)
read(".source-panel")  → 驗證新來源出現
```

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
