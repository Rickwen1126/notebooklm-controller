# Browser Capability Spike — Handover Document

> 本文件是 spike 實驗的完整交接文件，放在 `spike/` 內部，不污染 repo 主線。
> 新 session 讀這份文件即可完整接手。

## TL;DR

**核心結論**：CDP helpers + DOM 查詢可以完全操控 NotebookLM，且可 tool 化讓 LLM agent 不寫 code 推進任務。已驗證 7 個 tool 足夠。

## 實驗狀態

| 項目 | 狀態 |
|------|------|
| Phase A（CDP 直接驗證） | ✅ PASS — 3 flow 全通過 |
| Tool 化驗證（純 tool call 操作） | ✅ PASS — 14 calls, 0 code |
| Haiku 模型驗證 | ✅ PASS — 13 calls, 完整 flow |
| 多來源 + 跨來源提問 | ✅ PASS — 2 來源, 跨來源引用正確 |
| UI 狀態陷阱發現 + 恢復 | ✅ 來源展開遮蔽 → collapse_content 恢復 |
| Phase B（Copilot SDK runtime） | ✅ PASS — 20 tool calls, 86-136s, 完整 flow |
| Chrome | 仍在跑 port 9222，spike profile |

## 檔案結構

```
spike/browser-capability/
├── experiment.ts          # 主實驗 script（7 個 tool commands）
├── results.md             # Phase A 詳細結果
├── HANDOVER.md            # 本文件
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

### 2. 7 個 Tool 的分工

| Tool | 角色 | 不可替代的原因 |
|------|------|--------------|
| screenshot | 視覺狀態理解 | LLM 需要看到頁面才能決定下一步 |
| find | 精確定位 | 座標估算不可行，必須 DOM query |
| click | 操作 | 觸發 UI 互動 |
| paste | 輸入 | 大量文字輸入（比 type 快且穩） |
| type | 輸入 | 特殊鍵（Enter, Tab, Escape）保留 |
| scroll | 操作 | 滾動頁面 |
| read | 結果提取 | 取回答文字、狀態檢查、錯誤訊息 |

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

### 5. 笨模型可行性（已驗證）

Execution 層（find → click → paste → read）是機械的，不需要強推理。
智慧在 task planning（決定做什麼），不在 tool execution（怎麼點）。
Haiku / GPT-4.1-mini 級別模型足夠做 execution agent。

**實測**：Haiku (claude-haiku-4-5) 成功跑完建立筆記本 → 加來源 → 提問 → 讀回答的完整流程，13 tool calls。

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
# 跑法
npx --yes tsx spike/browser-capability/experiment.ts launch   # 先啟動 Chrome
npx --yes tsx spike/browser-capability/experiment.ts navigate https://notebooklm.google.com  # 到首頁
npx --yes tsx spike/browser-capability/phase-b.ts --preset create-and-query  # 跑 agent
```

### Setup timing
- Chrome connect: 28ms
- client.start(): 644ms
- createSession(): **5.6s**（瓶頸，tool schema 序列化 + GitHub API 握手）
- 生產環境 CopilotClient singleton 常駐，每任務只付 createSession() 成本

### Agent 行為觀察
- 9 tools（7 browser + navigate + wait）
- 20 tool calls 完成完整 flow（建立筆記本 → 加來源 → 提問 → 讀回答）
- `session.on()` 可觀測所有事件：reasoning、tool start/complete、message
- SDK 注入自己的工具：`report_intent`（宣告意圖）、`view`（查看截圖）
- Prompt 品質決定 agent 準確度 — 需要包含 UI 知識 + 操作規則 + 步驟分解

## 回灌主專案

完成 Phase B 後需要更新：
- `specs/001-mvp/tasks.md`：新增 find + read tools（原本只有 5 個 CDP helper）
- `src/agent/tools/browser-tools.ts`：加 find + read 兩個 tool
- `specs/001-mvp/spec.md`：更新 tool 清單
- Cache flow：agent read → cache-manager 存儲
