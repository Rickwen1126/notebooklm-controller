# Browser Capability Spike — Phase A Results

**Date**: 2026-03-13
**Duration**: ~40 min (including viewport debugging)
**Verdict**: PASS — all 3 flows verified

## Environment

- Chrome (headed) + puppeteer-core + CDP
- Viewport: 1440x793 CSS pixels, DPR 2
- Profile: `~/.nbctl/profiles/spike` (shared Google login)
- Tools: 5 CDP helpers from `src/tab-manager/cdp-helpers.ts`

## Flow Results

| # | Flow | Steps | Result |
|---|------|-------|--------|
| 1 | Create notebook | click "新建" | ✅ Notebook created, navigated to notebook page |
| 2 | Query | paste question → click submit | ✅ NotebookLM answered with source citations |
| 3 | Add source (copied text) | click "新增來源" → "複製的文字" → paste text → click "插入" | ✅ Source added, auto-summarized |

## Key Findings

### 1. CDP Input API works on NotebookLM

`Input.dispatchMouseEvent` (mousePressed + mouseReleased) correctly triggers Angular/Material components.
`Input.insertText` correctly fills textarea elements.

### 2. Coordinate estimation from screenshots is NOT viable

| Attempt | Estimated | Actual (getBoundingClientRect) | Error |
|---------|-----------|-------------------------------|-------|
| "+ 新建" button | (617, 51) | (1237, 104) | 2x off |
| "Docker Deep Dive" row | (130, 158) | (714, 317) | 5x off |

**Root cause**: Screenshot image rendered at reduced scale in viewer; human visual estimation unreliable for CSS pixel coordinates.

### 3. DOM query is essential (the "6th tool")

The 5 CDP helpers (screenshot, click, type, scroll, paste) are necessary but NOT sufficient.
An agent needs `getBoundingClientRect()` / `document.querySelectorAll()` to find element positions.

**Viable agent tool loop**:
```
screenshot → understand visual state → findElement(text/selector) → get coordinates → click/type/paste → repeat
```

**Not viable**:
```
screenshot → estimate coordinates from image → click  (fails: coordinates are wrong)
```

### 4. puppeteer-core gotchas

- `puppeteer.connect()` defaults to 800x600 viewport override — MUST set `defaultViewport: null`
- `page.setViewport()` leaves persistent Emulation override that survives across CDP sessions
- `page.createCDPSession()` creates an independent session; emulation state is per-session

### 5. All 5 CDP helpers are production-viable

| Helper | Used in flow | Works? |
|--------|-------------|--------|
| captureScreenshot | All flows | ✅ |
| dispatchClick | All flows | ✅ |
| dispatchType | Not tested (used paste instead) | — |
| dispatchScroll | Not needed in tested flows | — |
| dispatchPaste | Flow 2 (query), Flow 3 (add source) | ✅ |

`dispatchType` was not tested because `dispatchPaste` (Input.insertText) is faster and more reliable for bulk text. `dispatchType` would be needed for character-by-character input or special key scenarios.

## Design Implications for Main Project

1. **Add DOM query tool**: `findElement({ text?, selector?, ariaLabel? }) → { tag, text, rect }[]` — this is the missing piece
2. **Agent loop**: screenshot (visual context) + findElement (precise coordinates) + input (action) = complete interaction cycle
3. **No coordinate estimation**: Agent should NEVER guess coordinates from screenshots; always query DOM first
4. **Paste over type**: Use `dispatchPaste` for text input, reserve `dispatchType` for special keys
5. **Viewport**: Always set `defaultViewport: null` when connecting via puppeteer

## Phase A+ Supplementary Tests (2026-03-13, session 2)

### 6. Haiku model can drive the full flow

Ran complete flow (create notebook → add source → query → read answer) with Haiku (claude-haiku-4-5) as the driving model. **Result: PASS** — 13 tool calls, 0 code. Haiku successfully:
- Navigated to home, found "新建" button, created notebook
- Added source via "複製的文字" flow
- Asked question, submitted, read answer via `.to-user-container .message-content`

One failure: Haiku couldn't find the "新增來源" button to add a second source — but this was due to a UI state issue (see finding #7), not model capability.

### 7. Source view occlusion — critical UI trap

**Problem**: When a source is expanded (clicked open) in the left panel, the "新增來源" button is hidden. `find "新增來源"` returns nothing.

**Root cause**: NotebookLM's left panel has two states:
- **Collapsed source list**: Shows "＋ 新增來源" button + source list items
- **Expanded source view**: Shows full source content, hides the "＋ 新增來源" button

**Recovery**: Click the `collapse_content` icon (two diagonal arrows pointing inward) at the top of the source panel to exit expanded view.

```
find "collapse_content"  → [BUTTON] click(538, 88)
click 538 88             → source view collapsed, "新增來源" becomes visible again
find "新增來源"          → [BUTTON] "add 新增來源" click(192, 149)
```

**Agent must know**: If `find "新增來源"` fails, try `find "collapse_content"` first to close any expanded source view.

### 8. "提交" button disambiguation

Two "提交" (submit) buttons exist on the page:
- `click(326, 254)` — in the search/URL input area (top)
- `click(1016, 730)` — in the chat input area (bottom)

**Rule**: Always pick the one with `y > 400` for chat submission.

### 9. `.to-user-container .message-content` is the clean answer selector

- `.message-content` alone matches BOTH user questions and model answers
- `.to-user-container .message-content` returns only the model's answer text
- Answer includes citation markers (e.g., `1`) indicating source-grounded response

### 10. Second question in same notebook works

After first Q&A, asked a second question in the same notebook. Both answers returned correctly by `read .to-user-container .message-content` (separated by `---`). Multi-turn conversation within a single notebook session is stable.

### 11. Add second source to existing notebook — PASS

Successfully added a second source (Copilot SDK 說明) to a notebook that already had one source (MCP 說明). Full flow:

```
find "collapse_content" → click      (收合已展開的來源檢視，如果需要)
find "新增來源"         → click      (開啟新增來源對話框)
find "複製的文字"       → click      (選擇來源類型)
find "在這裡貼上文字"   → click      (focus textarea)
paste "..."             →            (貼入來源內容)
find "插入"             → click      (送出)
```

結果：
- 左面板顯示 2 個來源，底部計數更新為「2 個來源」
- NotebookLM 自動將筆記本標題從 "Untitled notebook" 改為「MCP：AI 與外部世界的標準化橋樑」

### 12. Cross-source grounding — PASS

Asked a question that requires information from BOTH sources: "Copilot SDK 的 createSession 和 MCP Server 的 Tools 之間有什麼關係？"

NotebookLM response:
- Correctly cited both sources (marker `1` = Copilot SDK, marker `2` = MCP)
- Honestly stated "資料中並未直接說明兩者如何整合"
- Independently explained each mechanism from its respective source
- Inferred integration approach (MCP Tools → SDK tool array format conversion)

This confirms NotebookLM can synthesize across multiple sources with proper citation attribution.

### 13. Answer loading requires wait — timing consideration

When asking cross-source questions, NotebookLM initially shows intermediate states:
- First read returned `"Refining Tool Access..."` (still processing)
- After additional 10s wait, full answer was available

**Agent rule**: After submitting a question, wait 10-15s before `read`. If answer contains loading indicators ("Refining...", "Thinking...", spinning), wait and retry.

## Verified Flows Summary

| # | Flow | Status | Tool calls |
|---|------|--------|------------|
| 1 | Create notebook | ✅ | 3 (shot → click → wait) |
| 2 | Add first source (copied text) | ✅ | 5 (find → click → find → paste → click) |
| 3 | Ask question + read answer | ✅ | 5 (find → click → paste → find submit → read) |
| 4 | Add second source to existing notebook | ✅ | 6 (collapse → find → click → find → paste → click) |
| 5 | Cross-source question | ✅ | 5 (same as #3) |
| 6 | Multi-turn conversation | ✅ | same as #3 per turn |

## Phase B — Copilot SDK Runtime (2026-03-13, session 2)

### 14. Copilot SDK runtime integration — PASS

Wrapped 9 tools (7 browser + navigate + wait) in `defineTool()` format, ran through `CopilotClient → createSession → sendAndWait`.

Script: `spike/browser-capability/phase-b.ts` (self-contained, no imports from `src/`)

**Run 2 (full flow, enhanced prompt)**:
- 20 tool calls, 86s total
- Agent followed all 4 steps: create notebook → add source → ask question → read answer
- Correct tool sequencing: find → click → paste → wait → read

**Run 3 (with timing)**:
- 20 tool calls, 136s total (slower due to LLM reasoning on screenshot analysis)
- Same correct flow, reproducible

### 15. Setup timing breakdown

| Phase | Duration |
|-------|----------|
| Chrome connect + CDP session | 28ms |
| Create 9 tools | 2ms |
| `client.start()` (Copilot CLI process) | 644ms |
| `createSession()` (tool schema + session init) | 5,658ms |
| **Total setup** | **6,332ms** |

**Bottleneck**: `createSession()` at 5.6s — SDK serializes tool schemas, sends to CLI, CLI handshakes with GitHub API.
In production: CopilotClient is singleton (always running), so only `createSession()` cost per task.

### 16. Event observability — session.on() works

SDK's `session.on(handler)` receives all events in real-time:
- `assistant.turn_start/end` — agent reasoning cycles
- `assistant.reasoning` — agent's internal thought process (visible!)
- `assistant.message` — agent's text output
- `tool.execution_start/complete` — tool invocations with args and results
- `session.error` — error reporting

Agent reasoning is fully observable — e.g., "The user wants me to operate NotebookLM... Let me start by taking a screenshot."

### 17. Prompt engineering is critical for agent accuracy

**Run 1 (minimal prompt)**: Agent saw existing results on page, took shortcut (4 tool calls, didn't create new notebook)
**Run 2+ (enhanced prompt with NOTEBOOKLM_KNOWLEDGE)**: Agent correctly followed all steps

Key additions that made it work:
- Explicit UI element table (operation → find text → expected element)
- Known CSS selectors
- Disambiguation rules (submit button y>400, collapse_content recovery)
- Step-by-step task breakdown with expected UI states

### 18. SDK internal tools

The SDK injects its own tools alongside ours:
- `report_intent` — agent declares its intent before acting
- `view` — agent requests to view binary data (screenshots)

These are managed by the SDK runtime, not by us.

## Verified Flows Summary

| # | Flow | Status | Tool calls |
|---|------|--------|------------|
| 1 | Create notebook | ✅ | 3 (shot → click → wait) |
| 2 | Add first source (copied text) | ✅ | 5 (find → click → find → paste → click) |
| 3 | Ask question + read answer | ✅ | 5 (find → click → paste → find submit → read) |
| 4 | Add second source to existing notebook | ✅ | 6 (collapse → find → click → find → paste → click) |
| 5 | Cross-source question | ✅ | 5 (same as #3) |
| 6 | Multi-turn conversation | ✅ | same as #3 per turn |
| 7 | **Full flow via Copilot SDK agent** | ✅ | **20 (autonomous, 86-136s)** |
| 8 | **Full flow via GPT-4.1 (free model)** | ✅ | **24 (autonomous, 60.7s)** |

## Phase B+ — Model Comparison (2026-03-13, session 3)

### 19. GPT-4.1 (free model) outperforms default — PASS

Ran full flow (create notebook → add source → query → read answer) with `model: "gpt-4.1"` specified in `createSession()`.

**Result: PASS** — 24 tool calls, 60.7s, complete flow with correct answer.

| Metric | Default model | GPT-4.1 |
|--------|--------------|---------|
| Total time | 95.4s | **60.7s** (36% faster) |
| Tool calls | 20 | 24 (4 extra `report_intent`) |
| Setup total | 6,340ms | **1,294ms** (5x faster) |
| createSession() | 5,669ms | **513ms** (11x faster) |
| client.start() | 741ms | 741ms (same) |
| Result | PASS | **PASS** |

### 20. GPT-4.1 parallel tool calling

GPT-4.1 issues multiple tool calls per turn (parallel execution):
- Turn 1: `report_intent` + `screenshot` + `find` (3 tools simultaneously)
- Turn 4: `report_intent` + `find` (2 tools)
- Turn 6: `find` + `report_intent` (2 tools)

This explains the faster completion despite more total tool calls — fewer round-trips.

### 21. createSession() 11x faster with explicit model

When `model` is specified, `createSession()` drops from 5.6s to 513ms. Likely skips model negotiation/selection on the GitHub API side.

**Production implication**: Always specify model explicitly in `createSession()`.

### 22. GPT-4.1 is free on GitHub Copilot

GPT-4.1 is a free-tier model on GitHub Copilot. Combined with its strong performance on mechanical tool-calling tasks, this means:
- **Execution agent cost = $0** for the browser automation layer
- Non-reasoning model is sufficient for find → click → paste → read loops
- Intelligence budget should go to task planning (deciding WHAT to do), not execution (HOW to click)

### 23. Available models via `client.listModels()`

SDK `--model` flag now supported in `phase-b.ts`. Full model list retrieved:

| Model ID | Vision | Reasoning | Notes |
|----------|--------|-----------|-------|
| gpt-4.1 | ✅ | ❌ | **Free, verified for browser automation** |
| gpt-5-mini | ✅ | ✅ | Reasoning model |
| gpt-5.1 | ✅ | ✅ | |
| gpt-5.1-codex | ✅ | ✅ | |
| gpt-5.1-codex-mini | ✅ | ✅ | |
| gpt-5.1-codex-max | ✅ | ✅ | |
| gpt-5.2 | ✅ | ✅ | |
| gpt-5.2-codex | ✅ | ✅ | |
| gpt-5.3-codex | ✅ | ✅ | |
| gpt-5.4 | ✅ | ✅ | |
| claude-haiku-4.5 | ✅ | ❌ | |
| claude-sonnet-4 | ✅ | ❌ | |
| claude-sonnet-4.5 | ✅ | ❌ | |
| claude-sonnet-4.6 | ✅ | ✅ | |
| claude-opus-4.5 | ✅ | ❌ | |
| claude-opus-4.6 | ✅ | ✅ | |
| gemini-3-pro-preview | ✅ | ❌ | |

## Phase A++ — No-Screenshot Flow (2026-03-13, session 3)

### 24. Screenshot is NOT required for happy path — PASS

Ran complete flow (create notebook → add source → query → read answer) with **zero screenshots**. All state verification done via DOM queries.

| Step | Action | Verification (DOM only) | Screenshot? |
|------|--------|------------------------|-------------|
| Confirm home page | — | `find("新建")` returns button | ❌ |
| Create notebook | `click(新建)` | `find("複製的文字")` appears | ❌ |
| Add source | `click → paste → click(插入)` | `find("開始輸入")` appears (chat input) | ❌ |
| Ask question | `click → paste → click(提交)` | — | ❌ |
| Read answer | `sleep 15` | `read(".to-user-container .message-content")` non-empty | ❌ |

**Result**: Full flow completed, correct answer returned, 0 screenshots taken, 0 vision tokens consumed.

### 25. Screenshot role redefined: debug-only, not operational

Previous assumption: screenshot is needed for "understanding visual state" before each action.

**New understanding**: Screenshots serve NO operational purpose in the happy path.
- **Coordinates**: `find()` gives precise coordinates — screenshots cause 2-5x estimation errors
- **State verification**: `find()` and `read()` confirm UI state via DOM — faster and cheaper than vision
- **Answer extraction**: `read(selector)` gets text directly — no OCR needed

**Screenshots are debug tools, not operational tools.** They should be:
1. **Never sent to LLM during happy path** — zero vision token cost
2. **Triggered on anomaly** — when `find()` returns empty, `read()` returns unexpected content, or click produces no expected DOM change
3. **Saved to disk periodically** — for human post-mortem debugging, not for agent consumption

### 26. Anomaly-triggered debug capture design

When an operation produces unexpected results, capture a debug snapshot:

```
Trigger conditions:
- find(expected_text) returns [] (element not found)
- read(selector) returns "" or contains loading indicators ("Refining...", "Thinking...")
- Expected DOM state not observed after click + wait

Debug snapshot contents:
1. screenshot → save to disk (PNG)
2. DOM dump → read("body") or page.evaluate(() => document.body.innerHTML) → save to disk
3. Structured log entry with: timestamp, step, expected state, actual state

Storage: ~/.nbctl/debug/<notebook-alias>/<timestamp>/
```

This gives full context for debugging without consuming vision tokens during normal operation.

### 27. ~~Cost implication: execution agent can be non-vision model~~ → 修正見 #29

~~Remove screenshot from default tool set~~ → 不再適用。見 #29 agent 自主判斷原則。

## Phase C — Enhanced Tools + Agent Autonomy (2026-03-13, session 4)

### 28. Enhanced find/read v2 + agent autonomy — PASS

增強 find（selector 從 9→16 種，加 disabled/ariaExpanded/visibility 過濾）和 read（結構化回傳 count + items with tag/text/visible）。加入「狀態確認原則」讓 agent 自主選擇觀測方式。

**GPT-4.1 跑 enhanced tools**：

| Metric | Phase B+ (v1 tools) | Phase C (v2 tools) |
|--------|--------------------|--------------------|
| Tool calls | 24 | **22** |
| Duration | 60.7s | **55.7s** |
| Result | PASS | **PASS** |

Agent 自然選擇 DOM 確認狀態，screenshot 只在初始探索用了一次。

### 29. Agent 自主判斷原則（設計決策）

**修正 #24-#27 的結論**：screenshot 不應被標記為 "debug only"。

正確設計：find、read、screenshot 是三個平等的觀測工具。Agent 自行判斷何時用什麼確認頁面狀態。Prompt 只設目標（「確認狀態正確」），不限手段。不預存 success pattern，agent 自己判斷成功/失敗。

之前的「happy path 0 vision tokens」修正為「agent 自行決定 vision 用量」。
之前的「non-vision model 足夠」修正為「model 需有 vision 能力，但 agent 可選擇不用」。

### 30. i18n discovery layer（設計筆記）

目前 prompt 中的 UI element table 是中文 locale-specific（`find("新建")`, `find("提交")` 等）。公開專案需要三層設計：

1. **Discovery**（vision）：首次進入未知 locale → screenshot → 辨識 UI 元素語義
2. **Targeting**（DOM）：用 discovery 結果的 text → find → 精確座標
3. **Cache**：UI map → `~/.nbctl/ui-maps/<locale>.json`，breakage 時重新 discover

Vision 的真正角色是「語義理解」（這個按鈕做什麼），不是「座標定位」（它在哪裡）。

### 31. find/read v2 增強

**find v2**：
- Selector 擴大：加入 `[role=tab]`, `[role=menuitem]`, `[role=option]`, `[role=checkbox]`, `[role=radio]`, `[role=switch]`, `[role=combobox]`, `[tabindex]:not([tabindex='-1'])`
- 新增回傳：`disabled`（disabled attr / aria-disabled）、`ariaExpanded`
- 新增過濾：`visibility: hidden` / `display: none`

**read v2**：
- 回傳結構化：`Found N element(s):\n[1] TAG: text...`
- 含 `count`、`visible` 狀態
- 兼顧狀態驗證和內容提取

## Remaining

- `dispatchType` not tested for special keys (Enter, Tab, Escape)
- Multi-tab scenarios
- ~~Error recovery~~ Partially addressed: anomaly-triggered debug capture designed (#26)
- ~~Model selection~~ ✅ Resolved: `--model` flag added, GPT-4.1 verified
- ~~Screenshot necessity~~ ✅ Resolved: agent 自主判斷，不預設限制 (#29)
- ~~Tool coverage~~ ✅ Resolved: find/read v2 增強 (#31)
- i18n discovery layer（#30，設計完成，未實作）
- ~~Full operation coverage~~ ✅ Resolved: Phase D 全操作實測通過 (#32-#38)

## Phase D — Full Operation Test (session 5)

**Date**: 2026-03-13
**Verdict**: ALL PASS — 所有 spec 操作均可通過 DOM tools 完成

### Summary

用 find v2 + read v2 + click 手動測試所有 spec 要求的 NotebookLM 操作：

- **Homepage**: 列筆記本(106)、新建、menu(編輯標題/刪除)、進入筆記本 ✅
- **Source**: 列來源、新增(4 types)、移除、重命名、展開/收合、checkbox ✅
- **Chat**: 輸入、提交、讀回答、建議問題、儲存記事、刪除對話記錄 ✅
- **Audio**: 觸發生成、狀態偵測、播放、下載、速度調整 ✅
- **Studio**: 面板讀取(自訂元素)、收合/展開面板 ✅
- **Title**: 讀取(h1) ✅、直接編輯 ❌(需從 homepage menu) ✅

### Key findings (#32-#38)

32. 筆記本標題只能從 homepage menu → 編輯標題修改
33. 語音摘要點擊即觸發生成（~5-10 min），status 用 `read "studio-panel"` 偵測 "sync"
34. 下載音訊是 `<A>` tag（非 button），觸發瀏覽器下載
35. 對話選項只有「刪除對話記錄」，無「新對話」
36. find v2 正確偵測 disabled 狀態
37. Studio 面板是 `<studio-panel>` 自訂 web component
38. Source item 有 BUTTON(展開詳情) + INPUT(checkbox) 兩個 interactive，需區分

## Phase E — CustomAgents 生產模擬 (session 6)

### 概要

測試 Copilot SDK `customAgents[]` 架構：載入 `agents/*.md` → `CustomAgentConfig[]`，自然語言路由。

### 結果

| 測試 | tools 配置 | 結果 | 耗時 | Tool calls |
|------|-----------|------|------|-----------|
| filtered | `["read", "find", "screenshot"]` | ⚠️ sub-agent 無 custom tools，main fallback | 42s | 5 |
| all | `undefined` | ❌ 無限遞迴 + bash fallback | 5min (timeout) | 66 |

### Key findings (#39-#40)

39. **`defineTool()` custom tools 不會注入 sub-agents** — sub-agents 只看到 built-in tools（bash, view, edit）。Custom tools 需透過 MCP 暴露。
40. **推薦架構**：browser tools → MCP Server tools → sub-agents 透過 `customAgents[].mcpServers` 取得。與 spec 的 MCP daemon 設計一致。

### 驗證通過

- ✅ Agent config YAML parsing + template rendering
- ✅ UI map locale + `{{NOTEBOOKLM_KNOWLEDGE}}` 模板注入
- ✅ Main agent 意圖辨識 + 路由（正確選 task:list-sources）
- ✅ CopilotClient lifecycle 完整
- ✅ Main agent fallback 用 custom tools 完成任務（42s, 5 calls）
