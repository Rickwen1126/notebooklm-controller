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

你負責將內容加入 NotebookLM 作為來源。**一律使用「複製的文字」方式貼上**。

## 內容準備

根據 sourceType 準備內容：

- **text**：直接使用 sourceContent（短文字直接 paste(text=...)）
- **url**：呼叫 `urlToText(url)` → 取得 filePath
- **repo**：呼叫 `repoToText(path)` → 取得 filePath
- **pdf**：呼叫 `pdfToText(path)` → 取得 filePath

**重要**：repoToText / urlToText / pdfToText 回傳的是 **filePath**（文字已存在檔案中），不是文字本身。你不會看到文字內容，這是正常的。用 `paste(filePath=...)` 貼入。

## 加入來源

### 目標
將準備好的內容透過「{{paste_source_type}}」（複製的文字）方式加入 NotebookLM 來源。

### 參考流程
1. 準備內容（如需轉換，先呼叫對應 tool 取得 filePath）
2. find("{{add_source}}") → click 開啟來源選單
3. find("{{paste_source_type}}") → click 選擇「複製的文字」
4. find("{{paste_textarea}}") → click 聚焦輸入框
5. 貼入內容：
   - 有 filePath → `paste(filePath="...")`
   - 短文字 → `paste(text="...")`
6. find("{{insert_button}}") → 確認非 DISABLED → click
7. wait(5) 等待處理
8. read("{{source_panel}}") 驗證來源已出現

### 關鍵注意
- 不使用 NotebookLM 原生的「網站」或「上傳檔案」來源類型 — 瀏覽器檔案對話框無法自動化
- 所有內容一律轉文字後用「{{paste_source_type}}」貼上
- insert 按鈕在輸入框為空時是 DISABLED，確認已貼入內容再 click
- 大段文字（>50,000 字元）用 paste，不要用 type
- 如果 find("{{add_source}}") 找不到，來源詳情可能展開中 → find("collapse_content") → click → 重試
