# Implementation Plan: NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-02-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp/spec.md`

## Summary

建構一個常駐 daemon 程式（`nbctl`），透過 AI agent 自動化操控 NotebookLM 瀏覽器介面。
daemon 連接 iso-browser Chrome instance，暴露 HTTP API 與 MCP server，
讓使用者透過 CLI 自然語言指令完成「餵入資料 → 查詢知識 → 使用回答」的完整工作流。

技術方案：TypeScript + Claude Agent SDK V2（per-notebook session）+ puppeteer-core（CDP）+
Fastify HTTP server + MCP SDK（stdio transport 內嵌）。

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `puppeteer-core`, `fastify`, `commander`, `repomix`, `zod`
**Storage**: JSON 檔案（`~/.nbctl/state.json`），atomic write
**Testing**: Vitest（unit + integration）
**Target Platform**: macOS（主要）、Linux（次要）
**Project Type**: Single project（CLI daemon）
**Performance Goals**: 管理指令 <100ms 回應（SC-002）；agent 操作依 spec SC-003~SC-005
**Constraints**: Daemon 記憶體 <500MB（SC-010）；127.0.0.1 only binding；1 daemon : 1 browser
**Scale/Scope**: 最多 20 個 notebook 元資料管理（SC-009）；單一使用者

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. 禁止過度設計 | PASS | 單一專案、JSON 檔案存儲、無 ORM/DB 抽象 |
| II. 單一職責 | PASS | 模組拆分：cli / daemon / agent / browser / content-pipeline / state / mcp |
| III. Agent 程式本質 | PASS | Agent session 為一等公民；1 daemon : 1 browser；操作序列化 |
| IV. 測試先行 | PASS | Vitest，每個模組伴隨 unit test |
| V. 語意明確命名 | PASS | 遵循 spec Key Entities 命名 |
| VI. 模組輕耦合 | PASS | 模組透過 TypeScript interface 溝通；依賴單向 |
| VII. 安全並行 | PASS | Operation Queue message passing；state 寫入序列化 |
| VIII. 繁體中文文件 | PASS | Spec/plan/使用者文件為繁體中文 |
| IX. CodeTour | PASS | 每個模組建立 CodeTour |
| X. Checkpoint & Review | PASS | 開發迴圈遵循 commit → review → approve |

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp/
├── plan.md              # This file
├── research.md          # Phase 0: 技術研究
├── data-model.md        # Phase 1: 資料模型
├── quickstart.md        # Phase 1: 快速上手指南
├── contracts/           # Phase 1: API contracts
│   ├── http-api.yaml    # OpenAPI spec for daemon HTTP API
│   └── mcp-tools.md     # MCP tool definitions
└── tasks.md             # Phase 2: 實作任務（/speckit.tasks 產出）
```

### Source Code (repository root)

```text
src/
├── cli/                        # CLI 入口與指令解析
│   ├── index.ts                # CLI entry point (commander setup)
│   ├── commands/               # 各子命令 handler
│   │   ├── start.ts
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   ├── list.ts
│   │   ├── open.ts
│   │   ├── close.ts
│   │   ├── use.ts
│   │   ├── add.ts
│   │   ├── add-all.ts
│   │   ├── exec.ts
│   │   └── login.ts
│   └── output.ts              # JSON output formatter
│
├── daemon/                     # Daemon 核心
│   ├── server.ts               # Fastify HTTP server setup
│   ├── routes/                 # HTTP API routes
│   │   ├── health.ts
│   │   ├── notebook.ts         # notebook CRUD endpoints
│   │   └── exec.ts             # exec endpoint
│   ├── process.ts              # Daemon 程序管理（PID, fork, signal）
│   └── queue.ts                # Operation Queue（序列化瀏覽器操作）
│
├── agent/                      # Agent session 管理
│   ├── session-manager.ts      # Per-notebook session lifecycle
│   ├── session.ts              # Single agent session wrapper
│   └── system-prompt.ts        # Agent system prompt template
│
├── browser/                    # Browser 連線與操作
│   ├── connector.ts            # Chrome CDP 連線管理
│   ├── tools.ts                # Browser tools (screenshot, click, type, scroll, paste)
│   └── health.ts               # 連線健康檢查 + 重連
│
├── content/                    # Content Pipeline
│   ├── repo-to-text.ts         # repomix wrapper
│   ├── url-to-text.ts          # Readability + jsdom
│   └── pdf-to-text.ts          # pdf-parse wrapper
│
├── state/                      # State 管理與持久化
│   ├── notebook-registry.ts    # Notebook Registry（CRUD + 持久化）
│   ├── local-cache.ts          # Per-notebook 來源/artifact 元資料
│   ├── operation-log.ts        # 操作歷程記錄
│   └── storage.ts              # JSON file atomic read/write
│
├── mcp/                        # MCP Server
│   ├── server.ts               # McpServer setup + tool registration
│   └── tools.ts                # notebooklm_exec, notebooklm_list_notebooks
│
└── shared/                     # 共用型別與 utilities
    ├── types.ts                # 核心型別定義
    ├── errors.ts               # Error classes + JSON error format
    ├── logger.ts               # stderr-only logger
    └── config.ts               # 常數與預設值（ports, paths）

tests/
├── unit/
│   ├── cli/
│   ├── daemon/
│   ├── agent/
│   ├── browser/
│   ├── content/
│   ├── state/
│   └── mcp/
├── integration/
│   ├── daemon-lifecycle.test.ts
│   ├── notebook-management.test.ts
│   └── exec-pipeline.test.ts
└── contract/
    └── http-api.test.ts
```

**Structure Decision**: Single project 結構。此為 CLI daemon 工具，不含前端。
模組按職責垂直拆分為 7 個核心目錄（cli, daemon, agent, browser, content, state, mcp）
加一個共用目錄（shared）。每個目錄對應一個單一職責模組。

## Module Dependency Graph

```text
cli → daemon (HTTP client calls)
daemon/server → daemon/queue → agent/session-manager → browser/connector
                                                     → content/*
daemon/server → state/notebook-registry
daemon/server → mcp/server (embedded, shares state)
agent/session → browser/tools (screenshot, click, type...)
state/* → state/storage (atomic JSON I/O)
mcp/tools → daemon/queue (submit exec requests)
           → state/notebook-registry (list notebooks)
```

依賴方向單向：`cli → daemon → agent → browser`，`state` 被 daemon/agent 共用，
`mcp` 被 daemon 啟動並共用 queue + state。

## Complexity Tracking

> No constitution violations detected. All design decisions align with principles.

| Aspect | Decision | Justification |
|--------|----------|--------------|
| 7 source directories | 對應 7 個職責域 | 遵循 Principle II 單一職責 |
| JSON file storage | 非 SQLite | 資料量小（≤20 notebooks），人類可讀，遵循 Principle I |
| Agent SDK V2 (unstable) | Adapter 隔離 | `session.ts` 封裝 SDK 呼叫，降低 API 變更風險 |
