<!--
  Sync Impact Report
  ==================
  Version change: 1.4.0 → 1.5.0
  Modified principles:
    - III. Agent 程式本質 → 新增「MCP Server 介面」段落。
      理由：CLI + HTTP API 架構中，CLI 是 thin HTTP client wrapper，
      18 個 command 檔案 + Fastify routes + Skill Template 都是膠水層。
      主要消費者是 AI agent（Claude Code），MCP 是 AI 工具的原生協議。
      改為 MCP Server 後：(1) 砍掉 CLI 模組、Fastify、commander 依賴；
      (2) MCP tool 自描述，不需 Skill Template；
      (3) MCP 持續連線，非同步通知可直接推送，簡化 Notification 系統。
      Daemon 核心（TabManager、Agent、State、NetworkGate）不變，
      只是介面層從 CLI+HTTP 換成 MCP protocol。
      Transport：Streamable HTTP（daemon 獨立存活 + 多 client 連線）。
  Modified sections:
    - III. Agent 程式本質 — 新增 MCP Server 介面
    - 並行與資料流設計約束 — HTTP Router → MCP Tool Handler
  Added sections: None
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md — ✅ no update needed
    - .specify/templates/spec-template.md — ✅ no update needed
    - .specify/templates/tasks-template.md — ⚠ pending (carried over)
    - .specify/templates/agent-file-template.md — ✅ no update needed
  Follow-up TODOs:
    - spec.md: v5 → v6 MCP Server pivot
    - plan.md: 模組結構 CLI+HTTP → MCP Server + browser-pool → tab-manager
    - data-model.md: CLI Response Shapes → MCP + BrowserInstance → Tab
    - research.md: 更新 Browser Automation section
    - CLAUDE.md: 模組列表更新
-->

# NotebookLM Controller Constitution

## Core Principles

### I. 禁止過度設計 (No Over-Engineering)

- 只實作當前明確需要的功能，嚴格遵守 YAGNI 原則。
- 不為假設性未來需求預留抽象層、設定旗標或向下相容墊片。
- 三行相似程式碼優於一個過早的抽象。
- 每一層複雜度 MUST 附帶明確理由；無法說明理由者 MUST 移除。

### II. 單一職責 (Single Responsibility)

- 每個模組、類別、函數 MUST 只做一件事，並且能用一句話描述其目的。
- 若描述中出現「和」或「同時」，MUST 拆分。
- 檔案層級亦適用：一個檔案 SHOULD 對應一個公開概念。

### III. Agent 程式本質 (Agent Program Nature)

- 本專案是一個 AI Agent 程式（daemon 管理多個 agent session）。
- 所有設計決策 MUST 以「agent 能否自主完成操作」為核心考量。
- Agent session、tool 呼叫、vision model 互動是一等公民，
  非附加功能。
- **MCP Server 介面**：
  - Daemon 以 MCP Server 形式暴露所有功能（Streamable HTTP transport）。
  - AI 工具（Claude Code 等）透過 MCP protocol 直接呼叫 tool，
    無需 CLI 中間層。
  - MCP tool 定義自描述（tools/list），不需額外 Skill Template。
  - 非同步操作透過 MCP tool 快速回傳 taskId，
    完成後以 MCP notification 通知連線中的 client。
  - Daemon 獨立於 client 存活（Streamable HTTP），
    支援多 client 同時連線。
- **Single Browser Multi-tab 架構**：
  - Daemon 管理一個 Chrome instance（headless），每個 notebook 一個 tab。
  - Agent session 透過 TabManager 取得 tab handle（CDP session），
    操作完畢歸還。Agent 不能自行啟動/關閉 Chrome。
  - Agent 透過 CDP 底層 API（`Input.dispatchMouseEvent`、
    `Page.captureScreenshot`）操作 tab，不依賴 Puppeteer 高層 API。
    背景 tab 操作完全可靠（實驗驗證）。
  - 認證：一個 `userDataDir` 即可，首次 headed 登入後
    後續 headless 直接複用 session。
  - NetworkGate 集中式流量閘門：agent 操作前 MUST `acquirePermit()`，
    異常時觸發全域 backoff。
  - Tab 超時未歸還 → daemon 強制關閉 tab。

### IV. 測試先行，通過才推進 (Test-First, Pass-Before-Proceed)

- 每一個開發步驟 MUST 先確認既有測試全部通過，才能進入下一步。
- 新功能 MUST 伴隨對應測試（unit 或 integration 視情境而定）。
- 測試失敗即為紅燈：MUST 修復後才能繼續開發，禁止跳過。
- 此原則不可協商（NON-NEGOTIABLE）。

### V. 語意明確的命名 (Intention-Revealing Names)

- 所有 symbol（變數、函數、類別、模組、檔案）MUST 具備高可讀性
  且語意明確。
- 禁止單字母變數（迴圈索引 `i`, `j` 除外）。
- 命名 MUST 反映業務意圖而非實作細節
  （例：`notebookStateCache` 而非 `dataMap`）。
- 縮寫 MUST 在專案詞彙表有定義才可使用。

### VI. 模組輕耦合 (Loose Module Coupling)

- 模組之間 MUST 透過明確定義的介面（型別、契約）溝通。
- 禁止跨模組直接存取內部狀態。
- 依賴方向 MUST 單向且可在架構圖中清楚追蹤。
- 移除任一模組時，受影響範圍 SHOULD 僅限於直接消費者。

### VII. 安全的並行處理 (Safe Concurrency)

- 跨模組並行 MUST 採用資料流動（message passing / event / queue）
  設計，禁止共享可變狀態。
- 單一模組內部若需同步，SHOULD 限縮至最小 critical section，
  並 MUST 附帶文件說明鎖的範圍與理由。
- 所有非同步操作 MUST 有明確的錯誤傳播與取消機制。

### VIII. 繁體中文文件 (Traditional Chinese Documentation)

- 所有 specification、plan、使用者文件 MUST 使用繁體中文（zh-TW）
  撰寫。
- 程式碼中的註解 SHOULD 使用英文（與生態系慣例一致），但
  architecture decision record 與 commit message 的描述部分
  SHOULD 使用繁體中文。
- 此原則確保團隊溝通語言一致性。

### IX. CodeTour 意圖說明 (CodeTour Intent Documentation)

- 每個模組或重要函數 MUST 建立 VSCode CodeTour，內容包含：
  - **What**：這段程式做什麼
  - **Why**：為什麼需要它
  - **How**：實作方式概述
  - **Solved Problem**：解決了什麼問題
- Tour 路線 MUST 提供給 reviewer 作為 code review 的導覽路徑。

### X. Checkpoint 提交與 Code Review (Checkpoint Commit & Review)

- 每一個 checkpoint MUST 建立 git commit。
- Commit 後 MUST 指派 code review subagent 執行審查並產出：
  - 問題報告（issue report）
  - 對應的 CodeTour 路線供 user review
- User review 完成並確認通過後，才能繼續下一步開發。
- 此流程為開發迴圈的硬性閘門（hard gate），不可跳過。

## 並行與資料流設計約束

本專案架構核心為 daemon 管理多個 agent session，天然涉及並行處理。
以下約束補充 Principle III 與 Principle VII 的具體實施規則：

- **Agent ↔ Browser（Single Browser Multi-tab 模型）**：Daemon 管理
  一個 Chrome instance，每個 agent session 取得獨立的 tab（CDP session）。
  Agent 透過 CDP 底層 API 操作，background tab 截圖/點擊完全可靠，
  支援真正的跨 notebook parallel 操作。
  - Chrome 生命週期完全由 daemon 管理（agent 不能啟動/關閉 Chrome）。
  - Tab 超時未歸還 → daemon 強制關閉。
- **NetworkGate（集中式流量閘門）**：不在 data path，只管「能不能做」。
  Agent 操作前 MUST `acquirePermit()`。異常（429/timeout）觸發全域 backoff。
- **Agent Pool ↔ State Store**：透過事件或訊息傳遞同步狀態，
  禁止 agent 直接寫入 store 內部結構。
- **MCP Tool Handler ↔ Agent Pool**：tool handler MUST 透過
  pool 的公開介面派發任務，禁止直接操作 agent session 內部。
- **磁碟 I/O**：state 持久化 MUST 序列化存取，避免寫入衝突。

## 開發流程與品質門檻

### 開發迴圈

```
1. 撰寫 / 更新 CodeTour（Principle IX）
2. 撰寫測試（Principle IV）
3. 實作功能
4. 測試全部通過
5. Checkpoint commit（Principle X）
6. Code review subagent 審查 + 產出報告
7. User review CodeTour + 問題報告
8. User 確認通過 → 進入下一步
```

### 品質門檻

- 所有 PR / checkpoint MUST 通過 lint + test。
- 命名審查為 code review 的必檢項目（Principle V）。
- 模組耦合度為 code review 的必檢項目（Principle VI）。
- 並行安全性為涉及跨模組互動之 checkpoint 的必檢項目
  （Principle VII）。
- 瀏覽器隔離合規性為涉及 agent 操作之 checkpoint 的必檢項目
  （Principle III）。

## Governance

- 本 Constitution 為本專案最高治理文件，所有開發實踐 MUST 遵守。
- 修正案流程：
  1. 提出修正需求與理由。
  2. 評估對既有 principle 的影響。
  3. 更新 Constitution 並遞增版本號。
  4. 同步更新所有受影響的 template 與文件。
- 版本號遵循語意化版本：
  - MAJOR：移除或重新定義既有原則（不向下相容）。
  - MINOR：新增原則或實質擴充既有指引。
  - PATCH：措辭修正、排版調整、非語意性修訂。
- 合規審查：每次 checkpoint code review MUST 包含 Constitution
  合規性檢查。

**Version**: 1.5.0 | **Ratified**: 2026-02-02 | **Last Amended**: 2026-02-23
