# 001-MVP Improvement Notes

> Post-MVP 全盤檢討。2026-03-15 G2 integration 完成後整理。

---

## Architecture Retrospective

### What Worked

1. **Planner → Script → Recovery pattern** — Happy path 0 LLM cost, query ~15-20s (vs 純 LLM Executor 70s)。Recovery 只在壞掉時出場，帶 repair log + suggestedPatch，有自我修復基礎。
2. **UIMap + findElementByText + wait primitives** — DOM 操作基礎建設。所有 script 和 Recovery agent 共用同一套 selector 體系。
3. **ctx injection pattern** — scripts 零 import，依賴透過 ScriptContext 注入。未來 `~/.nbctl/scripts/` 動態載入的基礎。
4. **ISO Browser 獨立驗證** — 不信任 daemon 自己的回報。renameNotebook false positive 就是靠 ISO 抓到的。沒有它這個 bug 會上線。

### What Took Detours

- CustomAgent sub-agent → Two-Session Planner+Executor → Script-first，繞了一大圈。如果一開始直接 spike script 可行性，可以省掉 Executor 那整層。
- 但 spike 過程發現了 Finding #39（sub-agent 拿不到 custom tools）、#55（z.record crash）、#60（viewport），不算白費。

---

## Known Fragilities

### 1. DOM 文字匹配的脆弱性

`findElementByText` 用文字 includes 匹配，有兩層風險：

- **Google 改按鈕文字** → UIMap 可以隔離，但要人工更新
- **用戶內容汙染** → notebook/source 名稱包含 UI 按鈕文字（「儲存」「刪除」「插入」）會 match 到錯誤元素

**已修**：dialog 按鈕搜尋 scope 到 `.cdk-overlay-pane`。
**未修**：頁面級搜尋仍可能被用戶內容干擾（如 "新增來源" 出現在 source 名稱中）。

### 2. Viewport 硬綁定

1920×1080 是 contract。script 的 `getBoundingClientRect()` 座標是 viewport-relative，改解析度 = 改所有座標。目前沒有自動校準或相對定位機制。

### 3. Recovery 黑箱

GPT-5-mini 跑 Recovery 時只有 tool call log 可觀測。timeout 120s 不 call submitResult 的情況出現多次。10 tool call limit 是防護但不夠精準。

### 4. Planner 偶爾 timeout

GPT-4.1 對某些 prompt 會思考 60s+ 不 call tool。「Planner 不 call tool = 什麼都不發生」的設計讓這變成靜默失敗。

### 5. Angular Material 的 CDP 限制

- `Input.insertText`（CDP）不觸發 Angular change detection → 必須用 native value setter + dispatchEvent
- Headless Chrome 的 `Input.dispatchMouseEvent` 有時不正確 focus dialog input
- Menu popup 會因 focus change 自動關閉 → find+click 必須 atomic

---

## Technical Debt

| 項目 | 嚴重度 | 說明 |
|------|--------|------|
| `agent-loader.ts` + `AgentConfig` | LOW | 不再被主流程使用，保留增加認知負擔 |
| `waitForContent` browser tool | LOW | 被 `pollForAnswer` 取代但未刪 |
| `operations.ts` 991 行 | MEDIUM | dialog 操作 boilerplate 重複多，應抽 helper |
| renameSource 用 CDP `dispatchPaste` | MEDIUM | 可能跟 renameNotebook 一樣有 false positive，未驗證 |
| `.chat-panel` / `.source-panel` CSS class | HIGH | Google 改這些 class 全壞，無替代 selector |
| `ensureHomepage` hardcode URL | LOW | `https://notebooklm.google.com` 寫死 |

---

## Missing MVP Features（未實作）

### Content Pipeline（高優先）

Spec 裡定義了但未整合到 G2 script flow：

1. **Repomix (repo → text)** — `src/content/repo-to-text.ts` 已有 code，但 `scriptedAddSource` 只支援純文字 paste。需要：
   - addSource script 接受 `type: "repo"` param
   - 自動調用 `repoToText()` 產出 markdown
   - 大檔案走 file-based paste（temp file + CDP Input.dispatchDragEvent 或分段 paste）
   - 500K word limit 分段策略

2. **Crawl4AI / URL → text** — `src/content/url-to-text.ts` 已有 readability extraction，但：
   - 未整合到 addSource script
   - NotebookLM 本身支援 URL native import（`url_source_type` in UIMap），應優先用 native
   - Crawl4AI 做 fallback（SPA、需要 JS render 的頁面）

3. **PDF → Markdown** — `src/content/pdf-to-text.ts` 已有 pdf-parse，但：
   - 未整合到 addSource script
   - 大 PDF（> 500K words）需要分段
   - NotebookLM 支援 PDF upload（`upload_source_type`），但有 50MB 限制

### Audio Operations（低優先）

- `generateAudio` — 產生語音摘要（Audio Overview）
- `downloadAudio` — 下載產生的語音檔
- 這兩個 spike 沒做，script 也沒寫。UI flow 更複雜（需要等 generation 完成、polling progress）。

### Publishing Architecture（中優先）

計畫中的 `~/.nbctl/scripts/` 動態載入：
- `src/scripts/*.ts` → tsc → `default-scripts/*.js` → postinstall copy → `~/.nbctl/scripts/*.js`
- Repair agent 可以修改 user scripts
- UIMap user override 已實作（`~/.nbctl/ui-maps/`），scripts 動態載入還沒

---

## Improvement Priorities

### P0: Content Pipeline Integration

```
addSource script → detect type (text/repo/url/pdf) →
  text: direct paste (current)
  repo: repoToText() → paste (或 file-based paste if > limit)
  url:  native URL import (NotebookLM 原生) → fallback to crawl4AI + paste
  pdf:  native upload (NotebookLM 原生) → fallback to pdf-parse + paste
```

### P1: Script Robustness

- 抽出 `dialogHelper(overlay, buttonText)` 減少 boilerplate
- renameSource 改用 native value setter（跟 renameNotebook 一樣）
- 加入 script-level result verification（不只回報 success，用 DOM 確認操作真的生效）
- `findElementByText` 加 scope 參數（optional container selector）

### P2: Observability

- Recovery session 的 tool call log 即時串流（不只在結束後 dump）
- Planner timeout 時自動 retry（目前是靜默失敗）
- Script step-by-step log 送 MCP notification（client 可以看進度）

### P3: Resilience

- Viewport 自動偵測 + 自動調整（量 page layout 再決定座標偏移）
- UIMap auto-patch（suggestedPatch confidence > 0.8 自動套用）
- Script retry（非 selector 失敗的 transient error 自動重試 1 次）
