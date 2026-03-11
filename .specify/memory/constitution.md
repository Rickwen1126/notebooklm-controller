<!--
  Sync Impact Report
  ==================
  Version change: 1.6.0 → 1.7.0
  Removed principles:
    - IX. CodeTour 意圖說明 — 完全移除。CodeTour 是開發者主動發起的活動，
      不是 AI executor 的約束，不屬於 Constitution 範疇。
    - X. Checkpoint 提交與 Code Review — 移除 code review hard gate 和
      品質門檻中的 review 必檢項目。Code review/audit 是開發者主動發起，
      不是 executor 約束。
  Kept from old X (renumbered as IX):
    - Checkpoint commit + lint + test 為 executor 必要條件。
  Renumbered:
    - Old X → IX（CodeTour 移除後遞補）
  Modified sections:
    - 開發迴圈 — 精簡為 4 步
    - 品質門檻 — 只保留 lint + test（executor 可自動化的部分）
  Templates requiring updates:
    - .specify/templates/tasks-template.md — ⚠ pending (carried over from v1.6.0)
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

### IX. Checkpoint 提交 (Checkpoint Commit)

- 每一個 checkpoint MUST 建立 git commit，且 MUST 通過 lint + test。

## 開發流程與品質門檻

### 開發迴圈

```
1. 撰寫測試（Principle IV）
2. 實作功能
3. 測試全部通過
4. Checkpoint commit（Principle IX）
```

### 品質門檻

- 所有 PR / checkpoint MUST 通過 lint + test。

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
**Version**: 1.7.0 | **Ratified**: 2026-02-02 | **Last Amended**: 2026-03-12
