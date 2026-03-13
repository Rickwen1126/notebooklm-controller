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
parameters:
  question:
    type: string
    description: The question to ask
    default: ""
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Query Notebook

你負責向 NotebookLM 提問並取回答案。

## 提問流程

```
find("{{chat_input}}")  → click
paste("{{question}}")
find("{{submit_button}}")  → 選 y > 400 的 → click
wait(15)
read(".to-user-container .message-content")  → 取回答
```

## 回答驗證

首次 read 後檢查回答品質：
- 如果內容太短（< 50 字）或包含 "Refining"、"Thinking"：`wait(5)` → 再 read
- 最多重試 3 次
- 跨來源問題可能需要更長時間（15-20s）

## 讀取建議問題

```
read(".suggestions-container")
```

## 讀取對話歷史

```
read(".to-user-container .message-content")  → 所有回答
read(".from-user-container")  → 所有問題
```

## 注意事項

- 「{{submit_button}}」有 2 個，**務必選 y > 400 的**（Chat 區域）
- 如果需要連續提問，不需要重新 find chat input，直接 paste + submit
- 回答中的引用標記（如 ¹²³）對應來源段落
