# Implementation Plan: NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-02-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp/spec.md` (v4 — BrowserPool 架構)

## Summary

建構一個 CLI daemon 工具 `nbctl`，讓開發者透過命令列控制 Google NotebookLM：
管理 notebook、餵入來源（repo/URL/PDF）、查詢 grounded 回答、產生 Audio Overview。

技術架構：TypeScript daemon 透過 BrowserPool 管理多個 headless Chrome instance，
每個 agent session 取得獨立完整 Chrome instance（cookie injection 共享認證），
NetworkGate 集中管理流量許可。內嵌 Claude Agent SDK V2 的 vision-based AI agent
執行 UI 操作，agent 擁有完整自我修復能力。
非同步操作 + 檔案型 Notification Inbox + per-tool Adapter 實現跨工具通知。

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js 22 LTS
**Primary Dependencies**:
- `@anthropic-ai/claude-agent-sdk` — AI agent session 管理（V2 API）
- `puppeteer-core` — Chrome CDP 控制（launch + multi-page 操作）
- `fastify` — Daemon HTTP API server
- `commander` — CLI 框架
- `repomix` — Git repo → 文字轉換
- `zod` — Runtime schema validation
- `@mozilla/readability` + `jsdom` — URL → 文字轉換
- `pdf-parse` — PDF → 文字轉換

**Storage**: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）
**Testing**: Vitest
**Target Platform**: macOS（主要），Linux（次要）
**Project Type**: Single（CLI daemon 程式）
**Performance Goals**: 管理指令 <100ms 回應（SC-002），daemon 啟動 <10s（SC-001），async 提交 <500ms（SC-100）
**Constraints**: Daemon 記憶體 <500MB（不含 Chrome）（SC-010），hook 腳本 <5s（FR-126），同時 ≤3 Chrome instances（FR-173）
**Scale/Scope**: 單一使用者，≤20 notebook 註冊，≤3 同時 Chrome instances

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase 0 Gate

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | 禁止過度設計 | **PASS** | 10 模組各有明確職責。BrowserPool（FR-140~142）、AuthManager（FR-145~147）、NetworkGate（FR-190~194）皆為 spec 明確要求，非投機設計。 |
| II | 單一職責 | **PASS** | 每模組一句話描述：CLI=指令解析、Daemon=HTTP+程序管理、BrowserPool=Chrome instance pool 管理、AuthManager=認證 cookie 管理、NetworkGate=流量許可閘門、Agent=AI session+操作、Content=格式轉換、State=持久化、Notification=inbox+adapter、Skill=外部化操作定義。 |
| III | Agent 程式本質 | **PASS** | Constitution v1.3.0：BrowserPool 中央集權管理 + 全權委派操作。Agent 取得完整 Chrome instance，具備自我修復能力。Daemon 管理 Chrome lifecycle + NetworkGate 流量控制。 |
| IV | 測試先行 | **PASS** | 每模組伴隨 unit test，integration test 覆蓋 CLI→daemon→agent 流程。 |
| V | 語意明確命名 | **PASS** | 所有模組、entity、CLI 指令命名已在 spec 中定義，語意清晰。 |
| VI | 模組輕耦合 | **PASS** | 依賴方向單向：CLI→Daemon→{ConnectionMgr, Agent, State, Notification}→底層。模組間透過 TypeScript interface 溝通。 |
| VII | 安全並行 | **PASS** | Per-notebook operation queue（message passing），State Store 序列化寫入，Inbox 原子 rename。無 shared mutable state。 |
| VIII | 繁體中文文件 | **PASS** | 所有 spec/plan 文件為繁體中文。Code 註解英文。 |
| IX | CodeTour | **PASS** | 每模組實作時建立 CodeTour。 |
| X | Checkpoint Commit | **PASS** | 每 checkpoint 建立 commit + code review subagent 審查。 |

### Principle III 技術背景

**Constitution v1.3.0 架構**：BrowserPool 中央集權管理 + 全權委派操作。

**從 multi-tab 到 BrowserPool 的技術理由**（Phase 0 research + 架構討論）：
1. CDP background tab 操作不可靠（GitHub #3318、#12712），multi-tab 必須序列化，
   序列化後只剩省 navigate 時間，不值得整個 ConnectionManager 抽象。
2. BoundTools interface 限制 agent 自我修復能力：agent 遇到 modal/redirect
   只能回報錯誤，需額外 repair agent。完整 Chrome 讓 agent 自主修復。
3. BrowserPool 天然 parallel：每個 agent session 獨立 Chrome instance。

**MVP 實作**：
- BrowserPool 管理 N headless Chrome instances（max=3）
- Agent 透過 acquire() 取得完整 Chrome instance，release() 歸還
- Cookie injection：AuthManager 管理 Google cookies，注入每個 headless instance
- NetworkGate：agent 操作前 acquirePermit()，異常時全域 backoff
- 超時未歸還 → daemon 強制回收
- 純讀取記憶體狀態的指令（`list`、`status`）不需 Chrome instance，即時回應

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp/
├── plan.md              # 本文件
├── research.md          # Phase 0: 技術研究報告
├── data-model.md        # Phase 1: 資料模型
├── quickstart.md        # Phase 1: 快速上手指南
├── contracts/
│   └── http-api.yaml    # Phase 1: HTTP API 契約（OpenAPI 3.1）
├── checklists/
│   └── flow-coverage.md # Pre-plan 流程覆蓋清單
└── tasks.md             # Phase 2: 實作任務（由 /speckit.tasks 產生）
```

### Source Code (repository root)

```text
src/
├── cli/                    # CLI 進入點（Commander.js）
│   ├── index.ts            # CLI 主程式，註冊所有 subcommand
│   ├── commands/           # 每個 subcommand 一個檔案
│   │   ├── start.ts
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   ├── list.ts
│   │   ├── exec.ts
│   │   ├── open.ts
│   │   ├── close.ts
│   │   ├── use.ts
│   │   ├── add.ts
│   │   ├── add-all.ts
│   │   ├── rename.ts
│   │   ├── remove.ts
│   │   ├── cancel.ts
│   │   ├── reauth.ts
│   │   ├── skills.ts
│   │   ├── install-hooks.ts
│   │   ├── uninstall-hooks.ts
│   │   └── export-skill.ts
│   └── output.ts          # JSON stdout 輸出格式化
│
├── daemon/                 # Daemon 程序管理 + HTTP API
│   ├── server.ts           # Fastify HTTP server 設定與路由
│   ├── process.ts          # Daemon 背景程序化（fork / PID file）
│   ├── routes/             # HTTP API 路由
│   │   ├── health.ts
│   │   ├── exec.ts
│   │   ├── notebooks.ts
│   │   ├── tasks.ts
│   │   └── status.ts
│   └── scheduler.ts        # Operation scheduler（global semaphore + per-notebook queue）
│
├── browser-pool/              # BrowserPool — Chrome instance pool 管理
│   ├── pool.ts                # BrowserPool 主類別，manage N headless Chrome instances
│   ├── types.ts               # BrowserInstance, PoolError 型別定義
│   ├── puppeteer-launcher.ts  # Puppeteer 底層 Chrome launch 實作
│   └── chrome-finder.ts       # Chrome 執行檔路徑探索
│
├── auth/                      # AuthManager — 認證 cookie 管理
│   ├── manager.ts             # AuthManager 主類別
│   ├── cookie-extractor.ts    # Headed Chrome cookie 擷取
│   └── cookie-injector.ts     # Headless Chrome cookie 注入
│
├── network-gate/              # NetworkGate — 集中式流量閘門
│   ├── gate.ts                # NetworkGate 主類別（acquirePermit / reportAnomaly）
│   ├── throttle-detector.ts   # Rate limit / CAPTCHA 偵測
│   └── backoff.ts             # Exponential backoff 實作
│
├── agent/                  # AI Agent — Claude Agent SDK V2
│   ├── session.ts          # Agent session 建立與管理
│   ├── tools/              # Agent 可用的 tool 定義
│   │   ├── browser-tools.ts    # screenshot, click, type, scroll, paste, download（包裝 Chrome instance）
│   │   ├── content-tools.ts    # repoToText, urlToText, pdfToText
│   │   └── file-tools.ts      # writeFile（查詢結果輸出）
│   └── skill-loader.ts    # 從檔案載入 skill 定義
│
├── content/                # Content Pipeline — 格式轉換
│   ├── repo-to-text.ts     # repomix 包裝
│   ├── url-to-text.ts      # Readability + jsdom 包裝
│   └── pdf-to-text.ts      # pdf-parse 包裝
│
├── state/                  # State Store — 持久化
│   ├── store.ts            # 記憶體狀態 + JSON 持久化
│   ├── notebook-registry.ts # Notebook 元資料 CRUD
│   ├── local-cache.ts      # Per-notebook 來源/artifact 快取
│   ├── operation-log.ts    # 操作歷程紀錄
│   └── task-store.ts       # Async task 狀態管理
│
├── notification/           # Notification — Inbox + Adapter
│   ├── inbox.ts            # 檔案型 inbox 讀寫（atomic write + rename consume）
│   ├── adapter.ts          # Adapter 介面定義
│   ├── adapters/
│   │   ├── claude-code.ts  # Claude Code adapter（hooks 安裝/移除 + 腳本產生）
│   │   └── generic.ts      # Generic pull-based adapter
│   └── hooks/              # Hook 腳本模板
│       ├── user-prompt-submit.sh
│       └── stop.sh
│
├── skill/                  # Agent Skill 外部化定義
│   ├── types.ts            # Skill 定義型別
│   ├── loader.ts           # Skill 檔案載入與驗證
│   └── template-exporter.ts # AI Skill Template 輸出
│
└── shared/                 # 共用工具
    ├── errors.ts           # 統一錯誤型別
    ├── logger.ts           # 結構化日誌（stderr）
    ├── paths.ts            # ~/.nbctl/ 路徑常數 + 權限管理
    └── validation.ts       # URL 格式、alias 格式驗證

skills/                     # Agent Skill 定義檔案（外部化）
├── add-source.yaml
├── query.yaml
├── generate-audio.yaml
├── screenshot.yaml
├── list-sources.yaml
└── rename-source.yaml

tests/
├── unit/                   # 單元測試（對應 src/ 結構）
│   ├── cli/
│   ├── daemon/
│   ├── browser-pool/
│   ├── auth/
│   ├── network-gate/
│   ├── agent/
│   ├── content/
│   ├── state/
│   ├── notification/
│   └── skill/
├── integration/            # 整合測試
│   ├── cli-daemon.test.ts      # CLI → HTTP → daemon 流程
│   ├── agent-browser.test.ts   # Agent → BrowserPool → mock Chrome instance
│   ├── async-notification.test.ts # Async exec → inbox → consume
│   └── state-persistence.test.ts  # State → stop → restart → restore
└── contract/               # 契約測試
    └── http-api.test.ts    # HTTP API 符合 OpenAPI spec
```

**Structure Decision**: 採用 Single project 結構。10 個功能模組 + shared 工具，
每模組一個目錄。CLI 與 daemon 分離（CLI 是 HTTP client，daemon 是 server）。
BrowserPool + AuthManager + NetworkGate 三模組協作管理瀏覽器與流量。
Agent skill 定義以 YAML 檔案外部化於 `skills/` 目錄。

## Module Dependency Graph

```text
CLI ──HTTP──→ Daemon
                ├──→ Scheduler ──→ Agent ──→ BrowserPool ──→ [Chrome/Puppeteer]
                │                    │              │
                │                    │         AuthManager (cookie injection)
                │                    │
                │                    ├──→ NetworkGate (acquirePermit before operations)
                │                    ├──→ SkillLoader ──→ skills/*.yaml
                │                    └──→ ContentPipeline
                ├──→ StateStore ←── Agent (透過 daemon 介面)
                └──→ NotificationInbox
                        └──→ Adapter (claude-code / generic)
```

依賴方向：CLI → Daemon → {Scheduler, State, Notification} → {Agent, BrowserPool, AuthManager, NetworkGate} → 底層
禁止反向依賴。Agent 不直接存取 StateStore，透過 daemon 提供的回呼介面更新狀態。
Agent 操作前 MUST 透過 NetworkGate acquirePermit()。BrowserPool 啟動 Chrome 時透過 AuthManager 取得 cookies。

## Complexity Tracking

> **No constitution violations.** 以下記錄需要額外複雜度說明的設計決策。

| Decision | Why Needed | Simpler Alternative Rejected Because |
|----------|------------|-------------------------------------|
| 10 個模組（原 9 → +AuthManager） | 每模組職責明確且為 spec FR 明確要求。BrowserPool（FR-140）、AuthManager（FR-145）、NetworkGate（FR-190）、Notification Adapter（FR-120）皆為獨立模組。 | 合併模組會違反 Principle II 單一職責（如 BrowserPool + AuthManager 合併後描述需用「和」）。 |
| BrowserPool 取代 ConnectionManager | Agent 自我修復需要完整 Chrome instance。Multi-tab 序列化後優勢消失。BrowserPool 天然 parallel。 | Multi-tab + BoundTools 限制 agent 能力 + 不支援真正 parallel。 |

## Constitution Re-Check (Post Phase 1 Design)

| # | Principle | Status | Phase 1 Notes |
|---|-----------|--------|---------------|
| I | 禁止過度設計 | **PASS** | data-model 只包含 spec 要求的 entity。HTTP API 每個 endpoint 對應一個 CLI 指令，無多餘。AuthManager 從 BrowserPool 拆出因為 cookie 管理 ≠ Chrome lifecycle 管理。 |
| II | 單一職責 | **PASS** | 10 模組各有一句話描述，無重疊。data-model entity 各有明確職責。 |
| III | Agent 程式本質 | **PASS** | Constitution v1.3.0：BrowserPool 中央集權管理 + 全權委派操作。Agent 取得完整 Chrome instance，自主操作 + 自我修復。 |
| IV | 測試先行 | **PASS** | 測試結構（unit/integration/contract）已規劃。Contract test 驗證 HTTP API 符合 OpenAPI。 |
| V | 語意明確命名 | **PASS** | Entity 命名（NotebookEntry, SourceRecord, AsyncTask）語意明確。API endpoint 路徑 RESTful。 |
| VI | 模組輕耦合 | **PASS** | 依賴圖單向。Agent 不直接存取 StateStore。BrowserPool 透過 acquire/release interface 管理 Chrome，AuthManager 透過 cookie injection 共享認證。 |
| VII | 安全並行 | **PASS** | BrowserPool 天然隔離（獨立 Chrome instance）。Per-notebook queue 用 message passing。NetworkGate permit-based 流量控制。Inbox 用 atomic rename。State 用 atomic write。 |
| VIII | 繁體中文文件 | **PASS** | 所有 Phase 1 文件為繁體中文。 |
| IX | CodeTour | **PASS** | 實作時每模組建立 CodeTour。 |
| X | Checkpoint Commit | **PASS** | 實作時每 checkpoint commit + review。 |

**Post-Phase 1 Gate**: **ALL PASS**. 設計階段無 constitution violation。
