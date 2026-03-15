# NotebookLM Shared Knowledge

> 此檔案不是 agent config，是共用知識模板。
> agent-loader 讀取後注入各 agent prompt 的 `{{NOTEBOOKLM_KNOWLEDGE}}` 變數。

## Tools

| Tool | 用途 | 回傳 |
|------|------|------|
| `find(text)` | 按文字定位互動元素 → 座標 | `[TAG] "text" → click(x, y) rect(...) aria="..." [DISABLED] [expanded=...]` |
| `click(x, y)` | 點擊座標 | 確認 |
| `paste(text)` | 貼上文字到 focus 的輸入框。`clear=true` 會先全選再取代 | 確認 |
| `type(text)` | 鍵盤輸入特殊鍵（Enter, Backspace, Tab, Escape） | 確認 |
| `read(selector)` | CSS selector 讀取 DOM | `Found N element(s): [1] TAG: text...` |
| `scroll(x, y, dx, dy)` | 滾動頁面 | 確認 |
| `navigate(url)` | 跳轉 URL | 確認 |
| `wait(seconds)` | 固定等待 N 秒 | 確認 |
| `waitForContent(selector)` | Poll 直到內容穩定（取代 wait+read）| 穩定後的文字內容 |
| `screenshot()` | 截圖（視覺分析用） | base64 image |

## 核心操作原則

1. **觀察→行動→驗證**——每步操作前 screenshot() 確認當前狀態，操作後 screenshot() 驗證結果
2. **先 find 再 click**——永遠不猜座標，用 find 定位元件
3. **元件名稱是高信心參考**——prompt 中的 `{{...}}` 標籤是系統驗證過的多語言名稱，優先使用。如果 find 沒結果，根據截圖嘗試替代文字
4. **視覺 + DOM 綜合判斷**——screenshot 看全局狀態，find/read 確認具體元件。兩者互補，不只依賴其一
5. **不盲目執行**——如果操作結果不如預期，分析截圖後決定：重試、換方法、或回報問題
6. **DISABLED 判斷**——find 回傳 DISABLED 的按鈕不點擊，先完成前置條件

## 固定 Selectors（語言無關）

| 用途 | Selector |
|------|----------|
| 回答內容 | `.to-user-container .message-content` |
| 問題內容 | `.from-user-container` |
| 建議問題 | `.suggestions-container` |
| 來源面板 | `.source-panel` |
| Studio 面板 | `studio-panel` |
| 筆記本標題 | `h1` |
| 筆記本列表 | `tr[tabindex]` |

## 固定 Icon Names（find 可直接搜）

| Icon | 功能 |
|------|------|
| `more_vert` | 選單按鈕 |
| `collapse_content` | 收合來源詳情 |
| `play_arrow` | 播放音訊 |
| `dock_to_left` | 收合工作室面板 |
| `dock_to_right` | 收合來源面板 |

## 歧義消除

### 「{{submit_button}}」按鈕
頁面有 2 個提交按鈕，**選 y > 400 的**（Chat 區域）。

### `more_vert` 按鈕
| 位置 | aria | 用途 |
|------|------|------|
| x < 300 | "更多" | 來源選單 |
| y < 100, 對話區 | "{{conversation_options}}" | 對話選項 |
| x > 1200, homepage | "專案動作選單" | 筆記本選單 |
| 音訊播放器 | "查看更多音訊播放器選項" | 播放器選單 |

### 來源項 BUTTON vs INPUT
- **BUTTON**(aria=來源名稱) → 展開來源詳情
- **INPUT**(aria=來源名稱) → 勾選/取消選取

## 常見問題處理

| 狀況 | 處理方式 |
|------|----------|
| find 找不到預期元件 | screenshot() 看實際畫面 → 嘗試替代文字或 scroll 找 |
| `find("{{add_source}}")` 找不到 | 來源詳情展開中遮蔽 → `find("collapse_content")` → click → 重試 |
| 回答還在生成 | `wait(5)` → 重新 read → 最多 3 次 |
| Dialog 未關閉 | `type("Escape")` |
| 操作後畫面無變化 | screenshot() 分析 → 可能需要 wait 或重試 |
| 不在預期頁面 | screenshot() 確認 → navigate 回正確頁面 |
| 元素被遮擋 | scroll 調整位置 → 重新 find |
