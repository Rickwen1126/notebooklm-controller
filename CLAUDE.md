# notebooklm-controller Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-24

## Active Technologies

- TypeScript 5.x, Node.js 22 LTS + `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse` (001-mvp)
- Storage: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）(001-mvp)
- Testing: Vitest (001-mvp)

## Project Structure

```text
src/
  daemon/         # MCP Server daemon (Streamable HTTP, @modelcontextprotocol/sdk)
  tab-manager/    # Single Chrome multi-tab management (puppeteer-core, CDP)
  network-gate/   # Centralized traffic gate (permit-based)
  agent/          # Copilot SDK agent adapter
    client.ts     # CopilotClient singleton (manages CLI process)
    session-runner.ts  # Planner → Script → Recovery orchestration
    recovery-session.ts  # GPT-5-mini LLM recovery (only on script failure)
    repair-log.ts  # Repair log + screenshot persistence
    hooks.ts      # SessionHooks (NetworkGate integration, error recovery)
    agent-loader.ts  # Legacy agent config loader (kept for backward compat)
    tools/        # defineTool() + Zod (browser-tools, content-tools, state-tools)
  scripts/        # G2: Deterministic DOM scripts (0 LLM cost happy path)
    types.ts      # ScriptResult, ScriptContext, ctx injection types
    find-element.ts  # findElementByText — 16 interactive selectors + disambiguate
    wait-primitives.ts  # pollForAnswer, waitForGone/Visible/Enabled/Navigation/CountChange
    ensure.ts     # ensureChatPanel, ensureSourcePanel, ensureHomepage
    operations.ts # 10 scripted operations (query, addSource, listSources, ...)
    index.ts      # runScript dispatcher + buildScriptCatalog
  content/        # Content pipeline (repo/URL/PDF → text, pure functions)
  state/          # JSON state persistence
  notification/   # MCP notification (async task completion)
  shared/         # Shared utilities
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x, Node.js 22 LTS: Follow standard conventions

## Recent Changes
- 001-mvp: Added TypeScript 5.x, Node.js 22 LTS + `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`

- 001-mvp: MCP Server architecture (7 modules: daemon, tab-manager, network-gate, agent, content, state, notification)
- 001-mvp: CLI + HTTP API → MCP Server (Streamable HTTP); BrowserPool → TabManager (Single Browser Multi-tab)

<!-- MANUAL ADDITIONS START -->

## CRITICAL: AI Agent SDK

**使用 `@github/copilot-sdk`（GitHub Copilot SDK），不是 Claude Agent SDK。**
這是專案核心決策，不可更改。所有 agent session 管理、tool 注入、vision 操作都透過 Copilot SDK 的 agent runtime。

**角色分工**：
- **Daemon** = createSession 的呼叫者（不是 agent）
- **Main Agent** = Copilot CLI runtime 內建（不由我們定義），用 `systemMessage` 追加指令
- **Subagent** = `customAgents` 陣列的每個 entry（對應 `agents/*.yaml`），只看到自己 config 列的 tools

**SDK 標準寫法**：
- `CopilotClient` singleton（daemon 層級，autoRestart: true）
- `client.createSession({ tools, customAgents, hooks })` per-task
- `defineTool(name, { description, parameters: z.object(...), handler })` 定義 tool
- `ToolResultObject.binaryResultsForLlm` 回傳截圖（Tool 自包原則）
- `session.sendAndWait({ prompt })` 執行操作

## CRITICAL: Script DOM 搜尋安全規則

**Dialog 內的按鈕搜尋必須 scope 到 overlay container，不能搜全頁面。**

用戶的 notebook/source 名稱可能包含 UI 按鈕文字（「儲存」「刪除」「插入」「提交」等），`findElementByText` 搜全頁面會 match 到錯誤元素（false positive — script 報 success 但操作沒生效）。

**規則：**
- Dialog 按鈕：用 `page.evaluate` 在 `.cdk-overlay-pane, [role=dialog]` 內搜尋
- 頁面級固定 UI（「新增來源」「開始輸入」等）：可以用 `findElementByText`
- 有歧義的全頁搜尋：加 `disambiguate` 限制（如 `y > 400`）
- Angular Material input 設值：用 `HTMLInputElement.prototype.value` native setter + `dispatchEvent('input')`，CDP `Input.insertText` 不觸發 change detection

這些規則也適用於 Repair Agent 的 UIMap patch 建議。

## CRITICAL: Copilot SDK defineTool 限制

**`defineTool` 的 parameters 不支援 `z.record()`、`z.map()` 等動態 key types。**
Runtime 會 crash：`Cannot read properties of undefined (reading '_zod')`。
用 expanded optional fields 取代，handler 內部再轉回 Record。

## CRITICAL: Viewport 1920x1080 是 Contract

**所有 script 在 1920x1080 解析度下測試和運行。這是 contract，不是偏好。**

- `daemon/index.ts` 用 `Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false })`
- Script 用 `getBoundingClientRect()` 取座標 → `dispatchClick(x, y)` 點擊，座標是 viewport-relative
- **改解析度 = 改所有座標 = 所有 script 可能壞掉**
- 800x600 觸發 NotebookLM mobile tab view（已撞多次）
- 1440x900 homepage list view 的 more_vert column 超出 viewport（x≈1507）
- 任何改動 viewport 都必須重跑全部 real test（S01-S12 + ISO Browser 驗證）
- Spike 也必須用同一解析度

## G2: Script-first Architecture

**Happy path = 0 LLM cost（deterministic script）。Failure = Recovery LLM（GPT-5-mini）。**

流程：`Planner LLM (gpt-4.1)` → `runScript()` → (fail?) `runRecoverySession()` + `saveRepairLog()`

- Scripts 用 ctx injection pattern（零 import，所有依賴透過 ScriptContext 注入）
- 10 scripted operations：query, addSource, listSources, removeSource, renameSource, clearChat, listNotebooks, createNotebook, renameNotebook, deleteNotebook
- NetworkGate per-operation acquirePermit（scripts 繞過 SessionHooks）
- 截圖持久化 `~/.nbctl/screenshots/`，repair log `~/.nbctl/repair-logs/`

## Checkpoint

Run /save at: milestone completion, important decisions, tests passing, before ending session.

<!-- MANUAL ADDITIONS END -->
