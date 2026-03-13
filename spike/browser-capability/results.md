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

## Remaining

- `dispatchType` not tested for special keys (Enter, Tab, Escape)
- Multi-tab scenarios
- Error recovery (element not found, page not loaded)
- Model selection (SDK currently uses default model, not configurable in spike)
