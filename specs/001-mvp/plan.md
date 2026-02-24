# Implementation Plan: NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp/spec.md` (v6 — MCP Server + Single Browser Multi-tab)
**Pivots applied**: (1) BrowserPool → TabManager (spec v5, never cascaded to plan), (2) CLI + HTTP API → MCP Server (spec v6)

## Summary

建構一個 MCP Server daemon `nbctl`，讓 AI 工具透過 MCP protocol 控制 Google NotebookLM：
管理 notebook、餵入來源（repo/URL/PDF）、查詢 grounded 回答、產生 Audio Overview。

技術架構：TypeScript daemon 透過 Single Browser Multi-tab（一個 Chrome instance，多 tab）管理瀏覽器，
每個 agent session 取得獨立 tab（CDP session），userDataDir 共享認證，
NetworkGate 集中管理流量許可。內嵌 Claude Agent SDK V2 的 vision-based AI agent
執行 UI 操作，agent 擁有完整自我修復能力。
非同步操作完成後透過 MCP notification 直接推送通知至連線中的 client。

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**:
- `@anthropic-ai/claude-agent-sdk` — AI agent session 管理（V2 API）
- `puppeteer-core` — Chrome CDP 控制（launch + multi-tab 操作）
- `@modelcontextprotocol/sdk` — MCP Server 實作（Streamable HTTP transport）
- `repomix` — Git repo → 文字轉換
- `zod` — Runtime schema validation
- `@mozilla/readability` + `jsdom` — URL → 文字轉換
- `pdf-parse` — PDF → 文字轉換

**Storage**: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）
**Testing**: Vitest
**Target Platform**: macOS（主要），Linux（次要）
**Project Type**: Single（MCP Server daemon 程式）
**Performance Goals**: MCP tool 回應 <100ms（SC-002），daemon 啟動 <10s（SC-001），async 提交 <500ms（SC-100）
**Constraints**: Daemon 記憶體 <500MB（不含 Chrome）（SC-010），同時多 tab 操作
**Scale/Scope**: 單一使用者，≤20 notebook 註冊，單一 Chrome instance 多 tab

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase 0 Gate

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | 禁止過度設計 | **PASS** | 8 模組各有明確職責。TabManager（Single Browser Multi-tab）、NetworkGate（流量閘門）皆為 spec 明確要求，非投機設計。MCP Server 取代 CLI + HTTP 減少膠水層，非增加複雜度。 |
| II | 單一職責 | **PASS** | 每模組一句話描述：Daemon=MCP Server+程序管理、TabManager=單一 Chrome multi-tab 管理、NetworkGate=流量許可閘門、Agent=AI session+操作、Content=格式轉換、State=持久化、Notification=MCP 原生通知、Skill=外部化操作定義。 |
| III | Agent 程式本質 | **PASS** | Agent 具備完整自我修復能力（自主截圖分析、retry、處理意外）。瀏覽器生命週期由 daemon 管理。具體架構（MCP Server + TabManager + CDP）見 spec v6。 |
| IV | 測試先行 | **PASS** | 每模組伴隨 unit test，integration test 覆蓋 MCP tool→daemon→agent 流程。 |
| V | 語意明確命名 | **PASS** | 所有模組、entity、MCP tool 命名已在 spec 中定義，語意清晰。 |
| VI | 模組輕耦合 | **PASS** | 依賴方向單向：MCP Client→Daemon→{Scheduler, Agent, State, Notification}→底層。模組間透過 TypeScript interface 溝通。 |
| VII | 安全並行 | **PASS** | Per-notebook operation queue（message passing），無 shared mutable state。State Store per-file atomic write（非 global serialization）。CDP session 隔離各 tab。 |
| VIII | 繁體中文文件 | **PASS** | 所有 spec/plan 文件為繁體中文。Code 註解英文。 |
| IX | CodeTour | **PASS** | 每模組實作時建立 CodeTour。 |
| X | Checkpoint Commit | **PASS** | 每 checkpoint 建立 commit + code review subagent 審查。 |

### Principle III 技術背景

**Spec v6 架構**：MCP Server 介面 + Single Browser Multi-tab（Constitution v1.6.0 定義原則，具體架構在此）。

**從 BrowserPool 到 Single Browser Multi-tab 的技術理由**（Spike 0 實驗結果）：
1. CDP 底層 API（`Input.dispatchMouseEvent`、`Page.captureScreenshot`）在 background tab
   操作完全可靠。先前 multi-tab 不可靠的結論是 Puppeteer 高層 API（`page.click()`）的問題，
   非 Chrome/CDP 本身限制。
2. 單一 Chrome instance 多 tab：記憶體從 ~900MB（3 Chrome instances）降至 ~500MB。
   BrowserPool + AuthManager 簡化為 TabManager 單一模組。
3. 認證從 cookie extraction/injection 簡化為 `userDataDir` 共享：首次 headed 登入後，
   後續 headless 直接複用 session，不需獨立 AuthManager 模組。
4. Agent 透過 CDP 底層 API 操作 tab，可自主截圖分析/retry/關 modal（自我修復能力不變）。

**從 CLI + HTTP API 到 MCP Server 的技術理由**（介面簡化）：
1. CLI 是 thin HTTP client wrapper，18 個 command 檔案 + Fastify routes + Skill Template
   都是膠水層。主要消費者是 AI agent（Claude Code），MCP 是 AI 工具的原生協議。
2. MCP Server 後：砍掉 CLI 模組（18 command files）、Fastify、commander 依賴；
   MCP tool 自描述（tools/list），不需 Skill Template。
3. MCP 持續連線（Streamable HTTP），非同步通知可直接推送，
   簡化 Notification 系統（移除 inbox、adapter、hooks）。
4. Daemon 核心（TabManager、Agent、State、NetworkGate）不變，
   只是介面層從 CLI + HTTP 換成 MCP protocol。
5. 薄啟動器（`npx nbctl`）只負責 daemon 程序管理（start/stop/status），
   所有功能透過 MCP tool 暴露。

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp/
├── plan.md              # 本文件
├── research.md          # Phase 0: 技術研究報告
├── data-model.md        # Phase 1: 資料模型
├── quickstart.md        # Phase 1: 快速上手指南
├── contracts/
│   └── mcp-tools.yaml   # Phase 1: MCP Tool 契約定義
├── checklists/
│   └── flow-coverage.md # Pre-plan 流程覆蓋清單
└── tasks.md             # Phase 2: 實作任務（由 /speckit.tasks 產生）
```

### Source Code (repository root)

```text
src/
├── daemon/                    # MCP Server daemon
│   ├── index.ts               # Daemon 進入點 + MCP Server 初始化（Streamable HTTP）
│   ├── process.ts             # Daemon 背景程序化（fork / PID file）
│   ├── tools/                 # MCP Tool handlers（每個 tool 一個檔案）
│   │   ├── exec.ts            # exec tool（自然語言 → agent session）
│   │   ├── get-status.ts      # get_status tool（daemon/task/all 狀態）
│   │   ├── notebooks.ts       # list/add/add-all/open/close/rename/remove/set-default tools
│   │   ├── tasks.ts           # cancel_task tool
│   │   ├── skills.ts          # list_skills tool
│   │   ├── auth.ts            # reauth tool
│   │   └── system.ts          # shutdown tool
│   └── scheduler.ts           # Operation scheduler（global semaphore + per-notebook queue）
│
├── tab-manager/               # TabManager — 單一 Chrome multi-tab 管理
│   ├── manager.ts             # TabManager 主類別（openTab/closeTab/listTabs）
│   ├── types.ts               # TabHandle, TabError 型別定義
│   ├── puppeteer-launcher.ts  # Puppeteer 底層 Chrome launch 實作
│   └── chrome-finder.ts       # Chrome 執行檔路徑探索
│
├── network-gate/              # NetworkGate — 集中式流量閘門
│   ├── gate.ts                # NetworkGate 主類別（acquirePermit / reportAnomaly）
│   ├── throttle-detector.ts   # Rate limit / CAPTCHA 偵測
│   └── backoff.ts             # Exponential backoff 實作
│
├── agent/                     # AI Agent — Claude Agent SDK V2
│   ├── session.ts             # Agent session 建立與管理
│   ├── tools/                 # Agent 可用的 tool 定義
│   │   ├── browser-tools.ts   # screenshot, click, type, scroll, paste, download（CDP 底層 API）
│   │   ├── content-tools.ts   # repoToText, urlToText, pdfToText
│   │   └── file-tools.ts      # writeFile（查詢結果輸出）
│   └── skill-loader.ts        # 從檔案載入 skill 定義
│
├── content/                   # Content Pipeline — 格式轉換
│   ├── repo-to-text.ts        # repomix 包裝
│   ├── url-to-text.ts         # Readability + jsdom 包裝
│   └── pdf-to-text.ts         # pdf-parse 包裝
│
├── state/                     # State Store — 持久化
│   ├── store.ts               # 記憶體狀態 + JSON 持久化
│   ├── notebook-registry.ts   # Notebook 元資料 CRUD
│   ├── local-cache.ts         # Per-notebook 來源/artifact 快取
│   ├── operation-log.ts       # 操作歷程紀錄
│   └── task-store.ts          # Async task 狀態管理
│
├── notification/              # Notification — MCP 原生通知
│   └── notifier.ts            # MCP notification 發送（async task 完成時）
│
├── skill/                     # Agent Skill 外部化定義
│   ├── types.ts               # Skill 定義型別
│   └── loader.ts              # Skill 檔案載入與驗證
│
└── shared/                    # 共用工具
    ├── errors.ts              # 統一錯誤型別
    ├── logger.ts              # 結構化日誌（stderr）
    ├── paths.ts               # ~/.nbctl/ 路徑常數 + 權限管理
    └── validation.ts          # URL 格式、alias 格式驗證

skills/                        # Agent Skill 定義檔案（外部化）
├── add-source.yaml
├── query.yaml
├── generate-audio.yaml
├── screenshot.yaml
├── list-sources.yaml
└── rename-source.yaml

tests/
├── unit/                      # 單元測試（對應 src/ 結構）
│   ├── daemon/
│   ├── tab-manager/
│   ├── network-gate/
│   ├── agent/
│   ├── content/
│   ├── state/
│   ├── notification/
│   └── skill/
├── integration/               # 整合測試
│   ├── mcp-tools.test.ts      # MCP tool call → daemon → agent 流程
│   ├── agent-browser.test.ts  # Agent → TabManager → mock Chrome tab
│   ├── async-notification.test.ts # Async exec → MCP notification
│   └── state-persistence.test.ts  # State → stop → restart → restore
└── contract/                  # 契約測試
    └── mcp-tools.test.ts      # MCP tool schemas 符合定義
```

**Structure Decision**: 採用 Single project 結構。8 個功能模組 + shared 工具，
每模組一個目錄。Daemon 以 MCP Server 暴露所有功能。AI 工具透過 MCP protocol 直接連線。
薄啟動器（`npx nbctl`）只負責 daemon 程序管理。
TabManager + NetworkGate 兩模組協作管理瀏覽器與流量。
Agent skill 定義以 YAML 檔案外部化於 `skills/` 目錄。

## Module Dependency Graph

```text
MCP Client (Claude Code 等) ──MCP──→ Daemon (MCP Server)
                                        ├──→ Scheduler ──→ Agent ──→ TabManager ──→ [Chrome/Puppeteer]
                                        │                    │
                                        │                    ├──→ NetworkGate (acquirePermit before operations)
                                        │                    ├──→ SkillLoader ──→ skills/*.yaml
                                        │                    └──→ ContentPipeline
                                        ├──→ StateStore ←── Agent (透過 daemon 介面)
                                        └──→ Notifier (MCP notification)
```

依賴方向：MCP Client → Daemon → {Scheduler, State, Notifier} → {Agent, TabManager, NetworkGate} → 底層
禁止反向依賴。Agent 不直接存取 StateStore，透過 daemon 提供的回呼介面更新狀態。
Agent 操作前 MUST 透過 NetworkGate acquirePermit()。TabManager 管理單一 Chrome instance 多 tab，
認證透過 userDataDir 共享。

## Complexity Tracking

> **No constitution violations.** 以下記錄需要額外複雜度說明的設計決策。

| Decision | Why Needed | Simpler Alternative Rejected Because |
|----------|------------|-------------------------------------|
| 8 個模組（原 10 → -CLI -Auth，notification 簡化） | 每模組職責明確且為 spec FR 明確要求。TabManager（Single Browser Multi-tab）、NetworkGate（流量閘門）、Notification（MCP 原生通知）皆為獨立模組。 | 合併模組會違反 Principle II 單一職責（如 TabManager + NetworkGate 合併後描述需用「和」）。 |
| MCP Server 取代 CLI + HTTP | 主要消費者是 AI agent，MCP 是原生協議。砍掉 CLI（18 command files）、Fastify、commander、Skill Template。 | CLI wrapper 增加維護成本但不加價值。 |
| TabManager 取代 BrowserPool + AuthManager | Spike 0 實驗證實 CDP 底層 API background tab 操作完全可靠。單一 Chrome instance 多 tab 降低記憶體（~900MB → ~500MB）。userDataDir 取代 cookie injection，不需獨立 AuthManager。 | BrowserPool 多 Chrome instance 浪費記憶體且 AuthManager cookie injection 增加複雜度，無額外價值。 |

## Constitution Re-Check (Post Phase 1 Design)

| # | Principle | Status | Phase 1 Notes |
|---|-----------|--------|---------------|
| I | 禁止過度設計 | **PASS** | data-model 只包含 spec 要求的 entity。MCP tool 每個對應一個功能操作，無多餘。TabManager 從 BrowserPool + AuthManager 簡化而來，減少模組數。 |
| II | 單一職責 | **PASS** | 8 模組各有一句話描述，無重疊。data-model entity 各有明確職責。 |
| III | Agent 程式本質 | **PASS** | Agent 具備完整自我修復能力（自主截圖分析、retry、處理意外）。瀏覽器生命週期由 daemon 管理。具體架構見 spec v6。 |
| IV | 測試先行 | **PASS** | 測試結構（unit/integration/contract）已規劃。Contract test 驗證 MCP tool schemas 符合定義。 |
| V | 語意明確命名 | **PASS** | Entity 命名（NotebookEntry, SourceRecord, AsyncTask）語意明確。MCP tool 命名清晰（exec, get_status, list_skills 等）。 |
| VI | 模組輕耦合 | **PASS** | 依賴圖單向。Agent 不直接存取 StateStore。TabManager 透過 openTab/closeTab interface 管理 tab，認證透過 userDataDir 共享。 |
| VII | 安全並行 | **PASS** | CDP session 隔離各 tab，支援跨 notebook parallel。Per-notebook queue 用 message passing。NetworkGate permit-based 流量控制。State per-file atomic write（非 global serialization）。 |
| VIII | 繁體中文文件 | **PASS** | 所有 Phase 1 文件為繁體中文。 |
| IX | CodeTour | **PASS** | 實作時每模組建立 CodeTour。 |
| X | Checkpoint Commit | **PASS** | 實作時每 checkpoint commit + review。 |

**Post-Phase 1 Gate**: **ALL PASS**. 設計階段無 constitution violation。
