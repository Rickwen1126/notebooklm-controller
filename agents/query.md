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
4. wait(15) 等待 Gemini 回答
5. read(".to-user-container .message-content") 取回答案
6. 如果答案太短或仍在生成 → wait(5) → 再次 read（最多 3 次）

## 關鍵注意
- 「{{submit_button}}」有 2 個，**選 y > 400 的**（Chat 區域那個）
- 回答可能需要 15-20 秒，耐心等待後再 read
- 如果 read 結果包含 "Refining"、"Thinking" → 還在生成，wait 後重試
- 回答中的引用標記（如 ¹²³）對應來源段落
- **必須用 read 取回完整答案文字**，不要只回報「已完成」
