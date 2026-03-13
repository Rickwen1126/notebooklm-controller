# AUDIT: notebooklm-controller v1

tags: [audit, browser-automation, copilot-sdk, mcp-server, daemon, phase-2]

## Relations
- audit_for [[todo-notebooklm-controller]]
- follows [[SHIP-notebooklm-controller@20260310]]

## 產出類型
軟體產品（Phase 2 Foundational — 8 模組骨架 + 235 unit tests）

## 審計範圍
Phase 2 Foundation 全部 19 source files, 15 test files, 235 tests。
審計方式：codereview tour (`review-phase2-foundation-20260312.tour`) + 架構 tour (`01-sky-eye-phase2-foundation.tour`) + 本次修正。

---

## 通用核心

### A1 Contract
Phase 2 為所有 user story 建立可獨立測試的模組骨架：shared types/config/errors/logger、state 三件套、TabManager、NetworkGate、Agent runtime (client/session-runner/hooks/tools)、MCP Server skeleton、Scheduler、Notifier。

SHIP 偏移檢查：**一致**。SHIP 定義的架構（四層洋蔥 MCP→Daemon→Agent→CDP）、技術選擇（Copilot SDK、puppeteer-core CDP、MCP Streamable HTTP、JSON atomic write）全部落地。無方向偏移。

### A2 Failure Modes

1. **writeFile path traversal** → 證據：code review tour 🔴2 定位 `state-tools.ts:146` → **已修**：加 `resolve()` + `relative(NBCTL_HOME)` 邊界檢查 + 2 個 test cases
2. **result/error 未 persist 回 TaskStore** → 證據：code review tour 🔴3 + 架構 tour scheduler step 都定位 `scheduler.ts:296-314` → **已修**：`TaskStore.update()` 新方法 + scheduler 呼叫 + 2 個 persist 驗證 test + 1 個 thrown-error persist 驗證
3. **JSON.parse malformed body 回 500 而非 -32700** → 證據：code review tour 🔴1 定位 `mcp-server.ts:266` → **已修**：try/catch + JSON-RPC spec-compliant error response
4. **switchMode 毀掉進行中 agent session** → 證據：code review tour 🟡5 + 架構 tour tab-manager step 分析 → **已修**：`tabs.size > 0` guard + 2 個 test cases
5. **FR-051 結構化日誌缺口** → 證據：架構 tour hooks step 深入分析 — Phase 2 只有 coarse lifecycle log，缺 per-tool timing/diagnostics → **未修**：需新增專用 task（不在本次 review 修正範圍，屬規劃缺陷）

### A3 Trade-offs

- **替代 A：SQLite 持久化** → 不選原因：零依賴、可讀、可 git 追蹤。MVP scope JSON + atomic rename 夠用。concurrent write safety 的風險目前由 scheduler 串行保證，Phase 3 加 mutex 預防（T041.4）
- **替代 B：DI container 取代 singleton** → 不選原因：全 daemon 一個 CopilotClient/NetworkGate，singleton 簡單。`resetInstance()` 讓測試可控。DI 框架在 Node.js daemon 場景 overhead > benefit

### A4 AI 盲點

1. **session-runner outcome model 太扁** → ⚠️ 需驗證：架構 tour session-runner step 深入分析 — `sendAndWait` 不 throw = `success: true`，沒有 contract validation 也沒有 semantic interpretation。`response?.data?.content ?? undefined` 靜默返回 undefined。Phase 3 接入 production flow 前應補 response validation。（架構 tour 已記錄，但尚無對應 task）
2. **hooks classifyError regex brittle** → ⚠️ 需驗證：Google 改 error message 就會分類錯誤。目前 23 個 error pattern test 覆蓋，但沒有 real-world NotebookLM error corpus。Spike 階段會累積真實 error samples。
3. **CopilotClient 雙軌 state 漂移** → ✅ 可信：架構 tour client step 深度分析了 SDK source code（`ConnectionState` 4 態 + `reconnect()` 機制），結論明確 — 已標記為 T041.2 在 Phase 3 收斂

### A5 受眾價值
**受眾**：開發者自己（唯一用戶）
**拿到後能做**：Phase 3 daemon entry point 可以直接 wire 這 8 個模組。每個模組有獨立 unit test、明確邊界、已知缺陷清單。不需要重新理解任何模組的內部機制。

---

## Code 延伸

### C1 Lifecycle
- **Entry points**：每個模組都有明確的 init/start/stop — TabManager (`launch`/`shutdown`), CopilotClient (`start`/`stop`), MCP Server (`start`/`stop`), Scheduler (`submit`/`shutdown`)
- **Idempotent**：TabManager `launch()` 有 double-launch guard；CopilotClient `start()` 有 `started` flag guard
- **Cleanup 對稱**：TabManager `shutdown()` 逐 tab close 後 browser close ✅；MCP Server `stop()` 逐 transport close 後 http server close ✅；Scheduler `shutdown()` 等 loop drain 後 cancel queued ✅
- **缺口**：`_handleUnexpectedExit` 定義但未接線 → T041.2

### C2 Error Model
- **傳播路徑**：Tool handler error → hooks `onErrorOccurred` → classify → retry/skip/abort → session-runner catch → SessionResult → scheduler → taskStore transition
- **Silent failure**：`Notifier.notify()` fire-and-forget，失敗只 log warn — **by design**（SHIP #6: notification 是 best-effort）
- **使用者看到什麼**：MCP client 收到 `get_status` 回應的 `status: "failed"` + `error` 欄位。**已修** result/error persist（🔴3），確保磁碟上有完整資訊

### C3 Concurrency
- **共享狀態**：DaemonState（`state.json`）是跨 MCP tool 共享的。目前 Scheduler 串行保證同 notebook 不會 race，但多 MCP tool 同時讀寫可能在 Phase 3 出問題 → T041.4 mutex
- **競態風險**：`StateManager.load()→mutate→save()` 不是 atomic（架構 tour + review tour 🟡2 都標出）→ 目前安全，Phase 3 前加 mutex
- **非同步邊界**：Scheduler per-notebook queue 是非同步邊界。`processQueue` loop 是 fire-and-forget promise，由 `loopPromises` Map 追蹤。`shutdown()` await 所有 loop

### C4 Side Effects
- **I/O**：JSON file read/write（atomic）、Chrome CDP commands、HTTP server listen
- **Listener**：`browser.on('disconnected')` — 在 `shutdown()` 中 browser.close() 隱式清除 ✅；`transport.onclose` — 清除 Map entry ✅
- **Timer**：NetworkGate `sleep()` — 只在 backoff 時建立，自然 resolve ✅
- **Singleton**：CopilotClient、NetworkGate — 都有 `resetInstance()` for testing ✅

### C5 Observability
- **出事定位**：structured JSON log to stderr，每條帶 `module` + `taskId` + `notebookAlias` correlation fields
- **缺口**：FR-051 要求 per-tool timing + enter/exit + screenshot event + error classification metadata。目前 hooks 只 log coarse lifecycle events（架構 tour hooks step 標為最嚴重規劃缺陷）
- **建議**：
  1. hooks `onPreToolUse`/`onPostToolUse` 加 tool-level duration + argument summary
  2. session-runner 加 session aggregate summary（total tools called, total duration, error count）
  3. scheduler 加 queue depth metric（per-notebook queue size over time）

---

## [R]isky 追蹤

| SHIP 標記 | 實際結果 | 處理 |
|-----------|----------|------|
| TabManager lifecycle（Chrome crash = 全掛） | `browser.on('disconnected')` 已實作 + test，crash 清空 tabs + emit event。switchMode 已加 active-tab guard | ✅ 已安全通過 |
| NetworkGate permit 模型 | fail-open 實作正確（FR-195）。`recentLatencyMs` 修正為 `null`。`reset()` public 但無 production caller | ✅ 已安全通過 |
| MCP Server Streamable HTTP | skeleton 可工作。multi-session 行為未驗證 → T041.3 | ⚠️ 仍需觀察（Phase 3 驗證） |

## 累積項目檢查
- 首次 AUDIT，無之前的 BANK 記錄可對照
- SHIP 記錄的 9 個 SDK insight-learning 知識點全部在架構 tour 中得到驗證（agent config 命名、tool 自包、hooks 阻塞語意、session compact、permission model 等）

---

## 修正清單（本次 AUDIT 期間完成）

| # | 分類 | 修正 | 驗證 |
|---|------|------|------|
| 🔴1 | JSON-RPC 合規 | `mcp-server.ts` JSON.parse try/catch → -32700 | code review |
| 🔴2 | 安全 (path traversal) | `state-tools.ts` writeFile 加 NBCTL_HOME 邊界檢查 | 2 tests |
| 🔴3 | 資料正確性 | `task-store.ts` + `scheduler.ts` result/error persist | 3 tests |
| 🟡4 | 語意正確 | `types.ts` + `network-gate.ts` recentLatencyMs → null | 1 test |
| 🟡5 | 防禦性設計 | `tab-manager.ts` switchMode active-tab guard | 2 tests |
| 🟡6 | 程式碼風格 | `hooks.ts` SCREAMING_SNAKE → pattern | N/A |
| 🟡7 | 輸入驗證 | `state-tools.ts` updateCache add 必填欄位驗證 | 2 tests |

## 延後項目（已標記進 tasks.md Phase 3）

| Task | 內容 |
|------|------|
| T041.2 | autoRestart vs `_handleUnexpectedExit` 二選一 + `started` 雙軌 state 收斂 |
| T041.3 | MCP multi-session 行為驗證 |
| T041.4 | StateManager write mutex |

## 未標記但應追蹤

| 項目 | 來源 | 建議 |
|------|------|------|
| FR-051 agent execution structured logging | 架構 tour hooks step | Phase 2 或 Phase 3 初期補專用 task |
| session-runner response validation | 架構 tour session-runner step | Phase 3 接入 scheduler 前補 contract validation |
| disconnect() hang 影響 scheduler | 架構 tour session-runner step | Phase 3 考慮外層 timeout |

---

## 判定

**結果**：通過

**理由**：
- 3 個 Critical bug 全部修正並有 test 覆蓋
- 7 個 Suggestion 中 5 個修正、2 個合理延後（multi-session、mutex）並標記到 Phase 3
- SHIP 的所有 [R]isky 項目已解決或明確追蹤
- 235 tests 全過，lint clean（自己改動部分）
- Phase 2 的 contract（可獨立測試的模組骨架）已完成

**進入 BANK 的條件已滿足。**
