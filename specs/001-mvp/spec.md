# 功能規格書：NotebookLM Controller MVP

**Feature Branch**: `001-mvp`
**Created**: 2026-02-06
**Status**: Draft (v3 — 整併 002-abstract-cli-notify)
**Input**: PRD 文件 `docs/prd.md` + 架構重構討論

<!--
  v1 初始規格（2026-02-06）
  v2 對齊 Constitution v1.1.0，簡化指令模式（2026-02-07）
  v3 整併 002-abstract-cli-notify（2026-02-12）：
  1. 移除 MCP 整合（舊 FR-025~FR-027、舊 US13），
     改以 CLI + AI Skill + Notification Adapter 取代。
  2. 瀏覽器控制抽象化：Connection Manager 取代直連 iso-browser，
     底層自動化程式庫可替換（Puppeteer → Patchright）。
  3. 單一 browser + multi-tab 架構：1 daemon, 1 Chrome, N tabs。
     每個 notebook = 1 tab，跨 notebook parallel，同 notebook serial。
  4. Headless / headed 雙模式：daemon 自行管理 Chrome 生命週期，
     首次登入 headed，之後 headless。不再依賴外部 iso-browser。
  5. 非同步操作 + Notification Inbox + per-session routing。
  6. Notification Adapter（per-tool best practice, NOT lowest-common-denominator）。
  7. Agent Skill 參數化：操作技能以外部檔案定義，可調整不重編譯。
-->

## 使用者情境與測試 *(mandatory)*

<!--
  User Story 分為八類：
  - Part A: 基礎設施 (US1-US2)：Daemon 與 Notebook 管理
  - Part B: 資料餵入 (US3-US7)：將外部內容餵入 NotebookLM
  - Part C: 輔助功能 (US8-US9)：截圖除錯、狀態持久化
  - Part D: 查詢與使用 (US10-US12)：向 NotebookLM 查詢並使用知識
  - Part E: CLI + Skill + Notify 整合 (US13-US16)：非同步操作與通知
  - Part F: 瀏覽器抽象化 (US17-US18)：Connection Manager、Skill 參數化
  - Part G: 智慧選擇 (US19)：自動選擇最相關的 notebook
  - Part H: 命名與資源管理 (US20-US24)：命名、索引、歷程紀錄

  完整工作流：啟動 → 認證 → 納管 → 餵入 → 命名 → 查詢 → 使用
  即使只完成 US1-US3 + US10 + US13，就能完成核心流程。

  架構概要：
  - 1 daemon : 1 Chrome instance（headless/headed）: N tabs
  - Connection Manager 管理 Chrome 生命週期與 multi-tab
  - 每個 notebook 對應一個 tab + 獨立的 agent session
  - 跨 notebook parallel 執行，同 notebook 內 serial 執行
  - 透過 `--nb <id>` 指定操作目標，或 `nbctl use` 設定預設 notebook
  - 非同步操作：`--async` 立即返回 taskId，結果透過 Notification Inbox 送達
  - Notification Adapter：per-tool 最佳實作（Claude Code adapter = full push）

  指令模式：
  - 管理指令（結構化）：start/stop/status/list/open/close/use/add/add-all/reauth/skills
  - 操作指令（自然語言）：nbctl exec "<自然語言>" --nb <id> [--async]
  - 非同步管理：nbctl status <taskId> / nbctl status --all
  - Adapter 管理：nbctl install-hooks / uninstall-hooks / export-skill
-->

---

## Part A: 基礎設施 Stories

### User Story 1 - Daemon 生命週期管理 (Priority: P1)

身為開發者，我希望能透過 CLI 啟動與停止一個常駐 daemon，
讓它啟動 Chrome 瀏覽器並暴露 HTTP API，
作為所有後續操作的基礎設施。

Daemon 自行管理 Chrome 生命週期：
- 首次啟動（無有效 Google session）時以 headed mode 啟動 Chrome，
  讓使用者手動完成 Google 認證，cookies 持久化至 `~/.nbctl/profiles/`。
- 後續啟動載入 cookies，以 headless mode 運作，使用者桌面無瀏覽器視窗。
- Session 過期時提供 `nbctl reauth` 以 headed mode 重新認證。

**Why this priority**: 這是所有功能的基石。沒有 daemon 運行，
任何 notebook 操作都無法執行。必須最先完成。

**Independent Test**: 執行 `nbctl start`，確認 daemon 啟動、
Chrome 啟動、API 可存取；執行 `nbctl stop` 確認乾淨關閉。

**Acceptance Scenarios**:

1. **Given** 系統有有效的 Google session cookies（`~/.nbctl/profiles/`），
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 啟動為背景程序，以 headless mode 啟動 Chrome，
   輸出 JSON `{ "success": true, "port": 19224, "mode": "headless" }`，
   且 HTTP GET `localhost:19224/health` 回應 200。

2. **Given** 系統無有效的 Google session cookies（首次使用），
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 以 headed mode 啟動 Chrome，顯示瀏覽器視窗，
   導航至 Google 登入頁面，輸出提示 `{ "success": true, "port": 19224, "mode": "headed", "hint": "Complete Google login in the browser window." }`。
   使用者完成登入後 cookies 自動持久化。

3. **Given** daemon 正在執行，
   **When** 使用者執行 `nbctl status`，
   **Then** 輸出 JSON 包含 `{ "running": true, "browserConnected": true, "openNotebooks": [...], "defaultNotebook": null }`.

4. **Given** daemon 正在執行，
   **When** 使用者執行 `nbctl stop`，
   **Then** daemon 關閉所有 notebook tab、關閉 Chrome、釋放資源、程序結束，
   輸出 JSON `{ "success": true, "message": "Daemon stopped" }`。

5. **Given** Chrome 無法啟動（如 chromium 未安裝），
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 輸出錯誤 JSON `{ "success": false, "error": "Cannot launch Chrome: <reason>" }`，
   程序結束，不崩潰。

6. **Given** daemon 已在執行中（port 19224 已被佔用），
   **When** 使用者再次執行 `nbctl start`，
   **Then** 輸出錯誤 JSON `{ "success": false, "error": "Daemon already running on port 19224" }`，
   不啟動第二個 daemon 實例。

7. **Given** daemon 以 headless mode 運作但 Google session 已過期，
   **When** agent 偵測到認證失敗（頁面 redirect 到登入頁），
   **Then** daemon 通知使用者，相關操作回報錯誤
   `{ "success": false, "error": "Google session expired. Run 'nbctl reauth' to re-authenticate." }`。

8. **Given** daemon 正在執行且 Google session 已過期，
   **When** 使用者執行 `nbctl reauth`，
   **Then** daemon 以 headed mode 重新開啟 Chrome 視窗讓使用者完成登入，
   登入成功後切回 headless mode，輸出 `{ "success": true, "message": "Re-authenticated successfully" }`。

---

### User Story 2 - Notebook 管理與 Multi-tab 操作 (Priority: P2)

身為開發者，我希望能透過 CLI 註冊 NotebookLM notebook，
為其指派別名，並在 daemon 中同時開啟多個 notebook（各自一個 tab），
讓我能同時對不同 notebook 發出操作。

Daemon 採用 multi-tab 架構：每個 notebook 對應一個 Chrome tab，
跨 notebook 的操作可 parallel 執行，同一 notebook 內的操作 serial 執行。
使用 `--nb <id>` 指定操作目標，或用 `nbctl use` 設定預設 notebook。

對於我在 NotebookLM 中已有的大量 notebook，系統不主動處理，
而是提供 `add` 指令讓我選擇性地將想管理的 notebook 納入，
或使用 `add-all` 以交互式方式批次納管。

**Why this priority**: 必須能管理 notebook 才能執行任何 notebook 內操作。
依賴 US1 的 daemon 已啟動。既有 notebook 的納管是使用者的第一步操作，
大多數使用者已有 NotebookLM 帳號和既有的 notebook。

**Independent Test**: 開啟兩個 notebook，同時對兩個 notebook 發出操作，
驗證 parallel 執行。列出所有 notebook、關閉一個 notebook。
另外：使用 add 指令納管既有 notebook、使用 add-all 批次納管。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且 Chrome 已連線，
   **When** 使用者執行 `nbctl open https://notebooklm.google.com/notebook/xxx --name research`，
   **Then** daemon 在 Chrome 中開啟新 tab 並導航至該 URL，
   將 notebook 註冊為受管理 notebook，建立 agent session，
   輸出 JSON `{ "success": true, "id": "research", "url": "...", "status": "ready" }`。

2. **Given** 使用者已開啟 notebook "research" 和 "ml-papers"，
   **When** 使用者同時執行：
   ```
   nbctl exec "加來源" --nb research --async
   nbctl exec "問問題" --nb ml-papers --async
   ```
   **Then** 兩個操作在不同 tab 上 parallel 執行，各自獨立返回 taskId。

3. **Given** 已開啟多個 notebook，
   **When** 使用者執行 `nbctl list`，
   **Then** 輸出 JSON 陣列，每個 notebook 包含 description 與 tab 狀態：
   ```json
   [
     { "id": "research", "url": "...", "status": "ready", "tabOpen": true,
       "description": "包含專案認證模組與 API 文件的開發筆記" },
     { "id": "ml-papers", "url": "...", "status": "ready", "tabOpen": true,
       "description": "..." }
   ]
   ```

4. **Given** 已開啟 notebook "research"，
   **When** 使用者執行 `nbctl close research`，
   **Then** daemon 關閉該 notebook 的 tab 與 agent session，
   但保留 Notebook Registry 中的註冊資訊，
   輸出 JSON `{ "success": true }`,
   `nbctl list` 中該 notebook 顯示 `"tabOpen": false`。

5. **Given** daemon 執行中，
   **When** 使用者執行 `nbctl open <invalid-url> --name test`，
   **Then** 輸出錯誤 JSON `{ "success": false, "error": "Invalid NotebookLM URL" }`。

6. **Given** 使用者想設定預設 notebook 避免每次都帶 `--nb`，
   **When** 使用者執行 `nbctl use research`，
   **Then** 後續 `nbctl exec "..."` 自動對 "research" 操作，
   輸出 JSON `{ "success": true, "default": "research" }`。

7. **Given** 使用者的 NotebookLM 帳號中有多個既有 notebook，
   **When** 使用者執行 `nbctl add https://notebooklm.google.com/notebook/yyy --name ml-papers`，
   **Then** daemon 開啟 tab、導航至該 URL、掃描 notebook 狀態、
   將其納入管理並同步到 local cache，
   輸出 JSON `{ "success": true, "id": "ml-papers", "sources": [...], "title": "...", "description": "..." }`。

8. **Given** 使用者想批次納管所有既有 notebook，
   **When** 使用者執行 `nbctl add-all`，
   **Then** agent 導航至 NotebookLM 首頁，擷取所有 notebook 清單，
   依序展示每個 notebook 的標題與 URL，讓使用者選擇是否納管並指定別名，
   逐一完成後輸出 JSON 摘要 `{ "success": true, "added": 5, "skipped": 3, "notebooks": [...] }`。

9. **Given** 使用者在 `add-all` 過程中想跳過某些 notebook，
   **When** 使用者對某個 notebook 選擇「跳過」，
   **Then** 系統跳過該 notebook 繼續處理下一個，最終摘要中標記為 skipped。

10. **Given** 使用者執行 `nbctl exec "..." --nb <不存在的 notebook-id>`，
    **When** daemon 找不到該 notebook，
    **Then** 輸出錯誤 JSON `{ "success": false, "error": "Notebook '<id>' not found. Use 'nbctl list' to see registered notebooks." }`。

11. **Given** 已開啟的 notebook tab 數量達到上限（預設 10），
    **When** 使用者嘗試開啟新 notebook，
    **Then** 輸出錯誤 JSON `{ "success": false, "error": "Tab limit reached (10). Close an idle notebook with 'nbctl close <id>'." }`。

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

她用自然語言告訴 daemon 要做什麼：
$ nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb myproject

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
$ nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb myproject --async
→ 立即返回 taskId，完成後通知
```

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 已開啟且處於 ready 狀態，
   **When** 使用者執行 `nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb myproject`，
   **Then** agent 呼叫 repoToText 轉換 repo，執行 UI 操作新增為 text source，
   回應 JSON `{ "success": true, "sourceAdded": "my-project (repo)", "wordCount": 12345 }`。

2. **Given** repo 路徑不存在或不是 git repo，
   **When** 使用者執行上述指令，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Path is not a valid git repository" }`。

3. **Given** repo 轉換後超過 NotebookLM 的 500K 字限制，
   **When** 使用者執行上述指令，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Content exceeds 500K word limit (actual: 650K). Please split manually." }`。

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

$ nbctl exec "把 https://example.com/premium-article 的內容爬下來加入來源" --nb research

如果是公開 URL 可以直接用 NotebookLM 原生功能：
$ nbctl exec "加入連結來源 https://example.com/public-page" --nb research
```

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟，
   **When** 使用者執行 `nbctl exec "把 https://example.com/article 的內容爬下來加入來源" --nb research`，
   **Then** agent 呼叫 urlToText 擷取並轉換內容，新增為 text source，
   回應 JSON `{ "success": true, "sourceAdded": "example.com/article (web)", "wordCount": 3500 }`。

2. **Given** 使用者想直接使用 NotebookLM 原生 URL 功能，
   **When** 使用者執行 `nbctl exec "加入連結來源 https://example.com/public-page" --nb research`，
   **Then** agent 在 UI 中選擇「Link」選項，直接貼上 URL，
   回應 JSON `{ "success": true, "sourceAdded": "https://example.com/public-page", "type": "url" }`。

---

### User Story 5 - 將 PDF 文件餵入 NotebookLM (Priority: P5)

身為研究者，我希望能將本地 PDF 文件轉換後新增為 NotebookLM 來源，
避免透過 Google Drive 上傳的繁瑣流程。

**Why this priority**: PDF 是學術論文的主要格式，
能直接從本地新增 PDF 大幅簡化研究者的工作流程。

**Independent Test**: 指定一個 PDF 檔案路徑，內容應被轉換並新增為來源。

**Acceptance Scenarios**:

1. **Given** notebook "research" 已開啟，
   **When** 使用者執行 `nbctl exec "把 /path/to/paper.pdf 加入來源" --nb research`，
   **Then** agent 呼叫 pdfToText 轉換 PDF，新增為 text source，
   回應 JSON `{ "success": true, "sourceAdded": "paper (PDF)", "pages": 12, "wordCount": 8500 }`。

2. **Given** PDF 檔案損壞或無法解析，
   **When** 使用者執行上述指令，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Failed to parse PDF: <reason>" }`。

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

$ nbctl exec "產生 audio overview" --nb podcast-prep --async
→ { "taskId": "xyz", "status": "queued" }

# 幾分鐘後，操作完成通知送達...

$ nbctl exec "下載 audio 到 ~/podcast/episode-draft.wav" --nb podcast-prep
→ { "success": true, "path": "~/podcast/episode-draft.wav", "duration": "8:32" }
```

**Acceptance Scenarios**:

1. **Given** notebook "podcast" 有至少一個來源，
   **When** 使用者執行 `nbctl exec "產生 audio overview" --nb podcast`，
   **Then** agent 在 UI 中點擊產生 audio 的按鈕，
   回應 JSON `{ "success": true, "status": "generating", "estimatedTime": "5-10 minutes" }`。

2. **Given** audio 正在產生中，
   **When** 使用者執行 `nbctl exec "audio 狀態？" --nb podcast`，
   **Then** 回應 JSON `{ "status": "generating" }` 或 `{ "status": "ready" }`。

3. **Given** audio 已產生完成，
   **When** 使用者執行 `nbctl exec "下載 audio 到 /path/output.wav" --nb podcast`，
   **Then** agent 點擊下載按鈕，攔截下載並儲存到指定路徑，
   回應 JSON `{ "success": true, "path": "/path/output.wav", "size": "15.2MB" }`。

4. **Given** notebook 沒有任何來源，
   **When** 使用者嘗試產生 audio，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Notebook has no sources. Add sources before generating audio." }`。

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
   **When** 使用者執行 `nbctl exec "列出所有來源" --nb myproject`，
   **Then** agent 掃描 NotebookLM UI 中的來源面板，
   回應 JSON 包含完整的來源清單與各自狀態。

2. **Given** 使用者想知道 notebook 的整體狀態，
   **When** 使用者執行 `nbctl exec "目前 notebook 的狀態？" --nb myproject`，
   **Then** 回應 JSON 包含 notebook 全貌：來源清單、audio 狀態、notebook 標題等。

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
   **When** 使用者執行 `nbctl exec "截圖" --nb research`，
   **Then** 回應 JSON `{ "success": true, "screenshot": "base64...", "timestamp": "..." }`。

2. **Given** notebook "research" 已開啟，
   **When** 使用者執行 `nbctl exec "截圖存到 /tmp/screen.png" --nb research`，
   **Then** 截圖儲存至指定路徑，回應 JSON `{ "success": true, "path": "/tmp/screen.png" }`。

---

### User Story 9 - 狀態持久化與復原 (Priority: P9)

身為開發者，我希望 daemon 能將已註冊的 notebook 清單持久化到磁碟，
重啟後能復原先前的 notebook 註冊資訊，避免重新設定。

**Why this priority**: 提升使用體驗，daemon 重啟不需重新註冊所有 notebook。

**Independent Test**: 註冊 notebook、停止 daemon、重啟 daemon，
驗證 notebook 清單恢復。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且註冊了 notebook "research"（tab 已開啟），
   **When** 執行 `nbctl stop` 後再執行 `nbctl start`，
   **Then** `nbctl list` 仍包含 "research"（`tabOpen: false`），
   使用者可透過 `nbctl open research` 重新開啟 tab。

2. **Given** 先前 session 有 notebook，但對應 URL 已不存在，
   **When** daemon 嘗試復原，
   **Then** 標記該 notebook 為 stale，不阻塞其他 notebook 復原。

---

## Part D: 查詢與使用 Stories

### User Story 10 - 向 Notebook 提問並取得 Grounded 回答 (Priority: P10)

身為使用 AI coding tool 的開發者，我已經將專案程式碼餵入 NotebookLM，
現在我希望能直接透過 CLI 向 NotebookLM 提問，取得基於我上傳來源的
grounded 回答（帶來源引用），而不需要手動切換到瀏覽器操作。

**Why this priority**: 這是完成「餵入 → 查詢 → 使用」工作流的關鍵環節。

**Independent Test**: 對已有來源的 notebook 執行查詢指令，
驗證回應包含 grounded 答案與來源引用。

**使用情境描述**:

```
開發者 Alice 已透過 nbctl 將她的專案程式碼餵入 notebook "myproject"。

$ nbctl exec "這個專案的認證流程是怎麼運作的？" --nb myproject

Agent 自動：
1. 判斷這是一個查詢（而非操作指令）
2. 在 NotebookLM UI 的對話區域輸入問題
3. 等待 Gemini 產生回答
4. 擷取回答文字與來源引用
5. 以結構化 JSON 回傳
```

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 已開啟且有至少一個來源，
   **When** 使用者執行 `nbctl exec "這個專案的認證流程是怎麼運作的？" --nb myproject`，
   **Then** agent 在 NotebookLM 對話區輸入問題、等待回答、擷取結果，
   回應 JSON 包含 `answer` 欄位與 `citations` 陣列。

2. **Given** notebook 沒有任何來源，
   **When** 使用者執行 `nbctl exec "任何問題" --nb empty-nb`，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Notebook has no sources. Add sources before asking questions." }`。

3. **Given** 使用者未指定 `--nb` 且無預設 notebook，
   **When** 使用者執行 `nbctl exec "任何問題"`，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "No target notebook. Use '--nb <id>' or set default with 'nbctl use <id>'." }`。

4. **Given** NotebookLM 回答產生超時，
   **When** 使用者正在等待回答，
   **Then** 回應 JSON `{ "success": false, "error": "Response timed out", "screenshot": "base64..." }`，
   附帶當前畫面截圖供除錯。

---

### User Story 11 - 對話歷史保持與多輪對話 (Priority: P11)

身為研究者，我希望能對同一個 notebook 進行多輪連續提問，
每一輪都能參考前一輪的對話脈絡。

每個 notebook 有獨立的 agent session，對話歷史自然保持在該 session 中。

**Why this priority**: 單次提問的價值有限，研究者通常需要
透過多輪追問來深入理解某個主題。

**Independent Test**: 連續提問兩個相關問題，驗證第二個回答
能參考第一輪的對話脈絡。

**Acceptance Scenarios**:

1. **Given** 使用者已對 notebook "research" 提問了「這篇論文的方法論是什麼？」並收到回答，
   **When** 使用者再執行 `nbctl exec "這個方法的局限性是什麼？" --nb research`，
   **Then** agent 在同一個 NotebookLM 對話 session 中輸入追問，
   回答能正確參考前一輪的脈絡。

2. **Given** 使用者想開始全新的對話（不帶歷史），
   **When** 使用者執行 `nbctl exec "開始新對話，然後問：這篇論文的結論是什麼？" --nb research`，
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
   **When** 使用者執行 `nbctl exec "摘要這篇論文，結果存到 ~/notes/summary.md" --nb research`，
   **Then** 回答以 Markdown 格式寫入指定檔案，
   同時在 stdout 回應 JSON `{ "success": true, "outputPath": "~/notes/summary.md" }`。

2. **Given** 輸出路徑的目錄不存在，
   **When** 使用者執行上述指令，
   **Then** 系統自動建立目錄並儲存檔案。

---

## Part E: CLI + Skill + Notify 整合 Stories

### User Story 13 - 非同步操作提交與結果查詢 (Priority: P13)

身為使用 AI coding tool 的開發者，我希望透過 CLI 提交操作後能立即返回，
不需要等待操作完成，讓我的 AI 工具可以繼續做其他工作。
當操作完成時，我能透過 CLI 查詢結果。

**Why this priority**: 這是 CLI + Skill 整合模式的基礎。
沒有非同步操作支援，使用者的 AI 工具在等待 NotebookLM 操作時會完全 blocking，
無法做其他事情。非同步是讓 CLI 模式優於 MCP 的關鍵特性。

**Independent Test**: 以非同步模式提交一個操作，確認立即返回 taskId；
之後查詢該 taskId，驗證能取得操作結果。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且 notebook 已開啟，
   **When** 使用者執行 `nbctl exec "把 repo 加入來源" --nb alpha --async`，
   **Then** CLI 立即返回 JSON：
   ```json
   { "taskId": "abc123", "status": "queued", "notebook": "alpha",
     "hint": "Use 'nbctl status abc123' to check result later." }
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
   **When** 使用者執行 `nbctl exec "截圖" --nb alpha`（不帶 `--async`），
   **Then** CLI 等待操作完成後才返回結果（同步行為，向下相容）。

7. **Given** 使用者同時對不同 notebook 提交非同步操作，
   **When** 使用者執行：
   ```
   nbctl exec "加來源" --nb alpha --async
   nbctl exec "問問題" --nb beta --async
   ```
   **Then** 兩個操作在不同 tab 上 parallel 執行，各自獨立返回 taskId。

---

### User Story 14 - 操作完成自動通知 (Priority: P14)

身為使用 AI coding tool 的開發者，我希望非同步操作完成後，
結果能自動出現在我的 AI 工具的對話中，而不需要我主動查詢。

**Why this priority**: 僅靠 `nbctl status` 查詢是 pull-based。
自動通知讓體驗接近「提交即忘」，大幅提升使用流暢度。

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
   **Then** AI 工具收到錯誤通知，能向使用者說明失敗原因。

4. **Given** 沒有任何待處理通知，
   **When** AI 工具正常互動時，
   **Then** 沒有額外通知注入，不影響正常操作。

5. **Given** 使用者使用不支援 adapter 的 AI 工具（generic fallback），
   **When** 非同步操作完成後，
   **Then** 使用者可透過 `nbctl status --recent` 手動查詢所有近期完成的操作。

---

### User Story 15 - AI Skill 引導整合 (Priority: P15)

身為使用 AI coding tool 的開發者，我希望能透過安裝一個 Skill（prompt template），
讓我的 AI 工具自動學會如何使用 nbctl，包括非同步工作流和結果處理。

**Why this priority**: CLI 指令本身是機器友好的，但 AI 工具需要
一份「操作手冊」才能有效使用。Skill 是這份手冊的結構化表達。

**Independent Test**: 在 AI 工具中載入 Skill 後，
告訴 AI「把我的專案程式碼加入 NotebookLM」，
AI 能自動使用正確的 nbctl 指令完成操作。

**Acceptance Scenarios**:

1. **Given** AI 工具已載入 nbctl Skill，
   **When** 使用者告訴 AI「把 ~/code/my-project 加入 NotebookLM 來源」，
   **Then** AI 自動執行 `nbctl exec "把 ~/code/my-project 的程式碼加入來源" --nb <id> --async`，
   並向使用者說明已提交操作。

2. **Given** AI 工具已載入 nbctl Skill 且收到操作完成通知，
   **When** 通知內容為成功，
   **Then** AI 向使用者報告成功結果。

3. **Given** AI 工具已載入 nbctl Skill，
   **When** 使用者問「NotebookLM 裡有哪些 notebook？」，
   **Then** AI 自動執行 `nbctl list` 並以人類可讀的方式呈現結果。

---

### User Story 16 - Notification Adapter 安裝 (Priority: P16)

身為開發者，我希望能透過一個指令自動安裝適合我 AI CLI 工具的
通知 adapter，不需要手動編輯設定檔。系統會針對我的工具
提供最佳的通知體驗，而不是妥協到最低公約數的方案。

**Why this priority**: 每個 AI CLI 工具的 hook 機制不同，
per-tool adapter 能充分利用各工具的能力。自動安裝降低上手門檻。

**Independent Test**: 執行安裝指令後，驗證 adapter 設定檔已正確產生，
且下次 AI 工具互動時通知機制正常運作。

**Acceptance Scenarios**:

1. **Given** 使用者使用 Claude Code 且未安裝 nbctl adapter，
   **When** 使用者執行 `nbctl install-hooks --tool claude-code`，
   **Then** 系統安裝 Claude Code 專屬 adapter：
   設定 `UserPromptSubmit` 和 `Stop` hook，
   利用 stdin JSON 的 `session_id` 實現 per-session routing，
   輸出 JSON `{ "success": true, "tool": "claude-code", "adapter": "per-session-push", "hooks": ["UserPromptSubmit", "Stop"] }`。

2. **Given** 使用者使用尚未有專屬 adapter 的 AI 工具，
   **When** 使用者執行 `nbctl install-hooks --tool unknown-tool`，
   **Then** 系統安裝 generic adapter（pull-based），
   輸出 JSON `{ "success": true, "tool": "unknown-tool", "adapter": "generic-pull", "hint": "Use 'nbctl status --recent' to check results." }`。

3. **Given** 使用者已安裝過 adapter，
   **When** 使用者再次執行 `nbctl install-hooks --tool claude-code`，
   **Then** 系統偵測已存在的 adapter，提示是否要更新。

4. **Given** 使用者想移除 adapter，
   **When** 使用者執行 `nbctl uninstall-hooks --tool claude-code`，
   **Then** 系統移除先前安裝的 adapter 設定，
   輸出 JSON `{ "success": true, "removed": ["UserPromptSubmit", "Stop"] }`。

---

## Part F: 瀏覽器抽象化 Stories

### User Story 17 - Connection Manager 與底層可替換 (Priority: P17)

身為系統維護者，我希望 daemon 的瀏覽器控制層有統一的抽象介面，
讓底層自動化程式庫能被替換（如從 Puppeteer 切到 Patchright），
而不需要修改 agent 邏輯或 skill 定義。

Connection Manager 是 daemon 與瀏覽器之間的唯一抽象層：
- 管理 Chrome 生命週期（啟動、關閉、健康檢查）
- 管理 tab（每個 notebook 一個 tab，建立與銷毀）
- 為每個 tab 產生 pageId + closure-bound tools
- Agent 只透過 pageId + tools 操作，不知道底層實作

**Why this priority**: Connection Manager 抽象讓底層可替換，
確保當 NotebookLM 強化 bot 偵測時能快速因應。

**Independent Test**:
(a) 同時對兩個 notebook 發出操作，驗證 parallel 執行。
(b) 在設定檔中切換底層實作，重啟 daemon 後所有操作仍正常。

**Acceptance Scenarios**:

1. **Given** daemon 使用預設實作（Puppeteer + vision-based），
   **When** 使用者執行所有標準操作（新增來源、查詢、產生 audio 等），
   **Then** 操作結果正確。

2. **Given** 系統管理者在設定檔中切換了底層實作，
   **When** daemon 重新啟動，
   **Then** daemon 使用新實作運作，agent 與 skill 不受影響。

3. **Given** 底層實作出現錯誤（例如截圖失敗），
   **When** agent 嘗試操作，
   **Then** 錯誤以統一的格式回報，不因底層差異而產生不同錯誤路徑。

4. **Given** 單一 tab 崩潰或 unresponsive，
   **When** Connection Manager 偵測到異常，
   **Then** 只有該 tab 受影響，其他 tab 正常運作，
   Connection Manager 回報健康狀態並支援單一 tab 重建。

---

### User Story 18 - Agent Skill 參數化 (Priority: P18)

身為系統維護者，我希望 agent 的操作技能（如「新增來源」「查詢提問」
「產生 Audio」）以參數化的 skill 定義存在，讓我能調整 prompt 和
tool 組合，而不需要修改程式碼。

**Why this priority**: NotebookLM 的 UI 可能隨時間變化，
agent 的操作策略也需要持續調整。將 skill 定義外部化，
讓調整操作流程只需修改 skill 檔案。

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
   使用者未指定 `--nb` 也無預設 notebook，
   **When** 使用者執行 `nbctl exec "這個機器學習模型的 loss function 是什麼？"`，
   **Then** 系統根據各 notebook 的 description 與來源名稱比對指令內容，
   建議 "ml-papers"，並詢問使用者確認後執行查詢。

2. **Given** 使用者已有預設 notebook 但指令內容明顯與其他 notebook 更相關，
   **When** agent 判斷需要切換，
   **Then** agent 先詢問使用者確認是否切換 notebook。

---

## Part H: 命名與資源管理 Stories

### User Story 20 - 來源重命名與標記 (Priority: P20)

身為使用者，我希望透過 nbctl 新增的來源能有清楚的命名，
而不是 NotebookLM 自動產生的模糊名稱（如「Pasted text」）。
系統 MUST 在新增後自動重命名為有意義的名稱。

**Why this priority**: NotebookLM 的自動命名非常不直觀。
好的命名是所有後續資源管理的基礎。

**Independent Test**: 新增一個 repo 來源後，在 NotebookLM UI 中
確認來源名稱已被重命名為有意義的名稱。

**Acceptance Scenarios**:

1. **Given** 透過 nbctl 新增了一個 repo 來源，
   **When** 來源新增完成後，
   **Then** agent 自動在 NotebookLM UI 中將來源重命名為
   `<repo-name> (repo)` 格式。

2. **Given** 透過 nbctl 新增了一個 PDF 來源，
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<pdf-filename> (PDF)` 格式。

3. **Given** 透過 nbctl 新增了一個 URL 來源（crawl 方式），
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<domain/path> (web)` 格式。

4. **Given** 使用者想手動重命名某個來源，
   **When** 使用者執行 `nbctl exec "把來源 '<current-name>' 改名為 '<new-name>'" --nb <id>`，
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

1. **Given** 使用者已透過 nbctl 管理了多個 notebook 與來源，
   **When** 使用者執行 `nbctl exec "列出所有資源索引" --nb <id>`，
   **Then** 回應 JSON 包含完整資源索引，每個來源含 origin、addedAt、重命名紀錄。

2. **Given** 使用者透過 nbctl 觸發了 audio 或文章產生，
   **When** 產生完成後，
   **Then** local cache 自動記錄該 artifact 的產生 prompt、時間與路徑。

---

### User Story 22 - Prompt 與操作歷程紀錄 (Priority: P22)

身為使用者，我希望所有透過 nbctl 對 notebook 執行的操作都有操作紀錄，
包括當時使用的 prompt 和結果摘要，方便日後追溯。

**Why this priority**: 操作歷程是長期可維護性的關鍵。

**Independent Test**: 執行幾個操作後，查看操作歷程，驗證完整。

**Acceptance Scenarios**:

1. **Given** 使用者對 notebook 執行了多個操作，
   **When** 使用者執行 `nbctl exec "列出操作歷史" --nb <id>`，
   **Then** 回應 JSON 陣列，每筆包含 timestamp、action type、指令文字、result summary。

2. **Given** 使用者想查看某個特定 artifact 的來歷，
   **When** 使用者執行 `nbctl exec "這個 audio 是怎麼來的？" --nb <id>`，
   **Then** agent 查詢 local cache，回應包含產生它的原始 prompt。

---

### User Story 23 - Notebook 標題管理 (Priority: P23)

身為使用者，我希望能透過 nbctl 重命名 notebook 的標題。

**Why this priority**: 與來源重命名同理，notebook 標題的可讀性
是資源管理體驗的一環。

**Acceptance Scenarios**:

1. **Given** notebook 的 NotebookLM 標題為自動產生的模糊名稱，
   **When** 使用者執行 `nbctl exec "把 notebook 標題改為 '2026 Q1 ML 論文集'" --nb ml-papers`，
   **Then** agent 在 NotebookLM UI 中修改標題，local cache 同步更新，
   回應 JSON `{ "success": true, "oldTitle": "...", "newTitle": "2026 Q1 ML 論文集" }`。

---

### User Story 24 - 資源清單的人類可讀輸出 (Priority: P24)

身為使用者，我希望除了 JSON 格式外，還能以人類可讀的表格
或 Markdown 格式查看資源清單。

**Why this priority**: JSON 適合程式處理但不適合人類閱讀。

**Acceptance Scenarios**:

1. **Given** 使用者管理了多個 notebook，
   **When** 使用者執行 `nbctl exec "用表格列出所有 notebook 和來源" --nb <id>`，
   **Then** 回應為格式化的 CLI 表格。

2. **Given** 使用者想匯出資源清單，
   **When** 使用者執行 `nbctl exec "把所有資源清單匯出為 Markdown 到 ~/notes/catalog.md" --nb <id>`，
   **Then** 輸出完整的 Markdown 格式資源清單到指定檔案。

---

### Edge Cases

**基礎設施**:
- **Chrome 無法啟動**：daemon 回報清楚錯誤訊息，不崩潰。
- **Google session 過期**：daemon 偵測認證失敗（302 redirect 到登入頁），
  通知使用者執行 `nbctl reauth`，期間操作回報認證錯誤。
- **Headless mode 截圖正確性**：headless 下 `page.screenshot()` 渲染
  MUST 與 headed 一致（viewport size、DPI），確保 vision-based agent 準確。

**Multi-tab**:
- **Tab 崩潰隔離**：單一 tab 崩潰不影響其他 tab。
  Connection Manager 偵測並回報，支援單一 tab 重建。
- **Tab 數量上限**：同時開啟的 tab 數量 SHOULD 有可設定上限（預設 10），
  超過時回報錯誤並建議關閉閒置 notebook。
- **同 notebook 多個操作**：per-notebook queue 序列化。
- **跨 notebook 操作**：parallel 執行，互不干擾。

**非同步與通知**:
- **Inbox 檔案累積**：daemon 定期清理超過 24 小時的已消費通知。
  未消費的通知不自動清除。
- **Per-session routing**：每個 CLI session 有獨立的 inbox 子目錄，
  不存在跨 session 搶讀。
- **Hook 執行失敗**：hook 超時或錯誤不影響 AI 工具正常操作。
  通知保留在 Inbox，下次 hook 觸發時重試。
- **daemon 未啟動時執行 CLI**：回報清楚錯誤訊息。
- **非同步操作提交後 daemon 關閉**：未完成操作標記為 cancelled，
  通知寫入 Inbox。
- **通知 consume 原子性**：使用 rename 而非 delete，保留 audit trail。
- **通知優先級**：失敗操作（urgent）優先送達，Stop hook 中強制處理。

**瀏覽器抽象**:
- **底層實作切換後**：daemon 重建所有連線與 tab，
  Notebook Registry 不受影響，agent session 重建。
- **Skill 檔案格式錯誤**：daemon 啟動時驗證，格式錯誤的 skill 被跳過，
  記錄警告日誌，不阻塞 daemon 啟動。

**內容與互動**:
- **NotebookLM UI 更新**：vision-based agent 應能適應 UI 變化，
  若關鍵元素無法辨識，回報錯誤而非崩潰。
- **超大內容超過 500K 字限制**：回報錯誤建議使用者手動分割。
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
- **AI 工具無專屬 adapter**：使用者可透過 `nbctl status` 手動查詢。

---

## 需求 *(mandatory)*

### Functional Requirements

**Daemon & CLI**:
- **FR-001**: 系統 MUST 提供 `nbctl` CLI，支援以下結構化管理指令：
  `start`、`stop`、`status`、`list`、`open`、`close`、`use`、`add`、`add-all`、
  `reauth`、`skills`、`install-hooks`、`uninstall-hooks`、`export-skill`。
- **FR-002**: 系統 MUST 提供 `nbctl exec "<自然語言>" --nb <notebook-id>` 指令，
  將自然語言指令傳送給該 notebook 的 agent session。
  未指定 `--nb` 時使用預設 notebook（由 `nbctl use` 設定）。
- **FR-003**: 系統 MUST 將 daemon 作為背景程序執行，暴露 HTTP API 於 127.0.0.1:19224
  （僅 localhost binding，不加額外認證）。若 port 已被佔用，MUST 回報錯誤。
- **FR-004**: Daemon MUST 自行管理單一 Chrome 實例的生命週期（啟動、關閉、健康檢查），
  支援 multi-tab 架構：每個 notebook 對應一個 tab，由 Connection Manager 統一管理。
- **FR-005**: 所有 CLI 輸出 MUST 為 JSON 格式（stdout），錯誤訊息亦為 JSON。
- **FR-006**: 系統 MUST 支援 `nbctl use <notebook-id>` 指令設定預設 notebook，
  後續 `nbctl exec` 不帶 `--nb` 時自動使用此 notebook。

**Agent 能力**:
- **FR-007**: Agent MUST 能透過 vision model 理解 NotebookLM UI 狀態。
- **FR-008**: Agent MUST 提供 browser tools（screenshot, click, type, scroll, paste, downloadFile），
  透過 Connection Manager 的 pageId + bound tools 介面操作。
- **FR-009**: Agent MUST 提供 content tools：
  - repoToText：將 git repo 轉換為單一文字
  - urlToText：將網頁轉換為 Markdown
  - pdfToText：將 PDF 轉換為 Markdown
- **FR-010**: Agent MUST 能解讀自然語言指令，判斷使用者意圖，並自主呼叫對應 tools。

**NotebookLM 互動**:
- **FR-011**: 系統 MUST 支援透過「Copied text」方式新增文字來源。
- **FR-012**: 系統 MUST 支援透過「Link」方式新增 URL 來源。
- **FR-013**: 系統 MUST 支援觸發 Audio Overview 產生。
- **FR-014**: 系統 MUST 支援下載已產生的 Audio Overview 到本機檔案。
- **FR-015**: 系統 MUST 能擷取 notebook 當前來源清單與狀態。

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

**智慧選擇**:
- **FR-028**: Agent MUST 能在使用者未指定 notebook 時，根據指令內容
  與各 notebook 的 description 及來源元資料，建議最相關的 notebook。
- **FR-029**: 智慧選擇 MUST 預設詢問使用者確認後再切換 notebook。

**操作排隊與觀測**:
- **FR-030**: 每個 notebook tab MUST 有獨立的 operation queue。
  同一 notebook 內的操作 MUST 序列化執行（serial），
  不同 notebook 的操作 MUST 可 parallel 執行。
  純讀取記憶體狀態的指令（`list`、`status`）MUST 即時回應，不進入佇列。
- **FR-031**: 每個操作 MUST 有 timeout 機制避免無窮等待，
  超時回傳錯誤與截圖。具體 timeout 數值依操作類型於實測後決定。

**既有 Notebook 納管**:
- **FR-032**: 系統 MUST 提供 `nbctl add <url> --name <alias>` 指令，
  將既有 NotebookLM notebook 納入管理。
- **FR-033**: `add` 指令 MUST 導航至 notebook URL、掃描其來源清單與標題、
  同步到 local cache。
- **FR-034**: 系統 MUST 提供 `nbctl add-all` 指令，
  以交互式方式批次納管使用者帳號中的所有 notebook。
- **FR-035**: `add-all` MUST 依序展示每個 notebook 的標題與 URL，
  讓使用者選擇是否納管並指定別名。

**來源重命名**:
- **FR-036**: 系統 MUST 在透過「Copied text」方式新增來源後，
  自動將來源重命名為有意義的名稱。
- **FR-037**: 來源重命名規則：repo → `<repo-name> (repo)`；
  PDF → `<filename> (PDF)`；URL crawl → `<domain/path> (web)`。
- **FR-038**: Agent MUST 能根據使用者自然語言指令，
  在 NotebookLM UI 中執行來源或 notebook 標題重命名。

**結構化 Local Cache**:
- **FR-039**: 系統 MUST 維護本機結構化 cache，記錄每個 notebook 的
  所有來源與 artifacts 的完整元資料。
- **FR-040**: Local cache 中的每個來源 MUST 記錄 origin 資訊
  （type、原始路徑/URL、新增時間）。
- **FR-041**: Local cache 中的每個 artifact MUST 記錄產生它的原始 prompt 與時間。

**操作歷程**:
- **FR-042**: 系統 MUST 記錄所有透過 nbctl exec 執行的操作歷程。
- **FR-043**: Agent MUST 能根據使用者指令查詢並回傳操作歷程。

**同步**:
- **FR-044**: Agent MUST 能根據使用者指令，重新從 NotebookLM UI
  同步 notebook 狀態到 local cache。

**Notebook Description 自動維護**:
- **FR-045**: 系統 MUST 在 add/open notebook 後，由 agent 根據 notebook
  的來源清單自動產生 1-2 句 description。
- **FR-046**: 每次來源異動後，系統 MUST 自動更新 description。
- **FR-047**: Agent MUST 能根據使用者 exec 指令手動覆寫 description。

**認證**:
- **FR-048**: Daemon MUST 自行管理 Chrome 的 Google 認證。
  Cookies 持久化至 `~/.nbctl/profiles/`，支援跨 session 重用。
- **FR-049**: 系統 MUST 支援首次啟動以 headed mode 完成 Google 登入，
  後續以 headless mode 運作。
- **FR-050**: 若 agent 在操作過程中遇到未登入狀態，MUST 回報錯誤
  並提示使用者執行 `nbctl reauth`。

**結構化日誌**:
- **FR-051**: Daemon MUST 對每個 agent 操作步驟記錄結構化日誌
  （進入/退出時間、tool 呼叫、截圖事件、錯誤），
  確保能事後診斷卡住或異常的操作。

**非同步 CLI 操作** (FR-100 series):
- **FR-100**: 系統 MUST 支援 `nbctl exec "<自然語言>" --nb <notebook-id> --async` 模式，
  立即返回 `{ "taskId": "<id>", "status": "queued", "notebook": "<notebook-id>", "hint": "..." }`。
- **FR-101**: 系統 MUST 支援 `nbctl status <taskId>` 查詢特定操作的狀態與結果。
- **FR-102**: 系統 MUST 支援 `nbctl status --all` 列出所有近期操作（預設最近 20 筆）。
  MUST 支援 `--nb <notebook-id>` 篩選。
- **FR-103**: `nbctl exec` 不帶 `--async` 時 MUST 維持同步行為。
- **FR-104**: `nbctl exec --async` SHOULD 支援 `--context "<描述>"` 選項，
  附帶操作情境描述，出現在完成通知中。
- **FR-105**: `nbctl exec --async` 的返回 JSON MUST 包含 `hint` 欄位，
  作為防遺忘的第一層提醒。

**通知 Inbox** (FR-110 series):
- **FR-110**: Daemon MUST 在非同步操作完成後，將結果寫入通知 Inbox 目錄。
- **FR-111**: Inbox 目錄結構 MUST 支援 per-session routing：
  `~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`。
  未提供 session-id 時寫入 `~/.nbctl/inbox/_default/<priority>/`。
- **FR-112**: 每個通知 MUST 為獨立的 JSON 檔案，
  內容包含 taskId、status、result、notebook、originalContext、timestamp、sessionId。
- **FR-113**: Daemon MUST 自動清理超過 24 小時的已消費通知。
- **FR-114**: 通知檔案寫入 MUST 為原子操作（先寫暫存檔再 rename）。
- **FR-115**: 通知消費 MUST 使用 rename 到 `consumed/`，保留 audit trail。

**Notification Adapter** (FR-120 series):
- **FR-120**: 系統 MUST 定義 Notification Adapter 介面，
  包含 `install(toolName)`、`uninstall(toolName)`、`consume(sessionId)` 操作。
- **FR-121**: 系統 MUST 提供 `nbctl install-hooks --tool <tool-name>`。
- **FR-122**: 系統 MUST 提供 `nbctl uninstall-hooks --tool <tool-name>`。
- **FR-123**: 首批 MUST 實作：
  - **claude-code adapter**：full push + per-session routing。
    `UserPromptSubmit` hook 讀取 session inbox，輸出結果到 stdout。
    `Stop` hook 檢查 urgent 通知，有則 exit 2 阻止停止。
  - **generic adapter**：pull-based fallback（`nbctl status --recent`）。
- **FR-124**: Claude Code adapter 的 `UserPromptSubmit` hook MUST：
  (a) 從 stdin JSON 解析 `session_id`，
  (b) 讀取 `~/.nbctl/inbox/<session_id>/` 下的所有通知，
  (c) 以結構化純文字格式輸出到 stdout，
  (d) 將已讀通知 rename 到 `consumed/`。
- **FR-125**: Claude Code adapter 的 `Stop` hook MUST：
  (a) 從 stdin JSON 解析 `session_id`，
  (b) 檢查 urgent 通知，有則 exit 2 阻止停止，
  (c) normal 通知僅輸出提醒。
- **FR-126**: Adapter hook 腳本 timeout MUST 不超過 5 秒。
- **FR-127**: Hook 腳本安裝在 `~/.nbctl/hooks/` 目錄下。

**Skill 模板** (FR-130 series):
- **FR-130**: 系統 MUST 提供結構化的 AI Skill 模板檔案，
  教導 AI 工具如何使用 nbctl CLI。
- **FR-131**: Skill 模板 MUST 包含：可用指令、非同步工作流、通知處理、
  手動查詢 fallback、防遺忘指引。
- **FR-132**: Skill 模板 MUST 不綁定特定 AI CLI 工具。
- **FR-133**: 系統 MUST 提供 `nbctl export-skill` 指令輸出 Skill 模板。

**Connection Manager** (FR-140 series):
- **FR-140**: 系統 MUST 實作 Connection Manager，作為 daemon 與瀏覽器之間的
  唯一抽象層。負責：Chrome 生命週期、tab 建立/銷毀、
  pageId + bound tools 產生、cookies 持久化。
- **FR-141**: Connection Manager MUST 對外暴露以 pageId 為單位的操作介面：
  `screenshot(pageId)`、`click(pageId, x, y)`、`type(pageId, text)`、
  `navigate(pageId, url)`、`scroll(pageId, direction)`、`paste(pageId, content)`、
  `download(pageId)`、`healthcheck(pageId)`。
- **FR-142**: Connection Manager 底層實作 MUST 可替換。
  預設為 Puppeteer（vision-based）。
- **FR-143**: 底層實作 MUST 可透過設定檔指定。
- **FR-144**: 所有底層實作 MUST 使用統一的錯誤格式回報，
  包含錯誤類型（連線失敗、tab 崩潰、操作逾時、認證過期）
  與建議動作（重試、重建 tab、截圖、重新認證）。

**Agent Skill 參數化** (FR-150 series):
- **FR-150**: Agent 操作技能 MUST 以外部化的 skill 定義描述，
  包含 prompt template 與所需 tool 清單。
- **FR-151**: Skill 定義 MUST 可在不重新編譯的前提下修改。
- **FR-152**: 系統 MUST 提供 `nbctl skills` 列出所有已載入的 agent skill。
- **FR-153**: 每個 skill MUST 宣告依賴的瀏覽器操作。

**OS 通知（輔助）**:
- **FR-160**: 系統 SHOULD 在非同步操作完成時發送 OS 通知（macOS notification）。
- **FR-161**: OS 通知 MUST 可透過設定檔開關，預設開啟。

**Multi-tab Daemon** (FR-170 series):
- **FR-170**: Daemon MUST 支援在單一 Chrome 中管理多個 notebook tab。
- **FR-171**: 每個 notebook tab MUST 有獨立的 operation queue。
  同 notebook serial，跨 notebook parallel。
- **FR-172**: 每個 notebook tab MUST 對應一個獨立的 AI agent session。
- **FR-173**: 同時開啟的 tab 數量 MUST 有可設定上限（預設 10）。
- **FR-174**: 單一 tab 崩潰不影響其他 tab，支援單一 tab 重建。
- **FR-175**: Daemon MUST 支援 `nbctl open` 開啟 tab、`nbctl close` 關閉 tab。

**Headless / Headed 雙模式** (FR-180 series):
- **FR-180**: Daemon MUST 支援 headless 與 headed 兩種 Chrome 啟動模式。
- **FR-181**: 首次啟動且無有效 cookies 時，MUST 自動 headed mode 讓使用者登入，
  cookies 持久化至 `~/.nbctl/profiles/`。
- **FR-182**: 後續啟動 MUST headless mode，使用者桌面無瀏覽器視窗。
- **FR-183**: 系統 MUST 偵測 session 過期，提供 `nbctl reauth` 重新認證。
- **FR-184**: Headless 截圖渲染 MUST 與 headed 一致。

### Key Entities

- **Daemon**：常駐背景程序，管理所有已註冊 notebook，暴露 HTTP API，
  維護狀態快取。自行管理 Chrome 實例（透過 Connection Manager）。

- **Connection Manager**：daemon 與瀏覽器之間的唯一抽象層。
  管理 Chrome 生命週期、multi-tab、cookies 持久化、headed/headless 模式切換。
  對外以 pageId 為單位暴露操作介面。Agent 只透過 pageId + tools 操作。
  底層實作可替換（預設 Puppeteer）。

- **Notebook Registry**：所有已註冊 notebook 的元資料清單
  （ID/別名、URL、標題、description、tab 狀態、來源清單摘要），持久化於磁碟。
  `description` 由 agent 自動產生，每次來源異動後更新。使用者可覆寫。

- **Agent Session**：Per-notebook 的 AI agent。透過 Connection Manager
  取得專屬的 pageId + bound tools，不知道其他 session 的存在。
  具備 vision model 能力與 browser/content tools。

- **Agent Skill**：參數化的 agent 操作技能定義。
  包含 prompt template、所需 tool 清單、操作依賴宣告。
  以檔案形式存在，可不重編譯修改。

- **Notification Inbox**：per-session 的檔案型通知佇列。
  `~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`。
  通知消費使用 rename 到 `consumed/`，保留 audit trail。

- **Notification Adapter**：per-tool 的通知交付實作。
  Claude Code adapter = full push + per-session routing。
  Generic adapter = pull-based fallback。

- **Async Task**：非同步操作的追蹤紀錄。
  包含 taskId、status、notebook、sessionId、內容摘要、時間、結果。

- **AI Skill Template**：提供給外部 AI 工具的 nbctl 使用指南。
  與 Agent Skill 不同：Agent Skill 控制 daemon 內部 agent，
  AI Skill Template 教外部 AI 工具如何呼叫 nbctl CLI。

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
  同 notebook serial，跨 notebook parallel。

---

## Clarifications

### Session 2026-02-07

- Q: 當 daemon 已在執行中，使用者再執行 `nbctl start` 時應如何處理？ → A: 回報 JSON 錯誤，不啟動第二個實例。
- Q: 序列化執行的範圍？ → A: 每個 notebook tab 有獨立的 operation queue，同 notebook serial，跨 notebook parallel。純讀取狀態的指令即時回應，不進佇列。
- Q: HTTP API 是否需要認證？ → A: MVP 只靠 localhost binding，不加 token。Port 衝突時回報錯誤。
- Q: Agent session 的生命週期？ → A: Per-notebook session。每個 notebook 有獨立的 agent session，與 tab 同生命週期。不同 notebook 的 session 互相隔離。
- Q: Notebook Registry 的 description 欄位？ → A: Agent 自動摘要 + 使用者可覆寫。
- Q: Google 帳號認證？ → A: Daemon 自行管理 Chrome。首次以 headed mode 登入，cookies 持久化至 `~/.nbctl/profiles/`，後續 headless 運作。Session 過期提供 `nbctl reauth`。
- Q: `nbctl exec` 的 timeout？ → A: 不硬編碼。各操作合理 timeout 實測後決定。Spec 只要求有 timeout 機制 + 充分日誌。
- Q: `nbctl list` 輸出是否含 description？ → A: 是。

### Session 2026-02-12 (架構重構)

- Q: 為什麼不用 MCP？ → A: MCP tool call 在主流 AI CLI 中是 blocking 的，server-push 未被 client 實作。CLI + Skill + Hook 更通用、支援非同步。
- Q: 多 notebook 並行怎麼做？ → A: 1 daemon, 1 Chrome (headless), N tabs。每個 notebook 一個 tab，由 Connection Manager 管理。跨 notebook parallel，同 notebook serial。不需要多個 Chrome process。
- Q: 10 本 notebook 會開 10 個瀏覽器嗎？ → A: 不會。單一 Chrome，多個 tab。各 tab 渲染互不干擾。
- Q: Agent 如何各自操控瀏覽器？ → A: Connection Manager 為每個 tab 產生 pageId + closure-bound tools。Agent 只拿到 pageId + tools，不知道 Puppeteer。
- Q: 抽象層在哪裡？ → A: Connection Manager 本身。比 Browser Strategy pattern 更乾淨。
- Q: 瀏覽器必須可見嗎？ → A: 不必。Headless 截圖仍可正常渲染。首次登入需 headed。
- Q: 多 CLI session 通知如何 routing？ → A: Notification Adapter，per-tool best practice。Claude Code adapter 用 session_id 做 per-session inbox routing。
- Q: 為什麼不追求跨平台 general solution？ → A: 每個 AI CLI 的 hook 機制不同，妥協到最低公約數犧牲體驗。Per-tool adapter 讓核心協議統一，delivery 各自最佳化。
- Q: 防遺忘機制？ → A: 多層：(1) CLI hint 欄位；(2) UserPromptSubmit hook 注入；(3) Stop hook 攔截 urgent；(4) Skill 防遺忘指引。
- Q: Skill Template 和 Agent Skill 的差異？ → A: Agent Skill 是 daemon 內部 agent 的操作定義。AI Skill Template 是教外部 AI 工具如何呼叫 nbctl CLI。

---

## 成功指標 *(mandatory)*

### Measurable Outcomes

**效能指標**:
- **SC-001**: Daemon 啟動至 ready 狀態在 10 秒內完成（含 Chrome 啟動，不含首次登入）。
- **SC-002**: `nbctl list`、`nbctl status` 等管理指令在 100ms 內回應。
- **SC-003**: 開啟新 notebook tab（含導航）在 10 秒內完成。
- **SC-004**: Agent 簡單操作（如截圖、查詢來源清單）在 15 秒內完成。
- **SC-005**: Agent 多步驟操作（如新增來源含重命名）在 60 秒內完成。

**可靠性指標**:
- **SC-006**: 來源新增操作成功率 > 90%（agent 自我修正後）。
- **SC-007**: Audio 下載操作成功率 > 95%。
- **SC-008**: Content 轉換（repo/URL/PDF → text）成功率 > 95%。

**容量指標**:
- **SC-009**: 支援註冊至少 20 個 notebook，同時開啟至少 10 個 tab。
- **SC-010**: Daemon 記憶體使用量 < 500MB（不含 Chrome）。

**查詢效能指標**:
- **SC-011**: 單次查詢在 30 秒內完成。
- **SC-012**: 多輪對話追問速度與首次一致（差異 < 20%）。

**查詢可靠性指標**:
- **SC-013**: 查詢操作成功率 > 90%。
- **SC-014**: 來源引用擷取準確率 > 85%。

**使用者價值指標**:
- **SC-015**: 5 分鐘內完成「啟動 → 登入 → 註冊 notebook → 新增來源」流程。
- **SC-016**: 透過 `nbctl --help` 理解基本用法。
- **SC-017**: 餵入資料後 1 分鐘內完成首次查詢。
- **SC-019**: 完成「餵入 → 查詢 → 使用」完整工作流，不需離開終端機。

**命名與資源管理指標**:
- **SC-020**: 透過 nbctl 新增的來源，100% 自動重命名。
- **SC-021**: 3 秒內取得 notebook 資源索引。
- **SC-022**: 每個 artifact 追溯率 100%。
- **SC-023**: 管理 10+ notebook 仍能快速找到目標資源。
- **SC-024**: `add-all` 單個 notebook 30 秒內完成。

**非同步操作效率**:
- **SC-100**: 非同步提交在 500ms 內返回 taskId。
- **SC-101**: `nbctl status` 查詢在 200ms 內回應。
- **SC-102**: 通知寫入 Inbox 延遲不超過 1 秒。

**通知可靠性**:
- **SC-103**: 通知 100% 寫入 Inbox。
- **SC-104**: Claude Code adapter routing 成功率 > 99%。
- **SC-105**: Hook 腳本執行時間 < 2 秒。

**跨工具相容性**:
- **SC-106**: Skill Template 能被至少 2 種 AI CLI 工具正確使用。
- **SC-107**: 不安裝 adapter 也能透過 `nbctl status` 完成所有查詢。

**Connection Manager 穩定性**:
- **SC-108**: 切換底層實作後，所有操作成功率不低於原實作。
- **SC-109**: 統一錯誤格式，agent 正確處理所有錯誤類型。

**使用者上手效率**:
- **SC-110**: 3 分鐘內完成 adapter 安裝。
- **SC-111**: 5 分鐘內載入 Skill Template 並完成首次非同步操作。

**Skill 參數化**:
- **SC-112**: 修改 agent skill prompt 後重啟，agent 使用新 prompt。

**Multi-tab 並行**:
- **SC-113**: N 個 notebook（N ≤ 10）操作互不阻塞。
- **SC-114**: 單一 tab 崩潰後 5 秒內偵測，其他 tab 不受影響。

**Headless 模式**:
- **SC-115**: Headless vision-based agent 成功率與 headed 無顯著差異（< 5%）。
- **SC-116**: 首次登入後，後續 daemon 重啟自動 headless。
