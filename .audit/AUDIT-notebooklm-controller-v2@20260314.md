# AUDIT: notebooklm-controller v2

tags: [audit, browser-automation, copilot-sdk, mcp-server, daemon, review-1.5, spike-backfill]

## Relations
- audit_for [[todo-notebooklm-controller]]
- follows [[SHIP-notebooklm-controller@20260310]]
- previous [[AUDIT-notebooklm-controller-v1@20260313]]

## 產出類型
軟體產品（Review 1.5 Code Alignment + Spike 回灌 + 一致性修正）

## 審計範圍
Review Point 1.5 全鏈路：spec/plan 修正 → code alignment（31 files）→ tours（4 個）→ code review → spike 回灌（4 項）→ speckit.analyze（7 findings 修正）。
Commit `a564347`，35 files changed, 555 tests passing, lint 0 errors。

---

## 通用核心

### A1 Contract
Review 1.5 讓 spec/plan/tasks/code 全部對齊 Notebook-First + Tab Pool 架構：notebook = 產品概念，tab = 內部資源。Spike 回灌讓 browser capability 實驗結論進入主線文件。speckit.analyze 修正 7 個跨文件不一致。

SHIP 偏移檢查：**一致**。SHIP 的「Single Browser Multi-tab（CDP 底層 API）」方向不變，Tab Pool 是 multi-tab 的 refined 實作。Two-Session Planner+Executor 取代 CustomAgent sub-agent，是 SDK 限制（Finding #39）驅動的實作路徑變更，不是方向偏移。

### A2 Failure Modes

1. **tabHandle.url 是 assignment metadata 不是 live page fact** → 證據：Tour 03 Finding A + code review 🟡1 定位 `src/daemon/index.ts:117`。affinity reuse 時 tabHandle.url 不更新，pre-navigate hint 拿錯。→ **未修**：T-HF01 追蹤，Phase 6 前必修
2. **waitForIdle() 等全部 queue 而非單一 task** → 證據：Tour 02 Step-by-step review 發現 `src/daemon/exec-tools.ts:151` sync mode。其他 notebook 有排隊 task 會卡住 sync caller。→ **未修**：T-HF02 追蹤，Phase 6 前必修
3. **Planner 不知道 target notebook** → 證據：Tour 03 Finding C 定位 `src/agent/session-runner.ts:227`。Planner systemMessage 只有 catalog + locale，缺 notebookAlias。→ **未修**：T-HF03 追蹤，Phase 6 前必修
4. **acquireTab double-acquire race** → 證據：Tour 03 Finding B 定位 `src/tab-manager/tab-manager.ts:139`。同步選 tab 和 async navigate 之間無互斥。→ **未修**：T-HF05 追蹤，scheduler FIFO 降低機率但架構上應修
5. **CDP Ctrl+A 在 Angular Material dialog 失效** → 證據：Spike Finding #43。cdp-helpers 的 selectAll 用 CDP key event，Angular zone 攔截。→ **未修**：T-SB06-07 追蹤

### A3 Trade-offs

- **替代 A：保留 open_notebook / close_notebook MCP tools** → 不選原因：YAGNI。使用者不需感知 tab，debug 用途透過 code/test 處理。砍掉 2 個 tools 減少介面面積。
- **替代 B：CustomAgent sub-agent（原始設計）取代 Two-Session** → 不選原因：Finding #39 驗證 sub-agent 無法存取 `defineTool()` custom tools。Two-Session 是唯一可行路徑。SHIP Solution Space 的「AI Agent」選擇不變，只是實作路徑從 sub-agent 切到獨立 session。

### A4 AI 盲點

1. **spec Key Entities 殘留舊架構描述** → ✅ 已修（F1）：「兩層 Agent 架構（Main Agent + Subagent）」已更新為「Two-Session Planner+Executor 架構」。scan 確認無殘留 `Main Agent` 或 `Subagent` 引用。
2. **US2 acceptance scenario JSON 含已移除欄位** → ✅ 已修（F2）：`"active": true` 已從 US2 AS3 JSON 移除。T051/T052 標記已移除。
3. **plan.md 模型選擇「可能性」vs 已決策** → ✅ 已修（F3）：「Model 分離可能性：Planner 用推理模型」更新為「Model 選擇：都用 GPT-4.1（Finding #50）」。與 spec.md L1478 和 code（session-runner hardcode）一致。

### A5 受眾價值
**受眾**：開發者自己
**拿到後能做**：spec/plan/tasks 三份文件一致性已通過 analyze，Phase 6 開發者讀文件不會遇到架構描述矛盾。3 個 blocking code fix（T-HF01~03）清楚追蹤，修完即可進 Phase 6 實作 repo source feeding。

---

## Code 延伸

### C1 Lifecycle
- **Tab Pool acquire/release 對稱**：`acquireTab()` 在 `createRunTask()` 的 try block，`releaseTab()` 在 finally ✅（`src/daemon/index.ts:110-125`）
- **Tab state machine**：`active` → `idle`（release 時）。TabHandle 初始 `state: "active"`。release 更新 `state` + `releasedAt` ✅
- **缺口**：acquireTab 三級策略中 strategy 2（idle reuse）的 navigate 是 async，navigate 失敗的 tab 歸還 pool 路徑未測試 → 中等風險

### C2 Error Model
- **acquireTab 失敗傳播**：pool 滿全佔用 → throw TabLimitError → scheduler catch → task failed → taskStore persist → 使用者收到 error → **但 spec 說不暴露 pool 錯誤** → T-HF05 的 producer-consumer 尚未實作，暫時仍會 throw
- **pre-navigate 錯誤**：agentConfig.startPage mismatch → page.goto() 可能 timeout → session-runner 不處理此 error → Executor 收到錯誤截圖 → 可接受（agent 有自我修復能力）

### C3 Concurrency
- **acquireTab race**（T-HF05）：同步 select idle tab 和 async goto 之間無 lock。多 notebook 並發可能 double-acquire → 已追蹤
- **StateManager 依然無 mutex**（T041.4）：已在 Phase 3 tasks 追蹤，Review 1.5 未修改此項 → 延後可接受

### C4 Side Effects
- **新增 side effects**：無。Code alignment 改的是資料流和介面，沒有新增 I/O、listener 或 timer
- **移除 side effects**：`open_notebook` / `close_notebook` MCP tools 移除 → notebook-tools.ts 少了 2 個 handler

### C5 Observability
- **Tab pool metrics**：`get_status` 回傳 `tabPool: { usedSlots, maxSlots, idleSlots }` ✅
- **Pre-navigate hint**：注入 Executor prompt，可從 agent log 看到系統判斷結果 ✅
- **缺口**：v1 AUDIT 的 FR-051 structured logging 仍未修（T041.5 追蹤中）→ 不影響 Phase 6 但影響 production observability

---

## [R]isky 追蹤

| SHIP 標記 | 實際結果 | 處理 |
|-----------|----------|------|
| TabManager lifecycle | acquireTab/releaseTab 實作完成，133 新 test cases。Chrome crash handler 不受影響 | ✅ 已安全通過 |
| NetworkGate permit 模型 | 不受 Review 1.5 影響 | ✅ 已安全通過 |
| MCP Server Streamable HTTP | multi-session 驗證完成（T041.3 ✅），per-session McpServer instance | ✅ 已安全通過 |
| **新增** Planner Input Gate | spec FR-185~188 + plan 更新完成。code 尚未實作（T-SB01~03） | ⚠️ 文件完成，code 待實作 |
| **新增** Download 基礎設施 | spec + plan 記載 CDP Browser.setDownloadBehavior。code 尚未實作（T-SB04~05） | ⚠️ 文件完成，code 待實作（Phase 9） |

## 累積項目檢查

| 來源 | 檢查 | 結果 |
|------|------|------|
| v1 AUDIT 🔴1-3 | 本次 code alignment 是否引入類似 bug？ | ✅ 無新 critical。code review tour（review-tab-pool-alignment-20260314）確認 0 critical |
| v1 AUDIT A4#1 session-runner outcome model | 本次 session-runner 改動是否加劇？ | 不變。DualSessionOptions 加了 notebookAlias/tabUrl，但 response handling 未動 |
| v1 AUDIT C3 StateManager race | 本次 code alignment 是否新增 race surface？ | 新增了 `stateManager.getNotebook()` 呼叫在 `createRunTask()` 中，但 scheduler 串行保證安全。T041.4 仍需修 |
| SHIP #5 CustomAgentConfig 命名修正 | spec/plan/tasks 是否全面更新？ | ✅ 全面。spec Key Entities 已從 "Subagent(CustomAgent)" 更新為 "Executor Session" |

---

## 修正清單（本次 AUDIT 期間）

本次 AUDIT 無新增 code 修正。所有 F1~F7 文件修正已在 AUDIT 前 commit（`a564347`）。

## 延後項目（已追蹤）

| Task | 內容 | 阻塞 Phase 6? |
|------|------|---------------|
| T-HF01 | tabHandle.url → page.url() | **是** |
| T-HF02 | waitForTask 取代 waitForIdle | **是** |
| T-HF03 | Planner systemMessage 注入 notebookAlias | **是** |
| T-HF04 | prompt 拼接 → SDK systemMessage 參數 | 否（不影響正確性） |
| T-HF05 | acquireTab async race | 否（FIFO 降低機率） |
| T-SB01~03 | Planner Input Gate code | 否（Phase 6 不需要拒絕功能） |
| T-SB04~05 | Download 基礎設施 | 否（Phase 9 US6） |
| T-SB06~07 | CDP Ctrl+A selectAll | 可能（add-source paste 操作） |

---

## 判定

**結果**：通過（附條件）

**理由**：
- 本次產出是文件一致性修正 + code alignment，不是新功能開發
- spec/plan/tasks 三份文件已通過 speckit.analyze 交叉檢查，7 個 inconsistency 全部修正
- Spike 回灌 4 項全部進入 spec/plan/tasks，有對應 FR 編號和 task ID
- 555 tests 全過，lint clean
- 3 個 Phase 6 blocking code fix 已明確追蹤（T-HF01~03）

**附條件**：Phase 6 開始前 MUST 修完 T-HF01、T-HF02、T-HF03。

**進入 BANK 的條件已滿足。**
