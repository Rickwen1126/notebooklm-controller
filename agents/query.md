---
name: query
displayName: Query Notebook
description: Ask a question to NotebookLM and retrieve the grounded answer
tools:
  - find
  - click
  - paste
  - read
  - wait
  - screenshot
  - waitForContent
infer: true
startPage: notebook
parameters:
  question:
    type: string
    description: The question to ask
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Query Notebook

你負責向 NotebookLM 提問並取回完整答案。

## 目標
將問題送入 NotebookLM chat，等待 Gemini 回答，取回完整答案文字。

## 參考流程
1. find("{{chat_input}}") → click 聚焦輸入框
2. paste("{{question}}") 貼入問題
3. find("{{submit_button}}") → 選 y > 400 的（Chat 區域）→ click
4. waitForContent(".to-user-container .message-content", rejectIf="Thinking|Refining") → 自動等到回答穩定並回傳

## 關鍵注意
- 「{{submit_button}}」有 2 個，**選 y > 400 的**（Chat 區域那個）
- `waitForContent` 會自動 poll 到回答不再變化，不需要手動 wait + read
- 它預設只取**最後一個**匹配元素（最新回答），不會拿到舊對話
- 回答中的引用標記（如 ¹²³）對應來源段落
- **必須回傳 waitForContent 取得的完整答案文字**，不要只回報「已完成」
