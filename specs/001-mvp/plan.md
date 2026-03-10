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
│   ├── tab-manager.ts   # Chrome instance + tab lifecycle（open/close/list/health）
│   ├── tab-handle.ts    # TabHandle type + CDP session wrapper
│   └── cdp-helpers.ts   # CDP 底層 API helpers（click, type, screenshot, scroll）
├── network-gate/        # 集中式流量閘門
│   └── network-gate.ts  # acquirePermit / reportAnomaly / getHealth / backoff
├── agent/               # Copilot SDK agent adapter + config loader
│   ├── client.ts        # CopilotClient singleton lifecycle（start/stop/autoRestart）
│   ├── session-runner.ts # Per-task: createSession → sendAndWait → disconnect → collect result
│   ├── hooks.ts         # SessionHooks（onPreToolUse→NetworkGate, onErrorOccurred, onSessionEnd）
│   ├── agent-loader.ts  # Load YAML → CustomAgentConfig[]（SDK 原生型別）
│   └── tools/           # Agent tool definitions（defineTool + Zod）
│       ├── browser-tools.ts  # screenshot, click, type, scroll, paste（CDP-based, Tool 自包）
│       ├── content-tools.ts  # repoToText, urlToText, pdfToText
│       ├── state-tools.ts    # reportRateLimit, updateCache, writeFile
│       └── index.ts          # Tool registry: buildToolsForTab(tabHandle) → Tool[]
├── content/             # Content pipeline（pure functions, no SDK dependency）
│   ├── repo-to-text.ts  # repomix wrapper
│   ├── url-to-text.ts   # readability + jsdom
│   └── pdf-to-text.ts   # pdf-parse wrapper
├── state/               # JSON state persistence
│   ├── state-manager.ts # DaemonState CRUD + atomic write
│   ├── task-store.ts    # AsyncTask CRUD + TTL cleanup
│   └── cache-manager.ts # Per-notebook local cache（sources, artifacts, operations）
├── notification/        # MCP notification
│   └── notifier.ts      # Fire-and-forget MCP notification push
└── shared/              # Shared utilities
    ├── types.ts          # Shared TypeScript interfaces（from data-model.md）
    ├── errors.ts         # Unified error types + format
    └── config.ts         # Configuration（port, max tabs, timeouts, Chrome path, model）

agents/                  # Agent config YAML files（→ CustomAgentConfig）
├── add-source.yaml      # → CustomAgentConfig { name, prompt, tools: [...] }
├── query.yaml
├── generate-audio.yaml
├── download-audio.yaml
├── screenshot.yaml
├── list-sources.yaml
├── rename-source.yaml
├── create-notebook.yaml
└── sync.yaml

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

**v2 結構調整理由**（基於 SDK 研究）：
1. `agent/session.ts` → `agent/client.ts`（CopilotClient singleton）+ `agent/session-runner.ts`（per-task session lifecycle）。
   SDK 的 `CopilotClient` 管理 CLI process，`CopilotSession` 是 per-conversation 的。
   我們的 daemon 需要一個 client singleton + 每個 task 建立一個 session。
2. `agent/tools.ts` → `agent/tools/` 目錄。SDK 的 `defineTool()` + Zod 是標準寫法，
   tool 按職責分檔（browser/content/state），`index.ts` 提供 `buildToolsForTab(tabHandle)` 工廠函數。
3. 新增 `agent/hooks.ts`。SDK 的 `SessionHooks` 是 NetworkGate 整合的自然切入點
   （`onPreToolUse` → `acquirePermit()`），也處理 error recovery 和 session cleanup。
4. Agent config 載入併入 `agent/` 模組（`agent-loader.ts`），不再獨立 `skill/` 模組。
   YAML agent config → `agent-loader.ts` → `CustomAgentConfig { name, prompt, tools }`。
5. `content/` 維持純函數，不直接依賴 SDK——透過 `agent/tools/content-tools.ts` 包裝為 `defineTool()`。

**Per-task execution flow**:
```
Scheduler.dispatch(task)
  → SessionRunner.run(task, tabHandle, agentConfig)
    → client.createSession({ tools: buildToolsForTab(tabHandle), agent: agentConfig.name, hooks })
    → session.sendAndWait({ prompt: task.command })
    → session.disconnect()
    → return result
```

`agents/` 在 repo root（版本控制 + 可覆寫至 `~/.nbctl/agents/`）。
Tests 按 unit/integration/contract 分層，unit 按模組對應。

## Complexity Tracking

> 無 Constitution 違反需要 justify。

| Item | Assessment |
|------|-----------|
| 8 src 模組 | 每個模組一件事（Principle II），不是過度設計 |
| NetworkGate 獨立模組 | 流量控制邏輯足夠獨立，且跨 agent 共享（全域 backoff） |
| Agent config 外部化 | NotebookLM UI 會變，agent prompt 需可調整（FR-150~153） |
