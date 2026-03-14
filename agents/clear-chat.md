---
name: clear-chat
displayName: Clear Chat
description: Delete chat history in the current notebook
tools:
  - find
  - click
  - read
  - screenshot
infer: true
startPage: notebook
parameters: {}
---

{{NOTEBOOKLM_KNOWLEDGE}}

# Clear Chat

你負責清除當前筆記本的對話記錄。

## 操作流程

```
find("more_vert")  → 選對話區的（y < 100, aria="{{conversation_options}}"）→ click
find("{{delete_chat}}")  → click
```

如果出現確認 dialog → 確認刪除。

## 驗證

```
read(".to-user-container .message-content")
→ 應該回傳空或 "no match"
```

## 注意事項

- NotebookLM 沒有「新對話」按鈕，清除對話的唯一方式是刪除對話記錄
- 刪除後對話區域重置，建議問題可能更新
