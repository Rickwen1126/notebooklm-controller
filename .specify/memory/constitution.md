<!--
  Sync Impact Report
  ==================
  Version change: 1.5.0 → 1.6.0
  Modified principles:
    - III. Agent 程式本質 → 移除 MCP Server 介面、Single Browser Multi-tab 實作細節。
      理由：憲法應只包含不隨實作改變的原則。MCP、TabManager、CDP、
      NetworkGate 等具體架構已在 spec.md 和 plan.md 充分記載（147 處引用）。
      每次架構 pivot（multi-tab → BrowserPool → TabManager → MCP）都要改憲法
      說明它不該放這裡。保留原則層：agent 自主性、自我修復能力、
      瀏覽器生命週期由 daemon 管理。
    - VII. 安全的並行處理 → 新增 per-resource 寫入保護規則，取代舊的
      「磁碟 I/O MUST 序列化存取」。舊規則過於寬泛，可能導致
      global serialization 過度設計（違反 Principle I）。
  Modified sections:
    - III. Agent 程式本質 — 精簡為原則層
    - VII. 安全的並行處理 — 新增 per-resource 寫入保護
  Removed sections:
    - 並行與資料流設計約束 — 實作細節下放至 spec.md
  Templates requiring updates:
    - .specify/templates/tasks-template.md — ⚠ pending (carried over)
  Follow-up TODOs:
    - spec.md: 確認並行約束細節已涵蓋（已驗證）
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
- Agent MUST 擁有完整自我修復能力（可自主截圖分析、retry、
  處理意外狀況），不得將 agent 限制為只能回報錯誤的被動角色。
- 瀏覽器生命週期由 daemon 管理，agent 不能自行啟動或關閉瀏覽器。

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
- 同一持久化資源的寫入 MUST 防止競爭條件（race condition），
  保護範圍 MUST 限縮至最小單位（per-file），
  禁止 global serialization。
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

**Version**: 1.6.0 | **Ratified**: 2026-02-02 | **Last Amended**: 2026-02-24
