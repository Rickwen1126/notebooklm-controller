# 功能規格書：NotebookLM Controller MVP

**Feature Branch**: `001-mvp`
**Created**: 2026-02-06
**Status**: Draft (v8 — execution architecture rebaseline)
**Input**: PRD 文件 `docs/prd.md` + 架構重構討論

<!--
  v1 初始規格（2026-02-06）
  v2 對齊 Constitution v1.1.0，簡化指令模式（2026-02-07）
  v3 整併 002-abstract-cli-notify（2026-02-12）：
  1. 移除 MCP 整合，改以 CLI + AI Skill + Notification Adapter 取代。
  2. 瀏覽器控制抽象化：Connection Manager + multi-tab 架構。
  3. 非同步操作 + Notification Inbox + per-session routing。
  v4 BrowserPool 架構 pivot（2026-02-12）：（已被 v5 取代）
  v5 Single Browser Multi-tab 架構 pivot（2026-02-23）：
  1. BrowserPool → Single Browser Multi-tab：實驗證實 background tab
     操作完全可靠（CDP Input.dispatchMouseEvent + Page.captureScreenshot），
     Puppeteer page.click() hang 是高層 API 問題，非 Chrome/CDP 限制。
  2. BrowserPool + AuthManager → TabManager：一個 Chrome instance 多 tab，
     認證透過 userDataDir 共享（不需 cookie extraction/injection）。
  3. Agent 透過 CDP 底層 API 操作 tab，擁有完整操作能力。
  4. 記憶體從 ~900MB 降至 ~500MB。
  5. NetworkGate 保留，Chrome 生命週期仍由 daemon 管理。
  v7 SHIP B/R/N 解除後補充設計決策（2026-03-10）：
  1. Agent task 設計原則：細粒度、每步進度外部化、conceptually stateless per run。
  2. Shutdown 策略：不做 graceful shutdown，直接終止，task queue 恢復。
  3. Chrome crash 處理：disconnected → 通知 agent → 重啟 Chrome → task queue 接手。
  4. PID file 雙重檢查：{ pid, startedAt } 防 PID 重用。
  5. 429 偵測：agent 自主偵測、回報，daemon 不規範方式。
  6. MCP notification：fire-and-forget，不補發。
  7. Tool 自包原則：screenshot tool 自行截圖 + 格式轉換，daemon 不中轉。
  v6 MCP Server 介面 pivot（2026-02-23）：
  1. CLI + HTTP API → MCP Server（Streamable HTTP transport）。
     主要消費者為 AI agent（Claude Code 等），MCP 是 AI 工具的原生協議。
     砍掉 CLI 模組（Commander.js）、Fastify HTTP router、Skill Template。
  2. MCP tool 自描述（tools/list），不需額外 AI Skill Template。
  3. MCP 持續連線，非同步完成通知直接透過 MCP notification 推送，
     簡化 Notification 系統（移除 Inbox 檔案、Hook 腳本、Adapter）。
  4. Daemon 核心不變（TabManager、Agent、State、NetworkGate），
     只是介面層從 CLI+HTTP 換成 MCP protocol。
  5. Daemon 透過 `npx nbctl` thin launcher 啟動，或由 MCP client 設定啟動。
  6. 移除 US15（AI Skill Template）、US16（Notification Adapter）——
     MCP tool 自描述取代 Skill Template，MCP notification 取代 Adapter。
-->

## Implementation Status (2026-03-20)

> Tracked against actual codebase as of 2026-03-20.
> This section is a status overlay — the User Stories below remain unchanged.

### Summary

| Status | Count | Stories |
|--------|-------|---------|
| DONE | 18 | US1, US2, US3, US4, US5, US7, US8, US9, US10, US11, US13, US14, US15, US17, US20, US21, US22, US23 |
| PARTIAL | 1 | US18 |
| NOT STARTED | 3 | US6, US12, US19 |

### DONE — fully implemented + tested

| Story | Title | Notes |
|-------|-------|-------|
| US1 | Daemon 生命週期管理 | startDaemon, stopDaemon, Chrome launch, Google session check, reauth, get_status, MCP Server |
| US2 | Notebook 管理 | register, register_all, create_notebook, unregister, list, set_default, rename (alias), parallel multi-notebook |
| US7 | Source 狀態查詢 | listSources via exec, source panel reading |
| US8 | 截圖除錯 | captureScreenshot via CDP, screenshot persistence to `~/.nbctl/screenshots/` |
| US9 | 狀態持久化 | state.json, task-store, cache-manager |
| US10 | 查詢 NotebookLM | scriptedQuery via exec, pollForAnswer with 3-layer stability check |
| US11 | 多輪對話 | chat panel maintains conversation, clearChat operation |
| US13 | 非同步操作 | async:true submit, taskId return, get_status polling, cancel_task |
| US14 | MCP 通知 | Notifier sends task completion/failure notifications |
| US15 | MCP tool 探索 | tools/list auto-discovery, legacy `list_agents` returns scripted operation catalog |
| US17 | TabManager | tab pool (max 10), acquire/release, weak affinity, CDP background tab ops |
| US20 | Source 命名 | scriptedRenameSource via exec |
| US21 | 本地快取 | CacheManager with sources.json, artifacts.json per notebook |
| US22 | 操作歷程 | OperationLogEntry recording per task |
| US23 | Notebook 標題管理 | scriptedRenameNotebook, scriptedDeleteNotebook via exec |

### DONE (newly completed)

| Story | Title | Notes |
|-------|-------|-------|
| US3 | Repo → source | Content pipeline integrated: repomix → auto-split 100K chunks → paste. 1.9M repo tested (20 chunks, 165s). |
| US4 | URL → source | Content pipeline integrated: readability → paste. Wikipedia tested. |
| US5 | PDF → source | Content pipeline integrated: pdf-parse → paste. 43-page PDF tested. |

### PARTIAL

| Story | Title | Notes |
|-------|-------|-------|
| US18 | Script Catalog / Runner Registry 邊界 | Historical story redefined. Current production path uses scripted operation catalog + specialized runners, not externalized agent configs as the main execution model. |

### NOT STARTED

| Story | Title | Notes |
|-------|-------|-------|
| US6 | Audio overview 生成 + 下載 | No script, no spike verification |
| US12 | 查詢結果輸出至檔案 | Not implemented |
| US19 | 智慧 notebook 選擇 | Not implemented |

### Architecture Change: execution architecture rebaseline

The implementation diverged from the original Agent Executor approach and now treats the following chain as the only production execution path:

`MCP tool` → `Scheduler` → `createRunTask()` dispatcher → `TaskRunner` → deterministic script → `runRecoverySession()` on failure

Current production characteristics:

- **MCP tool layer is interface-only** — validate input, resolve defaults, submit tasks, wait/poll, format result.
- **Dispatcher owns shared execution concerns** — notebook URL resolution, homepage routing, tab acquire/release, viewport, operation log, temp cleanup.
- **Runner owns task-family execution** — `pipeline`, `scanAllNotebooks`, `createNotebook`.
- **Recovery is runner-internal** — failure-only path, not a parallel public architecture.
- **Browser state is authoritative** for dynamic NotebookLM URLs after create/recovery flows.
- **Content pipeline** — repo (repomix), URL (readability), PDF (pdf-parse) → auto-split 100K chunks → paste + auto-rename.
- **Destructive ops disabled** — removeSource, deleteNotebook removed from planner-visible catalog (manual only).
- **Repair log + screenshot persistence** — `~/.nbctl/repair-logs/`, `~/.nbctl/screenshots/`
- **NetworkGate per-operation** — `acquirePermit()` before each script run.
- **Viewport 1920x1080 contract** — all scripts tested at this resolution.

### Architecture Constraints

- MCP tool handlers MUST NOT acquire/release tabs, touch `page` / `cdpSession`, build `ScriptContext`, or run DOM automation directly.
- New behavior that needs browser execution MUST enter through scheduler → dispatcher → runner; do not open ad hoc execution paths inside MCP handlers.
- `ctx injection` is a script-internal implementation detail, not a reason to expose `TabHandle` or browser objects to outer layers.
- Homepage flows (`register_all_notebooks`, `create_notebook`) MUST run on the `__homepage__` queue through specialized runners.

---

## 使用者情境與測試 *(mandatory)*

<!--
  User Story 分為八類：
  - Part A: 基礎設施 (US1-US2)：Daemon 與 Notebook 管理
  - Part B: 資料餵入 (US3-US7)：將外部內容餵入 NotebookLM
  - Part C: 輔助功能 (US8-US9)：截圖除錯、狀態持久化
  - Part D: 查詢與使用 (US10-US12)：向 NotebookLM 查詢並使用知識
  - Part E: 非同步操作與通知 (US13-US16)：非同步操作與 MCP 通知
  - Part F: 瀏覽器抽象化 (US17-US18)：TabManager、Script Catalog / Runner Registry 邊界
  - Part G: 智慧選擇 (US19)：自動選擇最相關的 notebook
  - Part H: 命名與資源管理 (US20-US24)：命名、索引、歷程紀錄

  完整工作流：啟動 → 認證 → 納管 → 餵入 → 命名 → 查詢 → 使用
  即使只完成 US1-US3 + US10 + US13，就能完成核心流程。

  架構概要（MCP Server + Scheduler/Dispatcher/Runner + Single Browser Multi-tab）：
  - Daemon 以 MCP Server 形式暴露所有功能（Streamable HTTP transport, 127.0.0.1:19224）
  - AI 工具（Claude Code 等）透過 MCP protocol 直接呼叫 tool，無需 CLI 中間層
  - Daemon 管理一個 Chrome instance（headless），透過 Tab Pool 管理 tab 資源
  - 使用者只指定 notebook（產品概念），tab 是系統內部資源，使用者不需要也不應該管理 tab
  - 操作期間每個 notebook 獨佔一個 tab（截圖/DOM 操控需要獨立 CDP session），
    操作完成後 tab 歸還 pool 可被其他 notebook 重用
  - TabManager 管理 tab pool 生命週期（acquire/release/health）
  - 認證透過 userDataDir 共享（首次 headed 登入，後續 headless 複用）
  - NetworkGate 集中式流量閘門（permit-based，不在 data path）
  - exec 時系統自動從 tab pool 取得 tab，使用者不需感知
  - 跨 notebook parallel（CDP 底層 API 支援 background tab 操作），同 notebook serial
  - Dispatcher 統一處理 URL resolve、tab acquire/release、viewport、runner dispatch
  - Runner 擁有 task-family execution；script 為 deterministic DOM primitives；Recovery 僅在 script fail 後啟用
  - Agent / Recovery 透過 CDP 底層 API 操作，可自主截圖分析/retry/關 modal（自我修復）
  - Chrome 生命週期由 daemon 管理，agent 不能啟動/關閉 Chrome
  - 透過 `exec` tool 的 `notebook` 參數指定操作目標，或 `set_default` tool 設定預設 notebook
  - 非同步操作：`exec` tool 帶 `async: true` 立即返回 taskId，完成後透過 MCP notification 通知連線中的 client
  - Daemon 獨立於 client 存活（Streamable HTTP），支援多 client 同時連線

  MCP Tools：
  - 操作指令（自然語言）：exec（prompt, notebook, async, context）
  - 管理工具：get_status, list_notebooks, register_notebook, register_all_notebooks,
    create_notebook, set_default, rename_notebook, unregister_notebook,
    cancel_task, reauth, list_agents
  - Daemon 啟動：`npx nbctl`（thin launcher）或 MCP client 設定
-->

---

## Part A: 基礎設施 Stories

### User Story 1 - Daemon 生命週期管理 (Priority: P1)

身為開發者，我希望能啟動與停止一個常駐 daemon，
讓它啟動 Chrome 瀏覽器並暴露 MCP Server（Streamable HTTP），
作為所有後續操作的基礎設施。

Daemon 自行管理 Chrome 生命週期：
- 啟動時**必須驗證 Google session**：導航至 NotebookLM，檢查最終 URL 判斷登入狀態。
  未登入時 log 明確警告，`get_status` 回傳 `googleSessionValid: false`。
- 首次啟動（無有效 Google session）時以 headed mode 啟動 Chrome，
  讓使用者手動完成 Google 認證，cookies 持久化至 `~/.nbctl/profiles/`。
- 後續啟動載入 cookies，以 headless mode 運作，使用者桌面無瀏覽器視窗。
- Session 過期時提供 `reauth` MCP tool：切換至 headed mode **並自動導航至 NotebookLM**，
  讓使用者在 Chrome 視窗中完成登入。完成後以 `headless=true` 呼叫切回。
  `reauth` 回傳 `loggedIn: true/false` 讓 MCP client 知道登入結果。

**Why this priority**: 這是所有功能的基石。沒有 daemon 運行，
任何 notebook 操作都無法執行。必須最先完成。

**Independent Test**: 啟動 daemon（`npx nbctl`），確認 daemon 啟動、
Chrome 啟動、MCP Server 可連線；以 launcher / SIGTERM 關閉並確認資源正確釋放。

**Acceptance Scenarios**:

1. **Given** 系統有有效的 Google session cookies（`~/.nbctl/profiles/`），
   **When** 使用者啟動 daemon（`npx nbctl`），
   **Then** daemon 啟動為背景程序，以 headless mode 啟動 Chrome，
   MCP Server 開始監聽 `127.0.0.1:19224`（Streamable HTTP transport），
   輸出啟動資訊 `{ "success": true, "mcp": "127.0.0.1:19224", "mode": "headless" }`。

2. **Given** 系統無有效的 Google session cookies（首次使用），
   **When** 使用者啟動 daemon（`npx nbctl`），
   **Then** daemon 以 headed mode 啟動 Chrome，顯示瀏覽器視窗，
   導航至 Google 登入頁面，輸出提示 `{ "success": true, "mcp": "127.0.0.1:19224", "mode": "headed", "hint": "Complete Google login in the browser window." }`。
   使用者完成登入後 cookies 自動持久化。

3. **Given** daemon 正在執行，
   **When** 呼叫 `get_status` tool（不帶任何參數），
   **Then** 回傳 daemon 級別狀態：
   ```json
   { "running": true,
     "googleSessionValid": true,
     "network": { "status": "healthy" },
     "tabPool": { "usedSlots": 1, "maxSlots": 10, "idleSlots": 2 },
     "activeNotebooks": ["research"], "defaultNotebook": null,
     "pendingTasks": 2, "runningTasks": 1 }
   ```
   `googleSessionValid` 反映啟動時的 Google 登入驗證結果。
   （`get_status` tool 帶 `taskId` 查詢單一任務；帶 `all: true` 列出所有近期任務。）

4. **Given** daemon 正在執行，
   **When** 使用者以 launcher / SIGTERM 終止 daemon，
   **Then** daemon 關閉所有 tab、關閉 Chrome、釋放資源、程序結束。

5. **Given** Chrome 無法啟動（如 chromium 未安裝），
   **When** 使用者啟動 daemon（`npx nbctl`），
   **Then** daemon 輸出錯誤 `{ "success": false, "error": "Cannot launch Chrome: <reason>" }`，
   程序結束，不崩潰。

6. **Given** daemon 已在執行中（port 19224 已被佔用），
   **When** 使用者再次啟動 daemon（`npx nbctl`），
   **Then** 輸出錯誤 `{ "success": false, "error": "Daemon already running on port 19224" }`，
   不啟動第二個 daemon 實例。

7. **Given** daemon 以 headless mode 運作但 Google session 已過期，
   **When** agent 偵測到認證失敗（頁面 redirect 到登入頁），
   **Then** daemon 通知使用者，相關操作回報錯誤
   `{ "success": false, "error": "Google session expired. 呼叫 reauth tool 重新認證。" }`。

8. **Given** daemon 正在執行且 Google session 已過期，
   **When** 呼叫 `reauth` tool，
   **Then** daemon 以 headed mode 重新開啟 Chrome 視窗讓使用者完成登入，
   登入成功後切回 headless mode，回傳 `{ "success": true, "message": "Re-authenticated successfully" }`。

---

### User Story 2 - Notebook 管理 (Priority: P2)

身為開發者，我希望能透過 MCP tools 管理 NotebookLM notebook，
包括納管既有 notebook、批次掃描帳號中的 notebook、建立全新的 notebook、
設定預設 notebook，以及清理本地 registry。

使用者只需指定 target notebook（alias），系統自動處理 tab 資源：
exec 時系統從 tab pool 取得 tab → 執行操作 → 完成後歸還 tab 至 pool。
使用者不需要也不應該手動管理 tab 的開啟與關閉。
跨 notebook 透過 CDP 底層 API 支援 parallel（background tab 操作可靠），
同一 notebook 內的操作 serial 執行。
使用 `exec` tool 的 `notebook` 參數指定操作目標，或用 `set_default` tool 設定預設 notebook。

指令語意：
- `register_notebook` tool（url, alias）：將使用者已知 URL 的既有 NotebookLM notebook 納入本地管理。
- `register_all_notebooks` tool：導航至 NotebookLM 首頁，自動掃描帳號中的 notebook，逐一點入取得 URL 並批次納管。
- `create_notebook` tool（title, alias?）：透過 homepage runner 建立新 notebook、必要時重新命名、完成本地註冊。
- `unregister_notebook` tool（alias）：只移除本地 registry/cache，不影響 NotebookLM 上的遠端 notebook。

**Why this priority**: 必須能管理 notebook 才能執行任何 notebook 內操作。
依賴 US1 的 daemon 已啟動。既有 notebook 的納管是使用者的第一步操作，
大多數使用者已有 NotebookLM 帳號和既有的 notebook。

**Independent Test**: register_notebook 納管一個既有 notebook，create_notebook 建立一個新 notebook，
register_all_notebooks 再批次掃描首頁補齊剩餘 notebook；之後同時對兩個 notebook 發出 exec 操作驗證 parallel 執行，
最後用 unregister_notebook 清掉其中一個本地 alias。

**Acceptance Scenarios**:

1. **Given** 使用者已註冊 notebook "research" 和 "ml-papers"，
   **When** 使用者同時呼叫：
   ```
   exec tool（prompt="加來源", notebook="research", async=true）
   exec tool（prompt="問問題", notebook="ml-papers", async=true）
   ```
   **Then** 兩個操作各自在獨立 tab 中 parallel 執行，各自獨立返回 taskId。

3. **Given** 已註冊多個 notebook，
   **When** 呼叫 `list_notebooks` tool，
   **Then** 回傳 JSON 陣列，每個 notebook 包含 description 與狀態：
   ```json
   [
     { "alias": "research", "url": "...", "title": "", "status": "ready",
       "description": "包含專案認證模組與 API 文件的開發筆記", "sourceCount": 3 },
     { "alias": "ml-papers", "url": "...", "title": "", "status": "ready",
       "description": "...", "sourceCount": 8 }
   ]
   ```

4. **Given** daemon 執行中，
   **When** 呼叫 `register_notebook` tool（url="<invalid-url>", alias="test"），
   **Then** 回傳錯誤 `{ "success": false, "error": "Invalid NotebookLM URL: must start with \"https://notebooklm.google.com/notebook/\"" }`。

6. **Given** 使用者想設定預設 notebook 避免每次都帶 `notebook` 參數，
   **When** 呼叫 `set_default` tool（alias="research"），
   **Then** 後續 `exec` tool 自動對 "research" 操作，
   回傳 `{ "success": true, "default": "research" }`。

7. **Given** 使用者知道某個既有 notebook 的 URL，
   **When** 呼叫 `register_notebook` tool（url="https://notebooklm.google.com/notebook/yyy", alias="ml-papers"），
   **Then** daemon 將該 URL 以本地 alias 納管，
   不做瀏覽器掃描與來源同步，
   回傳 `{ "success": true, "alias": "ml-papers", "url": "https://notebooklm.google.com/notebook/yyy", "title": "", "description": "" }`。

8. **Given** 使用者想批次納管所有既有 notebook，
   **When** 呼叫 `register_all_notebooks` tool，
   **Then** runner 導航至 NotebookLM 首頁，掃描 notebook 卡片，
   逐一點入取得動態 URL，跳過已註冊的 notebook，自動產生 alias 並完成納管，
   回傳摘要 `{ "success": true, "registered": 5, "skipped": 3, "notebooks": [...] }`。

10. **Given** 使用者呼叫 `exec` tool（notebook="<不存在的 notebook-id>"），
    **When** daemon 找不到該 notebook，
    **Then** 回傳錯誤 `{ "success": false, "error": "Notebook '<id>' not found. 呼叫 list_notebooks tool 查看已註冊的 notebooks。" }`。

11. **Given** 系統 tab pool 已滿（預設 max=10，所有 tab 都在使用中），
    **When** 使用者對新 notebook 發出 exec，
    **Then** task 排入等待佇列，直到有 tab 歸還 pool。系統自動消化佇列。
    使用者體驗為操作等待時間變長（sync exec 回應變慢，async exec 在 queued 狀態待更久），
    不會收到 tab 相關錯誤。使用者不需要知道 pool 的存在或狀態。

12. **Given** daemon 執行中，使用者想建立全新的 NotebookLM 筆記本，
    **When** 呼叫 `create_notebook` tool（title="My Research", alias="my-research"），
    **Then** specialized homepage runner 導航至 NotebookLM 首頁，點擊「新增筆記本」按鈕，
    等待 NotebookLM 建立新筆記本並取得動態產生的 URL，
    必要時重新命名為指定 title，
    自動將新筆記本註冊至 Notebook Registry，
    回傳 `{ "success": true, "alias": "my-research", "url": "...", "title": "My Research" }`。

13. **Given** daemon 執行中，使用者想將某份資料直接變成一本新筆記本，
    **When** 先呼叫 `create_notebook` 建立 notebook，再對其呼叫 `exec` / `addSource` 類操作，
    **Then** notebook 建立與內容匯入分別走正式 execution path，
    完成後筆記本已包含該來源且已自動命名。

14. **Given** 使用者想變更已註冊 notebook 的別名，
    **When** 呼叫 `rename_notebook` tool（oldAlias="research", newAlias="my-research"），
    **Then** Notebook Registry 更新別名，所有後續指令使用新別名，
    回傳 `{ "success": true, "oldAlias": "research", "newAlias": "my-research" }`。
    若 notebook 有進行中的操作，rename 仍可執行。

16. **Given** 使用者嘗試 rename 為已存在的別名，
    **When** 呼叫 `rename_notebook` tool（oldAlias="research", newAlias="ml-papers"）（ml-papers 已被使用），
    **Then** 回傳錯誤 `{ "success": false, "error": "Alias 'ml-papers' already in use." }`。

17. **Given** 使用者嘗試 add 一個已註冊的 URL，
    **When** 呼叫 `register_notebook` tool（url="https://notebooklm.google.com/notebook/yyy", alias="another-name"）
    且該 URL 已以 "ml-papers" 別名註冊，
    **Then** 回傳錯誤 `{ "success": false, "error": "URL already registered as 'ml-papers'" }`。

18. **Given** 使用者想將 notebook 從管理中移除（不刪除 NotebookLM 上的筆記本），
    **When** 呼叫 `unregister_notebook` tool（alias="ml-papers"），
    **Then** daemon 從 Notebook Registry 移除並清理 local cache 中的該 notebook 資料，
    不直接碰 browser state，
    回傳 `{ "success": true, "unregistered": "ml-papers" }`。
    NotebookLM 上的筆記本不受影響。

19. **Given** 使用者對 notebook "research" 呼叫 exec，
    **When** 系統處理 exec 請求，
    **Then** 系統自動執行：resolve notebook alias → acquire tab from pool → 執行操作 → release tab back to pool。
    使用者不需要也不需要知道 tab 的存在。

20. **Given** 使用者同時對 notebook "research" 和 "ml-papers" 發出 exec，
    **When** pool 有足夠 tab，
    **Then** 兩個 notebook 各自取得獨立 tab 並行執行（跨 notebook parallel）。
    同一 notebook 的多個 exec 按 per-notebook queue 串行執行（同 notebook serial）。

---

## Part B: NotebookLM 互動功能 Stories

### User Story 3 - 將專案程式碼餵入 NotebookLM 作為知識來源 (Priority: P3)

身為使用 AI coding tool 的開發者，我希望能將我的專案程式碼（git repo）
自動轉換並新增為 NotebookLM 的來源，讓我能透過 NotebookLM 詢問
關於專案的問題，得到基於原始碼的精準回答。

**Why this priority**: 這是本工具的核心價值主張——讓開發者能將 codebase
作為 grounded context 餵入 NotebookLM，解決 AI 工具的幻覺問題。

**Independent Test**: 指定一個本地 git repo 路徑，指令執行後，
該 repo 的內容應出現在 NotebookLM 的來源列表中。

**使用情境描述**:

```
開發者 Alice 正在用 Claude Code 開發一個專案。
她想讓 NotebookLM 理解她的 codebase。

她透過 MCP tool 告訴 daemon 要做什麼：
呼叫 exec tool（prompt="把 ~/code/my-project 的程式碼加入來源", notebook="myproject"）

Agent（daemon 內建的 AI agent）自動：
1. 理解使用者意圖：要將 repo 加入 NotebookLM 來源
2. 呼叫 repoToText tool 將 repo 轉換為單一文字檔
3. 在 NotebookLM UI 點擊「Add source」
4. 選擇「Copied text」
5. 將轉換後的內容貼上
6. 確認新增成功
7. 自動重命名來源為 "my-project (repo)"
8. 更新狀態快取

也可以非同步提交：
呼叫 exec tool（prompt="把 ~/code/my-project 的程式碼加入來源", notebook="myproject", async=true）
→ 立即返回 taskId，完成後透過 MCP notification 通知
```

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 已開啟且處於 ready 狀態，
   **When** 呼叫 `exec` tool（prompt="把 ~/code/my-project 的程式碼加入來源", notebook="myproject"），
   **Then** agent 呼叫 repoToText 轉換 repo，執行 UI 操作新增為 text source，
   回傳 `{ "success": true, "sourceAdded": "my-project (repo)", "wordCount": 12345 }`。

2. **Given** repo 路徑不存在或不是 git repo，
   **When** 使用者執行上述指令，
   **Then** 回傳錯誤 `{ "success": false, "error": "Path is not a valid git repository" }`。

3. **Given** repo 轉換後超過 NotebookLM 的 500K 字限制，
   **When** 使用者執行上述指令，
   **Then** 回傳錯誤 `{ "success": false, "error": "Content exceeds 500K word limit (actual: 650K). Please split manually." }`。

4. **Given** notebook "myproject" 已有來源 "my-project (repo)"（先前已新增），
   repo 有了新的 commits，使用者想更新該來源，
   **When** 呼叫 `exec` tool（prompt="更新 my-project 的來源", notebook="myproject"），
   **Then** agent 刪除舊的 "my-project (repo)" 來源，
   重新呼叫 repoToText 轉換最新內容，新增為新的 text source，
   自動重命名，local cache 記錄更新紀錄，
   回傳 `{ "success": true, "sourceUpdated": "my-project (repo)", "wordCount": 13000, "previousWordCount": 12345 }`。

5. **Given** 使用者想從 notebook 中移除某個來源，
   **When** 呼叫 `exec` tool（prompt="刪除來源 'my-project (repo)'", notebook="myproject"），
   **Then** agent 在 NotebookLM UI 中刪除該來源，
   local cache 記錄刪除操作，
   回傳 `{ "success": true, "sourceRemoved": "my-project (repo)" }`。

---

### User Story 4 - 將網頁內容餵入 NotebookLM (Priority: P4)

身為研究者，我希望能將網頁文章轉換後新增為 NotebookLM 來源，
因為有些網頁的內容 NotebookLM 無法直接透過 URL 存取（需登入、paywall、
或內容載入方式特殊）。

**Why this priority**: 補充 NotebookLM 原生 URL 功能的不足。

**Independent Test**: 指定一個 URL，內容應被擷取、轉換並新增為來源。

**使用情境描述**:

```
研究者 Bob 想把一篇需要登入才能看的技術文章加入 NotebookLM。

呼叫 exec tool（prompt="把 https://example.com/premium-article 的內容爬下來加入來源", notebook="research"）

如果是公開 URL 可以直接用 NotebookLM 原生功能：
呼叫 exec tool（prompt="加入連結來源 https://example.com/public-page", notebook="research"）
```

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟，
   **When** 呼叫 `exec` tool（prompt="把 https://example.com/article 的內容爬下來加入來源", notebook="research"），
   **Then** agent 呼叫 urlToText 擷取並轉換內容，新增為 text source，
   回傳 `{ "success": true, "sourceAdded": "example.com/article (web)", "wordCount": 3500 }`。

2. **Given** 使用者想直接使用 NotebookLM 原生 URL 功能，
   **When** 呼叫 `exec` tool（prompt="加入連結來源 https://example.com/public-page", notebook="research"），
   **Then** agent 在 UI 中選擇「Link」選項，直接貼上 URL，
   回傳 `{ "success": true, "sourceAdded": "https://example.com/public-page", "type": "url" }`。

---

### User Story 5 - 將 PDF 文件餵入 NotebookLM (Priority: P5)

身為研究者，我希望能將本地 PDF 文件轉換後新增為 NotebookLM 來源，
避免透過 Google Drive 上傳的繁瑣流程。

**Why this priority**: PDF 是學術論文的主要格式，
能直接從本地新增 PDF 大幅簡化研究者的工作流程。

**Independent Test**: 指定一個 PDF 檔案路徑，內容應被轉換並新增為來源。

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟，
   **When** 呼叫 `exec` tool（prompt="把 /path/to/paper.pdf 加入來源", notebook="research"），
   **Then** agent 呼叫 pdfToText 轉換 PDF，新增為 text source，
   回傳 `{ "success": true, "sourceAdded": "paper (PDF)", "pages": 12, "wordCount": 8500 }`。

2. **Given** PDF 檔案損壞或無法解析，
   **When** 使用者執行上述指令，
   **Then** 回傳錯誤 `{ "success": false, "error": "Failed to parse PDF: <reason>" }`。

---

### User Story 6 - 產生並下載 Podcast 風格的 Audio Overview (Priority: P6)

身為內容創作者，我希望能觸發 NotebookLM 基於我的來源產生
podcast 風格的 audio overview，並在完成後自動下載到本機。

**Why this priority**: Audio Overview 是 NotebookLM 最獨特的功能，
自動化這個流程對內容創作者價值極高，是「killer feature」。

**Independent Test**: 對有來源的 notebook 觸發 audio 產生，
等待完成後下載，驗證 audio 檔案可播放。

**使用情境描述**:

```
Podcaster David 用 NotebookLM 整理了一個主題的多個來源。

呼叫 exec tool（prompt="產生 audio overview", notebook="podcast-prep", async=true）
→ { "taskId": "xyz", "status": "queued" }

# 幾分鐘後，MCP notification 送達操作完成通知...

呼叫 exec tool（prompt="下載 audio 到 ~/podcast/episode-draft.wav", notebook="podcast-prep"）
→ { "success": true, "path": "~/podcast/episode-draft.wav", "duration": "8:32" }
```

**Acceptance Scenarios**:

1. **Given** notebook "podcast" 有至少一個來源，
   **When** 呼叫 `exec` tool（prompt="產生 audio overview", notebook="podcast"），
   **Then** agent 在 UI 中點擊產生 audio 的按鈕，
   回傳 `{ "success": true, "status": "generating", "estimatedTime": "5-10 minutes" }`。

2. **Given** audio 正在產生中，
   **When** 呼叫 `exec` tool（prompt="audio 狀態？", notebook="podcast"），
   **Then** 回傳 `{ "status": "generating" }` 或 `{ "status": "ready" }`。

3. **Given** audio 已產生完成，
   **When** 呼叫 `exec` tool（prompt="下載 audio 到 /path/output.wav", notebook="podcast"），
   **Then** agent 點擊 `<A>` 下載連結，Chrome 原生下載至 `~/.nbctl/downloads/`
   （CDP `Browser.setDownloadBehavior` 已預設），系統確認下載完成後移動至指定路徑，
   回傳 `{ "success": true, "path": "/path/output.wav", "size": "15.2MB" }`。

4. **Given** notebook 沒有任何來源，
   **When** 使用者嘗試產生 audio，
   **Then** 回傳錯誤 `{ "success": false, "error": "Notebook has no sources. Add sources before generating audio." }`。

---

### User Story 7 - 查詢 Notebook 來源狀態與管理 (Priority: P7)

身為開發者，我希望能查詢 notebook 中的所有來源清單，
了解每個來源的狀態（處理中、就緒、錯誤），
以便確認我的資料是否已正確載入。

**Why this priority**: 使用者需要能確認操作結果，
了解 notebook 的當前狀態。這是「可觀測性」的基本需求。

**Independent Test**: 新增幾個來源後，查詢狀態，驗證來源清單完整。

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 已開啟且有多個來源，
   **When** 呼叫 `exec` tool（prompt="列出所有來源", notebook="myproject"），
   **Then** agent 掃描 NotebookLM UI 中的來源面板，
   回傳包含完整的來源清單與各自狀態。

2. **Given** 使用者想知道 notebook 的整體狀態，
   **When** 呼叫 `exec` tool（prompt="目前 notebook 的狀態？", notebook="myproject"），
   **Then** 回傳包含 notebook 全貌：來源清單、audio 狀態、notebook 標題等。

---

## Part C: 輔助功能 Stories

### User Story 8 - 截圖除錯 (Priority: P8)

身為開發者，我希望能擷取目前瀏覽器畫面截圖，
用於除錯或確認 agent 操作結果。

**Why this priority**: 這是重要的除錯工具，
讓使用者能「看到」agent 看到的畫面，診斷問題。

**Independent Test**: 對某個 notebook 執行截圖指令，驗證圖片儲存成功。

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟，
   **When** 呼叫 `exec` tool（prompt="截圖", notebook="research"），
   **Then** 回傳 `{ "success": true, "screenshot": "base64...", "timestamp": "..." }`。

2. **Given** notebook "research" 已開啟，
   **When** 呼叫 `exec` tool（prompt="截圖存到 /tmp/screen.png", notebook="research"），
   **Then** 截圖儲存至指定路徑，回傳 `{ "success": true, "path": "/tmp/screen.png" }`。

---

### User Story 9 - 狀態持久化與復原 (Priority: P9)

身為開發者，我希望 daemon 能將已註冊的 notebook 清單持久化到磁碟，
重啟後能復原先前的 notebook 註冊資訊，避免重新設定。

**Why this priority**: 提升使用體驗，daemon 重啟不需重新註冊所有 notebook。

**Independent Test**: 註冊 notebook、停止 daemon、重啟 daemon，
驗證 notebook 清單恢復。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且註冊了 notebook "research"（正在執行操作），
   **When** 終止 daemon process 後再啟動 daemon（`npx nbctl`），
   **Then** `list_notebooks` tool 仍包含 "research"（status="ready"），
   使用者可直接呼叫 `exec` tool 對 "research" 執行操作，系統自動取得 tab。

2. **Given** 先前 session 有 notebook，但對應 URL 已不存在，
   **When** daemon 嘗試復原，
   **Then** 標記該 notebook 為 stale，不阻塞其他 notebook 復原。

---

## Part D: 查詢與使用 Stories

### User Story 10 - 向 Notebook 提問並取得 Grounded 回答 (Priority: P10)

身為使用 AI coding tool 的開發者，我已經將專案程式碼餵入 NotebookLM，
現在我希望能直接透過 MCP tool 向 NotebookLM 提問，取得基於我上傳來源的
grounded 回答（帶來源引用），而不需要手動切換到瀏覽器操作。

**Why this priority**: 這是完成「餵入 → 查詢 → 使用」工作流的關鍵環節。

**Independent Test**: 對已有來源的 notebook 執行查詢指令，
驗證回應包含 grounded 答案與來源引用。

**使用情境描述**:

```
開發者 Alice 已透過 exec tool 將她的專案程式碼餵入 notebook "myproject"。

呼叫 exec tool（prompt="這個專案的認證流程是怎麼運作的？", notebook="myproject"）

Agent 自動：
1. 判斷這是一個查詢（而非操作指令）
2. 在 NotebookLM UI 的對話區域輸入問題
3. 等待 Gemini 產生回答
4. 擷取回答文字與來源引用
5. 以結構化 JSON 回傳
```

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 已開啟且有至少一個來源，
   **When** 呼叫 `exec` tool（prompt="這個專案的認證流程是怎麼運作的？", notebook="myproject"），
   **Then** agent 在 NotebookLM 對話區輸入問題、等待回答、擷取結果，
   回傳包含 `answer` 欄位與 `citations` 陣列。

2. **Given** notebook 沒有任何來源，
   **When** 呼叫 `exec` tool（prompt="任何問題", notebook="empty-nb"），
   **Then** 回傳錯誤 `{ "success": false, "error": "Notebook has no sources. Add sources before asking questions." }`。

3. **Given** 使用者未指定 `notebook` 參數且無預設 notebook，
   **When** 呼叫 `exec` tool（prompt="任何問題"），
   **Then** 回傳錯誤 `{ "success": false, "error": "No target notebook. 指定 notebook 參數或呼叫 set_default tool。" }`。

4. **Given** NotebookLM 回答產生超時，
   **When** 使用者正在等待回答，
   **Then** 回傳 `{ "success": false, "error": "Response timed out", "screenshot": "base64..." }`，
   附帶當前畫面截圖供除錯。

---

### User Story 11 - 對話歷史保持與多輪對話 (Priority: P11)

身為研究者，我希望能對同一個 notebook 進行多輪連續提問，
每一輪都能參考前一輪的對話脈絡。

每個 notebook 的對話歷史保留在 NotebookLM 本身的 chat session 中；
系統只需確保後續查詢回到正確 notebook 頁面。

**Why this priority**: 單次提問的價值有限，研究者通常需要
透過多輪追問來深入理解某個主題。

**Independent Test**: 連續提問兩個相關問題，驗證第二個回答
能參考第一輪的對話脈絡。

**Acceptance Scenarios**:

1. **Given** 使用者已對 notebook "research" 提問了「這篇論文的方法論是什麼？」並收到回答，
   **When** 使用者再呼叫 `exec` tool（prompt="這個方法的局限性是什麼？", notebook="research"），
   **Then** 系統在同一個 NotebookLM 對話 session 中輸入追問，
   回答能正確參考前一輪的脈絡。

2. **Given** 使用者想開始全新的對話（不帶歷史），
   **When** 呼叫 `exec` tool（prompt="開始新對話，然後問：這篇論文的結論是什麼？", notebook="research"），
   **Then** agent 先清除 NotebookLM 的對話歷史，再輸入問題。

---

### User Story 12 - 查詢結果輸出為檔案 (Priority: P12)

身為內容創作者，我希望能將 NotebookLM 的回答直接儲存為
本機檔案（Markdown 格式），方便後續整理或發布。

**Why this priority**: 終端機輸出的 JSON 不便於閱讀與分享。

**Independent Test**: 執行查詢並指定輸出路徑，驗證檔案內容
為格式化的 Markdown。

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟且有來源，
   **When** 呼叫 `exec` tool（prompt="摘要這篇論文，結果存到 ~/notes/summary.md", notebook="research"），
   **Then** 回答以 Markdown 格式寫入指定檔案，
   同時回傳 `{ "success": true, "outputPath": "~/notes/summary.md" }`。

2. **Given** 輸出路徑的目錄不存在，
   **When** 使用者執行上述指令，
   **Then** 系統自動建立目錄並儲存檔案。

---

## Part E: 非同步操作與通知 Stories

### User Story 13 - 非同步操作提交與結果查詢 (Priority: P13)

身為使用 AI coding tool 的開發者，我希望透過 MCP tool 提交操作後能立即返回，
不需要等待操作完成，讓我的 AI 工具可以繼續做其他工作。
當操作完成時，我能透過 MCP tool 查詢結果。

**Why this priority**: 這是非同步操作模式的基礎。
沒有非同步操作支援，使用者的 AI 工具在等待 NotebookLM 操作時會完全 blocking，
無法做其他事情。

**Independent Test**: 以非同步模式提交一個操作，確認立即返回 taskId；
之後查詢該 taskId，驗證能取得操作結果。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且 notebook 已開啟，
   **When** 呼叫 `exec` tool（prompt="把 repo 加入來源", notebook="alpha", async=true），
   **Then** tool 立即回傳：
   ```json
   { "taskId": "abc123", "status": "queued", "notebook": "alpha",
     "hint": "呼叫 get_status tool（taskId='abc123'）查詢結果。" }
   ```
   不等待操作完成。

2. **Given** 操作 abc123 已完成，
   **When** 呼叫 `get_status` tool（taskId="abc123"），
   **Then** 回傳 `{ "taskId": "abc123", "status": "completed", "result": { ... } }`。

3. **Given** 操作 abc123 仍在進行中，
   **When** 呼叫 `get_status` tool（taskId="abc123"），
   **Then** 回傳 `{ "taskId": "abc123", "status": "running", "elapsed": "15s" }`。

4. **Given** 操作 abc123 失敗，
   **When** 呼叫 `get_status` tool（taskId="abc123"），
   **Then** 回傳 `{ "taskId": "abc123", "status": "failed", "error": "..." }`。

5. **Given** 使用者想查看所有背景操作，
   **When** 呼叫 `get_status` tool（all=true），
   **Then** 回傳 JSON 陣列，列出所有近期操作及其狀態。

6. **Given** 使用者不使用 `async` 參數，
   **When** 呼叫 `exec` tool（prompt="截圖", notebook="alpha"）（不帶 `async`），
   **Then** tool 等待操作完成後才回傳結果（同步行為，預設模式）。

7. **Given** 使用者同時對不同 notebook 提交非同步操作，
   **When** 使用者呼叫：
   ```
   exec tool（prompt="加來源", notebook="alpha", async=true）
   exec tool（prompt="問問題", notebook="beta", async=true）
   ```
   **Then** 兩個操作各自在獨立 tab 中 parallel 執行，各自獨立返回 taskId。

8. **Given** 操作 abc123 仍在 `queued` 狀態（agent 尚未取走），
   **When** 呼叫 `cancel_task` tool（taskId="abc123"），
   **Then** 任務從 queue 移除，狀態變為 `cancelled`，
   回傳 `{ "taskId": "abc123", "status": "cancelled", "cancelledAt": "..." }`。

9. **Given** 操作 abc123 正在 `running` 狀態（agent 執行中），
   **When** 呼叫 `cancel_task` tool（taskId="abc123"），
   **Then** 系統通知 agent 中止執行，agent 在安全點停止，
   狀態變為 `cancelled`，
   回傳 `{ "taskId": "abc123", "status": "cancelled", "cancelledAt": "...", "hint": "Agent will stop at next safe point." }`。

10. **Given** 操作 abc123 已是終態（`completed` / `failed` / `cancelled`），
    **When** 呼叫 `cancel_task` tool（taskId="abc123"），
    **Then** 回傳錯誤 `{ "success": false, "error": "Task already in terminal state: completed" }`。

---

### User Story 14 - 操作完成自動通知 (Priority: P14)

身為使用 AI coding tool 的開發者，我希望非同步操作完成後，
結果能自動推送到我的 MCP client，而不需要我主動查詢。

**Why this priority**: 僅靠 `get_status` tool 查詢是 pull-based。
MCP notification 自動推送讓體驗接近「提交即忘」，大幅提升使用流暢度。

**Independent Test**: 提交非同步操作，在操作完成後，
MCP client 自動收到完成通知。

**Acceptance Scenarios**:

1. **Given** 使用者在 MCP Client A 提交了非同步操作 abc123，
   操作已完成，
   **When** daemon 完成操作，
   **Then** daemon 透過 MCP notification 將結果推送至 Client A，
   Client A 收到完整結果：「操作已完成：來源 'my-project (repo)' 新增成功」。
   MCP 連線的自然隔離確保 Client B 不會收到此通知。

2. **Given** 非同步操作 abc123 已完成，
   **When** MCP Client 收到通知，
   **Then** AI 工具能根據通知內容自動處理操作結果。

3. **Given** 非同步操作 abc123 失敗，
   **When** daemon 完成操作，
   **Then** daemon 透過 MCP notification 推送錯誤通知（`status: "failed"`），
   AI 工具收到錯誤通知，能向使用者說明失敗原因。

4. **Given** 沒有任何待處理通知，
   **When** AI 工具正常互動時，
   **Then** 沒有額外通知推送，不影響正常操作。

5. **Given** 使用者的 MCP client 在操作完成前斷線，
   **When** 使用者重新連線後，
   **Then** 使用者可透過 `get_status` tool 查詢所有近期完成的操作。
   task store 保留結果直到 TTL 過期。

---

### User Story 15 - MCP Tool 探索 (Priority: P15)

（原 AI Skill 引導整合——已簡化。MCP tool 自描述取代 Skill Template。）

身為使用 AI coding tool 的開發者，我希望我的 AI 工具能透過 MCP protocol
自動發現所有可用的 tool 及其說明，不需要額外安裝 Skill Template。

**Why this priority**: MCP tool 透過 `tools/list` 自描述，
AI 工具連線後即可自動理解所有操作方式，零設定成本。

**Independent Test**: AI 工具連線至 MCP Server 後，
能透過 tools/list 列出所有可用 tool 及其 input schema。

**Acceptance Scenarios**:

1. **Given** AI 工具已連線至 MCP Server，
   **When** AI 工具呼叫 `tools/list`，
   **Then** 回傳所有可用 tool 的名稱、描述與 input schema，
   AI 工具能根據描述自動選擇正確的 tool 執行操作。

2. **Given** AI 工具已透過 MCP 連線，
   **When** 使用者告訴 AI「把 ~/code/my-project 加入 NotebookLM 來源」，
   **Then** AI 根據 tool 描述自動選擇 `exec` tool，
   並以正確參數呼叫。

3. **Given** 使用者想查看所有可用的 scripted operations，
   **When** 呼叫 `list_agents` tool，
   **Then** 回傳所有公開 scripted operations 的名稱、描述、參數與起始頁面。

---

### User Story 16 - （已移除：Notification Adapter 安裝）

（MCP protocol 原生支援通知推送，不需要 per-tool Notification Adapter。
MCP 連線自然隔離取代 per-session inbox routing。
所有通知功能已整合至 US14 的 MCP notification 機制。）

---

## Part F: 瀏覽器抽象化 Stories

### User Story 17 - TabManager 與底層可替換 (Priority: P17)

身為系統維護者，我希望 daemon 的瀏覽器控制層有統一的抽象介面，
讓底層自動化程式庫能被替換（如從 Puppeteer 切到 Patchright），
而不需要修改 dispatcher / runner 邏輯或 planner-visible script catalog 以外的邊界。

TabManager 是 daemon 管理 Chrome tabs 的核心，採用 **fixed-size tab pool** 設計：
- 管理單一 Chrome instance 中的 tab pool（預設 max=10）
- `acquireTab(notebookUrl)`: 有該 notebook 的 idle tab → 重用；pool 未滿 → 開新 tab；pool 滿 → 回收其他 idle tab；全佔用 → 排隊等待
- `releaseTab(tabId)`: 標記為 idle（可被回收重用），不立即關閉
- 正在執行操作（active）的 tab 不可被回收
- 為什麼需要獨立 tab：截圖/DOM 操控需要獨立 CDP session，操作期間 notebook 必須獨佔 tab
- Agent 透過 CDP 底層 API 操作 tab，可自主操作（非 bounded tools interface）
- Tab 超時未歸還 → daemon 強制回收至 pool

認證透過 userDataDir 共享：
- 首次 headed Chrome 登入 → cookies 寫入 userDataDir
- 後續 headless Chrome 直接複用同一 userDataDir

NetworkGate 集中管理流量：
- agent 操作前 acquirePermit()，異常時全域 backoff

**Why this priority**: TabManager 抽象讓底層可替換，
確保當 NotebookLM 強化 bot 偵測時能快速因應。

**Independent Test**:
(a) 同時對兩個 notebook 發出操作，驗證 parallel 執行（獨立 tab）。
(b) 在設定檔中切換底層實作，重啟 daemon 後所有操作仍正常。

**Acceptance Scenarios**:

1. **Given** daemon 使用預設實作（Puppeteer + vision-based），
   **When** 使用者執行所有標準操作（新增來源、查詢、產生 audio 等），
   **Then** 操作結果正確。

2. **Given** 系統管理者在設定檔中切換了底層實作，
   **When** daemon 重新啟動，
   **Then** daemon 使用新實作運作，runner / script 邊界不受影響。

3. **Given** 底層實作出現錯誤（例如截圖失敗），
   **When** agent 嘗試操作，
   **Then** 錯誤以統一的格式回報，不因底層差異而產生不同錯誤路徑。

4. **Given** 單一 tab 崩潰或 unresponsive，
   **When** TabManager 偵測到異常，
   **Then** 只有該 tab 受影響，其他 tab 正常運作，
   TabManager 回報健康狀態並支援重新建立 tab。

5. **Given** 新 task 需要 tab 且 pool 中有該 notebook 的 idle tab，
   **When** 系統呼叫 `acquireTab(notebookUrl)`，
   **Then** 重用既有 idle tab（不需重新 navigate），標記為 active。
   若 pool 中無該 notebook 的 tab 但 pool 未滿，開新 tab 並 navigate。
   若 pool 已滿但有 idle tab，回收最久未使用的 idle tab，開新 tab。
   操作完成後呼叫 `releaseTab(tabId)` 標記為 idle。

6. **Given** tab pool 已滿且所有 tab 都在使用中（active），
   **When** 新 task 需要 tab，
   **Then** task 進入等待佇列（producer-consumer 模式），
   直到有 tab 被 release 回 pool。系統自動消化佇列，使用者不會收到 pool 相關錯誤。

---

### User Story 18 - Script Catalog / Runner Registry 邊界 (Priority: P18)

身為系統維護者，我希望公開給 planner / MCP client 的 scripted operation catalog，
與內部 specialized runner registry 明確分離，
讓我能新增特殊執行能力而不需要在 MCP tool layer 繞過主架構。

**Why this priority**: NotebookLM 的首頁流程與 notebook 內流程不完全相同。
若沒有明確邊界，實作者很容易直接在 MCP handler 內碰 tab/page，造成架構漂移。

**Independent Test**: 新增 specialized runner 後，
MCP tool handler 仍只做 validate / submit / wait / format，
`list_agents` 只列出公開 scripted operations，不暴露 runner-internal flow。

**Acceptance Scenarios**:

1. **Given** 系統新增一個 specialized runner，
   **When** 該功能對外提供 MCP tool，
   **Then** tool handler 只 submit task，真正的 browser orchestration 仍由 dispatcher + runner 負責。

2. **Given** 使用者想查看所有可用的公開操作，
   **When** 呼叫 `list_agents` tool，
   **Then** 回傳 scripted operation catalog，而不是 runner registry 或 agent config 清單。

---

## Part G: 智慧選擇 Stories

### User Story 19 - 智慧 Notebook 選擇 (Priority: P19)

身為使用者，當我有多個 notebook 時，我希望系統能根據我的指令
自動選擇最相關的 notebook，而不需要我先手動指定。

**Why this priority**: 當使用者管理多個 notebook 時，記住哪個
notebook 包含哪些來源是一種認知負擔。

**Independent Test**: 註冊多個有不同主題來源的 notebook，
在沒有指定 notebook 的情況下提問，驗證系統選擇正確的 notebook。

**Acceptance Scenarios**:

1. **Given** daemon 管理了多個 notebook（如 "ml-papers"、"project-code"、"cooking-recipes"），
   使用者未指定 `notebook` 參數也無預設 notebook，
   **When** 呼叫 `exec` tool（prompt="這個機器學習模型的 loss function 是什麼？"），
   **Then** 系統根據各 notebook 的 description 與來源名稱比對指令內容，
   建議 "ml-papers"，並詢問使用者確認後執行查詢。

2. **Given** 使用者已有預設 notebook 但指令內容明顯與其他 notebook 更相關，
   **When** agent 判斷需要切換，
   **Then** agent 先詢問使用者確認是否切換 notebook。

---

## Part H: 命名與資源管理 Stories

### User Story 20 - 來源重命名與標記 (Priority: P20)

身為使用者，我希望透過 exec tool 新增的來源能有清楚的命名，
而不是 NotebookLM 自動產生的模糊名稱（如「Pasted text」）。
系統 MUST 在新增後自動重命名為有意義的名稱。

**Why this priority**: NotebookLM 的自動命名非常不直觀。
好的命名是所有後續資源管理的基礎。

**Independent Test**: 新增一個 repo 來源後，在 NotebookLM UI 中
確認來源名稱已被重命名為有意義的名稱。

**Acceptance Scenarios**:

1. **Given** 透過 exec tool 新增了一個 repo 來源，
   **When** 來源新增完成後，
   **Then** agent 自動在 NotebookLM UI 中將來源重命名為
   `<repo-name> (repo)` 格式。

2. **Given** 透過 exec tool 新增了一個 PDF 來源，
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<pdf-filename> (PDF)` 格式。

3. **Given** 透過 exec tool 新增了一個 URL 來源（crawl 方式），
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<domain/path> (web)` 格式。

4. **Given** 使用者想手動重命名某個來源，
   **When** 呼叫 `exec` tool（prompt="把來源 '<current-name>' 改名為 '<new-name>'", notebook="<id>"），
   **Then** agent 在 NotebookLM UI 中執行重命名操作。

---

### User Story 21 - 結構化 Local Cache（資源索引與追溯） (Priority: P21)

身為使用者，我希望系統在本機維護一份結構化的 local cache，
記錄每個 notebook 中的所有資源及它們的來歷，
讓我能一個指令調出完整的內容索引。

**Why this priority**: NotebookLM 的 UI 不提供好的資源管理，
使用者需要一個「真相來源」追溯每個資源的來歷。

**Independent Test**: 新增來源、產生 audio 後，查詢 catalog
驗證所有資源都有完整的來歷紀錄。

**Acceptance Scenarios**:

1. **Given** 使用者已透過 MCP tools 管理了多個 notebook 與來源，
   **When** 呼叫 `exec` tool（prompt="列出所有資源索引", notebook="<id>"），
   **Then** 回傳包含完整資源索引，每個來源含 origin、addedAt、重命名紀錄。

2. **Given** 使用者透過 exec tool 觸發了 audio 或文章產生，
   **When** 產生完成後，
   **Then** local cache 自動記錄該 artifact 的產生 prompt、時間與路徑。

---

### User Story 22 - Prompt 與操作歷程紀錄 (Priority: P22)

身為使用者，我希望所有透過 exec tool 對 notebook 執行的操作都有操作紀錄，
包括當時使用的 prompt 和結果摘要，方便日後追溯。

**Why this priority**: 操作歷程是長期可維護性的關鍵。

**Independent Test**: 執行幾個操作後，查看操作歷程，驗證完整。

**Acceptance Scenarios**:

1. **Given** 使用者對 notebook 執行了多個操作，
   **When** 呼叫 `exec` tool（prompt="列出操作歷史", notebook="<id>"），
   **Then** 回傳 JSON 陣列，每筆包含 timestamp、action type、指令文字、result summary。

2. **Given** 使用者想查看某個特定 artifact 的來歷，
   **When** 呼叫 `exec` tool（prompt="這個 audio 是怎麼來的？", notebook="<id>"），
   **Then** agent 查詢 local cache，回傳包含產生它的原始 prompt。

---

### User Story 23 - Notebook 標題管理 (Priority: P23)

身為使用者，我希望能透過 exec tool 重命名 notebook 的標題。

**Why this priority**: 與來源重命名同理，notebook 標題的可讀性
是資源管理體驗的一環。

**Acceptance Scenarios**:

1. **Given** notebook 的 NotebookLM 標題為自動產生的模糊名稱，
   **When** 呼叫 `exec` tool（prompt="把 notebook 標題改為 '2026 Q1 ML 論文集'", notebook="ml-papers"），
   **Then** agent 在 NotebookLM UI 中修改標題，local cache 同步更新，
   回傳 `{ "success": true, "oldTitle": "...", "newTitle": "2026 Q1 ML 論文集" }`。

---

### User Story 24 - 資源清單的人類可讀輸出 (Priority: P24)

身為使用者，我希望除了 JSON 格式外，還能以人類可讀的表格
或 Markdown 格式查看資源清單。

**Why this priority**: JSON 適合程式處理但不適合人類閱讀。

**Acceptance Scenarios**:

1. **Given** 使用者管理了多個 notebook，
   **When** 呼叫 `exec` tool（prompt="用表格列出所有 notebook 和來源", notebook="<id>"），
   **Then** 回傳格式化的表格。

2. **Given** 使用者想匯出資源清單，
   **When** 呼叫 `exec` tool（prompt="把所有資源清單匯出為 Markdown 到 ~/notes/catalog.md", notebook="<id>"），
   **Then** 輸出完整的 Markdown 格式資源清單到指定檔案。

---

### Edge Cases

**基礎設施**:
- **Chrome 無法啟動**：daemon 回報清楚錯誤訊息，不崩潰。
- **Google session 過期**：daemon 偵測認證失敗（302 redirect 到登入頁），
  通知使用者呼叫 `reauth` tool，期間操作回報認證錯誤。
- **Headless mode 截圖正確性**：headless 下 `page.screenshot()` 渲染
  MUST 與 headed 一致（viewport size、DPI），確保 vision-based agent 準確。

**TabManager**:
- **Tab 崩潰隔離**：單一 tab 崩潰不影響其他 tab 與 Chrome process。
  TabManager 偵測並回報，支援重新建立 tab。
- **Chrome crash**：Chrome 對 daemon 至關重要（所有 agent 的工作環境）。
  `browser.on('disconnected')` → 立即通知所有 agent 停止工作 →
  重啟 Chrome → agent 從 task queue 的上一個完成點接手。
- **Tab pool 容量**：tab pool MUST 有可設定上限（預設 max=10）。
  Pool 滿時回收 idle tab；全佔用時 task 排隊等 tab 歸還（producer-consumer）。
  使用者不會收到 pool/tab 相關錯誤。
- **Download 基礎設施**：TabManager 啟動時 MUST 透過 CDP `Browser.setDownloadBehavior`
  設定下載行為（`behavior: "allowAndName"`, `downloadPath: config.downloadDir`）。
  音訊下載是 `<A>` link 直接觸發瀏覽器下載（Spike Phase D 發現），
  不需要自訂 download interception——只需確保 Chrome 下載目錄指向可控路徑。
  預設下載目錄為 `~/.nbctl/downloads/`。
- **同 notebook 多個操作**：per-notebook queue 序列化。
- **跨 notebook 操作**：parallel 執行（CDP 底層 API 支援 background tab），互不干擾。

**非同步與通知**:
- **MCP 通知推送失敗**：若 client 已斷線，通知無法推送。
  結果保留在 task store，client 重新連線後可透過 `get_status` tool 查詢。
  不做 notification 補發機制（fire-and-forget）——MCP 對 client 而言
  只是可重試的資料來源，非 mission-critical 即時通道。
- **Task store TTL**：已完成任務的結果保留 24 小時，過期後自動清理。
- **MCP 連線隔離**：每個 MCP client 連線自然隔離，
  不存在跨 client 搶讀通知的問題。
- **Client 連線失敗**：MCP client 無法連線至 daemon 時，回報清楚錯誤訊息。
- **Daemon 關閉（無論正常或異常）**：不做 agent-level graceful shutdown。
  Vision agent 單步操作可能耗時數分鐘，等待 agent 完成不切實際。
  關閉策略：直接終止 process，task queue 負責恢復。
  重啟後 `queued` 恢復為 `queued`，`running` 標記為 `failed`
  （reason: "daemon interrupted"）。Agent task 設計為細粒度、
  每步進度外部化，因此最多重做一個小步驟。
- **使用者主動取消 `running` 任務**：agent 在安全點停止（不保證立即中止），
  視覺操作可能已部分完成，不自動回滾。
- **通知無優先級**：所有通知 fire-and-forget，client 透過 `status` 欄位區分成功/失敗。

**瀏覽器抽象**:
- **底層實作切換後**：daemon 重建 TabManager，
  Notebook Registry 不受影響，後續 task 會在新 tab / runner execution path 上運作。
- **公開 script catalog / runner registry 邊界錯誤**：必須在 code review 與測試階段攔下，
  不允許以 MCP tool handler 直接補 browser orchestration 的方式繞過主架構。

**內容與互動**:
- **NotebookLM UI 更新**：vision-based agent 應能適應 UI 變化，
  若關鍵元素無法辨識，回報錯誤而非崩潰。
- **超大內容超過 500K 字限制**：所有 text source（repo、URL、PDF）皆適用 NotebookLM 的 500K 字限制。
  超過時回報錯誤建議使用者手動分割。具體限制值需實測確認，以實測結果為準。
- **無效 notebook URL**：驗證 URL 格式，拒絕非 NotebookLM 網域。
- **網路斷線中途**：agent 操作應有 timeout，失敗時回報當前狀態截圖。
- **NotebookLM 回答含圖片或表格**：純文字擷取，圖片以佔位符替代，
  表格轉為 Markdown。
- **極長回答**：分段擷取，確保完整性。
- **NotebookLM 拒絕回答**：回傳拒絕訊息，不偽造回答。
- **回答不完整**：agent 等待回答完全產生後才擷取。
- **來源重命名失敗**：local cache 仍記錄原始與預期名稱，標記 rename_pending。
- **add-all 超過 50 個 notebook**：分頁處理。
- **local cache 與 NotebookLM 不一致**：使用者可透過 exec 要求重新同步。
- **同一來源重複新增**：local cache 偵測重複，警告但不阻止。
- **agent 無法理解指令**：回報解析失敗並附上支援的操作範例。
- **無 MCP client 時**：可透過 `npx nbctl` 啟動 daemon，以任何 MCP client 連線操作。

**網路與 Rate Limiting**:
- **NotebookLM rate limiting**：Agent 自主偵測 429（透過 CDP 或視覺分析，
  不規範偵測方式），透過 `reportRateLimit` tool 回報 NetworkGate。
  NetworkGate 收到後觸發全域 backoff，期間 acquirePermit() 等待。
- **Bot 偵測（CAPTCHA）**：NetworkGate 偵測後暫停 permit 發放，
  通知使用者可能需要呼叫 `reauth` tool 或手動介入。
- **網路斷線**：NetworkGate 暫停所有 permit 發放，恢復後自動恢復。
- **`register_all_notebooks` 批次操作 throttling**：NetworkGate 在批次操作間
  自動插入 backoff interval，避免觸發 rate limit。

---

## 需求 *(mandatory)*

### Functional Requirements

**MCP Server & Daemon**:
- **FR-001**: 系統 MUST 以 MCP Server 形式暴露所有功能，提供以下 MCP tools：
  `exec`、`get_status`、`list_notebooks`、`register_notebook`、`register_all_notebooks`、
  `create_notebook`、`set_default`、`rename_notebook`、`unregister_notebook`、
  `cancel_task`、`reauth`、`list_agents`。
- **FR-002**: 系統 MUST 提供 `exec` MCP tool（prompt, notebook, async, context），
  將自然語言指令送入該 notebook 的正式 execution pipeline。
  未指定 `notebook` 時使用預設 notebook（由 `set_default` tool 設定）。
- **FR-003**: 系統 MUST 將 daemon 作為背景程序執行，暴露 MCP Server（Streamable HTTP transport）
  於 127.0.0.1:19224（僅 localhost binding，不加額外認證）。若 port 已被佔用，MUST 回報錯誤。
- **FR-004**: Daemon MUST 透過 TabManager 管理單一 Chrome instance 中的 tab pool（預設 max=10）。
  TabManager 提供 `acquireTab(notebookUrl)` 取得 tab 和 `releaseTab(tabId)` 歸還 tab。
  每個操作期間 notebook 獨佔一個 tab（CDP session）。
- **FR-005**: 所有 MCP tool 回應 MUST 為 JSON 格式內容，錯誤訊息亦為 JSON。
- **FR-006**: 系統 MUST 支援 `set_default` MCP tool 設定預設 notebook，
  後續 `exec` tool 不帶 `notebook` 參數時自動使用此 notebook。

**Agent 能力**:
- **FR-007**: Agent MUST 能透過 vision model 理解 NotebookLM UI 狀態。
- **FR-008**: Agent MUST 擁有獨立的 tab（CDP session），透過 CDP 底層 API
  （Input.dispatchMouseEvent, Page.captureScreenshot, Input.dispatchKeyEvent 等）
  及 browser tools 自主操作，具備截圖分析、retry、關 modal 等自我修復能力。
  Browser tools 完整清單（Spike 1 驗證，9 個）：
  - **Core 5**（CDP helpers）：screenshot, click, type, scroll, paste
  - **DOM query 2**（page.evaluate）：find（元素定位 + 座標）, read（CSS selector 文字擷取）
  - **Navigation 2**：navigate（URL 跳轉）, wait（等待 + 截圖）
  - downloadFile（Phase 9 US6 實作，暫不含——音訊下載走 `<A>` link + CDP download behavior，非自訂 tool）
  Tool factory 接收 `TabHandle`（已含 cdpSession + page），直接複製 spike 驗證過的 tool 實作。
  **已知限制（Spike Finding #43）**：CDP `Input.dispatchKeyEvent` 的 Ctrl+A（全選）
  在 Angular Material dialog 中失效（事件被 Angular zone 攔截）。
  修正方式：cdp-helpers 的 selectAll 操作 MUST 改用 JS `document.activeElement.select()`
  取代 CDP key event，確保在所有 UI context 下可靠工作。
  Spike playground 保持獨立（不 import src/），後續 repair 機制再處理 single source of truth。
- **FR-009**: Agent MUST 提供 content tools：
  - repoToText：將 git repo 轉換為單一文字
  - urlToText：將網頁轉換為 Markdown
  - pdfToText：將 PDF 轉換為 Markdown
- **FR-009.1**（Spike Finding #51, file-based paste）: Content tools 的轉換結果 MUST 走 temp file
  pass-through，不進 LLM context。repoToText handler 寫 temp file（`~/.nbctl/tmp/`），
  返回 `{ filePath, charCount, wordCount }` → paste tool 接受 `filePath` 參數，handler 讀檔貼入。
  **Tool boundary = context boundary**：LLM 根本拿不到文字內容（0 token 消耗），
  這是架構層面的保證，不是 prompt-level instruction。
  urlToText / pdfToText 同理。NotebookLM 無前端字數限制（Spike 驗證 500K / 83ms）。
- **FR-010**: Agent MUST 能解讀自然語言指令，判斷使用者意圖，並自主呼叫對應 tools。

**NotebookLM 互動**:
- **FR-011**: 系統 MUST 支援透過「Copied text」方式新增文字來源。
  paste tool MUST 支援 `filePath` 參數——有 filePath 時讀檔貼入，
  text 不經 LLM context（FR-009.1 file-based pass-through）。
- **FR-012**: 系統 MUST 支援透過「Link」方式新增 URL 來源。
- **FR-013**: 系統 MUST 支援觸發 Audio Overview 產生。
- **FR-014**: 系統 MUST 支援下載已產生的 Audio Overview 到本機檔案。
- **FR-015**: 系統 MUST 能擷取 notebook 當前來源清單與狀態。

**來源更新與移除**:
- **FR-060**: Agent MUST 能根據使用者指令更新已存在的來源
  （刪除舊來源 → 重新轉換 → 新增為新來源 → 重命名）。
  Local cache MUST 記錄更新紀錄（含前後 wordCount）。
- **FR-061**: Agent MUST 能根據使用者指令在 NotebookLM UI 中刪除指定來源。
  Local cache MUST 記錄刪除操作。

**查詢功能**:
- **FR-016**: Agent MUST 能在 NotebookLM UI 的對話區域輸入問題、
  等待回答產生完成、擷取回答文字與來源引用。
- **FR-017**: 查詢回答結果 MUST 包含結構化的 `answer` 與 `citations` 欄位。
- **FR-018**: 系統 MUST 支援多輪對話，在同一個 NotebookLM 對話 session 中保持脈絡。
- **FR-019**: Agent MUST 能根據使用者指令清除對話歷史並開始新對話。

**查詢輸出**:
- **FR-020**: Agent MUST 能將回答以 Markdown 格式寫入使用者指定的檔案路徑。
- **FR-021**: Markdown 輸出 MUST 包含問題標題、回答內容、來源引用區段。

**狀態管理**:
- **FR-022**: 系統 MUST 在每次操作後更新 notebook 狀態快取（post-op sync）。
- **FR-023**: 系統 MUST 將已註冊 notebook 清單持久化至磁碟，支援重啟後復原。
- **FR-024**: 系統 MUST 在無法啟動 Chrome 或連線中斷時提供清楚錯誤訊息，不崩潰。
- **FR-025**: `exec` tool 對非 `ready`/`operating` 狀態的 notebook MUST 依狀態區分處理：
  - `stale`（URL 無效）：直接回報錯誤 `{ "success": false, "error": "Notebook '<alias>' is stale (URL invalid). 呼叫 unregister_notebook 移除或重新確認 URL。" }`，不嘗試連線。
  - `error`（連線錯誤）：嘗試重新開 tab 連線一次，成功則繼續執行，失敗則回報錯誤。
  - 其他非預期狀態：嘗試恢復至 `ready` 後繼續執行。

**智慧選擇**:
- **FR-028**: Agent MUST 能在使用者未指定 notebook 時，根據指令內容
  與各 notebook 的 description 及來源元資料，建議最相關的 notebook。
- **FR-029**: 智慧選擇 MUST 預設詢問使用者確認後再切換 notebook。

**操作排隊與觀測**:
- **FR-030**: 每個 notebook MUST 有獨立的 operation queue。
  同一 notebook 內的操作 MUST 序列化執行（serial），
  不同 notebook 的操作 MUST 可 parallel 執行（獨立 tab，CDP 底層 API 支援 background tab）。
  Tab pool 滿且全佔用時，task 排隊等 tab 空出，系統自動消化（producer-consumer）。
  不向使用者暴露 pool 滿錯誤——sync exec 等待時間變長，async exec 在 queued 狀態待更久。
  純讀取記憶體狀態的 tool（`list_notebooks`、`get_status`）MUST 即時回應，不進入佇列。
- **FR-031**: 每個操作 MUST 有 timeout 機制避免無窮等待，
  超時回傳錯誤與截圖。具體 timeout 數值依操作類型於實測後決定。
  Sync exec 使用 per-task wait（waitForTask），只等自己的 task 完成，不是 global waitForIdle。

**既有 Notebook 納管**:
- **FR-032**: 系統 MUST 提供 `register_notebook` MCP tool（url, alias），
  將既有 NotebookLM notebook 納入管理。
- **FR-033**: `register_notebook` tool MUST 只做本地 registry 納管：
  驗證 URL / alias、檢查 alias 與 URL 唯一性、寫入 Notebook Registry。
  它 MUST NOT 導航至 notebook URL、掃描來源清單，或同步 browser 狀態到 local cache。
- **FR-034**: 系統 MUST 提供 `register_all_notebooks` MCP tool，
  透過 specialized homepage runner 批次納管使用者帳號中的所有 notebook。
- **FR-035**: `register_all_notebooks` MUST 走 scheduler → dispatcher → `scanAllNotebooks` runner，
  導航至 NotebookLM 首頁、掃描 notebook 卡片、逐一點入取得 URL、跳過已註冊項目，
  並回傳批次摘要。它不是互動式 preview/confirm workflow。
- **FR-035A**: `register_all_notebooks` 的 MCP tool handler MUST 是 thin submitter，
  不可直接 acquire tab、碰 `page` / `cdpSession`、建立 `ScriptContext`，或執行 DOM automation。

**建立新筆記本**:
- **FR-036**: 系統 MUST 提供 `create_notebook` MCP tool（title, alias?），
  用於建立新的 NotebookLM notebook 並完成本地註冊。
- **FR-037**: `create_notebook` MUST 走 scheduler → dispatcher → `createNotebook` runner，
  在 `__homepage__` queue 上執行。MCP tool handler MUST 只負責 validate / submit / wait / format。
- **FR-038**: `createNotebook` runner MUST 建立 `ScriptContext`、執行 homepage create script、
  必要時進行 rename、失敗時進入 Recovery，並以 browser state 作為最終 notebook URL 的權威來源。
- **FR-039**: 若 NotebookLM 遠端 notebook 已建立，但 rename 或本地註冊失敗，
  runner MUST 回傳失敗，並明確告知 remote notebook 可能已存在；不得誤報成功。

**來源重命名**:
- **FR-040**: 系統 MUST 在透過「Copied text」方式新增來源後，
  自動將來源重命名為有意義的名稱。
- **FR-041**: 來源重命名規則：repo → `<repo-name> (repo)`；
  PDF → `<filename> (PDF)`；URL crawl → `<domain/path> (web)`。
- **FR-042**: Agent MUST 能根據使用者自然語言指令，
  在 NotebookLM UI 中執行來源或 notebook 標題重命名。

**結構化 Local Cache**:
- **FR-043**: 系統 MUST 維護本機結構化 cache，記錄每個 notebook 的
  所有來源與 artifacts 的完整元資料。
- **FR-044**: Local cache 中的每個來源 MUST 記錄 origin 資訊
  （type、原始路徑/URL、新增時間）。
- **FR-045**: Local cache 中的每個 artifact MUST 記錄產生它的原始 prompt 與時間。

**操作歷程**:
- **FR-046**: 系統 MUST 記錄所有透過 exec tool 執行的操作歷程。
- **FR-047**: Agent MUST 能根據使用者指令查詢並回傳操作歷程。

**同步**:
- **FR-048**: Agent MUST 能根據使用者指令，重新從 NotebookLM UI
  同步 notebook 狀態到 local cache。

**Notebook Description 自動維護**:
- **FR-049**: 系統 MUST 在 register_notebook 後，由 agent 根據 notebook
  的來源清單自動產生 1-2 句 description。
- **FR-050**: 每次來源異動後，系統 MUST 自動更新 description。
- **FR-051**: Agent MUST 能根據使用者 exec 指令手動覆寫 description。

**檔案權限**:
- **FR-051A**: Daemon MUST 在建立 `~/.nbctl/` 及所有子目錄時設定權限為 `700`，
  所有檔案設定為 `600`（同 `~/.ssh/` 慣例）。
- **FR-051B**: Daemon 啟動時 MUST 驗證 `~/.nbctl/` 權限，若權限過於寬鬆則
  輸出警告日誌並自動修正為正確權限。

**認證**:
- **FR-052**: Daemon MUST 自行管理 Chrome 的 Google 認證。
  Cookies 持久化至 `~/.nbctl/profiles/`，支援跨 session 重用。
- **FR-053**: 系統 MUST 支援首次啟動以 headed mode 完成 Google 登入，
  後續以 headless mode 運作。
- **FR-054**: 若 agent 在操作過程中遇到未登入狀態，MUST 回報錯誤
  並提示使用者呼叫 `reauth` tool。

**結構化日誌**:
- **FR-055**: Daemon MUST 對每個 agent 操作步驟記錄結構化日誌
  （進入/退出時間、tool 呼叫、截圖事件、錯誤），
  確保能事後診斷卡住或異常的操作。
  每條日誌 MUST 帶 correlation fields：`taskId`、`notebookAlias`、`actionType`，
  確保可從工單（OperationLogEntry）追蹤到完整的 agent 執行細節。
  日誌格式 MUST 為 JSON，MUST 區分 log levels（info/warn/error）。

**Notebook 別名與唯一性**:
- **FR-056**: Notebook alias MUST 在 Notebook Registry 中全域唯一。
  `register_notebook` tool 時若 alias 已存在，MUST 回報錯誤。
- **FR-057**: 同一 NotebookLM URL MUST 只能註冊一次。
  `register_notebook` tool 時若 URL 已註冊，MUST 回報警告並顯示既有 alias：
  `{ "success": false, "error": "URL already registered as '<alias>'" }`。
- **FR-058**: 系統 MUST 提供 `rename_notebook` MCP tool（oldAlias, newAlias），
  允許使用者變更已註冊 notebook 的別名。新 alias MUST 同樣全域唯一。
  若 notebook 有進行中的操作，rename 仍可執行（alias 為邏輯標籤）。
- **FR-059**: 系統 MUST 提供 `unregister_notebook` MCP tool（alias），
  將 notebook 從 Notebook Registry 移除並清理 local cache。
  它 MUST NOT 變更遠端 NotebookLM notebook，也 MUST NOT 直接操作 browser state。

**非同步操作** (FR-100 series):
- **FR-100**: 系統 MUST 支援 `exec` MCP tool 帶 `async: true` 參數模式，
  立即返回 `{ "taskId": "<id>", "status": "queued", "notebook": "<notebook-id>", "hint": "..." }`。
- **FR-101**: `get_status` MCP tool MUST 依據參數區分查詢模式：
  - 無參數：回報 daemon 級別狀態（running、browser、network health、task 摘要）。
  - `taskId`：查詢特定非同步操作的狀態與結果。
  - `all: true`：列出所有近期操作（預設最近 20 筆），MUST 支援 `notebook` 參數篩選。
  - `recent: true`：列出近期已完成但未被通知推送的操作（client 斷線 fallback）。
  - 參數衝突時優先級：`all` > `recent` > `taskId` > 無參數。
    設計原則：fail-open，衝突時回傳更多資料（浪費 token 可接受，漏資訊不行）。
- **FR-103**: `exec` tool 不帶 `async` 參數時 MUST 維持同步行為。
- **FR-104**: `exec` tool 帶 `async: true` 時 SHOULD 支援 `context` 參數，
  附帶操作情境描述，出現在完成通知中。
- **FR-105**: `exec` tool 帶 `async: true` 的返回 MUST 包含 `hint` 欄位，
  作為防遺忘的第一層提醒。

**Async Task 生命週期** (FR-106 series):
- **FR-106**: Async Task MUST 遵循以下狀態機，每個狀態兼具內部工程語意與外部顯示標籤：
  ```
  queued ──→ running ──→ completed
    │           │
    ↓           ↓
  cancelled   failed
              cancelled
  ```
  - `queued`：任務在 daemon 的 operation queue 中等待，session agent 尚未取走。
  - `running`：session agent 已取走任務並開始執行，結果尚未產出。
  - `completed`：執行完成，結果已回到 answer queue，可供查詢與通知。
  - `cancelled`：使用者主動取消（`cancel_task` tool）。
    `queued` 狀態可直接移除；`running` 狀態需通知 agent 中止執行。
  - `failed`：執行過程中發生非預期錯誤（agent 異常、Chrome 崩潰、超時等），
    需要 debug。MUST 附帶錯誤訊息與截圖（若可取得）。
- **FR-107**: 系統 MUST 提供 `cancel_task` MCP tool（taskId），
  允許使用者從外部取消 `queued` 或 `running` 狀態的任務。
  - `queued` → `cancelled`：從 queue 移除，立即生效。
  - `running` → `cancelled`：通知 agent 中止當前操作，
    agent SHOULD 在安全點停止（不保證立即中止）。
  - `completed` / `failed` / `cancelled`：回報錯誤「Task already in terminal state」。
- **FR-108**: Daemon 非正常關閉時（crash、SIGKILL），
  重啟後 MUST 將先前 `queued` 狀態的任務恢復為 `queued`，
  `running` 狀態的任務標記為 `failed`（reason: "daemon interrupted"）。
- **FR-109**: 所有狀態轉換 MUST 記錄 timestamp，
  `get_status` tool 回應中 MUST 包含完整的狀態歷程。

**MCP 通知** (FR-110 series):
- **FR-110**: Daemon MUST 在非同步操作完成後，透過 MCP notification 將結果推送至連線中的 client。
- **FR-111**: MCP 連線的自然隔離確保通知只送達提交操作的 client（per-connection routing）。
- **FR-112**: 每個通知 payload MUST 包含 taskId、status、result、notebook、originalContext、timestamp。
- **FR-113**: Task store MUST 自動清理超過 24 小時的已完成任務。
  未被查詢的結果不自動清除直到 TTL 過期。
- **FR-114**: （已移除——MCP notification 不需要原子檔案寫入。）
- **FR-115**: （已移除——MCP notification 不需要 consume rename pattern。）

**（FR-120 series：已移除——Notification Adapter）**
（MCP protocol 原生通知取代 per-tool Notification Adapter。
不需要 install-hooks / uninstall-hooks / hook 腳本。）

**（FR-130 series：已移除——AI Skill Template）**
（MCP tool 自描述（tools/list）取代 AI Skill Template。
不需要 export-skill 指令。）

**TabManager** (FR-140 series):
- **FR-140**: 系統 MUST 實作 TabManager，以 fixed-size tab pool 管理單一 Chrome instance 中的 tab 資源。
  負責：tab pool acquire/release、idle tab 回收、超時強制回收、健康檢查。
  Pool 容量可設定（預設 max=10）。
- **FR-141**: TabManager MUST 提供 `acquireTab(notebookUrl)` → 從 pool 取得 tab（重用 idle 或開新），
  回傳 tab handle（CDP session）。
  `releaseTab(tabId)` → 標記 tab 為 idle，歸還 pool（不立即關閉）。
- **FR-142**: TabManager 底層自動化程式庫 MUST 可替換。
  預設為 Puppeteer + CDP 底層 API（vision-based）。
- **FR-143**: 底層實作 MUST 可透過設定檔指定。
- **FR-144**: 所有底層實作 MUST 使用統一的錯誤格式回報，
  包含錯誤類型（連線失敗、tab 崩潰、操作逾時、認證過期）
  與建議動作（重試、重建 tab、截圖、重新認證）。

**認證管理** (FR-145 series):
- **FR-145**: _(alias of FR-048)_ 系統 MUST 透過 userDataDir 管理 Google 認證。
  首次登入以 headed Chrome（同一 userDataDir）完成認證，
  cookies 與 session 自動持久化至 `~/.nbctl/profiles/`。
- **FR-146**: 後續 headless Chrome 啟動時 MUST 使用同一 userDataDir，
  自動繼承已登入的 Google session，無需 cookie injection。
- **FR-147**: 系統 MUST 偵測 session 過期（302 redirect to login），
  通知使用者呼叫 `reauth` tool 重新認證。
- **FR-148**: `reauth` tool 只負責恢復 Google session，不自動重試先前因認證失敗的操作。
  使用者 MUST 自行重新提交先前失敗的操作。設計原則：不做過度設計，避免「哪些 task 該重試」的複雜度。

**Scripted operation catalog** (FR-150 series):
- **FR-150**: 系統 MUST 維護 planner-visible scripted operation catalog，
  描述每個可公開操作的名稱、描述、參數與起始頁面。
- **FR-151**: runner-internal scripts MAY 存在，但 MUST NOT 自動暴露到 planner-visible catalog。
- **FR-152**: 系統 MUST 提供 `list_agents` MCP tool 作為 legacy 名稱，
  實際回傳 scripted operation catalog，而非 agent config registry。
- **FR-153**: Specialized runner 的 existence MUST 由 `RUNNER_REGISTRY` 定義；
  它們不是 `list_agents` 對外暴露的 catalog 項目。

**OS 通知（輔助）**:
- **FR-160**: 系統 SHOULD 在非同步操作完成時發送 OS 通知（macOS notification）。
- **FR-161**: OS 通知 MUST 可透過設定檔開關，預設開啟。

**Multi-tab Daemon** (FR-170 series):
- **FR-170**: _(alias of FR-004)_ Daemon MUST 管理單一 Chrome instance，透過 TabManager 為每個
  執行中的 task 分配獨立的 tab（CDP session）。
- **FR-171**: _(alias of FR-030)_ 每個 notebook MUST 有獨立的 operation queue。
  同 notebook serial，跨 notebook parallel（CDP 底層 API 支援 background tab 操作）。
- **FR-172**: 每個 notebook 操作 MUST 由 dispatcher 自動從 tab pool 取得獨立 tab，
  再交由對應 runner / pipeline 執行。
  執行層透過 CDP 底層 API 操作，可自主操作與自我修復。
  操作完成後 tab 歸還 pool。
- **FR-173**: 同時活躍的 tab 數量 MUST 有可設定上限（預設 10）。
- **FR-174**: 單一 tab 崩潰不影響其他 tab 與 Chrome process，支援重新建立。
- **FR-175**: _(已移除——`open_notebook`/`close_notebook` YAGNI，tab 由系統自動管理)_
- **FR-176**: Canonical notebook context（alias、URL、description）MUST 顯式注入 Planner 和 Executor 的 systemMessage，
  確保 agent 明確知道操作的 target notebook identity。
- **FR-177**: Sync exec MUST 使用 per-task wait（waitForTask），只等待自己的 task 完成，
  不是 global waitForIdle（等全部 queue idle）。
- **FR-178**: Tab 是操作的執行單位——截圖/DOM 操控需要獨立 CDP session，
  因此操作期間 notebook 獨佔一個 tab。完成後 tab 歸還 pool 可被其他 notebook 重用。
  這是操作期間的獨佔，不是永久 1:1 綁定。
- **FR-179**: Executor 啟動前，系統 MUST 用 `tab.url` exact match 做 O(1) 錨點判斷，
  根據 AgentConfig 的 `startPage` 欄位決定目標頁面（homepage 或 notebook URL），
  必要時先 navigate 到正確頁面。判斷結果作為 **hint** 注入 Executor prompt
  （如「系統檢查：目前 tab URL 符合筆記本 research」），不是 assertion。
  Agent 保留完整自主權：可信任 hint 直接執行，也可自行觀測（screenshot/find/read）確認頁面狀態。

**Planner Input Gate** (FR-185 series):
- **FR-185**: Planner Session MUST 提供 `rejectInput` tool（與 `submitPlan` 並列），
  當使用者請求不屬於 NotebookLM 操作範圍時，Planner 呼叫 `rejectInput` 回傳拒絕理由，
  不進入 Executor 階段。
- **FR-186**: `rejectInput` tool MUST 接受 `category`（拒絕類別）和 `reason`（理由描述）兩個參數。
  拒絕類別共 6 種：`off_topic`（非 NotebookLM 相關）、`harmful`（有害/違規請求）、
  `ambiguous`（無法判斷意圖）、`unsupported`（NotebookLM 不支援的操作）、
  `missing_context`（缺少必要資訊如 notebook 名稱）、`system`（系統限制）。
- **FR-187**: Planner 被拒絕的請求 MUST 在 SessionResult 中標記 `rejected: true`，
  包含 category + reason，讓 exec tool 回傳結構化的拒絕訊息給 MCP client。
- **FR-188**: Planner Input Gate 是安全邊界——所有使用者 NL 輸入 MUST 先經過 Planner 分類，
  只有通過的請求才會觸發 Executor 帶 browser tools 執行。

**NetworkGate** (FR-190 series):
- **FR-190**: 系統 MUST 實作 NetworkGate，作為集中式流量閘門。
  不在 data path（不 proxy 請求），只管「能不能做」。
  Agent 操作前 MUST `acquirePermit(notebookId)` 取得許可。
- **FR-191**: NetworkGate MUST 偵測 rate limiting 與 throttling 信號
  （HTTP 429/503、異常延遲、CAPTCHA / bot 偵測頁面），
  偵測後 `reportAnomaly()` 觸發全域 backoff，所有 agent 暫停操作。
- **FR-192**: 偵測到 throttling 時 MUST 套用 exponential backoff（初始 5s，
  上限 5 min），backoff 期間 `acquirePermit()` 等待直到 backoff 結束。
- **FR-195**: `acquirePermit()` 本身異常（NetworkGate 內部錯誤）時 MUST fail-open——
  操作繼續執行，不因 gate 故障阻塞 agent。記錄警告日誌。
- **FR-193**: NetworkGate MUST 監控網路斷線與恢復，
  斷線時暫停所有操作並通知使用者，恢復後自動恢復 permit 發放。
- **FR-194**: NetworkGate MUST 透過 `getHealth()` 和 `get_status` tool 回報
  當前網路健康狀態（`healthy` / `throttled` / `disconnected`），
  包含 backoff 剩餘時間（若適用）。

**Headless / Headed 雙模式** (FR-180 series):
- **FR-180**: Daemon MUST 支援 headless 與 headed 兩種 Chrome 啟動模式。
- **FR-181**: _(alias of FR-049)_ 首次啟動且無有效 session 時，MUST 自動 headed mode 讓使用者登入，
  session 持久化至 `~/.nbctl/profiles/`（userDataDir）。
- **FR-182**: 後續啟動 MUST headless mode，使用者桌面無瀏覽器視窗。
- **FR-183**: 系統 MUST 偵測 session 過期，提供 `reauth` MCP tool 重新認證。
- **FR-184**: Headless 截圖渲染 MUST 與 headed 一致。

**Agent Runtime Health（Circuit Breaker）** (FR-210 series):
- **FR-210**: Scheduler MUST 對每次 `runTask` 設定外層 timeout（上限值可設定），
  超時後放棄等待並標記 task 為 failed。timeout 後 MUST 呼叫 `session.disconnect()`
  嘗試釋放 zombie session 資源。
- **FR-211**: Scheduler MUST 追蹤連續 timeout 次數。當連續 timeout 達到閾值（預設 3 次）時，
  系統進入 `degraded` 狀態，拒絕接受新的 exec 請求，
  回傳明確訊息：「Agent runtime 連續 timeout，請呼叫 restart tool 或重啟 daemon」。
- **FR-212**: `get_status` MCP tool MUST 在 `degraded` 狀態時回報
  `agentHealth: "degraded"` + 連續 timeout 次數 + 最後一次 timeout 時間，
  確保使用者/AI 工具能感知系統健康狀態。
- **FR-213**: 系統 MUST 提供從 `degraded` 狀態恢復的機制：
  重啟 CopilotClient（kill CLI process + 重啟）清除所有 zombie session，
  重置連續 timeout 計數，恢復接受新任務。
  恢復可透過 `reauth` tool 或新增的 `restart_agent` tool 觸發。

**MCP Server** (FR-200 series):
- **FR-200**: MCP Server MUST 使用 Streamable HTTP transport，監聽 127.0.0.1:19224。
- **FR-201**: MCP Server MUST 將所有管理操作暴露為 MCP tools，
  每個 tool MUST 有 Zod-validated input schema。
- **FR-202**: MCP Server MUST 支援多個同時連線的 client。
- **FR-203**: Daemon MUST 提供 thin launcher（`npx nbctl`）啟動 MCP server process，
  亦可透過 MCP client 設定（如 Claude Code MCP config）直接啟動。
- **FR-204**: _(alias of FR-110)_ MCP Server MUST 在非同步操作完成時，透過 MCP notification 通知連線中的 client。
- **FR-205**: 若 client 在操作完成前斷線，結果 MUST 保留在 task store，
  client 重新連線後可透過 `get_status` tool 查詢。

### Key Entities

- **Daemon**：常駐背景程序，管理所有已註冊 notebook，暴露 MCP Server（Streamable HTTP），
  維護狀態快取。管理單一 Chrome instance，透過 TabManager 管理多個 tab。
  PID file（`~/.nbctl/daemon.pid`）格式為 `{ pid, startedAt }`，
  啟動時雙重檢查（process 存在 AND 啟動時間吻合）防止 PID 重用誤判。
  Shutdown 策略：不做 agent-level graceful shutdown，直接終止。
  恢復靠 task queue（細粒度任務 + 每步進度外部化），不靠 cleanup handler。

- **TabManager**：以 fixed-size tab pool 管理單一 Chrome instance 中的 tab 資源（預設 max=10）。
  負責 tab pool acquire/release、idle tab 回收、超時強制回收、健康檢查。
  底層實作可替換（預設 Puppeteer + CDP 底層 API）。
  系統透過 `acquireTab(notebookUrl)` 取得獨立 tab（CDP session），`releaseTab(tabId)` 歸還 pool。
  Tab 是系統內部資源，使用者不需要也不應該管理。

- **NetworkGate**：集中式流量閘門（不在 data path，只管「能不能做」）。
  Agent 操作前 MUST `acquirePermit()`。偵測 429/timeout 觸發全域 backoff。
  提供 `getHealth()` 回報 healthy/throttled/disconnected。

- **Notebook Registry**：所有已註冊 notebook 的元資料清單
  （alias、URL、標題、description、狀態、來源清單摘要），持久化於磁碟。
  Alias 全域唯一，URL 全域唯一（不可重複註冊），alias 可透過 `rename_notebook` tool 變更。
  `description` 由 agent 自動產生，每次來源異動後更新。使用者可覆寫。

- **Dispatcher**：`createRunTask()` 為共享 execution 層。
  負責 runner lookup、resolve notebook URL、homepage routing、tab acquire/release、viewport 設定、
  runner dispatch、operation log 與 temp cleanup。MCP tool handler 不得重做這些責任。

- **Runner**：task-family 的正式執行單位。
  目前 production runner 包含 `pipeline`、`scanAllNotebooks`、`createNotebook`。
  Runner 可以建立 `ScriptContext`、呼叫 deterministic script、在失敗時啟動 Recovery，
  並在成功後進行結構化 writeback（例如 notebook registry 更新）。

- **Pipeline / Recovery Session**：預設 notebook 內操作走 Planner → Script → Recovery-on-fail。
  Happy path 以 deterministic script 為主；Recovery 僅在 script fail 時啟動。
  Recovery 透過 Copilot SDK session 與 browser tools 補完失敗操作，並產出 repair log / screenshot。

- **Script Catalog**：planner-visible 的公開 scripted operation 清單。
  由 `src/scripts/index.ts` 維護，描述 operation、description、params、startPage。
  `list_agents` 是 legacy tool 名稱，但實際回傳的是這份 scripted operation catalog。

- **Runner-internal scripts**：可被 runner 直接 import 的內部腳本。
  它們不一定暴露到 planner-visible catalog，也不應直接由 MCP tool handler 呼叫。

- **MCP Tool**：MCP Server 暴露的工具定義。每個 tool 透過 `tools/list` 自描述，
  包含名稱、描述與 Zod-validated input schema。AI client 連線後即可自動探索。

- **Task Completion Notification**：透過 MCP protocol 推送的非同步操作完成通知。
  MCP 連線自然隔離，確保通知只送達正確的 client。
  Client 斷線時結果保留在 task store，可透過 `get_status` tool 查詢。

- **Async Task**：非同步操作的追蹤紀錄。
  包含 taskId、status、notebook、內容摘要、時間、結果。
  狀態機：`queued`（等待 agent 取走）→ `running`（agent 執行中）→
  `completed`（成功）| `failed`（異常，需 debug）| `cancelled`（使用者取消）。
  所有狀態轉換記錄 timestamp。
  **Task 設計原則**：任務切為細粒度步驟，每步完成後進度外部化至 task store。
  Agent 在概念上是 stateless per run — 每個 run 完成後，
  任何無記憶的 agent 都能從 task store 接手。Session 內部有 state（對話記憶），
  但架構不依賴 session persistence。Daemon 負責全局狀態與調度，
  agent 只負責執行單一細粒度任務。

- **State Store**：記憶體中的狀態快取 + 磁碟持久化。

- **Content Pipeline**：將外部內容（repo、URL、PDF）轉換為
  NotebookLM 可接受的文字格式的工具集。

- **QueryResult**：查詢結果，包含 answer、citations、後設資料。

- **Citation**：來源引用，包含 source name、引用段落摘要。

- **Local Cache**：結構化的本機資料庫，記錄所有受管理 notebook 的
  來源元資料、artifacts、操作歷程與命名對照。

- **Source Origin**：來源的溯源紀錄（type、原始路徑/URL、新增時間、重命名紀錄）。

- **Artifact**：NotebookLM 產生的衍生資源（audio、note 等），
  包含產生 prompt、時間、路徑。

- **Operation Log**：操作歷程紀錄。

- **Operation Queue**：per-notebook 的 exec 請求等待佇列。
  同 notebook serial，跨 notebook parallel（獨立 tab，CDP 底層 API 支援 background tab）。
  Tab pool 滿且全佔用時，task 排隊等 tab 歸還（producer-consumer），系統自動消化。

---

## Clarifications

### Session 2026-02-07

- Q: 當 daemon 已在執行中，使用者再啟動 daemon 時應如何處理？ → A: 回報錯誤，不啟動第二個實例。
- Q: 序列化執行的範圍？ → A: 每個 notebook 有獨立的 operation queue，同 notebook serial，跨 notebook parallel（獨立 tab，CDP 底層 API 支援 background tab）。純讀取狀態的 tool 即時回應，不進佇列。
- Q: MCP Server 是否需要認證？ → A: MVP 只靠 localhost binding，不加 token。Port 衝突時回報錯誤。
- Q: 執行單位的生命週期？ → A: Per-task runner。每個 task 透過 scheduler 進入 dispatcher，由 dispatcher acquire/release tab；runner 負責該 task family 的執行與 recovery。不是 per-notebook persistent agent session。
- Q: Notebook Registry 的 description 欄位？ → A: Agent 自動摘要 + 使用者可覆寫。
- Q: Google 帳號認證？ → A: Daemon 自行管理 Chrome。首次以 headed mode 登入，cookies 持久化至 `~/.nbctl/profiles/`，後續 headless 運作。Session 過期提供 `reauth` tool。
- Q: `exec` tool 的 timeout？ → A: 不硬編碼。各操作合理 timeout 實測後決定。Spec 只要求有 timeout 機制 + 充分日誌。
- Q: `list_notebooks` tool 輸出是否含 description？ → A: 是。

### Session 2026-02-12

- Q: `open_notebook` 與 `register_notebook` 的語意區分？ → A: _(已過時——`open_notebook`/`close_notebook` 已砍掉。)_ `register_notebook` tool（url, alias）只負責納管既有 notebook（使用者已知 URL）；建立全新 notebook 由 `create_notebook` tool 處理。Tab 由系統自動管理，使用者不需手動管理。
- Q: 如何處理 NotebookLM rate limiting / throttling？ → A: NetworkGate 集中式流量閘門（FR-190 series）。Agent 操作前 acquirePermit()，異常時 reportAnomaly() 觸發全域 backoff。不在 data path，只管「能不能做」。TabManager 管理 tab，NetworkGate 管理流量許可。
- Q: `~/.nbctl/` 的檔案權限模型？ → A: 目錄 `700`、檔案 `600`（同 `~/.ssh/` 慣例）。Daemon 建立時設定，啟動時驗證並自動修正。新增 FR-051A/FR-051B。
- Q: Async Task 生命週期狀態機？ → A: `queued`（daemon queue 中等待 agent 取走）→ `running`（agent 執行中）→ `completed`（結果回到 answer queue）| `failed`（非預期異常，需 debug）| `cancelled`（使用者主動取消 `cancel_task` tool）。新增 `cancel_task` tool（FR-107）。Daemon crash 後 `queued` 恢復、`running` 標記 `failed`。所有狀態轉換記錄 timestamp。
- Q: Notebook alias 的唯一性約束？ → A: Alias 全域唯一 + URL 全域唯一（不可重複註冊）。新增 `rename_notebook` tool（FR-058）允許變更別名。重複 URL 時警告並顯示既有 alias。

### Session 2026-02-12 (架構重構)

- Q: 為什麼 v3 不用 MCP？ → A: 當時 MCP tool call 在主流 AI CLI 中是 blocking 的，server-push 未被 client 實作。v3 選擇 CLI + Skill + Hook。
- Q: 為什麼 v6 改回 MCP？ → A: 重新評估後發現：(1) CLI 是 thin HTTP client wrapper，18 個 command 檔案 + Fastify routes + Skill Template 都是膠水層；(2) 主要消費者是 AI agent（Claude Code），MCP 是 AI 工具的原生協議；(3) MCP tool 自描述取代 Skill Template；(4) MCP 持續連線讓非同步通知可直接推送，簡化 Notification 系統（移除 Inbox/Hook/Adapter）；(5) Daemon 核心不變，只是介面層替換。Transport 選擇 Streamable HTTP（daemon 獨立存活 + 多 client 連線）。
- Q: 多 notebook 並行怎麼做？ → A: 單一 Chrome instance，TabManager 管理多 tab（預設上限 10）。dispatcher 依 notebook alias / homepage queue acquire 獨立 tab，透過 CDP 底層 API 操作 background tab，天然 parallel。認證透過 userDataDir 共享。
- Q: 10 本 notebook 會開 10 個 tab 嗎？ → A: 可以，tab 上限預設 10。Tab 比 Chrome instance 輕量很多。操作完畢可關閉 tab 釋放資源。
- Q: 誰負責操控瀏覽器？ → A: 正式 ownership 在 dispatcher + runner + script/recovery。MCP tool handlers 不得直接碰 tab/page。CDP 底層 API 仍是執行基礎。
- Q: 抽象層在哪裡？ → A: TabManager 管理 tab lifecycle，NetworkGate 管理流量，dispatcher 管理共享 execution concerns，runner 管理 task-family execution。認證透過 userDataDir 自然共享，不需額外模組。
- Q: 為什麼從 BrowserPool 改回 multi-tab？ → A: 實驗驗證（Spike 0, 2026-02-23）：background tab 操作不可靠是 Puppeteer page.click() 高層 API 的問題，非 Chrome/CDP 限制。CDP Input.dispatchMouseEvent + Page.captureScreenshot 在 background tab 完全可靠（5 tabs 並行 15/15 成功）。Multi-tab 省記憶體（~500MB vs ~900MB）、認證簡化（userDataDir 共享 vs cookie injection）、程序管理簡化。
- Q: 瀏覽器必須可見嗎？ → A: 不必。Headless 截圖仍可正常渲染。首次登入需 headed。
- Q: 多 MCP client 通知如何 routing？ → A: MCP 連線自然隔離。每個 client 連線獨立，通知只送達提交操作的連線。Client 斷線後結果保留在 task store，重新連線可透過 `get_status` tool 查詢。
- Q: 防遺忘機制？ → A: 多層：(1) exec tool hint 欄位；(2) MCP notification 自動推送；(3) tools/list 自描述讓 AI 工具理解工作流。

### Session 2026-02-23 (MCP Server pivot)

- Q: 為什麼從 CLI + HTTP API 改為 MCP Server？ → A: (1) CLI 模組（Commander.js 18 個 command 檔案）+ Fastify HTTP routes 都是膠水層，主要消費者是 AI agent，MCP 是 AI 工具原生協議，直接砍掉中間層；(2) MCP tool 自描述（tools/list），不需 Skill Template 教 AI 工具如何使用；(3) MCP 持續連線支援 server-push notification，簡化整個 Notification 系統（移除 Inbox 檔案、Hook 腳本、per-tool Adapter）；(4) Daemon 核心（TabManager、Agent、State、NetworkGate）完全不變，只是介面層替換。
- Q: Transport 為什麼選 Streamable HTTP？ → A: Daemon 需要獨立於 client 存活（client 斷線後操作繼續），且需支援多 client 同時連線。Streamable HTTP 滿足這兩個需求，stdio transport 不行。
- Q: 移除了哪些 User Stories？ → A: US15（AI Skill Template）簡化為 MCP tool 探索；US16（Notification Adapter）完全移除，MCP notification 取代。
- Q: 移除了哪些 FR？ → A: FR-120~127（Notification Adapter 全系列）、FR-130~133（AI Skill Template 全系列）、FR-114/FR-115（Inbox 原子寫入/consume rename）。
- Q: 新增了哪些 FR？ → A: FR-200~205（MCP Server 系列）。
- Q: Daemon 如何啟動？ → A: `npx nbctl` thin launcher 啟動 daemon process，或透過 MCP client 設定（如 Claude Code MCP config）直接啟動。不再需要完整 CLI 框架。

### Session 2026-03-13 (Spike 1: Browser Capability)

- Q: 5 個 browser tool 夠嗎？ → A: 不夠。Spike 驗證需要 9 個：原有 5 個（screenshot, click, type, scroll, paste）+ find（DOM query 取精確座標）、read（CSS selector 文字擷取）、navigate（URL 跳轉）、wait（延遲 + 截圖）。find 和 read 走 `page.evaluate()`，不需要新增 CDP helper。
- Q: Tool factory 為什麼維持 TabHandle？ → A: TabHandle 已含 `cdpSession` + `page`，不需要額外抽介面。直接複製 spike 驗證過的 tool code 進 src/，在 handler 內取 `tabHandle.page` 和 `tabHandle.cdpSession`。Spike playground 保持獨立（不 import src/），後續 repair 機制再處理 single source of truth。
- Q: Execution agent 用什麼模型？ → A: GPT-4.1（GitHub Copilot 免費模型）。Spike 驗證：24 tool calls / 60.7s 完成完整 flow（建立筆記本 → 加來源 → 提問 → 讀回答），支援平行 tool calling，比預設模型快 36%。非推理模型足夠，因為 execution 是機械的 find → click → paste → read 循環。智慧在 task planning，不在 tool execution。
- Q: createSession() 為什麼要指定 model？ → A: 不指定時 createSession() 花 5.6s（模型協商），指定後降至 0.5s（11x 加速）。Production MUST 明確指定。
- Q: NotebookLM UI 有哪些陷阱？ → A: (1) 來源展開遮蔽「新增來源」按鈕 → 收合恢復。(2) 兩個「提交」按鈕 → 需用位置或容器消歧。(3) 回答需等 10-15s → wait 後 read，若含 "Refining..." 重試。這些規則 MUST 寫入 script / recovery knowledge，而不是散落在 MCP handler。
- Q: Spike playground 的定位？ → A: 獨立的驗證操作台，不 import src/。保有自己的 tool 實作副本，用於 (1) 新 tool 的快速驗證 (2) NotebookLM UI 變動的定期偵測。Production tool 從 spike 複製進 src/ 並適配 TabHandle。後續 repair 機制再統一。
- Q: NOTEBOOKLM_KNOWLEDGE 放哪裡？ → A: 目前 production 由 UIMap + script / recovery execution path 吸收，這段 CustomAgent prompt 討論屬於歷史 spike note，不是現行主架構。
- Q: 為什麼用 Two-Session（Planner+Executor）而不是 spike 的扁平模式？ → A: 這是歷史 spike 討論。現行 production 路徑已收斂為 Planner → deterministic Script → Recovery-on-fail，並以 specialized runner 處理首頁型流程。
- Q: i18n 怎麼處理？ → A: MVP 內建 3 locale（zh-TW, en, zh-CN）。UI map config（`src/config/ui-maps/*.json`）存放 locale-specific 元素文字和 CSS selectors。Daemon 啟動時偵測 Chrome locale → 載入對應 UI map → 注入 KNOWLEDGE template。Post-MVP 支援 `tools repair` 自動 discover 新 locale。

### Session 2026-03-10 (SHIP B/R/N 解除)

- Q: execution session 需要 persist across daemon restart 嗎？ → A: 不需要。Task 設計為細粒度 + 每步進度外部化，session persistence 不必要。類比 message queue consumer：consumer 是 stateless 的，state 在 queue 裡。Daemon 管全局狀態，執行層只負責單一步驟。
- Q: Vision input（截圖）怎麼傳給 agent？ → A: Tool 自包截圖 + 格式轉換。Screenshot tool 自行透過 CDP 截圖、轉換格式、回傳給 Copilot CLI agent。Daemon 不中轉。Copilot SDK 的 tool return spec 接受什麼 image 格式是語法層問題（Spike 1 確認）。
- Q: Daemon 收到 SIGTERM 時 agent 在操作中怎麼辦？ → A: 不做 agent-level graceful shutdown。Vision agent 單步可能耗時 5 分鐘，等不起。Graceful shutdown 本身不可靠（SIGKILL/OOM 繞過 handler）。直接終止，task queue 負責恢復。
- Q: Atomic write 怎麼保證 crash 安全？ → A: temp file + rename。rename 在 APFS/ext4 上是 atomic（單一 metadata pointer 更新），writeFile 不是（多次 data block 寫入可中斷）。
- Q: Stale PID file 怎麼處理？ → A: PID file 存 `{ pid, startedAt }`，驗證時雙重檢查（process 存在 AND 啟動時間吻合），防止 PID 被 OS 重用給其他 process 的誤判。
- Q: Chrome crash 怎麼處理？ → A: Chrome 對 daemon 至關重要。`browser.on('disconnected')` → 通知所有 agent 停止 → 重啟 Chrome → agent 從 task queue 接手。
- Q: Agent 怎麼偵測 429？ → A: 不規範偵測方式（CDP 或視覺分析都可），agent 自主決定。Daemon 提供 `reportRateLimit` tool 讓 agent 回報，NetworkGate 負責 backoff 決策。
- Q: MCP notification 斷線後怎麼補？ → A: 不補。Fire-and-forget。MCP 對 client 而言是可重試的資料來源，非 mission-critical 即時通道。Client 再 query 一次就好。

### Review Point 1.5 (2026-03-14): Notebook-First + Tab Pool 架構

Code review（Phase 3→5.5）發現 Notebook（產品概念）vs Tab（內部資源）的邊界未畫清楚。以下為決策記錄：

- Q: Notebook 和 Tab 的關係？ → A: **Notebook = 產品概念，Tab = 內部資源**。使用者只指定 target notebook（alias），系統負責 tab。Tab 是操作的執行單位——截圖/DOM 操控需要獨立 CDP session，所以操作期間 notebook 獨佔一個 tab（runtime 仍是 1:1）。但這是操作期間的獨佔，不是永久綁定——完成後歸還 pool 供其他 notebook 使用。
- Q: `open_notebook` / `close_notebook` 還需要嗎？ → A: **砍掉**。YAGNI — debug 用途透過 code/test 處理即可，不需要暴露 MCP tool。使用者不需要手動管理 tab。
- Q: Tab pool 滿了怎麼辦？ → A: **純 producer-consumer**。使用者不需要知道 pool 滿不滿。Task 排隊等 tab 空出，系統自動消化。不回 pool full error 給使用者。Sync exec 就是等久一點，async exec 就是 queued 久一點。
- Q: Sync exec 怎麼等？ → A: **Per-task wait（waitForTask）**，只等自己的 task 完成。不是 global waitForIdle（等全部 queue idle），那會讓一個 sync exec 被其他 notebook 的操作卡住。
- Q: 執行層怎麼知道操作哪本 notebook？ → A: dispatcher 解析 canonical notebook context（alias、URL、description），runner 再帶著這些結構化資訊執行。不要靠 MCP handler 直接注入 tab/page。
- Q: 同 notebook 多個操作、跨 notebook 操作？ → A: 同 notebook 串行（per-notebook queue），不同 notebook 並行（各自獨立 tab）。與先前設計一致，但現在 tab 來自 pool 而非永久綁定。
- Q: 執行層怎麼知道自己在哪個頁面？ → A: dispatcher 先做 URL / homepage 錨點判斷，必要時先 navigate；runner 再根據該 task family 的 start page 執行。這個判斷屬於 execution layer，不屬於 MCP handler。

---

## 成功指標 *(mandatory)*

### Measurable Outcomes

**效能指標**:
- **SC-001**: Daemon 啟動至 ready 狀態在 10 秒內完成（含 Chrome 啟動，不含首次登入）。
- **SC-002**: `list_notebooks`、`get_status` 等管理 tool 在 100ms 內回應。
- **SC-003**: 開啟新 tab + navigate 在 5 秒內完成。
- **SC-004**: Agent 簡單操作（如截圖、查詢來源清單）在 15 秒內完成。
- **SC-005**: Agent 多步驟操作（如新增來源含重命名）在 60 秒內完成。

**可靠性指標**:
- **SC-006**: 來源新增操作成功率 > 90%（agent 自我修正後）。
- **SC-007**: Audio 下載操作成功率 > 95%。
- **SC-008**: Content 轉換（repo/URL/PDF → text）成功率 > 95%。

**容量指標**:
- **SC-009**: 支援註冊至少 20 個 notebook，同時活躍至多 10 個 tab。
- **SC-010**: Daemon 記憶體使用量 < 500MB（不含 Chrome）。

**查詢效能指標**:
- **SC-011**: 單次查詢在 30 秒內完成。
- **SC-012**: 多輪對話追問速度與首次一致（差異 < 20%）。

**查詢可靠性指標**:
- **SC-013**: 查詢操作成功率 > 90%。
- **SC-014**: 來源引用擷取準確率 > 85%。

**使用者價值指標**:
- **SC-015**: 5 分鐘內完成「啟動 → 登入 → 註冊 notebook → 新增來源」流程。
- **SC-016**: 透過 MCP `tools/list` 自動探索所有可用操作。
- **SC-017**: 餵入資料後 1 分鐘內完成首次查詢。
- **SC-019**: 完成「餵入 → 查詢 → 使用」完整工作流，不需離開 AI 工具。

**命名與資源管理指標**:
- **SC-020**: 透過 exec tool 新增的來源，100% 自動重命名。
- **SC-021**: 3 秒內取得 notebook 資源索引。
- **SC-022**: 每個 artifact 追溯率 100%。
- **SC-023**: 管理 10+ notebook 仍能快速找到目標資源。
- **SC-024**: `register_all_notebooks` 單個 notebook 30 秒內完成。

**非同步操作效率**:
- **SC-100**: 非同步 `exec` tool（async=true）在 500ms 內返回 taskId。
- **SC-101**: `get_status` tool 查詢在 200ms 內回應。
- **SC-102**: MCP notification 推送延遲不超過 1 秒（操作完成到通知送達）。

**通知可靠性**:
- **SC-103**: 連線中 client 100% 收到 MCP notification。
- **SC-104**: 斷線 client 重新連線後可 100% 透過 `get_status` tool 查詢結果。
- **SC-105**: （已移除——無 Hook 腳本。）

**跨工具相容性**:
- **SC-106**: （已移除——無 Skill Template。MCP tool 自描述。）
- **SC-107**: 任何支援 MCP protocol 的 AI 工具皆可連線使用。

**TabManager 穩定性**:
- **SC-108**: 切換底層實作後，所有操作成功率不低於原實作。
- **SC-109**: 統一錯誤格式，agent 正確處理所有錯誤類型。

**使用者上手效率**:
- **SC-110**: （已移除——無 adapter 安裝。MCP client 設定即可連線。）
- **SC-111**: （已移除——無 Skill Template。MCP tool 自描述，零設定成本。）

**Script Catalog / Runner 邊界**:
- **SC-112**: 新增 specialized runner 後，不需在 MCP tool handler 增加平行 execution path。

**Multi-tab 並行**:
- **SC-113**: N 個 notebook（N ≤ tab max）操作互不阻塞。
- **SC-114**: 單一 tab 崩潰後 5 秒內偵測，其他 tab 不受影響。

**Headless 模式**:
- **SC-115**: Headless vision-based agent 成功率與 headed 無顯著差異（< 5%）。
- **SC-116**: 首次登入後，後續 daemon 重啟自動 headless。

**NetworkGate**:
- **SC-117**: Throttling 偵測後 3 秒內 acquirePermit() 開始等待（全域 backoff）。
- **SC-118**: 網路斷線偵測後 5 秒內暫停 permit 發放，恢復後自動恢復。
- **SC-119**: `get_status` tool 回報網路健康狀態延遲 < 200ms。
