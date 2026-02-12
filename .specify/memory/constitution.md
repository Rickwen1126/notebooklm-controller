<!--
  Sync Impact Report
  ==================
  Version change: 1.0.0 → 1.1.0
  Modified principles:
    - III. Agent 程式本質 → 更新為 1 agent : 1 browser instance 模型
  Modified sections:
    - 並行與資料流設計約束 — 移除 Page Pool multi-tab 約束，
      改為 Browser Instance Isolation（1 agent : 1 browser）
  Added sections: None
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md — ✅ no update needed
      (template is generic; constitution check section derives from principles)
    - .specify/templates/spec-template.md — ✅ no update needed
      (spec template is principle-agnostic)
    - .specify/templates/tasks-template.md — ⚠ pending
      (checkpoint commit + code review + codetour gates not yet reflected;
       carried over from 1.0.0)
    - .specify/templates/agent-file-template.md — ✅ no update needed
  Follow-up TODOs:
    - specs/001-mvp/spec.md 中 Key Entities 的 Page Pool 描述需同步更新
      為 Browser Instance Pool
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
- **瀏覽器隔離原則**：每個 agent MUST 使用獨立的瀏覽器實例
  （browser instance），而非同一瀏覽器的不同分頁。
  理由：vision-based agent 依賴瀏覽器的 active tab 進行截圖
  與 UI 操作，同一瀏覽器一次只能有一個 active tab，因此
  多 tab 共用一個瀏覽器在 vision 模型下無法真正並行。
- MVP 階段可先以「1 daemon : 1 browser : 序列化操作」實作，
  但架構 MUST 預留擴展為「1 agent : 1 browser instance」的空間。

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

- **Agent ↔ Browser 隔離**：每個 agent MUST 使用獨立的瀏覽器實例。
  同一瀏覽器一次只能有一個 active tab，vision-based agent 依賴
  active tab 進行截圖與操作，因此「多 tab 共用一個瀏覽器」
  在 vision 模型下無法並行。
  - MVP 階段：1 daemon : 1 browser instance，所有 notebook 操作
    序列化執行（同一時間只操作一個 notebook）。
  - 擴展階段：1 agent : 1 browser instance，可真正並行處理
    多個 notebook。
- **Agent Pool ↔ State Store**：透過事件或訊息傳遞同步狀態，
  禁止 agent 直接寫入 store 內部結構。
- **HTTP Router ↔ Agent Pool**：request handler MUST 透過
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

**Version**: 1.1.0 | **Ratified**: 2026-02-02 | **Last Amended**: 2026-02-06
