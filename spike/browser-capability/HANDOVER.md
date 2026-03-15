# Browser Capability Spike — Handover Document

> 本文件是 spike 實驗的完整交接文件，放在 `spike/` 內部，不污染 repo 主線。
> 新 session 讀這份文件即可完整接手。

## TL;DR

**核心結論**：CDP helpers + DOM 查詢可以完全操控 NotebookLM，且可 tool 化讓 LLM agent 不寫 code 推進任務。GPT-4.1（免費模型）即可驅動完整 flow，56s 內完成。Agent 自主選擇觀測方式（find/read/screenshot），不需人為限制。

## 實驗狀態

| 項目 | 狀態 |
|------|------|
| Phase A（CDP 直接驗證） | ✅ PASS — 3 flow 全通過 |
| Tool 化驗證（純 tool call 操作） | ✅ PASS — 14 calls, 0 code |
| Haiku 模型驗證 | ✅ PASS — 13 calls, 完整 flow |
| 多來源 + 跨來源提問 | ✅ PASS — 2 來源, 跨來源引用正確 |
| UI 狀態陷阱發現 + 恢復 | ✅ 來源展開遮蔽 → collapse_content 恢復 |
| Phase B（Copilot SDK runtime） | ✅ PASS — 20 tool calls, 86-136s, 完整 flow |
| Phase B+（GPT-4.1 免費模型） | ✅ PASS — 24 tool calls, 60.7s, 比預設快 36% |
| Phase C（Enhanced tools v2 + agent autonomy） | ✅ PASS — 22 tool calls, 55.7s |
| Phase D（全操作實測） | ✅ PASS — 40+ 操作全通過，9 tools 充分 |
| Phase E（CustomAgents 生產模擬） | ⚠️ 架構限制 — sub-agent 無法取得 custom tools |
| Phase F（Two-Session Planner+Executor） | ✅ PASS — 13/13 全操作通過（GPT-4.1） |
| Chrome | 仍在跑 port 9222，spike profile |

## 檔案結構

```
spike/browser-capability/
├── experiment.ts          # 主實驗 script（7 個 tool commands）
├── phase-b.ts             # Copilot SDK runtime 驗證腳本
├── phase-e.ts             # CustomAgents 生產模擬腳本（Finding #39-40）
├── phase-f.ts             # Two-Session Planner+Executor 驗證腳本（Finding #41-42）
├── results.md             # Phase A-F 詳細結果
├── HANDOVER.md            # 本文件
├── agent-guide.md         # Agent system prompt 操作準則（→ 主線 agent prompt 基礎）
├── ui-maps/               # i18n UI element config
│   ├── zh-TW.json         # 繁體中文（已驗證，25 elements）
│   ├── zh-CN.json         # 簡體中文（估計值）
│   └── en.json            # 英文（核心已驗證，擴展估計）
├── debug-viewport.ts      # 除錯用（可刪）
├── debug-raw-cdp.ts       # 除錯用（可刪）
├── debug-click.ts         # 除錯用（可刪）
└── screenshots/           # 實驗截圖
```

## experiment.ts 使用方式

```bash
# 啟動 Chrome（用 spike profile，port 9222）
npx tsx spike/browser-capability/experiment.ts launch

# 7 個核心 tool commands
npx tsx spike/browser-capability/experiment.ts screenshot          # 截圖
npx tsx spike/browser-capability/experiment.ts find <text>         # DOM 查詢 → 座標
npx tsx spike/browser-capability/experiment.ts shot <text>         # screenshot + find 合一
npx tsx spike/browser-capability/experiment.ts click <x> <y>      # 點擊
npx tsx spike/browser-capability/experiment.ts paste <text>        # 貼上文字
npx tsx spike/browser-capability/experiment.ts type <text>         # 逐字輸入
npx tsx spike/browser-capability/experiment.ts scroll <x> <y> <dx> <dy>  # 滾動
npx tsx spike/browser-capability/experiment.ts read <selector>     # 取頁面文字

# 基礎設施
npx tsx spike/browser-capability/experiment.ts navigate <url>
npx tsx spike/browser-capability/experiment.ts status
npx tsx spike/browser-capability/experiment.ts resize <w> <h>
npx tsx spike/browser-capability/experiment.ts close
```

**重要**：所有命令需要 `dangerouslyDisableSandbox: true`（npm cache 權限）。

## Agent 操作 NotebookLM 的 Tool Call 模式

### Flow 1: 建立筆記本 + 加來源 + 提問 + 取回答

```
shot "新建"            → [BUTTON] "add新建" → click(1237, 104)
click 1237 104         → 筆記本建立
shot "複製的文字"       → [BUTTON] click(919, 572)
click 919 572          → 開啟 paste 表單
find "在這裡貼上文字"   → [TEXTAREA] click(722, 408)
find "插入"            → [BUTTON] click(901, 601)
click 722 408          → focus textarea
paste "..."            → 貼入 source 內容
click 901 601          → source 加入
shot "開始輸入"        → [TEXTAREA] click(663, 730)
click 663 730          → focus chat input
paste "問題..."        → 貼入問題
find "提交"            → [BUTTON] click(1016, 730)  ← 選 y>400 的（chat 區）
click 1016 730         → 提交問題
                       → wait 10-15s（等 NotebookLM 回答完成）
read .to-user-container .message-content  → 取回答純文字
```

### Flow 2: 已開啟筆記本新增第二個來源

```
find "collapse_content" → click         ← 如果來源展開中，先收合
find "新增來源"         → click(192, 149)
find "複製的文字"       → click
find "在這裡貼上文字"   → click
paste "..."            → 貼入 source 內容
find "插入"            → click          → 等 5s 處理
```

### 注意事項

- **提交按鈕歧義**：頁面有 2 個「提交」按鈕，選 `y > 400` 的（chat 區）
- **回答載入時間**：跨來源問題可能需要 10-15s，首次 read 若出現 "Refining..." 需重試
- **來源展開遮蔽**：`find "新增來源"` 失敗時，先 `find "collapse_content"` 收合
- **回答 selector**：用 `.to-user-container .message-content` 只取回答，不含問題

## 關鍵發現

### 1. 座標不能目測，必須 DOM 查詢

| 目測估算 | 實際座標 | 誤差 |
|---------|---------|------|
| (617, 51) | (1237, 104) | 2x |
| (130, 158) | (714, 317) | 5x |

**原因**：screenshot 在 viewer 中縮放顯示，人眼估算 CSS pixel 座標不可靠。

### 2. Tool 分工（9 個，agent 自主選擇觀測方式）

| Tool | 角色 | 說明 |
|------|------|------|
| find | **定位 + 存在性 + 狀態** | DOM query 取座標、disabled、aria-expanded。操作前必用 |
| click | 操作 | 觸發 UI 互動 |
| paste | 輸入 | 大量文字輸入（比 type 快且穩） |
| type | 輸入 | 特殊鍵（Enter, Tab, Escape）保留 |
| scroll | 操作 | 滾動頁面 |
| read | **狀態驗證 + 結果提取** | 結構化回傳（count + items with tag/text/visible） |
| navigate | 導航 | URL 跳轉 |
| wait | 等待 | 延遲 N 秒（等 NotebookLM 生成回答） |
| screenshot | **觀測** | 視覺狀態理解。Agent 自行判斷何時需要 |

**設計原則**：find、read、screenshot 是三個平等的觀測工具。Agent 自行判斷用哪個（或組合）確認頁面狀態。Prompt 只設目標：「確認狀態正確」，不限手段。DOM 查詢比截圖快且省 vision tokens，agent 會自然傾向優先使用。

**Enhanced find**（v2）：
- Selector 擴大覆蓋 ARIA roles：`[role=tab]`, `[role=menuitem]`, `[role=option]`, `[role=checkbox]`, `[role=radio]`, `[role=switch]`, `[role=combobox]`, `[tabindex]`
- 新增回傳：`disabled`（disabled attr / aria-disabled）、`ariaExpanded`
- 新增過濾：`visibility: hidden` / `display: none` 的元素不回傳

**Enhanced read**（v2）：
- 回傳結構化：`count` + items array with `tag`, `text`, `visible`
- 可用於狀態驗證（「來源面板有幾個來源？」）和內容提取（取回答文字）

### 3. NotebookLM DOM 結構（已知 selectors）

| 元素 | Selector |
|------|----------|
| 回答純文字（只取回答） | `.to-user-container .message-content` |
| 回答純文字（含問題+回答） | `.message-content` |
| 問題 | `.from-user-container` |
| 回答區（含按鈕） | `.to-user-container` |
| 回答卡片 | `.to-user-message-card-content` |
| Chat 對話面板 | `.chat-panel` |
| 建議問題 | `.suggestions-container` |
| Source 列表面板 | `.source-panel` |
| 收合來源檢視圖標 | `collapse_content`（find text match） |
| 新增來源按鈕 | `find "新增來源"` → `add 新增來源` |

### 4. puppeteer-core 陷阱

- `puppeteer.connect()` **必須** `defaultViewport: null`，否則強制 800x600
- `page.setViewport()` 留 persistent emulation override，重啟 Chrome 才清掉
- `page.createCDPSession()` 的 emulation 是 per-session，跨 session 不共享

### 5. 免費模型可行性（已驗證）

Execution 層（find → click → paste → read）是機械的，不需要強推理。
智慧在 task planning（決定做什麼），不在 tool execution（怎麼點）。

**實測結果**：

| 模型 | Tool calls | 時間 | 結果 | 費用 |
|------|-----------|------|------|------|
| Haiku (claude-haiku-4-5) | 13 | — | ✅ PASS | 付費 |
| 預設模型 (Copilot SDK) | 20 | 95.4s | ✅ PASS | — |
| **GPT-4.1** | 24 | **60.7s** | ✅ PASS | **免費** |

**GPT-4.1 是最佳 execution agent**：免費、最快（平行 tool calling）、完全正確。

**關鍵設計決策**：Execution agent 用 GPT-4.1，task planning 用高階模型。成本分離。

### 6. UI 狀態陷阱：來源展開遮蔽

**問題**：來源被點開（展開檢視）後，左面板的「＋ 新增來源」按鈕消失，`find "新增來源"` 回傳空。

**恢復方式**：
```
find "collapse_content"  → [BUTTON] click(538, 88)  ← 兩個斜角箭頭指向中心的收合圖標
click 538 88             → 來源檢視收合
find "新增來源"          → 按鈕重新出現
```

**Agent 規則**：若 `find "新增來源"` 失敗，先嘗試 `find "collapse_content"` 收合來源面板再重試。

### 7. "提交" 按鈕歧義

頁面上有兩個「提交」按鈕（搜尋欄 + Chat 輸入欄）。
**規則**：選 `y > 400` 的那個（Chat 區域）。

## Phase B 結果

**全部通過。** `spike/browser-capability/phase-b.ts` 是自包的實驗腳本（不 import src/）。

```bash
# 跑法（預設模型）
npx --yes tsx spike/browser-capability/experiment.ts launch   # 先啟動 Chrome
npx --yes tsx spike/browser-capability/experiment.ts navigate https://notebooklm.google.com  # 到首頁
npx --yes tsx spike/browser-capability/phase-b.ts --preset create-and-query  # 跑 agent

# 指定模型（推薦 GPT-4.1，免費且最快）
npx --yes tsx spike/browser-capability/phase-b.ts --model gpt-4.1 --preset create-and-query
```

### Setup timing（指定 model vs 不指定）

| 項目 | 不指定 model | 指定 `--model gpt-4.1` |
|------|-------------|----------------------|
| Chrome connect | 28ms | 37ms |
| client.start() | 644ms | 741ms |
| createSession() | **5,669ms** | **513ms** (11x 快) |
| **Total setup** | **6,340ms** | **1,294ms** |

**結論**：永遠明確指定 model，跳過模型協商省 5 秒。

### Agent 行為觀察
- 9 tools（7 browser + navigate + wait）
- GPT-4.1：24 tool calls，60.7s（平行 tool calling，更少 round-trips）
- 預設模型：20 tool calls，95.4s（sequential）
- `session.on()` 可觀測所有事件：reasoning、tool start/complete、message
- SDK 注入自己的工具：`report_intent`（宣告意圖）、`view`（查看截圖）
- Prompt 品質決定 agent 準確度 — 需要包含 UI 知識 + 操作規則 + 步驟分解
- GPT-4.1 的平行 tool calling 是速度優勢關鍵

## Phase C — Enhanced Tools + Agent Autonomy (2026-03-13, session 4)

### 28. Enhanced find/read + agent autonomy — PASS

增強 find（擴大 selector + disabled/ariaExpanded/visibility）和 read（結構化回傳 count + items），
加入「狀態確認原則」讓 agent 自主選擇觀測方式（find/read/screenshot 皆可）。

**GPT-4.1 跑 enhanced tools**：

| Metric | Phase B+ (v1 tools) | Phase C (v2 tools) |
|--------|--------------------|--------------------|
| Tool calls | 24 | **22** |
| Duration | 60.7s | **55.7s** |
| Result | PASS | **PASS** |
| Setup | 1,294ms | 1,310ms |

Agent 自然選擇用 DOM 確認狀態（find + read），screenshot 只在初始探索用了一次。
驗證了 agent autonomy 原則：給工具、不限手段，agent 會自己最佳化。

### 29. Agent 自主判斷原則

**設計決策**：screenshot、find、read 是三個平等的觀測工具，agent 自行決定何時用什麼。

原則：
- Prompt 只設目標（「確認狀態正確」），不規定手段
- DOM 查詢比截圖快且省 vision tokens，agent 會自然傾向優先使用
- 不預存 success pattern，agent 自己判斷成功/失敗
- Screenshot 不再標記 "debug only"

之前的結論「happy path 0 vision tokens」修正為「agent 自行決定 vision 用量」。

### 30. i18n 考量（設計筆記，未實作）

目前 prompt 中的 UI element table 是中文 locale-specific。公開專案需要處理多語言：
- **Discovery layer**（vision）：首次進入未知 locale 時用 screenshot 辨識 UI 元素
- **Targeting layer**（DOM）：用 discovery 結果的 text 去 find 精確座標
- **UI map cache**：`~/.nbctl/ui-maps/<locale>.json`，breakage 時重新 discover

### 31. find/read v2 增強細節

**find v2**：
- Selector 從 9 種擴大到 16 種（加入 ARIA interactive roles + tabindex）
- 新增 `disabled`、`ariaExpanded` 回傳屬性
- 新增 `visibility: hidden` / `display: none` 過濾

**read v2**：
- 回傳從純文字改為結構化：`count` + items with `tag`, `text`, `visible`
- 兼顧狀態驗證（count / visibility check）和內容提取（text）

## 回灌主專案

完成 Phase C 後需要更新：
- `specs/001-mvp/tasks.md`：新增 find + read tools（原本只有 5 個 CDP helper），使用 v2 增強版
- `src/agent/tools/browser-tools.ts`：加 find + read 兩個 tool（v2：擴大 selector + 結構化回傳）
- `specs/001-mvp/spec.md`：更新 tool 清單 + agent 自主判斷原則
- Cache flow：agent read → cache-manager 存儲
- **新增**：`createSession({ model: "gpt-4.1" })` 作為 execution agent 預設模型
- **新增**：明確指定 model 以跳過 5s 的模型協商延遲
- **新增**：Prompt 「狀態確認原則」— agent 自主選擇觀測方式
- **新增**：i18n discovery layer 設計（vision → locale-specific UI map → DOM targeting）
- **新增**：`tools repair` CLI — 自動偵測 locale、smoke test、config/code 自修復
- **新增**：內建 3 locale（zh-TW, zh-CN, en），repair 補其他語言

## 設計筆記：tools repair + i18n（未實作）

### UI Map Config 架構

Tool 不再 hardcode locale text，改從 UI map config 讀取：

```
src/config/ui-maps/          # 內建 locale（隨 npm 發布）
  zh-TW.json
  zh-CN.json
  en.json
~/.nbctl/ui-map.json         # runtime 使用（從內建複製 or repair 生成）
```

UI map 結構：
```json
{
  "locale": "zh-TW",
  "elements": {
    "create_notebook": { "text": "新建" },
    "paste_source_type": { "text": "複製的文字" },
    "paste_textarea": { "text": "在這裡貼上文字", "match": "placeholder" },
    "insert_button": { "text": "插入" },
    "submit_button": { "text": "提交", "disambiguate": "y > 400" },
    "chat_input": { "text": "開始輸入", "match": "placeholder" },
    "add_source": { "text": "新增來源" },
    "collapse_source": { "text": "collapse_content" }
  },
  "selectors": {
    "answer": ".to-user-container .message-content",
    "question": ".from-user-container",
    "suggestions": ".suggestions-container",
    "source_panel": ".source-panel"
  },
  "verified_at": "2026-03-13T14:50:00Z"
}
```

### tools repair 機制

```bash
nbctl tools repair
```

1. **Config repair**（安全，高頻）：偵測 Chrome locale → 選內建 or repair 生成 ui-map.json → smoke test 驗證
2. **Code repair**（強力，低頻）：DOM 結構性改變時，repair session 有寫入 `src/agent/tools/` 權限，改完重跑 smoke test，git commit + 用戶確認

啟動流程：偵測 locale → 有內建直接用 → 沒有就跑 repair → Google 改版壞了就再 repair

內建 zh-TW + zh-CN + en 涵蓋主要目標用戶，其他語言 repair 自動生成。

## Phase D — 全操作實測 (2026-03-13, session 5)

用 experiment.ts CLI 手動測試所有 spec 要求的 NotebookLM 操作，記錄 DOM tool 可達性。

### 測試環境

- Chrome port 9222, spike profile, zh-TW locale
- 測試筆記本：`TypeScript 靜態型別開發指南`（1 source, 1 conversation）
- 工具：find (v2), read (v2), click, screenshot

### 操作測試結果

#### Homepage 操作

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 列出所有筆記本 | `read "tr[tabindex]"` | ✅ 106 筆 | 回傳標題+來源數+日期+角色 |
| 建立新筆記本 | `find "新建"` | ✅ aria="建立新的筆記本" | homepage 和 notebook 內都有 |
| 筆記本選單 | `find "more_vert"` | ✅ aria="專案動作選單" | 每個 notebook row 都有 |
| 編輯筆記本標題 | menu → `find "編輯標題"` | ✅ 彈出 dialog + 輸入框 | "筆記本標題*" 輸入 + 取消/儲存 |
| 刪除筆記本 | menu → `find "刪除"` | ✅ 可點擊 | 未實際執行刪除（避免資料損失） |
| 進入筆記本 | click notebook row | ✅ | 或直接 navigate URL |

#### Source 操作（筆記本內）

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 列出來源 | `read ".source-panel"` | ✅ | 結構化回傳，含來源名稱 |
| 新增來源（按鈕） | `find "新增來源"` | ✅ aria="新增來源" | 開啟 add source dialog |
| 來源類型：複製文字 | `find "複製的文字"` | ✅ | dialog 內底部 button |
| 來源類型：網站 URL | `find "網站"` | ✅ | 含 link+youtube 圖標 |
| 來源類型：上傳檔案 | `find "上傳檔案"` | ✅ | |
| 來源類型：Google Drive | `find "雲端硬碟"` | ✅ | |
| URL 貼入區 | `find "貼上任何連結"` | ✅ aria="輸入網址" | textarea placeholder |
| 插入按鈕（disabled 偵測）| `find "插入"` | ✅ DISABLED | 空 URL 時正確顯示 disabled |
| 來源選單 | `find "more_vert"` (x < 300) | ✅ aria="更多" | 第一個 more_vert 是來源的 |
| 移除來源 | menu → `find "移除來源"` | ✅ | 未實際執行 |
| 重新命名來源 | menu → `find "重新命名來源"` | ✅ dialog | "來源名稱*" 輸入 + 取消/儲存 |
| 來源詳情展開 | click source button | ✅ | 顯示完整內容 + 來源指南 |
| 來源詳情收合 | `find "collapse_content"` | ✅ | 已知操作 |
| 選取所有來源 | `find "選取所有來源"` | ✅ checkbox | aria="選取所有來源" |
| 來源搜尋 | `find "在網路上搜尋新來源"` | ✅ textarea | aria="根據輸入的查詢內容，探索來源" |

#### Chat 操作

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| Chat 輸入 | `find "開始輸入"` | ✅ textarea | aria="查詢方塊" |
| 提交問題 | `find "提交"` + `y > 400` | ✅ | 需要位置歧義消除 |
| 讀取回答 | `read ".to-user-container .message-content"` | ✅ | 只取回答，不含問題 |
| 讀取問題 | `read ".from-user-container"` | ✅ | |
| 讀取建議問題 | `read ".suggestions-container"` | ✅ | 3 個 suggestion |
| 儲存至記事 | `find "儲存至記事"` | ✅ aria="將訊息儲存至記事" | 注意有 2 個，選 visible 的 |
| 對話選項 | `find "對話選項"` 或 more_vert (y < 100) | ✅ expanded=false | |
| 刪除對話記錄 | menu → `find "刪除對話記錄"` | ✅ | 唯一選項，無「新對話」選項 |
| 設定對話（notebook config）| `find "設定筆記本"` (tune icon) | ✅ aria="設定筆記本" | 預設/學習指引/自訂 + 回覆長度 |

#### Studio 面板操作

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 讀取 Studio 面板 | `read ".studio-panel"` or `read "studio-panel"` | ✅ | 自訂元素 `<studio-panel>` |
| 語音摘要（Audio Overview）| `find "語音摘要"` | ✅ aria="語音摘要" | div，非 button |
| 自訂語音摘要 | `find "自訂語音摘要"` 或 edit icon | ✅ aria="自訂語音摘要" | edit button |
| 觸發語音生成 | click 語音摘要區域 | ✅ 自動開始 | 生成中顯示 "sync 正在生成語音摘要..." |
| 生成狀態偵測 | `read "studio-panel"` | ✅ | 有 "sync" → 生成中；無 → 完成 |
| 播放音訊 | `find "play_arrow"` | ✅ aria="播放" | 生成完成後出現 |
| 音訊時長 | screenshot 或 read player | ✅ | 顯示 00:02 / 20:36 |
| 音訊下載 | player menu → `find "下載"` | ✅ `<A>` tag | 注意：是 link 不是 button！ |
| 播放速度 | player menu → `find "變更播放速度"` | ✅ | |
| 音訊分享 | player menu → `find "分享"` | ✅ | |
| 播放器選單 | `find "查看更多音訊播放器選項"` | ✅ | aria on more_vert |

#### 筆記本標題操作

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 讀取標題 | `read "h1"` | ✅ | H1 元素，class=notebook-title |
| 筆記本內直接改標題 | click H1 | ❌ 不可編輯 | H1 非 contenteditable |
| 從 homepage 改標題 | notebook menu → 編輯標題 | ✅ | 唯一的標題修改方式 |

#### 面板控制

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 收合工作室面板 | `find "dock_to_left"` | ✅ aria="收合「工作室」面板" | |
| 收合來源面板 | `find "dock_to_right"` | ✅ aria="收合來源面板" | |

#### 其他工具列

| 操作 | Tool | 結果 | 備註 |
|------|------|------|------|
| 數據分析 | `find "數據分析"` | ✅ | 需 4+ 共用用戶，MVP 無關 |
| 共用筆記本 | `find "共用"` | ✅ aria="共用筆記本" | |
| 設定 | `find "設定"` | ✅ aria="設定" | 全域設定 |

### 關鍵發現

#### 32. 筆記本標題只能從 homepage 修改

筆記本內的 H1 標題不是 contenteditable，沒有 click-to-edit。要改標題必須回 homepage → notebook menu → 編輯標題。

#### 33. 語音生成觸發即開始

點擊 Studio 面板的「語音摘要」區域就直接觸發生成（不是先預覽再確認）。生成時間約 5-10 分鐘。狀態偵測用 `read "studio-panel"` 檢查是否包含 "sync" 關鍵字。

#### 34. 下載音訊是 `<A>` link，不是 button

音訊播放器的下載選項是 `<A>` tag（會觸發瀏覽器下載行為），不是普通 button。agent 需要 click 這個 link 來觸發下載。

#### 35. 對話選項只有「刪除對話記錄」

沒有「新對話」按鈕。清除對話可能需要刪除整個對話記錄然後重新開始。或者新開一個 tab/session。

#### 36. 插入按鈕 disabled 偵測

find v2 正確回報 `DISABLED` 狀態（URL input 為空時）。這對 agent 很有用——可以知道何時按鈕可以點擊。

#### 37. Studio 面板使用自訂元素

`<studio-panel>` 是自訂 web component，不是標準 HTML。用 `read "studio-panel"` 可以讀取（tag name selector）。

#### 38. 來源 checkbox vs button 區分

Source item 有兩個 interactive elements：
- BUTTON (aria="貼上的文字") → 點擊展開來源詳情
- INPUT (aria="貼上的文字") → 勾選/取消選取來源
需要根據 tag type 或 rect 位置區分。

### 待更新 UI Map 新元素

zh-TW locale 已驗證新增：

| Key | Text | Type | 備註 |
|-----|------|------|------|
| remove_source | 移除來源 | text | source menu |
| rename_source | 重新命名來源 | text | source menu |
| delete_chat | 刪除對話記錄 | text | conversation menu |
| audio_overview | 語音摘要 | text | Studio panel |
| customize_audio | 自訂語音摘要 | aria-label | edit icon |
| url_source_type | 網站 | text | add source dialog |
| upload_source_type | 上傳檔案 | text | add source dialog |
| drive_source_type | 雲端硬碟 | text | add source dialog |
| url_textarea | 貼上任何連結 | placeholder | URL input |
| save_button | 儲存 | text | dialogs |
| cancel_button | 取消 | text | dialogs |
| edit_title | 編輯標題 | text | homepage notebook menu |
| delete_notebook | 刪除 | text | homepage notebook menu |
| play_audio | 播放 | aria-label | audio player |
| download_audio | 下載 | text | audio player menu |
| notebook_settings | 設定筆記本 | aria-label | tune icon |
| conversation_options | 對話選項 | aria-label | chat more_vert |

### 工具充分性結論

**原本的 9 個 tool 完全涵蓋所有 spec 操作，不需要額外新增 tool。**

| Tool | 涵蓋操作 |
|------|---------|
| find | 定位按鈕/輸入框/選單項（含 disabled、ariaExpanded 偵測） |
| click | 所有點擊：按鈕、選單、link（包含 `<A>` 下載連結） |
| paste | 貼入來源內容、URL、問題、新名稱 |
| type | Escape 關閉 dialog、Ctrl+A 選取全文（改名前清空） |
| read | 列筆記本、列來源、取回答、偵測音訊生成狀態 |
| navigate | 跳轉 homepage ↔ notebook |
| wait | 等 NotebookLM 生成回答/音訊 |
| scroll | 長列表滾動（106 筆記本） |
| screenshot | agent 自主觀測（可用可不用） |

關鍵 selectors 和 aria-labels 穩定，icon names（more_vert, collapse_content, play_arrow, dock_to_left 等）是語言無關的。locale-dependent 的文字元素需要 UI map config 支援。

### 基礎設施需求（TabManager 層，非 agent tool）

以下功能不在 agent tool 層面，而是 TabManager 初始化時需要設定的 CDP 基礎設施：

#### 1. 檔案下載管理

音訊下載是 `<A>` link，click 後觸發瀏覽器原生下載行為。TabManager 需要：

```typescript
// 初始化時設定下載目錄
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: "/path/to/downloads",  // e.g. ~/.nbctl/downloads/
});

// 監聽下載完成事件
cdp.on("Browser.downloadProgress", (event) => {
  if (event.state === "completed") {
    // event.guid → 下載的檔案識別
    // 檔案在 downloadPath 內
  }
});
```

**用途**：`download_audio` 操作。agent click `<A>` 下載連結後，TabManager 負責追蹤下載狀態和最終檔案路徑。

#### 2. 檔案上傳攔截（MVP 可選）

「上傳檔案」按鈕會觸發瀏覽器原生 file picker dialog。如果未來需要支援 PDF/image 直傳：

```typescript
// puppeteer-core 內建支援
const [fileChooser] = await Promise.all([
  page.waitForFileChooser(),
  page.click('button[aria-label="上傳檔案"]'),
]);
await fileChooser.accept(["/path/to/file.pdf"]);
```

**MVP 不需要**：因為 content pipeline 已經將 repo/URL/PDF 轉為文字，走 paste 流程。但未來 PDF 直傳會更高效（保留格式 + 圖表）。

#### 3. 新分頁/彈窗攔截

某些操作（如 Google Drive 來源選擇、共用設定）可能開新分頁或 OAuth popup：

```typescript
browser.on("targetcreated", async (target) => {
  if (target.type() === "page") {
    const newPage = await target.page();
    // 攔截並處理，或關閉
  }
});
```

**MVP 影響**：Google Drive 來源需要，但 MVP 只做 paste/URL，可延後。

## Phase E — CustomAgents 生產模擬 (2026-03-13, session 6)

### 目標

驗證 Copilot SDK `customAgents[]` 架構：載入 `agents/*.md` config → `CustomAgentConfig[]`，用自然語言讓 main agent 自動路由到 sub-agent 執行 browser 操作。

### 測試腳本

`phase-e.ts` — 載入 10 個 agent config（add-source, clear-chat, download-audio, generate-audio, list-sources, manage-notebook, query, remove-source, rename-source, sync-notebook），解析 YAML frontmatter + Markdown body，渲染 `{{NOTEBOOKLM_KNOWLEDGE}}` 模板，建立 session 並送自然語言 prompt。

### 測試結果

| 測試 | 配置 | 結果 | 耗時 | Tool calls |
|------|------|------|------|-----------|
| Test 1: filtered tools | `tools: ["read", "find", "screenshot"]` | ⚠️ Sub-agent 無 custom tools → main agent fallback 自己完成 | 42s | 5 |
| Test 2: all tools | `tools: undefined` (= all) | ❌ 無限 sub-agent 遞迴 + 用 bash 完成 | 5min (timeout) | 66 |

### 關鍵發現 — Finding #39

**`defineTool()` 定義的 custom external tools 不會被注入到 sub-agents。**

Sub-agents 只看到 built-in tools（bash, view, edit 等），不看到 session 層的 custom tools（find, read, click, screenshot 等）。

證據：
- Test 1：sub-agent prompt 說要用 `read(".source-panel")`，但實際呼叫了 built-in `view`（permission.requested），不是 custom `read`（external_tool.requested）
- Test 2：sub-agent 給了 `tools: undefined`（所有 tools），但仍未呼叫任何 custom tool，最終靠 `bash` 完成
- Main agent 的 fallback 正確使用了 custom tools（external_tool.requested + external_tool.completed）

### 架構影響 — Finding #40

`CustomAgentConfig.tools` 只過濾 built-in tools，custom tools 需要走 **MCP** 才能暴露給 sub-agents。

**已知社群 issues 佐證（非孤例）：**

| Issue | 內容 | 狀態 |
|-------|------|------|
| copilot-sdk#553 | `CustomAgentConfig.mcpServers` MCP tools 不暴露給 sub-agent | ✅ 修復 (SDK v0.1.32) |
| copilot-cli#693 | CLI ≥0.0.361 agent MCP tools 不可見（regression） | ❌ Open |
| copilot-cli#556 | `customAgents[].tools` 過濾根本沒作用 | ❌ Open |
| copilot-sdk#301 | Sub-agent 編排支援 | ✅ 關閉（加文件，未完整實作） |

**結論：`defineTool()` → sub-agent 是架構限制，不是 bug。社群無人 file 此 issue。**

### 架構方案演進

#### 方案 A：MCP Self-loop（❌ 放棄）

把 browser tools 包成 MCP Server → sub-agents 透過 `mcpServers` 取得。
問題：自己暴露 MCP 然後自己消費，多一層不必要的 abstraction，dirty。

#### 方案 B：Two-Session Planner + Executor（✅ 採用）

不用 sub-agents，改為兩個獨立 session 分工：

```
Session 1 — Planner（輕量，無 browser tools）
  input:  使用者自然語言
  tools:  無（純 LLM 推理）
  systemMessage: 所有 agent config 的 description + parameter schema
  output: 結構化 prompt（從 agents/*.md template 選擇 + 填參數 + 路徑優化）

Session 2 — Executor（重量，帶 browser tools）
  input:  Planner 產出的結構化 prompt
  tools:  該操作需要的 browser tools subset（defineTool，session-level 直接可用）
  systemMessage: 選中的 agent config prompt（已渲染 template）
  output: 執行結果
```

**優勢：**
- `defineTool()` 在 session-level 天然可用，不需繞路
- Planner 極快（無 tools，純推理，低 token）
- Executor 精準（拿到明確指令，不需判斷意圖）
- Composite 操作：Planner 拆成 ordered steps → Executor 依序建 session 執行
- `agents/*.md` 成為 **prompt template library**，角色不變
- 完全不依賴 SDK 的 sub-agent 機制（那個機制有多個 open issues）

**對 spec 影響：**
- `session-runner.ts` 拆為 `planner-session` + `executor-session`（或合在 SessionRunner 內兩步驟）
- `agent-loader.ts` 不變 — 仍載入 `agents/*.md`，但用途從 `CustomAgentConfig[]` 變成 prompt template registry
- `customAgents` 參數從 `createSession()` 移除
- Daemon 不做意圖路由 — Planner session 做

### 驗證通過的部分

儘管 sub-agent 架構不適用，以下部分已驗證成功：
- ✅ Agent config 載入（YAML frontmatter parsing, template rendering）
- ✅ UI map locale 解析 + template variable 注入
- ✅ `{{NOTEBOOKLM_KNOWLEDGE}}` 共享知識模板渲染
- ✅ Main agent 意圖辨識 + 路由判斷（正確選擇 task:list-sources）
- ✅ CopilotClient lifecycle（start → createSession → sendAndWait → disconnect → stop）
- ✅ Event observer 完整捕捉所有 session events
- ✅ Main agent fallback 正確使用 custom tools 完成任務（42s, 5 calls）

## Phase F — Two-Session Planner + Executor (2026-03-13, session 6)

### 目標

驗證雙 session 架構：Planner（意圖解析 + prompt 組裝）→ Executor（browser tools 執行）。

### 測試腳本

`phase-f.ts` — Planner session 帶 1 個 `submitPlan` tool（純結構化輸出），Executor session 帶 browser tools subset。

### 測試結果

#### 初期驗證（單步 + 複合）

| 測試 | Prompt | Planner | Executor | Total |
|------|--------|---------|----------|-------|
| 單步 | "列出這個筆記本的來源" | 11s, 2 calls | 22.8s, 6 calls | **33.8s** |
| 複合 | "先問 TypeScript 靜態型別優點，然後列出來源" | 14.6s, 2 calls | Step1: 72.5s/12 calls + Step2: 24s/6 calls | **111.1s** |

#### 全操作 Batch Test（13 項，GPT-4.1）

| ID | 操作 | 狀態 | 耗時 | Agent |
|----|------|------|------|-------|
| T01 | list-sources | PASS | 38s | list-sources |
| T02 | sync-notebook | PASS | 175s | sync-notebook |
| T03 | query | PASS | 79s | query |
| T04 | add-source (text) | PASS | 66s | add-source |
| T05 | list-sources (驗證) | PASS | 41s | list-sources |
| T06 | rename-source | PASS | 93s | rename-source |
| T07 | query (cross-source) | PASS | 65s | query |
| T08 | clear-chat | PASS | 46s | clear-chat |
| T09 | remove-source | PASS | 62s | remove-source |
| T10 | list-sources (驗證) | PASS | 22s | list-sources |
| T11 | create notebook | PASS | 150s | manage-notebook |
| T12 | rename notebook | PASS | 82s | manage-notebook |
| T13 | delete notebook | PASS | 60s | manage-notebook |

**13/13 PASS，總時間 ~18 分鐘。** Planner 100% 選對 agent（零誤判）。

### 關鍵發現 — Finding #41

**Two-Session Planner+Executor 架構完全可行。**

- Planner 正確解析意圖（單步/複合）、選擇 agent config、組裝明確 prompt
- Executor 用 `defineTool()` custom tools 執行操作，所有 browser tools 正常
- Composite 操作（query → list-sources）正確拆成 ordered steps 依序執行
- 架構簡潔：兩個普通 `createSession → sendAndWait → disconnect`，中間是純資料傳遞

### Finding #42 — Built-in tools 殘留

Executor session 仍可使用 built-in tools（bash, view 等），偶爾會 fallback 到 built-in。生產環境需要：
- 在 systemMessage 明確指示「只使用以下 tools」
- 或等 SDK 支持 `disableBuiltInTools` 設定（copilot-sdk#617）

### Finding #43 — CDP Ctrl+A 在 Angular Material dialog 失效

CDP `Input.dispatchKeyEvent` 的 Ctrl+A 在 Angular Material dialog input 中不可靠。
**修正**：`dispatchType("Ctrl+A")` 改用 JS `document.activeElement.select()` 取代 CDP key event。

### Finding #44 — Dialog 確認步驟必須明確寫出

Agent prompt 中 dialog 出現後的確認/取消按鈕必須明確寫出 `find("按鈕文字") → click`，不能用「→ 確認」帶過。GPT-4.1 是非推理模型，無法推理「確認 dialog 後應該按什麼」。

修正的 agent configs：
- `manage-notebook.md`：delete 流程加 `find("刪除") → click`，rename 加 `find("input") → click`（確保 focus）
- `remove-source.md`：加 `find("移除來源") → click` 確認

### Finding #45 — 模型選擇：不需要 reasoning model

Planner（分類 + 參數抽取）和 Executor（照 recipe 執行）都用 GPT-4.1 足夠。
- Planner 13/13 選對 agent，零誤判 — 意圖分類不是推理任務
- Executor 成功率取決於 prompt 品質，不取決於模型能力
- 意圖不明時應回問用戶，不是靠更強模型猜測

### Finding #46 — 任務完成驗證用截圖確認

Agent 判斷任務是否成功完成的方式：**截圖 + 預期畫面描述**，不是結構化 `reportResult` tool。
LLM 有 vision 能力，截圖是最直接的客觀驗證。

### Finding #47 — Planner 同時作為 Input Gate（23/23 通過）

Planner session 加入 `rejectInput` tool，同時負責意圖解析和輸入過濾。6 個拒絕類別：

| 類別 | 測試數 | 結果 | 範例 |
|------|--------|------|------|
| off_topic | 4 | 全過 | 寫程式、天氣、翻譯、數學 |
| ambiguous | 3 | 全過 | 「幫我處理一下」「改一下」 |
| missing_params | 3 | 全過 | 「重新命名來源」缺名字 |
| unsupported | 3 | 全過 | 分享、匯出 PDF、音訊翻譯 |
| dangerous_bulk | 3 | 全過 | 「刪除所有筆記本」 |
| injection | 4 | 全過 | prompt injection、角色扮演繞過 |
| **正常輸入** | **3** | **全過** | 列出來源、提問、刪除筆記本 |

**重點**：
- 被拒絕時 task 終止在 Planner，不建立 Executor session — 零成本
- `rejectInput` 的 `userMessage` 直接回傳 client，包含引導修正的建議
- GPT-4.1 分類準確率 100%，每個判斷 ~10s
- 正常輸入不受影響，仍走 `submitPlan` 路徑

### Finding #48 — Executor Pre-Navigate：系統層錨點判斷

Agent 不自己判斷「我在哪個頁面」，由 Executor 層在啟動 session 前用 `tab.url` exact match 判斷：

```
tab.url === state.notebooks[name].url → 在對的筆記本 → 直接執行
tab.url === homepage                  → 在首頁 → 直接執行（manage-notebook 類）
otherwise                             → navigate 一次到正確頁面
```

**設計原則**：
- 二元判斷，0 screenshot、0 LLM call，純字串比對 O(n)
- Agent 永遠從 recipe 步驟 1 開始，不嘗試中間接續（頁面狀態不可靠，GPT-4.1 判斷不了中間狀態）
- 每個 agentConfig 加 `startPage: "homepage" | "notebook"` 欄位
- Executor 注入 prompt context：「你已在 [首頁/筆記本 xxx]，開始執行。」

### Finding #49 — Tab Pool Weak Affinity（弱綁定）

Tab 不硬綁 notebook，用 `affinityMap[notebookId] = tabId` 做 soft hint：

```
pool.acquire(notebookId):
  1. affinityMap[notebookId] 有值且該 tab 閒置 → 直接給（affinity hit）
  2. 否則 → 拿任意閒置 tab（affinity miss）
  3. 操作完 → 更新 affinityMap[notebookId] = tabId
```

| 情境 | Affinity | Pre-Navigate | 結果 |
|------|----------|-------------|------|
| 連續操作同 notebook | hit | URL match → 跳過 | **0 navigate，最快** |
| 切換 notebook | miss | URL mismatch → navigate 一次 | 1 次 navigate |
| Tab 被回收 | miss | 新 tab → navigate | navigate to target |

**重點**：不鎖定、不保證，affinity 只是 hint。Pool 分配永遠以「有閒置 tab」為優先，不造成 tab 飢餓。用戶通常連續操作同一本，所以 hit rate 預期很高。

### Finding #50 — Default Model 必須 Hardcode

Spike 腳本 `--model` flag 為可選，未帶時跑 Copilot SDK 預設模型（非 GPT-4.1），導致 50% premium 被意外消耗。

**修正**：所有 spike 腳本 default model 改為 `"gpt-4.1"`。Production code 也必須 hardcode model，不依賴 SDK default。

### Finding #51 — File-based Paste: 0 Token 消耗的大內容注入

NotebookLM 無前端 paste 字數限制（10K~500K 全通過），但 500K chars ≈ 125K tokens 會爆 GPT-4.1 context。

**解法**：`repoToText` 寫 temp file，只回傳 `{ filePath, charCount, summary }`。`paste(filePath=...)` handler 讀檔貼入。LLM 全程只看 metadata。

| | filePath 模式 | Baseline 模式 |
|---|---|---|
| 100K | ✅ (42.8s) | ✅ (34.2s) |
| 500K | ✅ (0 token) | ❌ (爆 context) |
| Content token 消耗 | **0** | ~25K tokens/100K |

**架構洞見**：Tool 定義 = context boundary。`defineTool` handler 控制回傳值，LLM 根本拿不到文字內容 — 這是 architectural enforcement，不是 prompt-level instruction。大部分 agent 框架做不到（tool result 直接回 context）。Tab 是 daemon 的資源，LLM 只需指定「貼在哪」，daemon 處理 paste。

詳見：`spike/FilePaste500KExperiment.md`
腳本：`spike/browser-capability/paste-limit-experiment.ts`、`spike/browser-capability/paste-filepath-experiment.ts`

### Finding #52 — Multi-Tab 並發操作：CDP 完全支援

Chrome CDP 支援多個 tab 同時操作，每個 tab 獨立 CDPSession，互不干擾。

| 測試 | 結果 | 說明 |
|------|------|------|
| 並發 Screenshot | ✅ | 兩 tab 同時截圖，內容各自正確 |
| 並發 Find（DOM 查詢）| ✅ | 同時查詢，各自返回正確結果 |
| 並發 Click | ✅ | 同時點擊不同 tab 不同元素，互不干擾 |
| Sequential vs Parallel | ✅ | Sequential=81ms, Parallel=65ms, 1.25x speedup |
| 交錯操作 20 次 | ✅ | 快速交替兩 tab 操作，全部成功 |

**結論**：Multi-tab 架構可行。之前 Phase F batch test 衝突的原因是**同一個 tab 被兩個 agent 同時操作**，不是 multi-tab 本身的問題。Tab pool 的 acquire/release 機制只需保證**一個 tab 同一時間只被一個 agent 使用**即可。

腳本：`spike/browser-capability/multi-tab-experiment.ts`

### 總結

**Spike 完成。** 所有核心驗證通過：

1. ✅ 9 browser tools 覆蓋所有 40+ spec 操作（Phase D）
2. ✅ Agent config 載入 + template rendering + UI map i18n（Phase E）
3. ✅ Two-Session Planner+Executor 架構（Phase F）
4. ✅ Composite 操作拆解 + 依序執行（Phase F）
5. ✅ 13/13 全操作 batch test 通過（Phase F batch）
6. ✅ Planner input gate 23/23 通過（Phase F guard）
7. ✅ File-based paste: 500K chars, 0 token 消耗（Paste experiment）
8. ✅ Multi-tab 並發：CDP 支援，互不干擾（Multi-tab experiment）

**可以回到主線開發。** 架構確定：
- `customAgents` sub-agent → 不用（SDK 限制）
- Planner session（意圖解析 + 輸入過濾）+ Executor session（browser 操作）
- `agents/*.md` = prompt template library（step-by-step recipe，零留白）
- `_knowledge.md` + UI maps = 共享知識 + i18n
- 模型：GPT-4.1 雙層都夠用，prompt 品質 > 模型能力，hardcode 不依賴 SDK default
- Planner 雙職責：submitPlan（路由）+ rejectInput（防護）
- Executor pre-navigate：系統層錨點判斷，agent 不自己判斷頁面狀態
- Tab pool weak affinity：連續操作同 notebook 免 navigate
- File-based paste：Tool boundary = context boundary，大內容 0 token
- Multi-tab 並發：CDP 支援，tab pool 只需保證一 tab 一 agent
