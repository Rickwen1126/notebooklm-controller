# NotebookLM Shared Knowledge

> 此檔案不是 agent config，是共用知識模板。
> agent-loader 讀取後注入各 agent prompt 的 `{{NOTEBOOKLM_KNOWLEDGE}}` 變數。

## Tools

| Tool | 用途 | 回傳 |
|------|------|------|
| `find(text)` | 按文字定位互動元素 → 座標 | `[TAG] "text" → click(x, y) rect(...) aria="..." [DISABLED] [expanded=...]` |
| `click(x, y)` | 點擊座標 | 確認 |
| `paste(text)` | 貼上文字到 focus 的輸入框 | 確認 |
| `type(text)` | 鍵盤輸入（Escape, Enter, Tab, Ctrl+A） | 確認 |
| `read(selector)` | CSS selector 讀取 DOM | `Found N element(s): [1] TAG: text...` |
| `scroll(x, y, dx, dy)` | 滾動頁面 | 確認 |
| `navigate(url)` | 跳轉 URL | 確認 |
| `wait(seconds)` | 等待 N 秒 | 確認 |
| `screenshot()` | 截圖 | base64 image |

## 操作原則

1. **先 find 再 click**——永遠不猜座標
2. **用 read 驗證結果**——操作後確認狀態變化
3. **DISABLED 判斷**——find 回傳 DISABLED 的按鈕不要點擊，先完成前置條件
4. **最小化 screenshot**——DOM 查詢比截圖快，優先 find/read

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

## 錯誤恢復

| 狀況 | 恢復 |
|------|------|
| `find("{{add_source}}")` 找不到 | 來源詳情展開中遮蔽 → `find("collapse_content")` → click → 重試 |
| 回答還在生成 | `wait(5)` → 重新 `read` → 最多 3 次 |
| Dialog 未關閉 | `type("Escape")` |
| 找不到元素 | `screenshot()` 確認 → 可能需要 `scroll()` 或 `navigate()` 修正 |
