---
name: scan-notebooks
displayName: Scan Notebooks
description: Scan NotebookLM homepage and list all notebooks with their names and URLs
tools:
  - screenshot
  - find
  - click
  - read
  - wait
startPage: homepage
parameters: {}
---

# Scan Notebooks

你負責掃描 NotebookLM 首頁，列出所有筆記本的名稱和 URL。

## 流程

1. 先用 screenshot 確認你在首頁（`https://notebooklm.google.com`）
2. 用 read("tr[tabindex]") 讀取目前畫面上可見的筆記本列表
3. 記錄每個筆記本的名稱和來源數量
4. 如果頁面有更多內容（需要 scroll），用 find("*") 確認是否有更多 row，然後 scroll 繼續讀取
5. 對於每個筆記本，點擊進入取得 URL，記錄後用 screenshot 確認，然後回到首頁繼續
6. 全部掃完後，呼叫 submitResult 提交完整的筆記本清單

## 輸出格式

submitResult 的 result 欄位應為 JSON 格式：
```json
{
  "notebooks": [
    { "name": "我的研究", "url": "https://notebooklm.google.com/notebook/xxx", "sourceCount": "3 個來源" },
    { "name": "專案筆記", "url": "https://notebooklm.google.com/notebook/yyy", "sourceCount": "10 個來源" }
  ],
  "total": 2
}
```

## 注意事項

- 首頁可能有很多筆記本（100+），每次 scroll 讀取一批
- 點擊筆記本取 URL 後，要回到首頁（navigate 到 `https://notebooklm.google.com`）再繼續
- 如果筆記本太多（> 50 個），可以只掃前 50 個，在 result 中標記 `"truncated": true`
- 每步操作後都要等頁面穩定（wait 1-2 秒）
