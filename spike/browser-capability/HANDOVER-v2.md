# Script-first Architecture — Production Handover (v2)

> 本文件是 spike → main 整合的交接文件。包含所有 production code 需要的架構決策、實測數據、陷阱、和具體實作指引。
> 讀這份文件 + `phase-g-scripts.ts` + `phase-g-shared.ts` 即可完整實作 main code。

---

## 1. 架構總覽

```
User NL request
  → Planner session (GPT-4.1, ~4s)
    ├── submitPlan → ordered steps
    └── rejectInput → 拒絕無效/危險輸入
  → For each step:
      Script (0 LLM, ~1-17s depending on operation)
        ├── success → return result immediately
        └── fail → Recovery session (GPT-5-mini, ~90s)
              ├── complete task with browser tools
              ├── analyze failure cause
              ├── output suggestedPatch
              └── save error log to ~/.nbctl/repair-logs/
  → Return result to user
```

### 三個角色

| 角色 | 模型 | 何時跑 | 做什麼 |
|------|------|--------|--------|
| Planner | GPT-4.1（免費） | 每次 | NL → 結構化步驟 + input gate |
| Script | 無 LLM | 每次 | 確定性 DOM 操作（CDP helpers） |
| Recovery | GPT-5-mini（推理，免費） | 只有 script 失敗 | 接手完成 + 分析 + patch |

### 為什麼不用 pure agent？

| | Script-first | Pure Agent |
|---|---|---|
| 操作速度 | **1.1s**（CDP 直接操作） | 10s+（每步 LLM roundtrip） |
| Happy path LLM cost | **0** | 22-31 tool calls |
| Query total | **~18s**（含 Gemini 等待） | ~70s |
| 可靠性 | 確定性（同輸入同輸出） | 非確定性（agent 可能走偏） |
| UI 改版適應 | 需要 repair（自動或手動） | 可能自動適應 |

Script 是 pure agent 的**加速層**，不是替代品。Pure agent 能力保留在 Recovery 裡，只在失敗時啟動。

---

## 2. Happy Path Scripts — 使用指南

### 2.1 每個 script 的起跑點驗證

**所有 script 都自帶起跑點驗證**，不需要外層確保頁面狀態：

| Script | ensure helper | 做什麼 |
|--------|--------------|--------|
| scriptedQuery | `ensureChatPanel` | 檢查 `.chat-panel` 可見，不可見則點「對話」tab |
| scriptedClearChat | `ensureChatPanel` | 同上 |
| scriptedAddSource | `ensureSourcePanel` | 檢查 `.source-panel` 可見，不可見則點「來源」tab |
| scriptedListSources | `ensureSourcePanel` | 同上 |
| scriptedRemoveSource | `ensureSourcePanel` | 同上 |
| scriptedRenameSource | `ensureSourcePanel` | 同上 |
| scriptedListNotebooks | `ensureHomepage` | 檢查 URL 是否 homepage，不是則 navigate |
| scriptedCreateNotebook | `ensureHomepage` | 同上 |
| scriptedRenameNotebook | `ensureHomepage` | 同上 |
| scriptedDeleteNotebook | `ensureHomepage` | 同上 |

**成本**：正確狀態 ~1ms（一次 DOM check），需要修正 ~800ms-2s。

**連續操作同類型**（如連續 query）不需要重新 ensure — chat panel 一直在。
**跨類型操作**（如 addSource → query）ensure 會自動切換面板。

### 2.2 全操作測試結果

**Happy path 11/12 PASS**（S12 是 test harness notebook 定位問題，非 script bug）：

| Script | 操作 | 速度 | 狀態 |
|--------|------|------|------|
| scriptedQuery | 提問 + 取答案 | 17.1s（含 Gemini 等待 15s） | ✅ |
| scriptedAddSource | 加文字來源 | 1.4s | ✅ |
| scriptedListSources | 讀來源列表 | <0.1s | ✅ |
| scriptedRemoveSource | 移除來源 | 1.8s | ✅ |
| scriptedRenameSource | 重命名來源 | 0.9s | ✅ |
| scriptedClearChat | 清除對話 | 1.5s | ✅ |
| scriptedListNotebooks | 讀筆記本列表 | <0.1s | ✅ |
| scriptedCreateNotebook | 建立筆記本 | 1.4s | ✅ |
| scriptedRenameNotebook | 重命名筆記本 | 5.4s（含 dialog 動畫） | ✅ |
| scriptedDeleteNotebook | 刪除筆記本 | 0.5s | ✅ |

### 2.3 ScriptResult 結構

每個 script 回傳統一結構：

```typescript
interface ScriptResult {
  operation: string;           // "query" | "addSource" | ...
  status: "success" | "fail";
  result: string | null;       // 答案文字、來源列表 JSON、etc.
  log: ScriptLogEntry[];       // 每步的結構化 log
  totalMs: number;
  failedAtStep: number | null; // fail 時是第幾步
  failedSelector: string | null; // fail 時是哪個 UI map key
}

interface ScriptLogEntry {
  step: number;
  action: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  durationMs: number;
}
```

### 2.4 Wait Primitives

**Production 需要 6 個 wait 原語**（全部 Node-side polling，0 LLM，不被 Chrome 背景 tab 節流）：

| Primitive | 用途 | 實作 |
|-----------|------|------|
| `pollForAnswer(selector)` | query 等答案穩定 | `.thinking-message` DOM signal + djb2 hash × 3 |
| `waitForGone(selector)` | dialog 關閉、來源消失、chat 清空 | poll `querySelector` → null/hidden |
| `waitForVisible(selector)` | dialog 出現、面板可見 | poll `getBoundingClientRect` > 0 |
| `waitForEnabled(text)` | 按鈕 disabled → enabled | poll `findElementByText` + !disabled |
| `waitForNavigation(opts)` | create notebook URL 跳轉 | poll `page.url()` |
| `waitForCountChange(selector, baseline)` | 來源數量 ±1 | poll `querySelectorAll.length` |

### 2.5 pollForAnswer 三層架構（最重要的 wait）

```
Layer 1 — .thinking-message 可見性等待
  - NotebookLM 的 loading 指示器，visible = 還在處理
  - 所有過渡訊息（Checking, Reading, Thinking）都在此階段
  - 消失後 = 答案開始/完成渲染
  - 參考：notebooklm-skill ask_question.py 同模式

Layer 2 — text hash stability
  - djb2 hash，3 次 same hash = stable
  - 1s polling interval
  - Node-side setTimeout（不被 Chrome 背景 tab 節流）

Layer 3 — defense-in-depth
  - len < 50 拒絕（過渡訊息都 < 30 chars）
  - rejectPattern: "Thinking|Refining|Checking|正在思考|正在整理|正在檢查"
  - baselineHash: submit 前記住舊答案 hash，排除舊答案
```

### 2.6 Script 注意事項

#### Menu 等待
NotebookLM 的 menu items 是 **plain BUTTON**，不是 `[role=menuitem]`。
不能用 `waitForVisible('[role=menuitem]')` — 永遠不會 match。
改用 `findElementByText("移除來源")` 或 `findElementByText("刪除")` 輪詢等待 menu render。

#### Dialog 等待
Dialog 使用 `mat-dialog-container[role=dialog]`。
等 dialog 出現：`waitForVisible('mat-dialog-container, [role=dialog]')`
等 dialog 關閉：`waitForGone('[role=dialog], .cdk-overlay-pane')`

#### 「提交」按鈕歧義
頁面上有 2 個「提交」按鈕（搜尋欄 + Chat 輸入欄）。
UI map 用 `disambiguate: "y > 400"` 過濾，選 Chat 區的那個。
match 方式是 `aria-label`，不是 text。

#### addSource paste textarea
`waitForVisible('textarea')` 會 match 到搜尋框（已存在）。
必須用 `waitForVisible('textarea[aria-label="貼上的文字"]')` 等 paste dialog 專用的 textarea。

#### 來源展開遮蔽
來源被展開時，「新增來源」按鈕消失。`ensureSourcePanel` 裡已處理（嘗試 `collapse_content`）。

#### Dialog 確認步驟必須明確
GPT-4.1 非推理模型，dialog 出現後的確認/取消按鈕必須明確寫出 `find("刪除") → click`。
不能用「→ 確認」帶過。所有 script 都已明確寫出。

---

## 3. Viewport — 致命陷阱（⚠️ 已撞多次）

### 問題

**800x600 viewport 觸發 NotebookLM responsive mobile layout**（三欄 → tab 切換）。所有 script 都會壞。

### 三層 viewport 機制

| 機制 | API | 改什麼 | 持久性 |
|------|-----|--------|--------|
| 物理視窗 | `Browser.setWindowBounds` | Chrome 視窗大小（含標題列） | 永久 |
| Emulation override | `Emulation.setDeviceMetricsOverride` | **content area rendering** | **per-CDPSession** |
| puppeteer viewport | `page.setViewport()` | 底層也是 Emulation override | **persistent！跨 session 殘留** |

### 正確做法

```typescript
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});
```

### 錯誤做法（都不行）

- ❌ `page.setViewport()` — 留 persistent emulation，後續 connect 也被影響
- ❌ `Browser.setWindowBounds` — 只改物理視窗邊框，不改 content area
- ❌ `defaultViewport: null` — 不覆蓋但不保證尺寸

### 診斷方法

Screenshot 輸出會顯示 `Viewport: 800x600`。看到就是這個問題。

---

## 4. NL Planner — 自然語言組合測試

### 4.1 測試結果：10/10 PASS

| 類型 | 測試 | Planner | Execution | 結果 |
|------|------|---------|-----------|------|
| 單步 | query | 6.8s | 18.6s | ✅ |
| 單步 | listSources | 4.5s | 1.5s | ✅ |
| 單步 | addSource | 3.5s | 2.8s | ✅ |
| 單步 | clearChat | 3.4s | 3.1s | ✅ |
| 組合 | addSource → query | 3.7s | 21.6s | ✅ |
| 組合 | query → clearChat | 3.9s | 30.6s | ✅ |
| 組合 | addSource → listSources | 4.1s | 4.5s | ✅ |
| 拒絕 | off-topic | 2.8s | — | ✅ rejected |
| 拒絕 | ambiguous | 5.8s | — | ✅ rejected |
| 拒絕 | dangerous bulk | 3.8s | — | ✅ rejected |

### 4.2 Planner prompt 設計

```
你是 NotebookLM 控制器的 Planner。分析使用者的自然語言指令，拆解成操作步驟。

## 可用操作
query, addSource, listSources, removeSource, renameSource,
clearChat, listNotebooks, createNotebook, renameNotebook, deleteNotebook

## 規則
1. 單一操作 → 1 個 step
2. 複合操作 → 多個 steps，按邏輯順序
3. params 必須從使用者指令中提取，不可自行編造
4. 呼叫 submitPlan 提交結果
5. 不明確/缺參數/不支援/危險 → 呼叫 rejectInput
```

### 4.3 Planner tool schema 注意

Copilot SDK `defineTool` **不支援 `z.record()`**。會報 `Cannot read properties of undefined (reading '_zod')`。
改用展開的 optional fields：

```typescript
// ❌ 不行
params: z.record(z.string())

// ✅ 正確
question: z.string().optional(),
content: z.string().optional(),
newName: z.string().optional(),
```

### 4.4 Planner 雙職責

Planner 同時是 **input gate**：
- `submitPlan` → 正常路由到 script 執行
- `rejectInput(reason, userMessage)` → 拒絕無效輸入，task 終止在 Planner，零成本

拒絕類別：`off_topic` | `ambiguous` | `missing_params` | `unsupported` | `dangerous_bulk`

---

## 5. Recovery — 失敗接手

### 5.1 何時觸發

**只有 script status=fail 時才觸發。** Happy path 零 LLM 開銷。

### 5.2 Recovery session 做三件事（一個 session）

1. **完成任務**：用 browser tools 從失敗點接續完成原始目標
2. **分析原因**：selector 變了？流程變了？頁面狀態不對？
3. **輸出 suggestedPatch**：如果找到正確的 selector/text 值

### 5.3 Recovery prompt 關鍵規則

```
- 你必須在 10 個 tool call 內呼叫 submitResult
- 不要判斷答案品質（NotebookLM 只能根據來源回答）
- 不要重複提問
- 只能使用：screenshot, find, click, paste, type, read, wait, submitResult
```

**不加這些限制的後果**：agent 會進入無限循環（G2 Phase G 實測過），反覆嘗試得到「正確」答案、用 bash 工具、或超過 180s timeout。

### 5.4 Recovery 驗證結果：9/10 correctly fail

所有 element-based script 在 selector 被 corrupt 時：
- ✅ 在正確的 step 失敗
- ✅ 回報正確的 `failedSelector`
- ✅ Recovery agent 能用 browser tools 接手完成
- ✅ 產出 `suggestedPatch` with confidence

### 5.5 Browser tools for Recovery

Recovery agent 拿到的工具和 Phase F pure agent 完全一樣：

| Tool | 用途 |
|------|------|
| screenshot | 截圖觀察頁面狀態 |
| find(query) | DOM 查詢互動元素（`"*"` 列出全部） |
| click(x, y) | 點擊 + 自動截圖 |
| paste(text) | 貼上文字 |
| type(text) | 特殊鍵（Escape, Enter, Ctrl+A） |
| read(selector) | CSS selector 讀取 DOM |
| wait(seconds) | 等待 N 秒 |
| submitResult | 提交結果 + 分析 + patch |

---

## 6. Error Log — 失敗紀錄（含 Recovery 失敗場景）

### 6.1 存放位置

```
~/.nbctl/repair-logs/
  2026-03-15T05-41-08_query_chat_input.json
  2026-03-15T05-41-08_query_chat_input.png   # Recovery 失敗時的最終截圖
```

### 6.2 Log 結構

```jsonc
{
  "operation": "query",
  "failedAtStep": 1,
  "failedSelector": "chat_input",
  "uiMapValue": { "text": "開始輸入", "match": "placeholder" },
  "scriptLog": [
    { "step": 1, "action": "find_chat_input", "status": "fail",
      "detail": "Element not found: \"開始輸入\"", "durationMs": 3 }
  ],
  "recovery": {
    "success": true,    // or false
    "model": "gpt-5-mini",
    "toolCalls": 9,
    "durationMs": 85791,
    "result": "NotebookLM 回覆...",
    "analysis": "Script failed because the chat input placeholder changed...",
    "toolCallLog": [
      { "tool": "screenshot", "input": "{}", "output": "(binary)" },
      { "tool": "find", "input": "{\"query\":\"*\"}", "output": "[TEXTAREA] ..." },
      { "tool": "click", "input": "{\"x\":600,\"y\":860}", "output": "..." },
      { "tool": "paste", "input": "{\"text\":\"問題\"}", "output": "Pasted 15 chars." },
      { "tool": "read", "input": "{\"selector\":\".to-user-container .message-content\"}", "output": "Found 15 element(s)..." }
    ],
    "agentMessages": [
      "Taking a screenshot to inspect the current UI...",
      "Focusing the chat input, pasting the question..."
    ],
    "finalScreenshotPath": "2026-03-15T05-41-08_query_chat_input.png"  // null if recovery succeeded
  },
  "suggestedPatch": {
    "elementKey": "chat_input",
    "oldValue": "開始輸入",
    "newValue": "textarea[aria=\"查詢方塊\"]",
    "confidence": 0.9
  },
  "timestamp": "2026-03-15T05:41:08.757Z"
}
```

### 6.3 Recovery 失敗時 log 的資訊量

即使 Recovery agent 沒呼叫 `submitResult`（timeout），error log 仍然包含：

| 欄位 | 有無 | 用途 |
|------|------|------|
| `scriptLog` | ✅ 永遠有 | 哪步壞了、哪個 selector |
| `toolCallLog` | ✅ 永遠有 | Recovery 嘗試了什麼、find 找到什麼 |
| `agentMessages` | ✅ 永遠有 | Recovery 的推理過程 |
| `finalScreenshotPath` | ✅ 失敗時有 | 最終頁面狀態截圖 |
| `analysis` | ❌ 可能沒有 | 需要 submitResult 才有 |
| `suggestedPatch` | ❌ 可能沒有 | 需要 submitResult 才有 |

**結論**：即使 Recovery 完全失敗，repair agent 讀 error log + toolCallLog + 截圖就能判斷該修什麼。

### 6.4 SDK event 型別（正確的欄位名稱）

從 `@github/copilot-sdk` 的 `session-events.d.ts` 確認：

```typescript
// tool.execution_start
data: {
  toolCallId: string;     // 用來 match start → complete
  toolName: string;
  arguments?: Record<string, unknown>;  // 不是 "input"
}

// tool.execution_complete
data: {
  toolCallId: string;
  success: boolean;
  result?: {
    content: string;     // 不是 "textResultForLlm"
  };
}
```

---

## 7. 發布架構

### 7.1 核心原則

**Script 和 UI map 不能是 binary 的一部分。** 必須是 runtime 可讀可改的檔案。
原因：repair agent 需要修改，使用者不一定有 git。

### 7.2 檔案結構

```
Package (npm install):
  dist/                  # compiled JS — daemon, tab-manager, agent 等核心
  default-scripts/       # readable script templates
  default-ui-maps/       # default UI map JSON

Runtime (~/.nbctl/):
  config.json
  ui-maps/
    zh-TW.json           # UI map（可被 repair 修改）
    zh-TW.json.bak       # repair 前自動備份（參考點）
  scripts/
    query.js             # scripted flow（可被 repair 修改）
    query.js.bak         # 備份
  repair-logs/           # error logs
```

### 7.3 動態載入

```typescript
function loadScript(operation: string): ScriptFunction {
  const userScript = join(NBCTL_DIR, "scripts", `${operation}.js`);
  const defaultScript = join(__dirname, "default-scripts", `${operation}.js`);
  if (existsSync(userScript)) return require(userScript);
  return require(defaultScript);
}
```

### 7.4 安裝 + 修復 + 重置

- **安裝**：`postinstall` 從 `default-*` 複製到 `~/.nbctl/`（不覆蓋已存在）
- **修復**：`nbctl repair` 讀 `repair-logs/`，分析 pattern，修 UI map/script，修改前 `.bak` 備份
- **重置**：`nbctl repair --reset` 從 package `default-*` 重新複製，覆蓋 `~/.nbctl/`

---

## 8. UI Map

### 8.1 結構

```jsonc
{
  "locale": "zh-TW",
  "verified": true,
  "elements": {
    "chat_input":       { "text": "開始輸入", "match": "placeholder" },
    "submit_button":    { "text": "提交", "match": "aria-label", "disambiguate": "y > 400" },
    "add_source":       { "text": "新增來源" },
    "paste_source_type": { "text": "複製的文字" },
    "paste_textarea":   { "text": "在這裡貼上文字", "match": "placeholder" },
    "insert_button":    { "text": "插入" },
    "collapse_source":  { "text": "collapse_content" },
    "remove_source":    { "text": "移除來源" },
    "rename_source":    { "text": "重新命名來源" },
    "delete_chat":      { "text": "刪除對話記錄" },
    "conversation_options": { "text": "對話選項", "match": "aria-label" },
    "create_notebook":  { "text": "新建" },
    "edit_title":       { "text": "編輯標題" },
    "delete_notebook":  { "text": "刪除" },
    "save_button":      { "text": "儲存" },
    "cancel_button":    { "text": "取消" },
    // Studio (generateAudio/downloadAudio 待實作)
    "audio_overview":   { "text": "語音摘要" },
    "play_audio":       { "text": "播放", "match": "aria-label" },
    "download_audio":   { "text": "下載" },
    "notebook_settings": { "text": "設定筆記本", "match": "aria-label" }
  },
  "selectors": {
    "answer":        ".to-user-container .message-content",
    "question":      ".from-user-container",
    "suggestions":   ".suggestions-container",
    "source_panel":  ".source-panel",
    "chat_panel":    ".chat-panel",
    "studio_panel":  "studio-panel",
    "notebook_title": "h1",
    "notebook_rows": "tr[tabindex]",
    "thinking":      "div.thinking-message"
  }
}
```

### 8.2 語言無關的 icon names

以下 icon names 是 Material Icons，跨語言一致，不需要 i18n：

```
more_vert, collapse_content, play_arrow, dock_to_left, dock_to_right,
arrow_forward, edit, delete, content_paste, drive_pdf
```

### 8.3 CSS selectors 穩定性

以下 selectors 是 Angular component class names，較穩定：

```
.to-user-container, .from-user-container, .message-content,
.source-panel, .chat-panel, .suggestions-container,
mat-dialog-container, .cdk-overlay-pane, studio-panel
```

---

## 9. CDP Helpers

### 9.1 findElementByText

搜尋所有互動元素（16 種 selector），支援 text / placeholder / aria-label match。

```typescript
findElementByText(page, text, {
  match: "text" | "placeholder" | "aria-label",  // default: "text"
  disambiguate: "y > 400"  // optional position filter
})
```

回傳：`{ tag, text, center: {x, y}, rect: {x, y, w, h}, disabled }`

### 9.2 dispatchClick / dispatchPaste / dispatchType

```typescript
dispatchClick(cdp, x, y)     // Input.dispatchMouseEvent (pressed + released)
dispatchPaste(cdp, text)     // Input.insertText (fast, no key events)
dispatchType(cdp, page, text) // Special keys or Ctrl+A (JS select() fallback)
```

**Ctrl+A 注意**：CDP `Input.dispatchKeyEvent` 的 Ctrl+A 在 Angular Material dialog input 不可靠。
改用 JS `document.activeElement.select()` 取代（Finding #43）。

### 9.3 connectToChrome

```typescript
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
const page = pages.find(p => p.url().includes("notebooklm")) ?? pages[0];
const cdp = await page.createCDPSession();
// ⚠️ 必須設 viewport
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
});
```

---

## 10. 已知限制 + 待辦

| 項目 | 狀態 | 說明 |
|------|------|------|
| generateAudio script | ❌ 待寫 | 5+ 分鐘等待，需 `waitForGone("sync")` |
| downloadAudio script | ❌ 待寫 | CDP `Browser.setDownloadBehavior` + `<A>` link |
| i18n 多語言 | ❌ 待實作 | UI map per locale + repair auto-discover |
| File-based paste | ✅ 設計完成 | 500K chars, 0 token。`paste(filePath=...)` handler 讀檔貼入 |
| Multi-tab 並發 | ✅ 驗證通過 | CDP 支援，tab pool acquire/release 保證一 tab 一 agent |
| Tab pool weak affinity | ✅ 設計完成 | 連續同 notebook 免 navigate |
| Executor pre-navigate | ✅ 設計完成 | 系統層 URL exact match，agent 不自己判斷頁面 |

---

## 11. Spike 檔案對照 → Production 模組

| Spike 檔案 | Production 位置 | 說明 |
|-----------|----------------|------|
| `phase-g-shared.ts` → CDP helpers | `src/tab-manager/cdp-helpers.ts` | findElementByText, dispatch*, wait primitives |
| `phase-g-shared.ts` → UIMap types | `src/shared/ui-map.ts` | UIMap interface, loadUIMap, resolveLocale |
| `phase-g-scripts.ts` → all scripts | `src/scripts/*.ts` or `default-scripts/` | 每個操作一個檔案 |
| `phase-g2.ts` → recovery session | `src/agent/recovery-session.ts` | runRecoverySession + saveRepairLog |
| `phase-g2-planner-test.ts` → planner | `src/agent/planner-session.ts` | runPlanner + submitPlan/rejectInput |
| `ui-maps/zh-TW.json` | `default-ui-maps/zh-TW.json` + `~/.nbctl/ui-maps/` | 隨 package 發布，runtime 讀 ~/.nbctl/ |
