# Tasks: NotebookLM Controller MVP

**Input**: Design documents from `/specs/001-mvp/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/mcp-tools.md, research.md, quickstart.md

**Tests**: Included per Constitution Principle IV（測試先行）。每個 user story phase 的 test tasks MUST 先寫且 FAIL 才開始實作。

**Organization**: Tasks grouped by user story。MVP 核心流程 = US1 + US2 + US3 + US10 + US13。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project scaffolding, dependencies, toolchain configuration

- [x] T001 Create project directory structure per plan.md (`src/daemon/`, `src/tab-manager/`, `src/network-gate/`, `src/agent/`, `src/agent/tools/`, `src/content/`, `src/state/`, `src/notification/`, `src/shared/`, `agents/`, `tests/unit/`, `tests/integration/`, `tests/contract/`)
- [x] T002 Initialize TypeScript project with package.json, tsconfig.json, and install dependencies (`@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`)
- [x] T003 [P] Configure Vitest in vitest.config.ts with unit/integration/contract test paths
- [x] T004 [P] Configure ESLint and Prettier for TypeScript 5.x

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that ALL user stories depend on. Includes shared types, state management, TabManager, NetworkGate, Agent runtime, and MCP Server skeleton.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Shared Utilities

- [x] T005 [P] Define all shared TypeScript interfaces from data-model.md in `src/shared/types.ts` (DaemonState, NotebookEntry, NotebookStatus, SourceRecord, SourceOrigin, ArtifactRecord, OperationLogEntry, OperationActionType, AsyncTask, TaskStatus, TaskStatusChange, TaskNotificationPayload, TabHandle, NetworkHealth, AgentConfig, AgentParameter, AsyncSubmitResult, DaemonStatusResult)
- [x] T006 [P] Implement unified error types and format in `src/shared/errors.ts` (NbctlError base, ChromeError, NotebookNotFoundError, AuthExpiredError, TabLimitError, InvalidUrlError, ContentTooLargeError, TaskNotFoundError, DaemonAlreadyRunningError)
- [x] T007 [P] Implement configuration module in `src/shared/config.ts` (port 19224, max tabs 10, timeouts, Chrome path discovery for macOS, model selection, `~/.nbctl/` paths, file permissions 700/600)
- [x] T007.1 [P] Implement structured logging in `src/shared/logger.ts` (FR-051: JSON format, log levels, operation context)

### State Management (covers US9 — State Persistence)

- [x] T008 Unit tests for state-manager in `tests/unit/state/state-manager.test.ts` (atomic write, CRUD, crash recovery, file permissions)
- [x] T009 Implement DaemonState CRUD + atomic write (temp + rename) in `src/state/state-manager.ts`
- [x] T010 [P] Unit tests for task-store in `tests/unit/state/task-store.test.ts` (CRUD, state machine transitions, TTL cleanup)
- [x] T011 [P] Implement AsyncTask CRUD + TTL cleanup + state machine in `src/state/task-store.ts`
- [x] T012 [P] Unit tests for cache-manager in `tests/unit/state/cache-manager.test.ts` (per-notebook source/artifact/operation CRUD)
- [x] T013 [P] Implement per-notebook local cache in `src/state/cache-manager.ts` (SourceRecord, ArtifactRecord, OperationLogEntry CRUD)

### TabManager (covers US17 — TabManager Abstraction)

- [x] T014 Unit tests for cdp-helpers in `tests/unit/tab-manager/cdp-helpers.test.ts` (click, type, screenshot, scroll via CDP mock)
- [x] T015 Implement CDP helpers in `src/tab-manager/cdp-helpers.ts` (dispatchMouseEvent, captureScreenshot, dispatchKeyEvent, scroll — all CDP 底層 API)
- [x] T016 Unit tests for tab-manager in `tests/unit/tab-manager/tab-manager.test.ts` (launch, openTab, closeTab, listTabs, tab timeout, Chrome crash detection)
- [x] T017 Implement TabHandle type + CDP session wrapper in `src/tab-manager/tab-handle.ts`
- [x] T018 Implement TabManager in `src/tab-manager/tab-manager.ts` (Chrome launch with userDataDir, tab lifecycle, max tab limit, timeout enforcement, `browser.on('disconnected')` crash detection, headed/headless mode switching)

### NetworkGate

- [x] T019 Unit tests for network-gate in `tests/unit/network-gate/network-gate.test.ts` (acquirePermit, reportAnomaly, backoff, health status)
- [x] T020 Implement NetworkGate in `src/network-gate/network-gate.ts` (acquirePermit, reportAnomaly, getHealth, exponential backoff with jitter, global backoff state)

### Agent Runtime (covers US18 — Agent Config Parameterization)

- [x] T021 [P] Unit tests for agent-loader in `tests/unit/agent/config/agent-loader.test.ts` (YAML frontmatter parse, template rendering, invalid config skip)
- [x] T022 [P] Implement agent-loader in `src/agent/agent-loader.ts` (load `agents/*.md` YAML frontmatter + Markdown body → template rendering → `CustomAgentConfig[]`, including `infer` field for Copilot CLI inference)
- [x] T023 Unit tests for CopilotClient singleton in `tests/unit/agent/client.test.ts` (start, stop, autoRestart, singleton lifecycle)
- [x] T024 Implement CopilotClient singleton in `src/agent/client.ts` (start/stop, autoRestart: true, singleton pattern)
- [x] T025 Unit tests for SessionHooks in `tests/unit/agent/hooks.test.ts` (onPreToolUse → acquirePermit, onErrorOccurred retry/skip/abort, fail-open behavior)
- [x] T026 Implement SessionHooks in `src/agent/hooks.ts` (onPreToolUse → NetworkGate acquirePermit, onErrorOccurred three-way routing, onSessionEnd cleanup, acquirePermit timeout < sendAndWait timeout constraint)
- [x] T027 Unit tests for session-runner in `tests/unit/agent/session-runner.test.ts` (createSession → sendAndWait → disconnect → result collection)
- [x] T028 Implement session-runner in `src/agent/session-runner.ts` (per-task: createSession with tools + agent + hooks, sendAndWait with configurable timeout per FR-031, disconnect, result collection)
- [x] T028.1 [P] **Spike backfill**: Add `model: "gpt-4.1"` to `createSession()` call in session-runner (Spike 1: explicit model skips negotiation, 5.6s → 0.5s setup). Model configurable via `config.ts`

### Agent Tools — Browser & State

- [x] T029 [P] Unit tests for browser-tools in `tests/unit/agent/tools/browser-tools.test.ts` (screenshot, click, type, scroll, paste — mock CDP session, verify Tool 自包：screenshot tool returns binaryResultsForLlm)
- [x] T030 [P] Implement browser-tools in `src/agent/tools/browser-tools.ts` (defineTool + Zod for screenshot, click, type, scroll, paste — all CDP-based, each tool self-contained with screenshot return via ToolResultObject.binaryResultsForLlm)
- [x] T030.2 [P] **Spike backfill**: Copy find tool v2 from spike into `src/agent/tools/browser-tools.ts`. Adapt to TabHandle (`tabHandle.page.evaluate()`). v2 spec: 16 interactive selectors (button/a/input/textarea/select + 6 ARIA roles + tabindex + contenteditable), returns tag/text/center coordinates/rect + disabled + ariaExpanded, filters visibility:hidden and display:none. Agent MUST use find before click — never guess coordinates from screenshots.
- [x] T030.3 [P] **Spike backfill**: Copy read tool v2 from spike into `src/agent/tools/browser-tools.ts`. Adapt to TabHandle. v2 spec: structured return { count, items[] } with tag/text/visible per item. Dual purpose: state verification (element count, visibility check) + content extraction (answer text). Key selector: `.to-user-container .message-content`
- [x] T030.4 [P] **Spike backfill**: Copy navigate tool from spike into `src/agent/tools/browser-tools.ts`. Adapt to TabHandle (`tabHandle.page.goto()` + waitUntil networkidle2 + screenshot return)
- [x] T030.5 [P] **Spike backfill**: Copy wait tool from spike into `src/agent/tools/browser-tools.ts` (setTimeout 1-30s + screenshot return)
- [x] T030.6 [P] Unit tests for new browser-tools (find v2, read v2, navigate, wait — mock page.evaluate + page.goto. Test: find visibility filter, find disabled/ariaExpanded return, read structured count+items, navigate screenshot auto-return, wait 1-30s range validation)
- [x] T031 [P] Unit tests for state-tools in `tests/unit/agent/tools/state-tools.test.ts` (reportRateLimit, updateCache, writeFile)
- [x] T032 [P] Implement state-tools in `src/agent/tools/state-tools.ts` (defineTool + Zod for reportRateLimit → NetworkGate, updateCache → cache-manager, writeFile)
- [x] T032.1 [P] Unit tests for tool-registry in `tests/unit/agent/tools/tool-registry.test.ts` (buildToolsForTab factory, tool combination, tool isolation per tab)
- [x] T033 Implement tool registry in `src/agent/tools/index.ts` (buildToolsForTab(tabHandle) → Tool[] factory function, combining browser + content + state tools)

### MCP Server Skeleton & Scheduler

- [x] T033.1 Unit tests for scheduler in `tests/unit/daemon/scheduler.test.ts` (queue dispatch, cross-notebook parallel, same-notebook serial, task cancellation)
- [x] T034 Implement scheduler in `src/daemon/scheduler.ts` (per-notebook operation queue, task dispatch to session-runner, cross-notebook parallel / same-notebook serial)
- [x] T035 Implement MCP Server skeleton in `src/daemon/mcp-server.ts` (Streamable HTTP transport setup with `@modelcontextprotocol/sdk`, tool registration framework, 127.0.0.1:19224)

### Notification

- [x] T035.1 [P] Unit tests for notifier in `tests/unit/notification/notifier.test.ts` (fire-and-forget push, client disconnect handling)
- [x] T036 [P] Implement notifier in `src/notification/notifier.ts` (fire-and-forget MCP notification push, TaskNotificationPayload, client uses `status` field to identify failures)

### Spike Backfill (Browser Capability Spike 1, 2026-03-13)

- [x] T030.2~T030.6: Browser tools v2 擴充（見上方 Agent Tools 區）
- [x] T028.1: Session-runner model 指定（見上方 Agent Runtime 區）
- [x] T037.1 [P] **Spike backfill**: Add `{{NOTEBOOKLM_KNOWLEDGE}}` template variable support to agent-loader. KNOWLEDGE 注入點：**CustomAgent prompt（`agents/*.md`）**，不是 session systemMessage。Main agent 只做 intent → agent routing（輕量 systemMessage），不需要 UI 知識。每個需要操作瀏覽器的 subagent（add-source, query, create-notebook 等）在 prompt 中引用 `{{NOTEBOOKLM_KNOWLEDGE}}`，agent-loader 解析時從 UI map config 載入 locale-specific 內容。KNOWLEDGE 內容：UI element table + known CSS selectors + disambiguation rules (submit button y>400, collapse_content recovery) + **狀態確認原則**（每步操作後 agent 用 find/read/screenshot 自行確認狀態，prompt 只設目標不限手段，不預存 success pattern，agent 自主選擇最有效的觀測方式）。
- [x] T037.2 [P] **Spike backfill**: Create UI map config data structure + 3 built-in locale files. `src/config/ui-maps/{zh-TW,en,zh-CN}.json` — contains `elements` (text + match + disambiguate per UI element) and `selectors` (answer, question, suggestions, source_panel). Schema from spike HANDOVER.md. Add `UIMap` / `UIMapElement` interfaces to `src/shared/types.ts`. Unit tests in `tests/unit/shared/ui-map.test.ts`.
- [x] T037.3 [P] **Spike backfill**: Implement locale resolver in `src/shared/locale.ts`. `resolveLocale(browserLang: string) → string` (navigator.language → zh-TW|zh-CN|en) + `loadUIMap(locale: string) → UIMap` (read built-in JSON, fallback to en). Unit tests in `tests/unit/shared/locale.test.ts`.

**Deleted**: ~~T030.1~~ (BrowserContext refactor — TabHandle 已有 cdpSession + page，不需要改介面), ~~T033.1a~~ (buildToolsForTab rename — 同上), ~~T037~~ (spike import 整合 — 改為直接複製 spike code 進 src/，後續 repair 機制再處理 single source of truth)

**Post-MVP（標注但不排入）**: `tools repair` CLI — 自動偵測 locale、smoke test、config/code 自修復。新 locale 自動 discovery（vision → UI map 生成）。Spike 與 src/ tool 定義 single source of truth 整合。

**Checkpoint**: Foundation ready — all infrastructure modules implemented and unit tested. Spike conclusions integrated. User story implementation can begin.

**🔍 Review Point 1**: 開發者主動發起 `/reviewCode` + `/codetour`（Constitution IX）。地基層，所有 user story 依賴它。

---

## Phase 3: US1 — Daemon 生命週期管理 (Priority: P1) 🎯 MVP

**Goal**: 啟動/停止 daemon，Chrome 管理，MCP Server 可連線，認證流程

**Independent Test**: `npx nbctl` 啟動 daemon → MCP Server 可連線 → `shutdown` tool 乾淨關閉

### Tests for US1

- [x] T037 [P] [US1] Integration test for daemon startup in `tests/integration/daemon/lifecycle.test.ts` (start daemon, verify MCP Server listening, Chrome launched, shutdown clean)
- [x] T038 [P] [US1] Integration test for reauth flow in `tests/integration/daemon/reauth.test.ts` (detect expired session, reauth tool, mode switching)
- [x] T039 [P] [US1] Contract test for get_status tool in `tests/contract/mcp-tools/get-status.test.ts` (DaemonStatusResult schema validation)
- [x] T040 [P] [US1] Contract test for shutdown tool in `tests/contract/mcp-tools/shutdown.test.ts` (response schema validation)

### Implementation for US1

- [x] T041 [US1] Implement daemon entry point in `src/daemon/index.ts` (Chrome launch via TabManager + CopilotClient start + MCP Server start, PID file write with `{ pid, startedAt }` double-check)
- [x] T041.1 [US1] Detect Chrome locale on daemon startup — `page.evaluate(() => navigator.language)` → `resolveLocale()` → `loadUIMap()` → store in daemon runtime state. Agent session creation passes resolved UIMap to agent-loader, which renders `{{NOTEBOOKLM_KNOWLEDGE}}` in CustomAgent prompts.
- [x] T041.2 [US1] **Review backfill**: Resolve CopilotClient restart strategy — choose between SDK `autoRestart: true` or wrapper `_handleUnexpectedExit()`, not both. If SDK autoRestart: remove `_handleUnexpectedExit`. If wrapper restart: disable `autoRestart`, wire to SDK exit event. Also unify `started` flag vs SDK `getState()` — either trust SDK state only or keep `started` as lifecycle-intent only (see Phase 2 review: client.ts dual-state issue).
- [x] T041.3 [US1] **Review backfill**: Verify MCP multi-session behavior — `McpServer.connect(transport)` called per new session may detach previous transport. Either create per-session `McpServer` instance (re-register tools), confirm SDK supports multi-transport, or reject concurrent sessions with clear error. (see Phase 2 review: mcp-server.ts 🟡1)
- [x] T041.4 [US1] **Review backfill**: Add write mutex to StateManager mutation methods — current load→mutate→save is not atomic across concurrent calls. Safe now (scheduler serializes same-notebook), but will race when multiple MCP tools read/write simultaneously. Add simple promise-chain lock. (see Phase 2 review: state-manager.ts 🟡2)
- [x] T041.5 [US1] **Review backfill**: FR-051 agent execution structured logging — hooks 目前只有 coarse lifecycle log，缺 per-tool timing (`onPreToolUse`/`onPostToolUse` duration + argument summary)、session aggregate summary (total tools, duration, error count)、scheduler queue depth metric。(see AUDIT A2#5 + 架構 tour hooks step)
- [x] T041.6 [US1] **Review backfill**: session-runner response validation — `sendAndWait` 不 throw = `success: true`，沒有 contract validation 也沒有 semantic interpretation。`response?.data?.content ?? undefined` 靜默返回 undefined。Phase 3 接入 scheduler 前應補 response schema validation。(see AUDIT A4#1 + 架構 tour session-runner step)
- [x] T041.7 [US1] **Review backfill**: session-runner disconnect() hang guard — `disconnect()` 可能 hang（SDK 內部等待），影響 scheduler processQueue 的下一個 task。加外層 timeout（e.g. 5s）+ catch fallback。(see AUDIT 未標記#3 + 架構 tour session-runner step)
- [x] T042 [US1] Implement thin launcher in `src/daemon/launcher.ts` (npx nbctl: fork daemon, PID file check for already-running, SIGTERM stop)
- [x] T043 [US1] Register `get_status` MCP tool in `src/daemon/mcp-server.ts` (daemon-level status: running, browserConnected, network health, openNotebooks, pendingTasks, runningTasks)
- [x] T044 [US1] Register `shutdown` MCP tool in `src/daemon/mcp-server.ts` (close all tabs → Chrome → release resources → clean PID file)
- [x] T045 [US1] Register `reauth` MCP tool in `src/daemon/mcp-server.ts` (close headless Chrome → launch headed Chrome → wait for login → switch back to headless)
- [x] T046 [US1] Handle Chrome startup errors (Chrome not found, port occupied, invalid userDataDir) with clear error messages per spec AS5, AS6

**Checkpoint**: Daemon can start, run MCP Server, handle Chrome lifecycle, and shut down cleanly.

---

## Phase 4: US2 — Notebook 管理與 Tab 操作 (Priority: P2) 🎯 MVP

**Goal**: 透過 MCP tools 管理 notebook（納管、開啟、關閉、列表、設定預設、重命名、移除）

**Independent Test**: add_notebook 納管 notebook → list_notebooks 列出 → open_notebook 開啟 tab → close_notebook 關閉 tab → remove_notebook 移除

### Tests for US2

- [x] T047 [P] [US2] Contract tests for notebook management tools in `tests/contract/mcp-tools/notebook-mgmt.test.ts` (add_notebook, list_notebooks, open_notebook, close_notebook, set_default, rename_notebook, remove_notebook — input/output schema validation)
- [x] T048 [P] [US2] Integration test for notebook CRUD in `tests/integration/daemon/notebook-crud.test.ts` (add → list → open → close → rename → remove full flow)

### Implementation for US2

- [x] T049 [US2] Register `add_notebook` MCP tool in `src/daemon/notebook-tools.ts` (validate URL format, check duplicate URL/alias, create NotebookEntry, sync to state)
- [x] T050 [US2] Register `list_notebooks` MCP tool in `src/daemon/notebook-tools.ts` (return all registered notebooks with description, status, active flag, sourceCount)
- [x] T051 [P] [US2] Register `open_notebook` MCP tool in `src/daemon/notebook-tools.ts` (mark active, next operation opens tab)
- [x] T052 [P] [US2] Register `close_notebook` MCP tool in `src/daemon/notebook-tools.ts` (close tab if open, mark inactive, preserve registration)
- [x] T053 [P] [US2] Register `set_default` MCP tool in `src/daemon/notebook-tools.ts` (update DaemonState.defaultNotebook)
- [x] T054 [P] [US2] Register `rename_notebook` MCP tool in `src/daemon/notebook-tools.ts` (validate new alias uniqueness, update state)
- [x] T055 [P] [US2] Register `remove_notebook` MCP tool in `src/daemon/notebook-tools.ts` (close tab, remove from registry, clean cache)
- [ ] T056 [US2] Register `add_all_notebooks` MCP tool in `src/daemon/mcp-server.ts` (navigate to NotebookLM homepage via agent, extract notebook list, batch add. ⚠️ MCP 互動模型待定：傾向 Preview+confirm 兩步模式，MVP 後決定)
- [ ] T057 [US2] Implement tab limit enforcement and queuing (max 10 tabs, wait or error per spec AS11)
- [ ] T058 [US2] Write `agents/create-notebook.md` agent config (navigate to NotebookLM homepage, click new notebook, capture dynamic URL, register)
- [ ] T058.1 [US2] Implement notebook description auto-maintenance in add-source/remove-source agent prompts (FR-045: auto-update on source change, FR-046: include source list summary, FR-047: include creation timestamp)

**Checkpoint**: All notebook management MCP tools functional. Can add, list, open, close, rename, remove notebooks.

---

## Phase 5: US13+US14 — 非同步操作與通知 (Priority: P13-P14) 🎯 MVP

**Goal**: exec tool 的 async 模式（立即返回 taskId）+ MCP notification 推送完成結果

**Independent Test**: exec(async=true) → 立即拿到 taskId → get_status 查詢結果 → MCP notification 自動推送

### Tests for US13+US14

- [ ] T059 [P] [US13] Contract test for exec tool (async mode) in `tests/contract/mcp-tools/exec-async.test.ts` (AsyncSubmitResult schema, get_status with taskId)
- [ ] T060 [P] [US13] Contract test for cancel_task tool in `tests/contract/mcp-tools/cancel-task.test.ts` (queued→cancelled, running→cancelled, terminal state error)
- [ ] T061 [P] [US14] Integration test for MCP notification in `tests/integration/mcp/notification.test.ts` (async operation complete → notification pushed to connected client)

### Implementation for US13+US14

- [ ] T062 [US13] Register `exec` MCP tool in `src/daemon/mcp-server.ts` (parse prompt + notebook + async + context, resolve default notebook, dispatch to scheduler)
- [ ] T063 [US13] Implement sync/async branching in exec tool (sync: await scheduler result; async: return taskId + hint immediately)
- [ ] T064 [US13] Register `cancel_task` MCP tool in `src/daemon/mcp-server.ts` (cancel queued task from queue, signal running agent to stop at safe point, reject terminal state)
- [ ] T065 [US13] Extend `get_status` MCP tool with task query modes (taskId → single task, all → recent tasks list, recent → undelivered tasks, notebook filter, limit)
- [ ] T066 [US14] Integrate notifier with scheduler — on task complete/fail, push MCP notification to connected clients (fire-and-forget, no priority — client uses `status` field)
- [ ] T067 [US14] Handle client disconnection gracefully (notification not sent, result preserved in task store for get_status pull)

**Checkpoint**: Async operations work end-to-end. Can submit, track, cancel tasks, and receive notifications.

---

## Phase 6: US3 — 將專案程式碼餵入 NotebookLM (Priority: P3) 🎯 MVP

**Goal**: 透過 exec tool 將 git repo 轉換並新增為 NotebookLM 來源

**Independent Test**: exec(prompt="把 ~/code/project 的程式碼加入來源") → repo 內容出現在 NotebookLM 來源列表

### Tests for US3

- [ ] T068 [P] [US3] Unit tests for repo-to-text in `tests/unit/content/repo-to-text.test.ts` (repomix wrapper, word count, gitignore respect, 500K limit check)
- [ ] T069 [P] [US3] Unit tests for content-tools in `tests/unit/agent/tools/content-tools.test.ts` (repoToText defineTool, parameter validation)
- [ ] T070 [P] [US3] Integration test for add-source flow in `tests/integration/agent/add-source.test.ts` (exec → agent → repoToText → UI paste → source added)

### Implementation for US3

- [ ] T071 [US3] Implement repo-to-text in `src/content/repo-to-text.ts` (repomix programmatic API wrapper, word count, 500K limit validation, error handling for non-git paths)
- [ ] T072 [US3] Implement repoToText in `src/agent/tools/content-tools.ts` (defineTool + Zod, call repo-to-text, return text result)
- [ ] T073 [US3] Write `agents/add-source.md` agent config (prompt: screenshot → click "Add source" → select "Copied text" → paste content → confirm → rename source per naming rules → update cache)
- [ ] T074 [US3] Implement source update flow in agent prompt (delete old source → re-convert → add new → rename, per spec AS4)
- [ ] T075 [US3] Implement source delete flow in agent prompt (find source in UI → delete, per spec AS5)

**Checkpoint**: Core value proposition works — can feed repo code into NotebookLM as a source.

---

## Phase 7: US10 — 向 Notebook 提問並取得 Grounded 回答 (Priority: P10) 🎯 MVP

**Goal**: 透過 exec tool 向 NotebookLM 提問，取得帶引用的 grounded 回答

**Independent Test**: exec(prompt="這個專案的認證流程是怎麼運作的？") → 回傳 answer + citations

### Tests for US10

- [ ] T076 [P] [US10] Integration test for query flow in `tests/integration/agent/query.test.ts` (exec query → agent types in chat → waits for response → extracts answer + citations)

### Implementation for US10

- [ ] T077 [US10] Write `agents/query.md` agent config (prompt: screenshot current state → type question in chat area → wait for Gemini response → extract answer text + citations → return structured result)
- [ ] T078 [US10] Handle query edge cases in agent prompt (no sources error, timeout with screenshot, empty/refused answer)

**Checkpoint**: MVP core flow complete — feed repo → query → get grounded answer. 🎉

**🔍 Review Point 2**: 開發者主動發起 `/audit` + `/codetour` + `/reviewCode`（Constitution IX）。MVP 整體架構穩定，適合全面審查。

---

## Phase 8: US4+US5 — 將網頁/PDF 內容餵入 NotebookLM (Priority: P4-P5)

**Goal**: 補充 content pipeline — URL 和 PDF 來源

**Independent Test**: exec 指定 URL → 內容擷取並新增為來源；exec 指定 PDF → 轉換並新增

### Tests for US4+US5

- [ ] T079 [P] [US4] Unit tests for url-to-text in `tests/unit/content/url-to-text.test.ts` (readability + jsdom extraction, word count)
- [ ] T080 [P] [US5] Unit tests for pdf-to-text in `tests/unit/content/pdf-to-text.test.ts` (pdf-parse wrapper, page count, error handling for corrupt PDF)

### Implementation for US4+US5

- [ ] T081 [P] [US4] Implement url-to-text in `src/content/url-to-text.ts` (readability + jsdom, extract article body to Markdown)
- [ ] T082 [P] [US5] Implement pdf-to-text in `src/content/pdf-to-text.ts` (pdf-parse wrapper, page count, word count)
- [ ] T083 [US4] Implement urlToText in `src/agent/tools/content-tools.ts` (defineTool + Zod)
- [ ] T084 [US5] Implement pdfToText in `src/agent/tools/content-tools.ts` (defineTool + Zod)
- [ ] T085 [US4] Handle URL-native source flow in add-source agent prompt (detect "加入連結來源" intent → use NotebookLM native Link option instead of crawl+paste)

**Checkpoint**: All three content types (repo, URL, PDF) can be fed into NotebookLM.

---

## Phase 9: US6 — 產生並下載 Audio Overview (Priority: P6)

**Goal**: 觸發 Audio Overview 產生 + 下載到本機

**Independent Test**: exec(prompt="產生 audio overview") → 等待完成 → exec(prompt="下載 audio") → 本機有 audio 檔案

### Tests for US6

- [ ] T086 [P] [US6] Integration test for audio flow in `tests/integration/agent/audio.test.ts` (generate → poll status → download)

### Implementation for US6

- [ ] T087 [US6] Write `agents/generate-audio.md` agent config (prompt: screenshot → click generate audio button → confirm → report generating status)
- [ ] T088 [US6] Write `agents/download-audio.md` agent config (prompt: screenshot → check audio ready → click download → intercept download via CDP → save to specified path → return path + size)
- [ ] T089 [US6] Implement downloadFile browser tool in `src/agent/tools/browser-tools.ts` (CDP download interception, save to local path)

**Checkpoint**: Audio Overview end-to-end: generate, wait, download.

---

## Phase 10: US7+US8 — 來源狀態查詢與截圖除錯 (Priority: P7-P8)

**Goal**: 查詢 notebook 來源清單 + 截圖除錯功能

**Independent Test**: exec(prompt="列出所有來源") → 完整來源清單；exec(prompt="截圖") → base64 截圖

### Implementation for US7+US8

- [ ] T090 [P] [US7] Write `agents/list-sources.md` agent config (prompt: screenshot source panel → extract source names, status, count → return structured list)
- [ ] T091 [P] [US8] Write `agents/screenshot.md` agent config (prompt: take screenshot → return base64 or save to path)

**Checkpoint**: Observability tools available — source listing and screenshot debugging.

---

## Phase 11: US20+US21+US22 — 命名、索引、歷程 (Priority: P20-P22)

**Goal**: 來源自動重命名、結構化 local cache 查詢、操作歷程紀錄

**Independent Test**: 新增來源 → 驗證自動重命名 → 查詢資源索引 → 查詢操作歷史

### Implementation for US20+US21+US22

- [ ] T092 [US20] Write `agents/rename-source.md` agent config (prompt: find source in UI → click rename → type new name per naming rules → confirm)
- [ ] T093 [US20] Ensure naming rules enforced in add-source agent (repo: `<name> (repo)`, PDF: `<filename> (PDF)`, URL: `<domain/path> (web)`)
- [ ] T094 [US21] Implement cache query capabilities in exec handler (query SourceRecord/ArtifactRecord from cache-manager, return structured index)
- [ ] T095 [US22] Implement operation log recording in session-runner (on task complete, write OperationLogEntry to cache-manager with command, actionType, status, resultSummary, durationMs)
- [ ] T095.1 [US21] Write `agents/sync.md` agent config and register `sync_notebook` MCP tool in scheduler (FR-044: re-scan notebook, diff local cache vs UI state, update SourceRecord/ArtifactRecord)

**Checkpoint**: Resource management complete — naming, indexing, audit trail.

---

## Phase 12: US11+US12 — 多輪對話與檔案輸出 (Priority: P11-P12)

**Goal**: 同 notebook 多輪連續提問 + 回答輸出為 Markdown 檔案

**Independent Test**: 連續提問兩個相關問題 → 第二個答案參考前一輪；指定檔案路徑 → Markdown 輸出

### Implementation for US11+US12

- [ ] T096 [US11] Extend query agent to support multi-turn (session reuse within same notebook, conversation context preserved in Copilot session)
- [ ] T097 [US11] Implement "新對話" intent detection in query agent (clear NotebookLM chat history before asking)
- [ ] T098 [US12] Implement file output detection in exec handler (detect "存到" / "output to" path in prompt → write Markdown file after query, include question title + answer + citations)

**Checkpoint**: Query experience complete — multi-turn dialogue and file output.

---

## Phase 13: US15+US19+US23+US24 — 探索、智慧選擇、標題管理、可讀輸出 (Priority: P15-P24)

**Goal**: MCP tool 自動探索、智慧 notebook 選擇、notebook 標題重命名、人類可讀格式輸出

### Implementation for US15+US19+US23+US24

- [ ] T099 [P] [US15] Register `list_agents` MCP tool in `src/daemon/mcp-server.ts` (return loaded agent configs with name, description)
- [ ] T100 [US19] Implement smart notebook selection in exec handler (when no notebook specified and no default, match prompt against notebook descriptions + source names, suggest and confirm)
- [ ] T101 [P] [US23] Add notebook title rename to exec agent capabilities (detect "改標題" intent → rename in NotebookLM UI → update cache)
- [ ] T102 [P] [US24] Add human-readable output format option in exec handler (detect "表格" / "Markdown" format requests → format response as table/Markdown)
- [ ] T102.1 [P] [US14] Implement OS notification for async task completion (FR-160: macOS notification via node-notifier or native API, FR-161: configurable on/off in config, default on)

**Checkpoint**: All user stories implemented.

---

## Phase 14: Polish & Cross-Cutting Concerns

**Purpose**: Quality, security, validation

- [ ] T103 [P] File permission enforcement on startup — verify `~/.nbctl/` tree is 700/600, auto-fix with warning per data-model.md
- [ ] T104 Security review — ensure no command injection in content pipeline, validate all user-provided paths, sanitize agent prompts
- [ ] T105 Run quickstart.md validation — full workflow: start daemon → add notebook → feed source → query → async task → shutdown
- [ ] T106 Performance baseline — measure daemon startup time (<10s), management tool latency (<100ms), simple agent operation (<15s)

**🔍 Review Point 3**: 開發者主動發起 `/audit` + `/codetour` + `/reviewCode`（Constitution IX）。全部完成，production readiness 審查。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3)**: Depends on Foundational — daemon must exist first
- **US2 (Phase 4)**: Depends on US1 — needs running daemon + MCP Server
- **US13+US14 (Phase 5)**: Depends on Phase 2 (Foundational) + US1 — needs running daemon + exec tool + scheduler
- **US3 (Phase 6)**: Depends on US2 + US13 — needs notebook management + exec tool
- **US10 (Phase 7)**: Depends on US3 — needs sources in notebook to query
- **US4+US5 (Phase 8)**: Depends on US3 — extends content pipeline
- **US6-US24 (Phase 9-13)**: Depends on core MVP (US1+US2+US3+US10+US13)
- **Polish (Phase 14)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1: Setup
  ↓
Phase 2: Foundational (BLOCKS ALL)
  ↓
Phase 3: US1 (Daemon)
  ↓
Phase 4: US2 (Notebook Mgmt) ←── Phase 5: US13+US14 (Async+Notify)
  ↓                                   ↓
Phase 6: US3 (Repo Source) ←──────────┘
  ↓
Phase 7: US10 (Query)
  ↓
  ├── Phase 8: US4+US5 (URL+PDF)
  ├── Phase 9: US6 (Audio)
  ├── Phase 10: US7+US8 (Status+Screenshot)
  ├── Phase 11: US20-22 (Naming+Cache+History)
  ├── Phase 12: US11+US12 (Multi-turn+File Output)
  └── Phase 13: US15+US19+US23+US24 (Discovery+Smart+Title+Readable)
       ↓
Phase 14: Polish
```

### Within Each User Story

1. Tests MUST be written and FAIL before implementation (Constitution IV)
2. Contract tests → Integration tests → Implementation
3. Agent configs after tool implementations
4. Commit after each task or logical group, MUST pass lint + test (Constitution IX)
5. Review points 由開發者主動發起（見 Phase 2 / Phase 7 / Phase 14 標記）

### Parallel Opportunities

**Phase 2 (Foundational)**:
- T005, T006, T007 (shared utils) — all parallel
- T008+T009, T010+T011, T012+T013 (state modules) — each pair sequential, pairs parallel
- T014+T015, T016+T017+T018 (tab-manager) — sequential within, parallel with other modules
- T019+T020 (network-gate) — parallel with other modules
- T021+T022, T023+T024, T025+T026, T027+T028 (agent) — each pair sequential, pairs parallel
- T029+T030, T031+T032 (agent tools) — parallel pairs

**Phase 4-5 (US2 + US13)**:
- US2 and US13 can partially overlap — US2 notebook tools and US13 async/exec tool are independent MCP tools

**Phase 8+ (post-MVP)**:
- Phases 8-13 can proceed in parallel once MVP is validated

---

## Parallel Example: Foundational Phase

```bash
# Parallel batch 1 — shared utils (all independent files):
Task T005: "Define shared types in src/shared/types.ts"
Task T006: "Implement error types in src/shared/errors.ts"
Task T007: "Implement config in src/shared/config.ts"

# Parallel batch 2 — state + tab + network + agent (independent modules):
Task T008+T009: "state-manager tests + impl"
Task T010+T011: "task-store tests + impl"      # parallel with above
Task T014+T015: "cdp-helpers tests + impl"      # parallel with above
Task T019+T020: "network-gate tests + impl"     # parallel with above
Task T021+T022: "agent-loader tests + impl"     # parallel with above

# Parallel batch 3 — depends on batch 2:
Task T012+T013: "cache-manager tests + impl"
Task T016+T017+T018: "tab-manager tests + impl"
Task T023+T024: "CopilotClient tests + impl"
Task T029+T030: "browser-tools tests + impl"    # parallel
Task T031+T032: "state-tools tests + impl"      # parallel
```

---

## Implementation Strategy

### MVP First (Phases 1-7)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: US1 — Daemon lifecycle
4. Complete Phase 4: US2 — Notebook management
5. Complete Phase 5: US13+US14 — Async operations + notifications
6. Complete Phase 6: US3 — Repo source feeding
7. Complete Phase 7: US10 — Query grounded answers
8. **STOP and VALIDATE**: Run quickstart.md full workflow
9. Deploy/demo if ready

### Incremental Delivery (post-MVP)

10. Phase 8: US4+US5 — URL + PDF sources → more content types
11. Phase 9: US6 — Audio Overview → killer feature
12. Phase 10-13: Remaining user stories → polish and completeness
13. Phase 14: Polish → production readiness

### MVP Scope

MVP = **US1 + US2 + US3 + US10 + US13+US14** = Phases 1-7 (T001-T078)

This covers the core flow: 啟動 → 認證 → 納管 → 餵入 repo → 查詢 → 取得 grounded 回答

---

## Summary

| Metric | Value |
|--------|-------|
| Total tasks | 114 |
| Phase 1 (Setup) | 4 |
| Phase 2 (Foundational) | 36 |
| Phase 3 US1 (Daemon) | 11 |
| Phase 4 US2 (Notebook) | 13 |
| Phase 5 US13+US14 (Async+Notify) | 9 |
| Phase 6 US3 (Repo Source) | 8 |
| Phase 7 US10 (Query) | 3 |
| Phase 8 US4+US5 (URL+PDF) | 7 |
| Phase 9 US6 (Audio) | 4 |
| Phase 10 US7+US8 (Status+Screenshot) | 2 |
| Phase 11 US20-22 (Naming+Cache+History) | 5 |
| Phase 12 US11+US12 (Multi-turn+File) | 3 |
| Phase 13 US15+US19+US23+US24 | 5 |
| Phase 14 (Polish) | 4 |
| MVP tasks (Phases 1-7) | 84 |
| Post-MVP tasks (Phases 8-14) | 30 |
| Review points | 3 (Phase 2 ✓ / Phase 7 ✓ / Phase 14 ✓) |
| Parallel opportunities | 15+ batches identified |
