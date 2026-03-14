# Implementation Plan: NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-03-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp/spec.md` (v7)

## Summary

建構一個 MCP Server daemon，透過 AI agent（GitHub Copilot SDK）自動操控 NotebookLM 瀏覽器介面。
Daemon 管理單一 Chrome instance（puppeteer-core + CDP 底層 API），暴露 14 個 MCP tools
（Streamable HTTP transport），支援同步/非同步操作、跨 notebook 並行、MCP notification 推送。

核心技術路線：
- **介面層**：MCP Server（`@modelcontextprotocol/sdk`, Streamable HTTP, 127.0.0.1:19224）
- **瀏覽器控制**：TabManager（puppeteer-core, Single Browser Multi-tab, CDP 底層 API）
- **AI Agent**：GitHub Copilot SDK（`@github/copilot-sdk`）+ 自訂 tool definitions
- **內容轉換**：repomix（repo）、readability + jsdom（URL）、pdf-parse（PDF）
- **狀態持久化**：JSON 檔案（`~/.nbctl/`）、atomic write（temp + rename）

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`
**Storage**: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）
**Testing**: Vitest
**Target Platform**: macOS（primary），Linux（secondary）
**Project Type**: Single project（daemon process）
**Performance Goals**: Daemon 啟動 <10s, 管理 tool <100ms, 簡單 agent 操作 <15s, 多步驟操作 <60s
**Constraints**: Localhost only（127.0.0.1:19224），max 10 concurrent tabs，daemon memory <500MB（不含 Chrome）
**Scale/Scope**: 20+ 註冊 notebook，10 concurrent tabs，24 小時 task TTL

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. 禁止過度設計 | ✅ PASS | 8 模組各有明確職責。NetworkGate 不在 data path（只管 permit）。不做 graceful agent shutdown。不補發 notification。|
| II. 單一職責 | ✅ PASS | daemon（調度）、tab-manager（tab lifecycle）、network-gate（流量控制）、agent（執行操作 + config 載入）、content（轉換）、state（持久化）、notification（MCP 推送）各自一件事。|
| III. Agent 程式本質 | ✅ PASS | Agent 是一等公民。透過 CDP 底層 API 自主操作、自我修復（截圖分析/retry/關 modal）。Tool 自包原則（screenshot tool 自行截圖+轉換）。|
| IV. 測試先行 | ✅ GATE | 實作時 MUST 先寫測試。每個 checkpoint commit 前全部測試通過。|
| V. 語意命名 | ✅ GATE | 所有 entity（TabHandle, NotebookEntry, AsyncTask 等）已在 data-model.md 定義明確語意。|
| VI. 模組輕耦合 | ✅ PASS | 模組間透過介面溝通。Agent 不能直接存取 TabManager 內部。依賴方向單向：daemon → tab-manager, daemon → agent。Agent config（YAML）由 agent 模組自行載入。|
| VII. 安全的並行處理 | ✅ PASS | 跨 notebook parallel（獨立 tab, CDP 底層 API）。同 notebook serial（per-notebook queue）。持久化寫入 per-file atomic write，禁止 global serialization。|
| VIII. 繁體中文文件 | ✅ PASS | Spec、plan 皆繁體中文。程式碼註解英文。|
| IX. CodeTour | ✅ GATE | 每個模組 MUST 建立 CodeTour。|
| X. Checkpoint 提交 | ✅ GATE | 每個 checkpoint MUST commit + code review subagent。|

**Gate violations**: 無。所有原則通過或標記為開發時 GATE。

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output（v5 — 對齊 spec v7 SHIP 決策）
├── data-model.md        # Phase 1 output（v2 — 對齊 spec v6）
├── quickstart.md        # Phase 1 output（v2 — 對齊 spec v6 MCP workflow）
├── contracts/
│   └── mcp-tools.md     # MCP tool 定義（取代 http-api.yaml）
└── tasks.md             # Phase 2 output（/speckit.tasks 產出）
```

### Source Code (repository root)

> **v2 結構**（基於 Copilot SDK 實際 API 研究後調整）。
> 核心變更：`agent/` 模組對齊 SDK 的 `CopilotClient` + `defineTool()` + `CustomAgentConfig` 模式。

```text
src/
├── daemon/              # MCP Server daemon（Streamable HTTP, @modelcontextprotocol/sdk）
│   ├── index.ts         # Entry point：Chrome launch + CopilotClient start + MCP Server start
│   ├── mcp-server.ts    # MCP Server setup（tools registration, Streamable HTTP transport）
│   ├── scheduler.ts     # Per-notebook operation queue, task dispatch
│   └── launcher.ts      # Thin launcher（npx nbctl）：fork daemon, PID file
├── tab-manager/         # Single Chrome multi-tab management
│   ├── tab-manager.ts   # Chrome instance + tab pool lifecycle（acquireTab/releaseTab/health）
│   ├── tab-handle.ts    # TabHandle type + CDP session wrapper
│   ├── cdp-helpers.ts   # CDP 底層 API helpers（click, type, screenshot, scroll, paste, selectAll via JS）
│   └── download.ts     # CDP Browser.setDownloadBehavior setup（音訊下載基礎設施）
├── network-gate/        # 集中式流量閘門
│   └── network-gate.ts  # acquirePermit / reportAnomaly / getHealth / backoff
├── agent/               # Copilot SDK agent adapter + config loader
│   ├── client.ts        # CopilotClient singleton lifecycle（start/stop/autoRestart）
│   ├── session-runner.ts # Per-task: createSession → sendAndWait → disconnect → collect result
│   ├── hooks.ts         # SessionHooks（onPreToolUse→NetworkGate, onErrorOccurred, onSessionEnd）
│   ├── agent-loader.ts  # Load YAML → CustomAgentConfig[]（SDK 原生型別）
│   └── tools/           # Agent tool definitions（defineTool + Zod）
│       ├── browser-tools.ts  # 9 tools: screenshot, click, type, scroll, paste(+filePath), find, read, navigate, wait
│       │                      # 接收 TabHandle，從 spike 複製並適配。paste 支援 filePath 讀檔貼入
│       ├── content-tools.ts  # repoToText, urlToText, pdfToText（file-based pass-through: temp file → filePath）
│       ├── state-tools.ts    # reportRateLimit, updateCache, writeFile
│       └── index.ts          # Tool registry: buildToolsForTab(tabHandle) → Tool[]
├── content/             # Content pipeline（pure functions, no SDK dependency）— utils layer
                         # 被 agent/tools/content-tools.ts 包裝為 defineTool()；分離是為了可獨立測試
│   ├── repo-to-text.ts  # repomix wrapper
│   ├── url-to-text.ts   # readability + jsdom
│   └── pdf-to-text.ts   # pdf-parse wrapper
├── state/               # JSON state persistence
│   ├── state-manager.ts # DaemonState CRUD + atomic write
│   ├── task-store.ts    # AsyncTask CRUD + TTL cleanup
│   └── cache-manager.ts # Per-notebook local cache（sources, artifacts, operations）
├── notification/        # MCP notification
│   └── notifier.ts      # Fire-and-forget MCP notification push
├── config/              # Runtime configuration data
│   └── ui-maps/         # Locale-specific UI element maps（built-in: zh-TW, en, zh-CN）
│       ├── zh-TW.json   # 繁體中文（primary）
│       ├── en.json       # English
│       └── zh-CN.json   # 簡體中文
└── shared/              # Shared utilities
    ├── types.ts          # Shared TypeScript interfaces（from data-model.md, + UIMap/UIMapElement）
    ├── errors.ts         # Unified error types + format
    ├── config.ts         # Configuration（port, max tabs, timeouts, Chrome path, model）
    └── locale.ts         # resolveLocale(browserLang) + loadUIMap(locale)

agents/                  # Agent config .md files（YAML frontmatter + Markdown prompt body → CustomAgentConfig）
│                        # 需要操作 NotebookLM UI 的 agent MUST 引用 {{NOTEBOOKLM_KNOWLEDGE}}
│                        # agent-loader 解析時從 UI map 載入 locale-specific 內容
├── add-source.md        # → CustomAgentConfig { name, prompt, tools: [...] }
├── query.md
├── generate-audio.md
├── download-audio.md
├── screenshot.md
├── list-sources.md
├── rename-source.md
├── create-notebook.md
└── sync.md

tests/
├── unit/
│   ├── tab-manager/
│   ├── network-gate/
│   ├── state/
│   ├── content/
│   ├── agent/config/    # agent-loader unit tests
│   └── agent/tools/     # Tool handler unit tests（mock CDP session）
├── integration/
│   ├── daemon/
│   ├── agent/           # CopilotClient + session integration
│   └── mcp/
└── contract/
    └── mcp-tools/       # MCP tool input/output schema validation
```

**Structure Decision**: Single project 結構。8 個 src/ 子模組對齊 CLAUDE.md 定義的模組劃分。

**⚠️ MUST READ**: 實作 `agent/` 模組前，必須先讀 [research.md Section 2 — Copilot SDK](./research.md)
的「Main Agent vs Subagent 架構」段落。

**⚠️ 架構更新（Phase F Spike 驗證後）**：CustomAgent sub-agent 無法存取 `defineTool()` custom tools（Finding #39）。
改用 **Two-Session Planner+Executor 架構**（Finding #41, Phase F spike 驗證通過）：
- **Session 1 (Planner)**：無 browser tools，提供雙 tool——`submitPlan`（通過）和 `rejectInput`（拒絕）。解析 NL 意圖 → 選 agent config → 組裝結構化 ExecutionPlan。也作為安全邊界（Input Gate，FR-185~188）：非 NotebookLM 請求透過 `rejectInput` tool 拒絕，附帶 category（6 種：off_topic/harmful/ambiguous/unsupported/missing_context/system）和 reason。被拒絕的請求不進入 Executor 階段。
- **Session 2 (Executor, per step)**：帶 browser tools via `defineTool()`。接收 agent prompt + tool constraint preamble。
- MCP 介面只暴露 `exec(NL prompt)`，browser tools 完全封裝在 session-runner 內部。

**⚠️ 架構更新（Review Point 1.5: Notebook-First + Tab Pool）**：
- **Notebook = 產品概念，Tab = 內部資源**。使用者只指定 target notebook，系統負責 tab。
- Tab pool（fixed-size, 預設 max=10）：`acquireTab(notebookUrl)` / `releaseTab(tabId)`。操作期間 notebook 獨佔 tab（截圖需要獨立 CDP session），完成後歸還 pool。
- **砍掉 `open_notebook` / `close_notebook`** MCP tools。YAGNI。
- **Pool 滿 = producer-consumer**。不向使用者暴露 pool 滿錯誤。Task 排隊等 tab 空出。
- **Canonical notebook context** 顯式注入 Planner 和 Executor 的 systemMessage。
- **Sync exec = per-task wait（waitForTask）**，不是 global waitForIdle。

**v2 結構調整理由**（基於 SDK 研究）：
1. `agent/session.ts` → `agent/client.ts`（CopilotClient singleton）+ `agent/session-runner.ts`（per-task session lifecycle）。
   SDK 的 `CopilotClient` 管理 CLI process，`CopilotSession` 是 per-conversation 的。
   我們的 daemon 需要一個 client singleton + 每個 task 建立一個 session。
2. `agent/tools.ts` → `agent/tools/` 目錄。SDK 的 `defineTool()` + Zod 是標準寫法，
   tool 按職責分檔（browser/content/state），`index.ts` 提供 `buildToolsForTab(tabHandle)` 工廠函數。
   Browser tools 接收 `TabHandle`（已含 cdpSession + page），tool 實作從 spike 複製並適配。
   Spike playground 保持獨立（不 import src/），後續 repair 機制再處理 single source of truth。
3. 新增 `agent/hooks.ts`。SDK 的 `SessionHooks` 是 NetworkGate 整合的自然切入點
   （`onPreToolUse` → `acquirePermit()`），也處理 error recovery 和 session cleanup。
4. Agent config 載入併入 `agent/` 模組（`agent-loader.ts`），不再獨立 `skill/` 模組。
   YAML agent config → `agent-loader.ts` → `CustomAgentConfig { name, prompt, tools }`。
5. `content/` 維持純函數，不直接依賴 SDK——透過 `agent/tools/content-tools.ts` 包裝為 `defineTool()`。
   **File-based pass-through**（Finding #51）：content tools 寫 temp file → 返回 filePath + metrics →
   paste tool 讀檔貼入。**Tool boundary = context boundary**——LLM 根本拿不到文字內容（0 token 消耗），
   是架構層面保證，不是 prompt-level instruction。所有 content tools（repo/URL/PDF）同一模式。

**Per-task execution flow (Two-Session Planner+Executor)**:
```
Scheduler.dispatch(task)
  → resolve canonical notebook (alias → NotebookEntry)
  → TabPool.acquireTab(notebook.url)  ← auto-acquire from pool
  → SessionRunner.runDualSession(task, tabHandle, agentConfigs, notebookContext)
    ┌─ Planner Session (no browser tools, Input Gate)
    │   tools: [submitPlan, rejectInput]
    │   systemMessage: agent catalog + routing rules + 「target notebook: {alias}」
    │   → session.sendAndWait({ prompt: task.command })
    │   → captured ExecutionPlan (submitPlan) or rejection (rejectInput)
    │   → session.disconnect()
    │
    └─ Executor Session(s) (per step, has browser tools)
        pre-navigate: tab.url vs agentConfig.startPage → navigate if mismatch (O(1) check)
        tools: buildToolsForTab(tabHandle) filtered by step.tools
        systemMessage: agentConfig.prompt + tool constraint preamble + 「target notebook: {alias}」
                       + page anchor hint（「系統檢查：目前 tab URL 符合 X」，agent 可自行驗證）
        → session.sendAndWait({ prompt: step.executorPrompt })
        → session.disconnect()
        → aggregate results
  → TabPool.releaseTab(tabHandle)  ← release back to pool
```

`agents/` 在 repo root（版本控制 + 可覆寫至 `~/.nbctl/agents/`）。格式為 `.md`（YAML frontmatter + Markdown prompt body），對齊 Copilot CLI `.agent.md` 慣例，prompt 長文本用 Markdown 撰寫更自然。
Tests 按 unit/integration/contract 分層，unit 按模組對應。

**Two-Session Planner+Executor 架構**（Phase F Spike 驗證後確認，取代原 CustomAgent sub-agent 方案）：
- **Planner Session**（意圖解析層）：session systemMessage 放 agent catalog（每個 agent 的 name/description/tools/parameters summary）+ routing rules。提供雙 tool——`submitPlan`（通過，捕獲結構化 `ExecutionPlan`）和 `rejectInput`（拒絕，附帶 category + reason）。Planner 作為 **Input Gate**（FR-185~188）：非 NotebookLM 請求透過 `rejectInput` 拒絕（6 種 category：off_topic/harmful/ambiguous/unsupported/missing_context/system），被拒絕的請求不進入 Executor 階段，SessionResult 標記 `rejected: true`。
- **Executor Session**（執行層）：每個 `agents/*.md` 的 prompt 作為 systemMessage，加上 tool constraint preamble（禁止 bash/view/edit 等內建工具）。只帶該 step 需要的 browser tools via `defineTool()`。
  **Prompt 零留白原則**（Spike Finding #44）：GPT-4.1 是非推理模型，不會自行推論省略的步驟。
  Agent prompt MUST 寫成 step-by-step recipe——每個 UI 互動步驟（點擊、確認 dialog、等待回應）
  都必須明確寫出，不可省略「顯而易見」的步驟（如 dialog confirm button 點擊）。
  違反此原則會導致 agent 跳過關鍵步驟或卡在 dialog 上。
- **agents/*.md 雙重角色**：Planner 讀 catalog（name/description/tools），Executor 讀完整 prompt（含 `{{NOTEBOOKLM_KNOWLEDGE}}`）。
- **KNOWLEDGE 注入**：agent-loader 載入 agent config → 偵測 `{{NOTEBOOKLM_KNOWLEDGE}}` → 讀 `src/config/ui-maps/<locale>.json` → 生成 knowledge string → 替換進 prompt。
- **i18n**：MVP 內建 zh-TW/en/zh-CN 三個 locale。Daemon 啟動時偵測 Chrome locale，載入對應 UI map。Post-MVP 支援 `tools repair` 自動 discover。
- **Model 選擇**（Spike Finding #50 驗證）：Planner 和 Executor 都使用 GPT-4.1（免費、快速）。非推理模型足夠——Planner 做分類路由，Executor 做機械操作，prompt 品質 > 模型能力。`createSession()` MUST hardcode model 參數。
- **Agent Runtime Health（Circuit Breaker, FR-210~213）**：
  Scheduler `executeTask` 包外層 `Promise.race` timeout（不依賴 SDK 內部 timeout）。
  timeout fire → `session.disconnect()` 嘗試釋放 → task 標 failed → 累計連續 timeout 計數。
  連續 N 次 timeout → Scheduler 進入 `degraded` state → reject 新 submit → `get_status` 回報 `agentHealth: "degraded"`。
  恢復路徑：`copilotClient.restart()`（kill CLI process + 重啟），清除 zombie session，重置計數。
  設計原因：單純 timeout 只解決「不 hang」，但連續 timeout = CLI process 僵死 → zombie session 累積 → memory leak。
  Circuit breaker 防止連鎖故障，強制使用者介入處理根因。

## Complexity Tracking

> 無 Constitution 違反需要 justify。

| Item | Assessment |
|------|-----------|
| 8 src 模組 | 每個模組一件事（Principle II），不是過度設計 |
| NetworkGate 獨立模組 | 流量控制邏輯足夠獨立，且跨 agent 共享（全域 backoff） |
| Agent config 外部化 | NotebookLM UI 會變，agent prompt 需可調整（FR-150~153） |
