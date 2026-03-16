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

## Phase 1：截圖蒐集（scrollbar 掃描）

1. 先用 screenshot 截一張首頁全貌，確認你在首頁
2. 用 read("tr[tabindex]") 確認目前畫面上可見的筆記本數量
3. 觀察截圖中的 scrollbar 長度，估算大概有多少筆記本
4. 每次向下捲動約半個畫面的高度（用 click 點擊頁面下半部，或用 find 找最後一個可見 row 然後 click 它下方）
5. 捲動後 screenshot 截圖，用 read("tr[tabindex]") 讀取新出現的筆記本
6. 重複步驟 4-5，直到 scrollbar 到底（不再出現新的 row，或 row 數量不再增加）
7. 整理所有截圖讀到的筆記本名稱 — **去除因捲動半頁造成的重複項目**
8. 統計去重後的總數

## Phase 2：建立 TODO List

根據 Phase 1 蒐集到的所有筆記本名稱，建立一個 TODO list：

```
- [ ] Docker Deep Dive (1 個來源)
- [ ] DesignPatternBook (1 個來源)
- [ ] 英文寫作資料庫 (2 個來源)
...
```

## Phase 3：逐一取得 URL

一次只處理一個筆記本，處理完再處理下一個：

1. 回到首頁頂端（scroll 到最上面）
2. 用 read 或 find 找到目標筆記本的 row
3. 點擊該 row 進入筆記本
4. wait 3 秒等頁面載入
5. 用 read("head") 或直接觀察截圖的網址列，取得真實的 notebook URL
6. 記錄 URL
7. 回到首頁：用 click 點擊 NotebookLM logo，或 find("新建") 確認回到首頁
8. wait 2 秒確認首頁載入
9. 將這個筆記本在 TODO list 標記為 ✅

**處理完一個之後，繼續處理下一個。不要視為任務結束。**

## Phase 4：完成條件

**只有當 TODO list 的所有項目都已勾選完畢**，才呼叫 submitResult。

如果所有項目都處理完了，呼叫 submitResult 提交完整結果。

## 輸出格式

submitResult 的 result 欄位為 JSON：

```json
{
  "notebooks": [
    { "name": "Docker Deep Dive", "url": "https://notebooklm.google.com/notebook/abc123", "sourceCount": "1 個來源" },
    { "name": "DesignPatternBook", "url": "https://notebooklm.google.com/notebook/def456", "sourceCount": "1 個來源" }
  ],
  "total": 10,
  "scanned": 10
}
```

## 重要規則

- **不要用 placeholder URL** — 每個 URL 必須從實際頁面讀取，是真實的 `https://notebooklm.google.com/notebook/...` 格式
- **不要跳過筆記本** — TODO list 上的每一個都要處理
- 如果筆記本太多（> 30 個），只處理前 30 個，在 result 加 `"truncated": true`
- 每步操作後 wait 1-2 秒等頁面穩定
- 回到首頁時用 read("tr[tabindex]") 確認 row 存在再繼續
- 如果某個筆記本點進去後無法取得 URL，記錄 `"url": "unknown"` 然後繼續下一個
