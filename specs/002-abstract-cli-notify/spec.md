# 功能規格書：架構重構 — 抽象瀏覽器介面 + CLI/Skill/Notify 整合

**Feature Branch**: `002-abstract-cli-notify`
**Created**: 2026-02-12
**Status**: Draft
**Input**: User description: "1. 加入抽象介面預留 patchright 可置換 2. mcp 架構直接取消，使用 SKILL + CLI 更換並加入 notify 機制"
**Supersedes**: 001-mvp 中的 MCP 整合（FR-025~FR-027）與瀏覽器直連架構

<!--
  v1 變更摘要：
  1. 瀏覽器控制層抽象化：定義統一的瀏覽器操作介面，
     讓底層自動化程式庫可被置換（如從 Puppeteer 切到 Patchright），
     不影響上層 agent 與 skill。
  2. 移除 MCP 整合：取消 001-mvp 的 FR-025~FR-027（MCP server 內嵌），
     改以 CLI + AI Skill + 通知機制實現外部 AI 工具整合。
  3. 非同步操作模式：CLI 支援非同步提交，透過 Inbox 通知機制
     在操作完成後通知使用者的 AI 工具，不需要 blocking 等待。
  4. 跨平台 AI 工具相容：設計不綁定特定 AI CLI 產品，
     CLI + 檔案通知機制可與任何能執行 shell 指令的 AI 工具整合。

  v2 變更摘要（2026-02-12 討論決策）：
  5. Multi-tab broker：1 daemon, 1 Chrome (headless), N tabs。
     每個 notebook 對應一個 tab，跨 notebook 真正 parallel 執行。
     同一 notebook 內操作為 serial（共享一個 tab/page）。
  6. Headless + headed auth 雙模式：首次登入以 headed mode 讓使用者
     手動完成 Google 認證，之後 headless 背景執行。Session 過期時
     fallback 回 headed 重新認證。
  7. Connection Manager 取代 Browser Strategy：抽象邊界從 strategy pattern
     移到連線管理層。Agent 只拿到 pageId + tools，不知道底層是
     Puppeteer 或 Patchright。Connection Manager 統一管理 browser 生命週期、
     tab 建立與銷毀、page reference binding。
  8. Notification Adapter 架構：放棄 lowest-common-denominator，
     改為 per-tool best practice。每個 AI CLI 工具有專屬 adapter，
     充分利用該工具的能力（如 Claude Code 的 session_id）。
     核心協議（inbox 格式、taskId 生命週期）統一，delivery 機制各自最佳化。
  9. Per-session inbox routing（Claude Code adapter）：利用 hook stdin JSON
     中的 session_id 實現精準通知路由。每個 CLI session 只收到自己
     提交的任務結果，多 session 不互相干擾。
-->

---

## 使用者情境與測試 *(mandatory)*

<!--
  本 spec 描述兩類架構變更：
  A) 瀏覽器控制抽象化（內部品質，使用者不直接感知但受益於更高穩定性）
  B) CLI + Skill + Notify 取代 MCP（使用者直接感知的整合方式變更）

  與 001-mvp 的關係：
  - 001-mvp 的 US1~US12, US14~US19 的使用者體驗不變
  - US13（MCP 整合）被本 spec 完全取代
  - 新增 async 操作模式與通知機制
  - 001-mvp 的 single-notebook daemon 擴展為 multi-notebook（multi-tab）

  跨 AI 工具相容性考量：
  - CLI 指令是最通用的整合介面，所有 AI CLI 工具都能執行 shell 指令
  - 通知機制採 Notification Adapter 架構，per-tool best practice：
    1. Claude Code adapter：per-session inbox routing，full push（利用 session_id）
    2. 其他工具 adapter：依該工具能力做最佳實作
    3. Generic adapter：pull-based fallback（`nbctl status`）
  - 每加一個 AI CLI 工具，只需實作一個新 adapter
-->

## Part A: CLI + Skill 整合 Stories

### User Story 1 - 非同步操作提交與結果查詢 (Priority: P1)

身為使用 AI coding tool 的開發者，我希望透過 CLI 提交操作後能立即返回，
不需要等待操作完成，讓我的 AI 工具可以繼續做其他工作。
當操作完成時，我能透過 CLI 查詢結果。

**Why this priority**: 這是 CLI + Skill 整合模式的基礎。
沒有非同步操作支援，使用者的 AI 工具在等待 NotebookLM 操作時會完全 blocking，
無法做其他事情。非同步是讓 CLI 模式優於 MCP 的關鍵特性。

**Independent Test**: 以非同步模式提交一個操作，確認立即返回 taskId；
之後查詢該 taskId，驗證能取得操作結果。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且有 active notebook，
   **When** 使用者執行 `nbctl exec "把 repo 加入來源" --nb <notebook-id> --async`，
   **Then** CLI 立即返回 JSON：
   ```json
   { "taskId": "abc123", "status": "queued", "notebook": "<notebook-id>",
     "hint": "Use `nbctl status abc123` to check result later." }
   ```
   不等待操作完成。

2. **Given** 操作 abc123 已完成，
   **When** 使用者執行 `nbctl status abc123`，
   **Then** 回應 JSON `{ "taskId": "abc123", "status": "completed", "result": { ... } }`。

3. **Given** 操作 abc123 仍在進行中，
   **When** 使用者執行 `nbctl status abc123`，
   **Then** 回應 JSON `{ "taskId": "abc123", "status": "running", "elapsed": "15s" }`。

4. **Given** 操作 abc123 失敗，
   **When** 使用者執行 `nbctl status abc123`，
   **Then** 回應 JSON `{ "taskId": "abc123", "status": "failed", "error": "..." }`。

5. **Given** 使用者想查看所有背景操作，
   **When** 使用者執行 `nbctl status --all`，
   **Then** 回應 JSON 陣列，列出所有近期操作及其狀態。

6. **Given** 使用者不使用 `--async` flag，
   **When** 使用者執行 `nbctl exec "截圖" --nb <notebook-id>`（不帶 `--async`），
   **Then** CLI 等待操作完成後才返回結果（向下相容 001-mvp 的同步行為）。

7. **Given** 使用者同時對不同 notebook 提交操作，
   **When** 使用者執行：
   ```
   nbctl exec "加來源" --nb alpha --async
   nbctl exec "問問題" --nb beta --async
   ```
   **Then** 兩個操作在不同 tab 上 parallel 執行，各自獨立返回 taskId。

---

### User Story 2 - 操作完成自動通知 (Priority: P2)

身為使用 AI coding tool 的開發者，我希望非同步操作完成後，
結果能自動出現在我的 AI 工具的對話中，而不需要我主動查詢。

**Why this priority**: 僅靠 `nbctl status` 查詢是 pull-based，
需要使用者或 AI 主動去查。自動通知讓體驗接近「提交即忘」，
大幅提升使用流暢度。這是 Notification Adapter 的核心價值。

**Independent Test**: 提交非同步操作，在操作完成後，
下次 AI 工具互動時，操作結果自動出現在對話 context 中。

**Acceptance Scenarios**:

1. **Given** 使用者在 Claude Code Session A 提交了非同步操作 abc123，
   操作已完成，通知已寫入該 session 的 Inbox，
   **When** 使用者在 Session A 中送出下一則訊息，
   **Then** Session A 的 hook 讀取該 session 專屬的 inbox，
   AI 收到完整結果：「[nbctl] 操作已完成：來源 'my-project (repo)' 新增成功」。
   Session B 不會收到此通知。

2. **Given** 非同步操作 abc123 已完成，通知已寫入 Inbox，
   **When** AI 工具完成當前工作準備停止，
   **Then** AI 工具被攔截並收到通知，先處理 nbctl 結果再停止。

3. **Given** 非同步操作 abc123 失敗，通知已寫入 Inbox（標記為 urgent），
   **When** AI 工具下一次互動時，
   **Then** AI 工具收到錯誤通知，能向使用者說明失敗原因並建議修正方式。

4. **Given** 沒有任何待處理通知，
   **When** AI 工具正常互動時，
   **Then** 沒有額外通知注入，不影響正常操作。

5. **Given** 使用者使用不支援 adapter 的 AI 工具（generic fallback），
   **When** 非同步操作完成後，
   **Then** 使用者可透過 `nbctl status --recent` 手動查詢所有近期完成的操作。

---

### User Story 3 - AI Skill 引導整合 (Priority: P3)

身為使用 AI coding tool 的開發者，我希望能透過安裝一個 Skill（prompt template），
讓我的 AI 工具自動學會如何使用 nbctl，包括非同步工作流和結果處理。

**Why this priority**: CLI 指令本身是機器友好的，但 AI 工具需要
一份「操作手冊」才能有效使用。Skill 是這份手冊的結構化表達。
沒有 Skill，使用者需要在每次對話中重複解釋 nbctl 的用法。

**Independent Test**: 在 AI 工具中載入 Skill 後，
告訴 AI「把我的專案程式碼加入 NotebookLM」，
AI 能自動使用正確的 nbctl 指令完成操作。

**Acceptance Scenarios**:

1. **Given** AI 工具已載入 nbctl Skill，
   **When** 使用者告訴 AI「把 ~/code/my-project 加入 NotebookLM 來源」，
   **Then** AI 自動執行 `nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb <id> --async`，
   並向使用者說明已提交操作，將在完成後通知。

2. **Given** AI 工具已載入 nbctl Skill 且收到操作完成通知，
   **When** 通知內容為成功，
   **Then** AI 向使用者報告：「你的專案已成功加入 NotebookLM，共 12,345 字。
   你現在可以向 NotebookLM 提問關於這個專案的問題了。」

3. **Given** AI 工具已載入 nbctl Skill，
   **When** 使用者問「NotebookLM 裡有哪些 notebook？」，
   **Then** AI 自動執行 `nbctl list` 並以人類可讀的方式呈現結果。

---

### User Story 4 - Notification Adapter 安裝 (Priority: P4)

身為開發者，我希望能透過一個指令自動安裝適合我 AI CLI 工具的
通知 adapter，不需要手動編輯設定檔。系統會針對我的工具
提供最佳的通知體驗，而不是妥協到最低公約數的方案。

**Why this priority**: 每個 AI CLI 工具的 hook 機制不同，
per-tool adapter 能充分利用各工具的能力提供最佳體驗。
自動安裝大幅降低上手門檻。

**Independent Test**: 執行安裝指令後，驗證 adapter 設定檔已正確產生，
且下次 AI 工具互動時通知機制正常運作。

**Acceptance Scenarios**:

1. **Given** 使用者使用 Claude Code 且未安裝 nbctl adapter，
   **When** 使用者執行 `nbctl install-hooks --tool claude-code`，
   **Then** 系統安裝 Claude Code 專屬 adapter：
   在 `.claude/settings.json` 中設定 `UserPromptSubmit` 和 `Stop` hook，
   hook 腳本利用 stdin JSON 的 `session_id` 實現 per-session routing，
   輸出 JSON `{ "success": true, "tool": "claude-code", "adapter": "per-session-push", "hooks": ["UserPromptSubmit", "Stop"] }`。

2. **Given** 使用者使用尚未有專屬 adapter 的 AI 工具，
   **When** 使用者執行 `nbctl install-hooks --tool unknown-tool`，
   **Then** 系統安裝 generic adapter（pull-based），
   輸出 JSON `{ "success": true, "tool": "unknown-tool", "adapter": "generic-pull", "hint": "Use 'nbctl status --recent' to check results." }`。

3. **Given** 使用者已安裝過 adapter，
   **When** 使用者再次執行 `nbctl install-hooks --tool claude-code`，
   **Then** 系統偵測已存在的 adapter，提示是否要更新，不重複安裝。

4. **Given** 使用者想移除 adapter，
   **When** 使用者執行 `nbctl uninstall-hooks --tool claude-code`，
   **Then** 系統移除先前安裝的 adapter 設定，
   輸出 JSON `{ "success": true, "removed": ["UserPromptSubmit", "Stop"] }`。

---

## Part B: 瀏覽器抽象化 Stories

### User Story 5 - Connection Manager 與 Multi-tab 架構 (Priority: P5)

身為系統維護者，我希望 daemon 能在單一 Chrome 實例中管理多個 notebook tab，
讓多個 AI agent session 可以 parallel 操作不同 notebook，
且底層自動化程式庫能被替換（如從 Puppeteer 切到 Patchright），
而不需要修改 agent 邏輯或 skill 定義。

**Why this priority**: Multi-tab 架構讓使用者可以同時操作多本 notebook，
這是本工具與手動操作的核心差異。Connection Manager 抽象讓底層可替換，
確保當 NotebookLM 強化 bot 偵測時能快速因應。

**Independent Test**:
(a) 同時對兩個 notebook 發出操作，驗證 parallel 執行。
(b) 在設定檔中切換底層實作，重啟 daemon 後所有操作仍正常。

**Acceptance Scenarios**:

1. **Given** daemon 啟動，使用者開啟了 notebook Alpha 和 Beta，
   **When** 使用者同時提交操作到兩個 notebook，
   **Then** daemon 在同一 Chrome 實例的不同 tab 上 parallel 執行兩個操作，
   各 agent session 互不干擾。

2. **Given** daemon 使用預設實作（Puppeteer + vision-based），
   **When** 使用者執行所有 001-mvp 的操作（新增來源、查詢、產生 audio 等），
   **Then** 操作結果與 001-mvp 行為一致。

3. **Given** 系統管理者在設定檔中切換了底層實作，
   **When** daemon 重新啟動，
   **Then** daemon 使用新實作運作，agent 與 skill 不受影響。

4. **Given** 底層實作出現錯誤（例如截圖失敗），
   **When** agent 嘗試操作，
   **Then** 錯誤以統一的格式回報，agent 能根據錯誤類型決定重試或放棄，
   不因底層程式庫差異而產生不同的錯誤處理路徑。

5. **Given** daemon 首次啟動且無有效 Google session，
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 以 headed mode 啟動 Chrome 讓使用者完成 Google 登入，
   登入成功後 cookies 持久化至 `~/.nbctl/profiles/`，
   後續重啟自動以 headless mode 運作。

6. **Given** daemon 以 headless mode 運作但 Google session 已過期，
   **When** agent 偵測到認證失敗，
   **Then** daemon 通知使用者需要重新認證，
   並提供 `nbctl reauth` 指令以 headed mode 重新登入。

---

### User Story 6 - Agent Skill 參數化 (Priority: P6)

身為系統維護者，我希望 agent 的操作技能（如「新增來源」「查詢提問」
「產生 Audio」）以參數化的 skill 定義存在，讓我能調整 prompt 和
tool 組合，而不需要修改程式碼。

**Why this priority**: NotebookLM 的 UI 可能隨時間變化，
agent 的操作策略也需要持續調整。將 skill 定義外部化，
讓調整操作流程只需修改 skill 檔案，不需重新編譯或部署。

**Independent Test**: 修改某個 skill 的 prompt，重啟 daemon，
驗證 agent 使用新的 prompt 執行操作。

**Acceptance Scenarios**:

1. **Given** 系統管理者修改了「新增來源」skill 的 prompt template，
   **When** daemon 重新啟動後使用者執行新增來源操作，
   **Then** agent 使用更新後的 prompt 執行操作。

2. **Given** 使用者想查看所有可用的 agent skill，
   **When** 使用者執行 `nbctl skills`，
   **Then** 回應 JSON 列出所有 skill 名稱、描述與版本。

---

### Edge Cases

- **Inbox 檔案過多累積**：daemon MUST 定期清理超過 24 小時的已消費
  （moved to `consumed/`）通知檔案，避免磁碟空間浪費。未消費的通知不自動清除。
- **多個 CLI session 同時消費 Inbox**：每個 CLI session 有獨立的 inbox
  子目錄（per-session routing），不存在跨 session 搶讀的問題。
  Claude Code adapter 透過 hook stdin 的 `session_id` 區分。
- **Hook 執行失敗**：hook 腳本 timeout 或錯誤不應影響 AI 工具的正常操作。
  通知保留在 Inbox 中，下次 hook 觸發時重試。
- **daemon 未啟動時執行 CLI**：`nbctl exec` 和 `nbctl status` MUST 回報
  清楚的錯誤訊息，提示使用者先執行 `nbctl start`。
- **非同步操作提交後 daemon 被關閉**：已提交但未完成的操作 MUST 被標記為
  `cancelled`，通知寫入 Inbox。
- **底層實作切換後的 session 相容性**：切換實作後，
  daemon MUST 重建所有 browser 連線與 tab，不嘗試恢復舊 session。
  Notebook Registry（持久化在磁碟上）不受影響。
- **Skill 檔案格式錯誤**：daemon 啟動時驗證 skill 檔案，
  格式錯誤的 skill 被跳過並記錄警告日誌，不阻塞 daemon 啟動。
- **AI 工具無專屬 adapter**：使用者仍可透過 `nbctl status` 手動查詢，
  或使用 generic adapter（pull-based）。
  Skill 中 MUST 包含手動查詢的使用說明。
- **多個 CLI session 同時使用 nbctl**：CLI 指令透過 daemon HTTP API 處理。
  同 notebook 操作由 per-tab queue 序列化，跨 notebook 操作 parallel 執行。
- **通知優先級**：失敗操作（urgent）MUST 比成功操作（normal）優先送達，
  urgent 通知在 Stop hook 中會強制 AI 工具繼續處理。
- **Multi-tab 資源限制**：同時開啟的 notebook tab 數量 SHOULD 有上限
  （建議預設 10），超過上限時 daemon 回報錯誤並建議關閉閒置 notebook。
- **Tab 崩潰隔離**：單一 tab 的崩潰或 unresponsive 不應影響其他 tab。
  Connection Manager MUST 偵測並回報 tab 健康狀態，支援單一 tab 重建。
- **Headless mode 截圖正確性**：headless 模式下 `page.screenshot()` 的
  渲染結果 MUST 與 headed 模式一致（viewport size、DPI 等），
  確保 vision-based agent 的判斷準確性。
- **Google session 過期**：daemon MUST 偵測認證失敗（如 302 redirect 到
  登入頁），通知使用者執行 `nbctl reauth` 以 headed mode 重新登入，
  期間其他操作 MUST 排隊等待或回報認證錯誤。
- **Notification consume 原子性**：hook 消費通知時 MUST 使用
  rename（移至 `consumed/`）而非 delete，確保操作原子性並保留 audit trail。
  daemon 的定期清理負責清除 `consumed/` 中的過期檔案。

---

## 需求 *(mandatory)*

### Functional Requirements

<!--
  本 spec 的 FR 編號從 FR-100 開始，避免與 001-mvp 衝突。
  以下 001-mvp FR 被本 spec 取代：
  - FR-025（MCP server 內嵌）→ 由 FR-101~FR-103 取代
  - FR-026（MCP 共用 session）→ 不再需要（CLI 直接呼叫 daemon HTTP API）
  - FR-027（MCP list notebooks tool）→ 由 nbctl list 取代（已存在於 FR-001）
  以下 001-mvp FR 被本 spec 擴展：
  - 001-mvp 的 single-notebook daemon → multi-notebook multi-tab daemon（FR-170~FR-175）
-->

**非同步 CLI 操作**:
- **FR-100**: 系統 MUST 支援 `nbctl exec "<自然語言>" --nb <notebook-id> --async` 模式，
  立即返回 `{ "taskId": "<id>", "status": "queued", "notebook": "<notebook-id>", "hint": "..." }`，
  不等待操作完成。
- **FR-101**: 系統 MUST 支援 `nbctl status <taskId>` 指令，
  查詢特定操作的狀態與結果。
- **FR-102**: 系統 MUST 支援 `nbctl status --all` 指令，
  列出所有近期操作（預設最近 20 筆）及其狀態。
  MUST 支援 `--nb <notebook-id>` 篩選特定 notebook 的操作。
- **FR-103**: `nbctl exec` 不帶 `--async` flag 時 MUST 維持同步行為
  （等待完成後返回結果），與 001-mvp FR-002 行為一致。
- **FR-104**: `nbctl exec --async` MUST 支援 `--context "<描述>"` 選項，
  讓使用者附帶操作情境描述（如「我正在修 auth bug」），
  此描述會出現在操作完成通知中，幫助 AI 工具恢復對話脈絡。
- **FR-105**: `nbctl exec --async` 的返回 JSON MUST 包含 `hint` 欄位，
  提示呼叫者如何查詢結果（如 `"Use nbctl status <taskId> to check result later."`），
  作為防遺忘的第一層提醒。

**通知 Inbox**:
- **FR-110**: Daemon MUST 在非同步操作完成（成功或失敗）後，
  將結果寫入通知 Inbox 目錄。
- **FR-111**: Inbox 目錄結構 MUST 支援 per-session routing：
  `~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`。
  其中 `<session-id>` 由提交操作時的 `--session` 參數或 adapter 自動提供，
  `<priority>` 為 `urgent`（失敗）或 `normal`（成功）。
  若未提供 session-id，則寫入 `~/.nbctl/inbox/_default/<priority>/`。
- **FR-112**: 每個通知 MUST 為獨立的 JSON 檔案，
  檔名包含 taskId（如 `task-abc123.json`），
  內容包含 taskId、status、result、notebook、originalContext（如有）、timestamp、sessionId。
- **FR-113**: Daemon MUST 自動清理超過 24 小時的已消費通知
  （`consumed/` 目錄下的檔案）。未消費的通知不自動清除。
- **FR-114**: 通知檔案的寫入 MUST 為原子操作（先寫暫存檔再 rename），
  避免 hook 讀到不完整的檔案。
- **FR-115**: 通知消費 MUST 使用 rename（移至同 session 的 `consumed/` 子目錄）
  而非 delete，確保原子性並保留 audit trail。

**Notification Adapter**:
- **FR-120**: 系統 MUST 定義 Notification Adapter 介面，
  包含 `install(toolName)`、`uninstall(toolName)`、`consume(sessionId)` 操作。
  每個 adapter 自行決定 push/pull 策略與 routing 機制。
- **FR-121**: 系統 MUST 提供 `nbctl install-hooks --tool <tool-name>` 指令，
  自動安裝該工具對應的 adapter。
- **FR-122**: 系統 MUST 提供 `nbctl uninstall-hooks --tool <tool-name>` 指令，
  移除先前安裝的 adapter。
- **FR-123**: 首批 MUST 實作以下兩個 adapter：
  - **claude-code adapter**：full push + per-session routing。
    利用 hook stdin JSON 的 `session_id` 欄位識別 CLI session，
    將 `session_id` 傳遞給 `nbctl exec --session <id>` 以建立 task-session 綁定。
    `UserPromptSubmit` hook 只讀取該 session 專屬的 inbox 目錄，
    直接將完整結果輸出到 stdout 注入對話 context。
    `Stop` hook 檢查 urgent 通知，有則 exit 2 阻止停止。
  - **generic adapter**：pull-based fallback。
    不安裝 hook，通知寫入 `_default` inbox。
    使用者或 AI 透過 `nbctl status --recent` 手動查詢。
- **FR-124**: Claude Code adapter 的 `UserPromptSubmit` hook MUST：
  (a) 從 stdin JSON 解析 `session_id`，
  (b) 讀取 `~/.nbctl/inbox/<session_id>/` 下的所有通知，
  (c) 以結構化純文字格式輸出到 stdout（按 notebook 分組），
  (d) 將已讀通知 rename 到 `consumed/`。
- **FR-125**: Claude Code adapter 的 `Stop` hook MUST：
  (a) 從 stdin JSON 解析 `session_id`，
  (b) 檢查該 session inbox 中的 urgent 通知，
  (c) 若有未處理的 urgent 通知，以 exit code 2 阻止停止，
  並將通知內容輸出到 stderr。
  (d) normal 通知不阻止停止，僅輸出提醒。
- **FR-126**: Adapter hook 腳本的 timeout MUST 不超過 5 秒，
  避免影響 AI 工具的回應速度。
- **FR-127**: Hook 腳本 MUST 安裝在 `~/.nbctl/hooks/` 目錄下，
  AI 工具的設定檔引用此路徑。每個 adapter 可有多個 hook 腳本。

**Skill 模板**:
- **FR-130**: 系統 MUST 提供一份結構化的 AI Skill 模板檔案，
  教導 AI 工具如何使用 nbctl CLI 指令，
  包含可用指令清單、非同步工作流說明、通知處理指引。
- **FR-131**: Skill 模板 MUST 包含以下章節：
  可用指令（含參數說明）、非同步工作流（提交 → 繼續 → 收到通知或主動查詢）、
  通知處理指引（收到通知時如何向使用者報告）、
  手動查詢 fallback（當 hook 不可用時如何使用 `nbctl status`）、
  **防遺忘指引**（提交 async 後務必記住 taskId，適時查詢）。
- **FR-132**: Skill 模板 MUST 不綁定特定 AI CLI 工具的語法或功能，
  使用通用的自然語言描述操作流程。
- **FR-133**: 系統 MUST 提供 `nbctl export-skill` 指令，
  將 Skill 模板輸出為純文字，方便使用者複製到 AI 工具的 skill 設定。

**Connection Manager**:
- **FR-140**: 系統 MUST 實作 Connection Manager，作為 daemon 與瀏覽器之間的
  唯一抽象層。Connection Manager 負責：
  (a) 管理單一 Chrome 實例的生命週期（啟動、關閉、健康檢查），
  (b) 建立與銷毀 tab（每個 notebook 一個 tab），
  (c) 為每個 tab 產生獨立的 pageId 與 bound tools，
  (d) 管理 Google 認證的 cookies 持久化。
- **FR-141**: Connection Manager MUST 對外暴露以 pageId 為單位的操作介面：
  `screenshot(pageId)`、`click(pageId, x, y)`、`type(pageId, text)`、
  `navigate(pageId, url)`、`scroll(pageId, direction)`、`paste(pageId, content)`、
  `download(pageId)`、`healthcheck(pageId)`。
  Agent 只透過 pageId + 這些操作與瀏覽器互動，不直接接觸底層 page reference。
- **FR-142**: Connection Manager 的底層實作 MUST 可替換。
  預設為 Puppeteer（vision-based：截圖 → AI 判斷 → 座標操作）。
  替換底層實作不需修改 agent 或 skill。
- **FR-143**: 底層實作 MUST 可透過設定檔指定，
  daemon 啟動時載入指定的實作。
- **FR-144**: 所有底層實作 MUST 使用統一的錯誤格式回報錯誤，
  包含錯誤類型（連線失敗、tab 崩潰、操作逾時、認證過期）
  與建議動作（重試、重建 tab、截圖、重新認證）。

**Multi-tab Daemon**:
- **FR-170**: Daemon MUST 支援在單一 Chrome 實例中管理多個 notebook tab。
  每個 notebook 對應一個 tab，由 Connection Manager 統一管理。
- **FR-171**: 每個 notebook tab MUST 有獨立的 operation queue。
  同一 notebook 內的操作 MUST 序列化執行（serial），
  不同 notebook 的操作 MUST 可 parallel 執行。
- **FR-172**: 每個 notebook tab MUST 對應一個獨立的 AI agent session
  （Claude Agent SDK）。Agent session 透過 Connection Manager 取得
  專屬的 pageId 與 bound tools，不知道其他 session 的存在。
- **FR-173**: 同時開啟的 notebook tab 數量 MUST 有可設定的上限
  （預設 10）。超過上限時 daemon MUST 回報錯誤並建議關閉閒置 notebook。
- **FR-174**: 單一 tab 崩潰或 unresponsive 不應影響其他 tab。
  Connection Manager MUST 偵測 tab 健康狀態並支援單一 tab 重建。
- **FR-175**: Daemon MUST 支援 `nbctl open <notebook-id>` 指令
  開啟新 notebook tab，`nbctl close <notebook-id>` 指令關閉 tab。
  `nbctl notebooks` 列出目前開啟的所有 notebook tab 及其狀態。

**Headless / Headed 雙模式**:
- **FR-180**: Daemon MUST 支援 headless 與 headed 兩種 Chrome 啟動模式。
  預設為 headless，使用者不可見任何瀏覽器視窗。
- **FR-181**: 首次啟動且無有效 Google session（cookies）時，
  daemon MUST 自動以 headed mode 啟動 Chrome，讓使用者手動完成 Google 登入。
  登入成功後 cookies MUST 持久化至 `~/.nbctl/profiles/`。
- **FR-182**: 後續啟動 MUST 載入持久化的 cookies 並以 headless mode 運作，
  使用者桌面不顯示任何瀏覽器視窗。
- **FR-183**: 系統 MUST 偵測 Google session 過期（如頁面 redirect 到登入頁），
  並通知使用者執行 `nbctl reauth` 以 headed mode 重新認證。
- **FR-184**: Headless 模式下的截圖渲染 MUST 與 headed 模式一致
  （viewport size、DPI 等設定對齊），確保 vision-based agent 判斷準確。

**Agent Skill 參數化**:
- **FR-150**: Agent 的操作技能（如新增來源、查詢提問、產生 Audio）
  MUST 以外部化的 skill 定義描述，包含 prompt template 與所需 tool 清單。
- **FR-151**: Skill 定義 MUST 可在不重新編譯程式碼的前提下修改。
  修改後重啟 daemon 即可生效。
- **FR-152**: 系統 MUST 提供 `nbctl skills` 指令，列出所有已載入的
  agent skill 名稱、描述與版本。
- **FR-153**: 每個 skill MUST 宣告它依賴的瀏覽器操作
  （如截圖、點擊、輸入），確保切換底層實作時能驗證相容性。

**OS 通知（輔助）**:
- **FR-160**: 系統 SHOULD 在非同步操作完成時發送作業系統層級通知
  （macOS notification），讓使用者在不盯著 AI 工具時也能得知結果。
- **FR-161**: OS 通知 MUST 可透過設定檔開關，預設為開啟。

### Key Entities

<!--
  以下為本 spec 新增或修改的 Key Entities。
  001-mvp 中未被修改的 entities 維持不變。
-->

- **Connection Manager**：daemon 與瀏覽器之間的唯一抽象層。
  管理單一 Chrome 實例的生命週期、多個 notebook tab 的建立與銷毀、
  Google 認證 cookies 的持久化、headed/headless 模式切換。
  對外以 pageId 為單位暴露操作介面（screenshot、click、type、navigate 等），
  agent 只透過 pageId + tools 操作，不知道底層是 Puppeteer 還是 Patchright。
  底層實作可透過設定檔切換，預設為 Puppeteer。
  取代 v1 的 Browser Strategy — 抽象邊界從 strategy pattern 移到連線管理層。

- **Agent Skill**：參數化的 agent 操作技能定義。
  包含 prompt template（指引 agent 如何完成操作）、
  所需 tool 清單（如截圖、點擊、repoToText 等）、
  操作依賴宣告（需要哪些 Connection Manager 操作）。
  Skill 以檔案形式存在，可在不重新編譯的前提下修改。
  agent 根據使用者自然語言指令選擇對應的 skill 執行。
  skill 定義也控制了 agent 面對特定操作時的行為模式。

- **Notification Inbox**：per-session 的檔案型通知佇列。
  目錄結構：`~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`。
  每個 CLI session 有獨立的 inbox 子目錄，由 adapter 負責 routing。
  未指定 session 的通知寫入 `_default/` 子目錄。
  通知消費使用 rename 到 `consumed/` 而非 delete，保留 audit trail。
  daemon 定期清理 `consumed/` 中超過 24 小時的檔案。
  取代 v1 的 flat inbox 設計。

- **Notification Adapter**：per-tool 的通知交付實作。
  定義 `install`、`uninstall`、`consume` 介面，
  每個 AI CLI 工具有專屬 adapter 以充分利用該工具的能力。
  Claude Code adapter：利用 hook stdin 的 `session_id` 實現
  per-session routing + full push（直接注入結果到 context）。
  Generic adapter：pull-based fallback（`nbctl status --recent`）。
  新增工具支援只需實作新 adapter，不需改核心協議。
  取代 v1 的統一 Notification Hook 設計。

- **Async Task**：非同步操作的追蹤紀錄。
  包含 taskId（唯一識別碼）、status（queued/running/completed/failed/cancelled）、
  notebook（目標 notebook 的 id）、sessionId（提交者的 CLI session id）、
  操作內容摘要、提交時間、完成時間、結果或錯誤、
  使用者附帶的 context 描述（如有）。
  由 daemon 的 per-notebook Operation Queue 管理。

- **AI Skill Template**：提供給外部 AI 工具的使用指南。
  以結構化文字描述 nbctl 的所有 CLI 指令、非同步工作流、
  通知處理方式、防遺忘指引。不綁定特定 AI CLI 產品。
  使用者透過 `nbctl export-skill` 匯出，複製到 AI 工具的 skill/prompt 設定中。
  與 Agent Skill 不同：Agent Skill 是 daemon 內部 agent 的操作定義，
  AI Skill Template 是教外部 AI 工具如何呼叫 nbctl CLI。

<!--
  以下 001-mvp 的 Key Entities 被本 spec 移除：
  - MCP Tool（由 AI Skill Template + CLI 取代）
  以下 v1 Key Entities 被 v2 取代：
  - Browser Strategy → Connection Manager
  - Notification Hook → Notification Adapter
-->

---

## Clarifications

### Session 2026-02-12 (v1)

- Q: 本 spec 是否完全取代 001-mvp？ → A: 否。本 spec 僅取代 001-mvp 的 MCP 整合部分（FR-025~FR-027），並新增瀏覽器抽象化與通知機制。001-mvp 的其他部分（daemon、agent、content pipeline、state 管理等）維持不變。
- Q: 為什麼不用 MCP？ → A: MCP 的 tool call 在主流 AI CLI 工具（如 Claude Code）中是 blocking 的，且 server-push 機制（sampling、elicitation）尚未被 client 實作。CLI + Skill + Hook 模式更通用、支援非同步、且不依賴特定協定。
- Q: Hook 只支援 Claude Code 嗎？ → A: 首批只支援 Claude Code。但通知機制的三層設計（Inbox 檔案 → Hook 注入 → 手動查詢）確保任何 AI 工具都能使用，hook 只是加速通知交付的增強層。
- Q: 瀏覽器策略切換後，已存在的 notebook session 如何處理？ → A: 切換策略後 daemon 必須重啟，所有 browser 連線重建。Notebook Registry（持久化在磁碟上）不受影響，但記憶體中的 agent session 會重建。
- Q: `--context` 選項是否必要？ → A: SHOULD（非 MUST）。這是提升 AI 工具體驗的增強功能，讓完成通知能帶上操作發起時的對話脈絡，幫助 AI 恢復上下文。
- Q: 為什麼 Skill Template 和 Agent Skill 是兩個不同的概念？ → A: Agent Skill 是 daemon 內部 agent 的操作定義（prompt + tools），控制 agent 如何操控 NotebookLM UI。AI Skill Template 是提供給外部 AI 工具的使用指南，教它如何呼叫 nbctl CLI。兩者面向不同的消費者。

### Session 2026-02-12 (v2 — 架構深化討論)

- Q: 多 notebook 並行怎麼做？ → A: 1 daemon, 1 Chrome (headless), N tabs。每個 notebook 一個 tab，由 Connection Manager 統一管理。跨 notebook 真正 parallel，同 notebook 內 serial。不需要多個 Chrome process。
- Q: 10 本 notebook 會開 10 個瀏覽器嗎？ → A: 不會。單一 Chrome 實例，多個 tab。Puppeteer 的 `browser.newPage()` 產生獨立的 Page 對象，各 tab 渲染互不干擾，headless 下可同時操作。
- Q: daemon 內部 AI agent session 如何各自操控瀏覽器？ → A: Connection Manager 為每個 notebook tab 產生 pageId 與 closure-bound tools。Agent 只拿到 pageId + tools（screenshot、click 等），不知道 Puppeteer 的存在。不同 agent session 操作不同 page reference，互不干擾，不需要多個 Puppeteer 連線。
- Q: 抽象層在哪裡？ → A: 在 Connection Manager 本身。Agent 只依賴 pageId + tools 介面，Connection Manager 內部封裝 Puppeteer/Patchright/其他實作。未來要換底層只動 Connection Manager，不動 agent。這比 v1 的 Browser Strategy pattern 更乾淨。
- Q: 瀏覽器 UI 必須可見嗎？ → A: 不必。Headless 模式下截圖仍可正常渲染。首次 Google 登入需 headed mode，之後 headless 背景執行，使用者桌面無可見視窗。
- Q: 多個外部 CLI session 同時使用時，通知如何 routing？ → A: 採 Notification Adapter 架構，per-tool best practice。Claude Code adapter 利用 hook stdin JSON 的 `session_id` 做 per-session inbox routing，每個 session 只收到自己的通知。不追求 lowest-common-denominator，每個工具做到最佳。
- Q: 為什麼不追求跨平台 general solution？ → A: 每個 AI CLI 工具的 hook 機制本來就不同，妥協到最低公約數會犧牲每個工具的最佳體驗。per-tool adapter 架構讓核心協議統一（inbox 格式、taskId lifecycle），delivery 機制各自最佳化。新增工具只需寫新 adapter。
- Q: 防止 AI 忘記查詢結果的機制？ → A: 多層提醒：(1) CLI 返回值包含 hint 欄位（提交當下）；(2) UserPromptSubmit hook 自動注入結果（Claude Code adapter）；(3) Stop hook 攔截未查的 urgent 通知；(4) Skill 模板中的防遺忘指引（行為引導）。

---

## 成功指標 *(mandatory)*

### Measurable Outcomes

**非同步操作效率**:
- **SC-100**: 非同步操作提交（`--async`）在 500 毫秒內返回 taskId。
- **SC-101**: `nbctl status` 查詢在 200 毫秒內返回結果。
- **SC-102**: 通知從操作完成到寫入 Inbox 的延遲不超過 1 秒。

**Multi-tab 並行效能**:
- **SC-113**: 同時操作 N 個 notebook（N ≤ 10）時，
  各 notebook 的操作互不阻塞，無可觀測的性能退化。
- **SC-114**: 單一 tab 崩潰後，Connection Manager 在 5 秒內偵測並回報，
  其他 tab 不受影響。

**通知可靠性**:
- **SC-103**: 非同步操作完成後，通知 100% 寫入 Inbox（不漏失）。
- **SC-104**: Claude Code adapter 正確 routing 通知到對應 session 的成功率 > 99%。
- **SC-105**: Hook 腳本執行時間 < 2 秒（不影響 AI 工具回應速度）。

**跨工具相容性**:
- **SC-106**: Skill Template 能被至少 2 種 AI CLI 工具
  （Claude Code + 一種其他工具）正確使用。
- **SC-107**: 不安裝 adapter 的情況下，使用者仍能透過
  `nbctl status` 完成所有非同步操作的結果查詢。

**Connection Manager 穩定性**:
- **SC-108**: 切換底層實作後，001-mvp 的所有操作
  （新增來源、查詢、Audio 等）成功率不低於原實作。
- **SC-109**: Connection Manager 錯誤以統一格式回報，agent 能正確處理
  所有錯誤類型，不因底層實作差異而產生未預期行為。

**使用者上手效率**:
- **SC-110**: 使用者能在 3 分鐘內完成 adapter 安裝
  （`nbctl install-hooks` 一個指令）。
- **SC-111**: 使用者能在 5 分鐘內將 Skill Template 載入 AI 工具
  並完成首次非同步操作。

**Skill 參數化靈活性**:
- **SC-112**: 修改 agent skill 的 prompt 後重啟 daemon，
  agent 在下一次操作中使用新 prompt，不需要重新編譯。

**Headless 模式**:
- **SC-115**: Headless 模式下 vision-based agent 的操作成功率
  與 headed 模式無顯著差異（< 5% 差距）。
- **SC-116**: 使用者完成首次 Google 登入後，後續所有 daemon 重啟
  自動以 headless mode 運作，無需再次手動介入。
