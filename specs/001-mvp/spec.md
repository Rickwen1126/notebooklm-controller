# 功能規格書：NotebookLM Controller MVP

**Feature Branch**: `001-mvp`
**Created**: 2026-02-06
**Status**: Draft (v2 — 對齊 Constitution v1.1.0)
**Input**: PRD 文件 `docs/prd.md`

<!--
  v2 變更摘要：
  1. 瀏覽器隔離：對齊 Constitution v1.1.0，明確 1 daemon : 1 browser instance，
     移除 multi-tab 並行概念。MVP 一次只能操作一個 notebook（類似 git checkout）。
  2. 指令模式簡化：移除大部分專用子命令（ask/screenshot/catalog/history/rename/sync），
     統一走 `nbctl exec "<自然語言>"` 模式。僅保留生命週期管理指令
     （start/stop/status/list/open/close/use/add/add-all）。
  3. 參考 docs/discuss-agent-daemon.md 結論，daemon 本身就是 agent，
     接收自然語言指令自主完成操作。
-->

## 使用者情境與測試 *(mandatory)*

<!--
  注意：User Story 分為五類：
  - 基礎設施 Stories (US1-US2)：建立系統運作的基礎（含既有 notebook 納管）
  - 資料餵入 Stories (US3-US7)：將外部內容餵入 NotebookLM
  - 輔助功能 Stories (US8-US9)：截圖除錯、狀態持久化
  - 查詢與使用 Stories (US10-US14)：向 NotebookLM 查詢並使用知識
  - 命名與資源管理 Stories (US15-US19)：結構化 local cache、來源重命名、prompt 紀錄

  完整工作流：納管 → 餵入 → 命名標記 → 查詢 → 使用
  即使只完成 US1-US3 + US10，使用者就能完成「餵入程式碼 → 提問取得回答」的核心流程。

  架構約束（Constitution v1.1.0）：
  - 1 daemon : 1 browser instance（非 multi-tab）
  - Vision-based agent 依賴 active tab 截圖，同一瀏覽器一次只能有一個 active tab
  - MVP 所有 notebook 操作序列化：一次只操作一個 notebook
  - 透過 `nbctl use <id>` 切換 active notebook（類似 git checkout 切換分支）

  指令模式：
  - 管理指令（結構化）：start/stop/status/list/open/close/use/add/add-all
  - 操作指令（自然語言）：nbctl exec "<自然語言>" — 對 active notebook 執行
  - daemon agent 自行解讀使用者意圖，決定呼叫哪些 tool
-->

---

## Part A: 基礎設施 Stories

### User Story 1 - Daemon 生命週期管理 (Priority: P1)

身為開發者，我希望能透過 CLI 啟動與停止一個常駐 daemon，
讓它連接到 iso-browser Chrome 並暴露 HTTP API，
作為所有後續操作的基礎設施。

**Why this priority**: 這是所有功能的基石。沒有 daemon 運行，
任何 notebook 操作都無法執行。必須最先完成。

**Independent Test**: 執行 `nbctl start`，確認 daemon 啟動、
連接 Chrome:19223、暴露 API 於 :19224；執行 `nbctl stop` 確認乾淨關閉。

**Acceptance Scenarios**:

1. **Given** iso-browser Chrome 執行中於 port 19223，
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 啟動為背景程序，輸出 JSON `{ "success": true, "port": 19224 }`，
   且 HTTP GET `localhost:19224/health` 回應 200。

2. **Given** daemon 正在執行，
   **When** 使用者執行 `nbctl status`，
   **Then** 輸出 JSON 包含 `{ "running": true, "browserConnected": true, "activeNotebook": null, "notebookCount": 0 }`。

3. **Given** daemon 正在執行，
   **When** 使用者執行 `nbctl stop`，
   **Then** daemon 斷開 browser 連線、釋放資源、程序結束，
   輸出 JSON `{ "success": true, "message": "Daemon stopped" }`。

4. **Given** iso-browser Chrome 未執行，
   **When** 使用者執行 `nbctl start`，
   **Then** daemon 輸出錯誤 JSON `{ "success": false, "error": "Cannot connect to Chrome on port 19223" }`，
   程序結束，不崩潰。

5. **Given** daemon 已在執行中（port 19224 已被佔用），
   **When** 使用者再次執行 `nbctl start`，
   **Then** 輸出錯誤 JSON `{ "success": false, "error": "Daemon already running on port 19224" }`，
   不啟動第二個 daemon 實例。

---

### User Story 2 - Notebook 管理與切換 (Priority: P2)

身為開發者，我希望能透過 CLI 註冊 NotebookLM notebook，
為其指派別名，並透過 `use` 指令切換 active notebook，
類似 git checkout 切換分支的概念。

由於 vision-based agent 一次只能操作瀏覽器的 active tab，
daemon 在 MVP 階段使用單一瀏覽器實例，同一時間只能操作一個 notebook。
切換到另一個 notebook 時，daemon 會導航到該 notebook 的 URL。

對於我在 NotebookLM 中已有的大量 notebook，系統不主動處理，
而是提供 `add` 指令讓我選擇性地將想管理的 notebook 納入，
或使用 `add-all` 以交互式方式批次納管。

**Why this priority**: 必須能管理 notebook 才能執行任何 notebook 內操作。
依賴 US1 的 daemon 已啟動。既有 notebook 的納管是使用者的第一步操作，
大多數使用者已有 NotebookLM 帳號和既有的 notebook。

**Independent Test**: 註冊一個 notebook、切換到它、列出所有 notebook、
關閉它。另外：使用 add 指令納管一個既有 notebook、使用 add-all 批次納管。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且 browser 已連線，
   **When** 使用者執行 `nbctl open https://notebooklm.google.com/notebook/xxx --name research`，
   **Then** daemon 將該 notebook 註冊為受管理 notebook，
   導航瀏覽器至該 URL，建立 agent session，設為 active notebook，
   輸出 JSON `{ "success": true, "id": "research", "url": "...", "active": true }`。

2. **Given** daemon 管理了 notebook "research" 和 "ml-papers"，
   目前 active 為 "research"，
   **When** 使用者執行 `nbctl use ml-papers`，
   **Then** daemon 將瀏覽器導航至 "ml-papers" 的 URL，
   切換 active notebook，
   輸出 JSON `{ "success": true, "active": "ml-papers" }`。

3. **Given** 已註冊 notebook "research"，
   **When** 使用者執行 `nbctl list`，
   **Then** 輸出 JSON 陣列，每個 notebook 包含 description，active notebook 有 `"active": true` 標記：
   `[{ "id": "research", "url": "...", "status": "ready", "active": true, "description": "包含專案認證模組與 API 文件的開發筆記" }]`。

4. **Given** 已註冊 notebook "research"，
   **When** 使用者執行 `nbctl close research`，
   **Then** daemon 移除該 notebook 的註冊與狀態，
   若該 notebook 為 active，active 設為 null，
   輸出 JSON `{ "success": true }`，`nbctl list` 不再包含該 notebook。

5. **Given** daemon 執行中，
   **When** 使用者執行 `nbctl open <invalid-url> --name test`，
   **Then** 輸出錯誤 JSON `{ "success": false, "error": "Invalid NotebookLM URL" }`。

6. **Given** 使用者的 NotebookLM 帳號中有多個既有 notebook，
   **When** 使用者執行 `nbctl add https://notebooklm.google.com/notebook/yyy --name ml-papers`，
   **Then** daemon 導航至該 URL、掃描 notebook 狀態（來源清單、標題等）、
   將其納入管理並同步到 local cache，
   輸出 JSON `{ "success": true, "id": "ml-papers", "sources": [...], "title": "...", "description": "包含 BERT、GPT 等機器學習論文的研究筆記" }`。

7. **Given** 使用者想批次納管所有既有 notebook，
   **When** 使用者執行 `nbctl add-all`，
   **Then** agent 導航至 NotebookLM 首頁，擷取所有 notebook 清單，
   依序展示每個 notebook 的標題與 URL，讓使用者選擇是否納管並指定別名，
   逐一完成後輸出 JSON 摘要 `{ "success": true, "added": 5, "skipped": 3, "notebooks": [...] }`。

8. **Given** 使用者在 `add-all` 過程中想跳過某些 notebook，
   **When** 使用者對某個 notebook 選擇「跳過」，
   **Then** 系統跳過該 notebook 繼續處理下一個，最終摘要中標記為 skipped。

9. **Given** 使用者執行 `nbctl use <不存在的 notebook-id>`，
   **When** daemon 找不到該 notebook，
   **Then** 輸出錯誤 JSON `{ "success": false, "error": "Notebook '<id>' not found. Use 'nbctl list' to see registered notebooks." }`。

---

## Part B: NotebookLM 互動功能 Stories

### User Story 3 - 將專案程式碼餵入 NotebookLM 作為知識來源 (Priority: P3)

身為使用 AI coding tool 的開發者，我希望能將我的專案程式碼（git repo）
自動轉換並新增為 NotebookLM 的來源，讓我能透過 NotebookLM 詢問
關於專案的問題，得到基於原始碼的精準回答。

**Why this priority**: 這是本工具的核心價值主張——讓開發者能將 codebase
作為 grounded context 餵入 NotebookLM，解決 AI 工具的幻覺問題。
這是目前 notebooklm-mcp 無法做到的功能。

**Independent Test**: 指定一個本地 git repo 路徑，指令執行後，
該 repo 的內容應出現在 NotebookLM 的來源列表中。

**使用情境描述**:

```
開發者 Alice 正在用 Claude Code 開發一個專案。
她想讓 NotebookLM 理解她的 codebase，這樣她可以問：
「這個專案的認證流程是怎麼運作的？」並得到基於實際程式碼的回答。

她先確認 active notebook：
$ nbctl use myproject

然後用自然語言告訴 daemon 要做什麼：
$ nbctl exec "把 ~/code/my-project 的程式碼加入來源"

Agent（daemon 內建的 AI agent）自動：
1. 理解使用者意圖：要將 repo 加入 NotebookLM 來源
2. 呼叫 repoToText tool 將 repo 轉換為單一文字檔
3. 在 NotebookLM UI 點擊「Add source」
4. 選擇「Copied text」
5. 將轉換後的內容貼上
6. 確認新增成功
7. 自動重命名來源為 "my-project (repo)"
8. 更新狀態快取

Alice 現在可以在 NotebookLM 中詢問關於專案的問題了。
```

**Acceptance Scenarios**:

1. **Given** notebook "myproject" 為 active notebook 且處於 ready 狀態，
   **When** 使用者執行 `nbctl exec "把 ~/code/my-project 的程式碼加入來源"`，
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

**Why this priority**: 補充 NotebookLM 原生 URL 功能的不足，
讓更多網頁內容可以被納入知識庫。

**Independent Test**: 指定一個 URL，內容應被擷取、轉換並新增為來源。

**使用情境描述**:

```
研究者 Bob 想把一篇需要登入才能看的技術文章加入 NotebookLM。
NotebookLM 的原生 URL 功能無法存取這個頁面。

他先在 iso-browser 中登入該網站，然後執行：
$ nbctl exec "把 https://example.com/premium-article 的內容爬下來加入來源"

Agent 自動：
1. 理解使用者意圖：要爬取網頁內容並加入來源
2. 呼叫 urlToText tool 擷取網頁內容
3. 將 HTML 轉換為乾淨的 Markdown
4. 透過「Copied text」方式新增為來源
5. 自動重命名為 "example.com/premium-article (web)"

如果是公開 URL 可以直接用 NotebookLM 原生功能：
$ nbctl exec "加入連結來源 https://example.com/public-page"

Agent 在 UI 中選擇「Link」選項，直接貼上 URL。
```

**Acceptance Scenarios**:

1. **Given** active notebook 為 "research"，
   **When** 使用者執行 `nbctl exec "把 https://example.com/article 的內容爬下來加入來源"`，
   **Then** agent 呼叫 urlToText 擷取並轉換內容，新增為 text source，
   回應 JSON `{ "success": true, "sourceAdded": "example.com/article (web)", "wordCount": 3500 }`。

2. **Given** 使用者想直接使用 NotebookLM 原生 URL 功能，
   **When** 使用者執行 `nbctl exec "加入連結來源 https://example.com/public-page"`，
   **Then** agent 在 UI 中選擇「Link」選項，直接貼上 URL，
   回應 JSON `{ "success": true, "sourceAdded": "https://example.com/public-page", "type": "url" }`。

---

### User Story 5 - 將 PDF 文件餵入 NotebookLM (Priority: P5)

身為研究者，我希望能將本地 PDF 文件轉換後新增為 NotebookLM 來源，
避免透過 Google Drive 上傳的繁瑣流程。

**Why this priority**: PDF 是學術論文的主要格式，
能直接從本地新增 PDF 大幅簡化研究者的工作流程。

**Independent Test**: 指定一個 PDF 檔案路徑，內容應被轉換並新增為來源。

**使用情境描述**:

```
研究者 Carol 下載了 5 篇論文 PDF，想快速加入她的研究 notebook。

她執行：
$ nbctl exec "把 /Downloads/paper1.pdf 加入來源"
$ nbctl exec "把 /Downloads/paper2.pdf 加入來源"
...

Agent 對每個 PDF：
1. 理解使用者意圖：要將 PDF 轉換並加入來源
2. 呼叫 pdfToText tool 保留結構轉換為 Markdown
3. 透過「Copied text」新增為來源
4. 自動重命名為 "paper1 (PDF)"

現在 Carol 可以問 NotebookLM：「這幾篇論文對 X 主題的共識是什麼？」
```

**Acceptance Scenarios**:

1. **Given** active notebook 為 "research"，
   **When** 使用者執行 `nbctl exec "把 /path/to/paper.pdf 加入來源"`，
   **Then** agent 呼叫 pdfToText 轉換 PDF，新增為 text source，
   回應 JSON `{ "success": true, "sourceAdded": "paper (PDF)", "pages": 12, "wordCount": 8500 }`。

2. **Given** PDF 檔案損壞或無法解析，
   **When** 使用者執行上述指令，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Failed to parse PDF: <reason>" }`。

---

### User Story 6 - 產生並下載 Podcast 風格的 Audio Overview (Priority: P6)

身為內容創作者，我希望能觸發 NotebookLM 基於我的來源產生
podcast 風格的 audio overview，並在完成後自動下載到本機，
用於發布或進一步編輯。

**Why this priority**: Audio Overview 是 NotebookLM 最獨特的功能，
自動化這個流程對內容創作者價值極高，是「killer feature」。

**Independent Test**: 對有來源的 notebook 觸發 audio 產生，
等待完成後下載，驗證 audio 檔案可播放。

**使用情境描述**:

```
Podcaster David 用 NotebookLM 整理了一個主題的多個來源。
他想產生一段 audio overview 作為 podcast 素材。

$ nbctl use podcast-prep
$ nbctl exec "產生 audio overview"

等待產生（可能需要數分鐘）...

$ nbctl exec "audio 好了嗎？"
{ "status": "ready" }

$ nbctl exec "下載 audio 到 ~/podcast/episode-draft.wav"
{ "success": true, "path": "~/podcast/episode-draft.wav", "duration": "8:32" }

David 現在可以用這段 audio 作為 podcast 的基礎。
```

**Acceptance Scenarios**:

1. **Given** active notebook "podcast" 有至少一個來源，
   **When** 使用者執行 `nbctl exec "產生 audio overview"`，
   **Then** agent 在 UI 中點擊產生 audio 的按鈕，
   回應 JSON `{ "success": true, "status": "generating", "estimatedTime": "5-10 minutes" }`。

2. **Given** audio 正在產生中，
   **When** 使用者執行 `nbctl exec "audio 狀態？"`，
   **Then** 回應 JSON `{ "status": "generating" }` 或 `{ "status": "ready" }`。

3. **Given** audio 已產生完成，
   **When** 使用者執行 `nbctl exec "下載 audio 到 /path/output.wav"`，
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

**使用情境描述**:

```
開發者 Eve 剛透過 nbctl 新增了 3 個來源到她的 notebook。
她想確認所有來源都已成功載入。

$ nbctl exec "目前有哪些來源？"
{
  "sources": [
    { "name": "my-project (repo)", "type": "text", "status": "ready", "wordCount": 12000 },
    { "name": "Architecture Doc", "type": "url", "status": "ready" },
    { "name": "RFC-001 (PDF)", "type": "text", "status": "processing" }
  ],
  "audio": { "status": "not_generated" },
  "lastUpdated": "2026-02-06T10:30:00Z"
}

Eve 看到 RFC-001 還在處理中，其他已就緒。
```

**Acceptance Scenarios**:

1. **Given** active notebook "myproject" 有多個來源，
   **When** 使用者執行 `nbctl exec "列出所有來源"`，
   **Then** agent 掃描 NotebookLM UI 中的來源面板，
   回應 JSON 包含完整的來源清單與各自狀態。

2. **Given** 使用者想知道 notebook 的整體狀態，
   **When** 使用者執行 `nbctl exec "目前 notebook 的狀態？"`，
   **Then** 回應 JSON 包含 notebook 全貌：來源清單、audio 狀態、
   notebook 標題等資訊。

---

## Part C: 輔助功能 Stories

### User Story 8 - 截圖除錯 (Priority: P8)

身為開發者，我希望能擷取目前瀏覽器畫面截圖，
用於除錯或確認 agent 操作結果。

**Why this priority**: 這是重要的除錯工具，
讓使用者能「看到」agent 看到的畫面，診斷問題。

**Independent Test**: 切換到某個 notebook，執行截圖指令，驗證圖片儲存成功。

**Acceptance Scenarios**:

1. **Given** daemon 有 active notebook，
   **When** 使用者執行 `nbctl exec "截圖"`，
   **Then** 回應 JSON `{ "success": true, "screenshot": "base64...", "timestamp": "..." }`。

2. **Given** daemon 有 active notebook，
   **When** 使用者執行 `nbctl exec "截圖存到 /tmp/screen.png"`，
   **Then** 截圖儲存至指定路徑，回應 JSON `{ "success": true, "path": "/tmp/screen.png" }`。

---

### User Story 9 - 狀態持久化與復原 (Priority: P9)

身為開發者，我希望 daemon 能將已註冊的 notebook 清單持久化到磁碟，
重啟後能復原先前的 notebook 註冊資訊，避免重新設定。

**Why this priority**: 提升使用體驗，daemon 重啟不需重新註冊所有 notebook。
此功能可在基本功能穩定後實作。

**Independent Test**: 註冊 notebook、停止 daemon、重啟 daemon，
驗證 notebook 清單恢復。

**Acceptance Scenarios**:

1. **Given** daemon 執行中且註冊了 notebook "research"，
   **When** 執行 `nbctl stop` 後再執行 `nbctl start`，
   **Then** `nbctl list` 仍包含 "research"，daemon 可透過 `nbctl use research`
   重新導航到該 notebook。

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
沒有查詢功能，使用者餵入資料後仍需手動到 NotebookLM 網頁介面提問，
等於整個自動化工作流只做了一半。既有的 notebooklm-skill 和
notebooklm-mcp 已具備此能力，但各自獨立運作，未利用 controller
的 daemon 架構（每次查詢都要開新 Chrome、重新登入）。

**Independent Test**: 對已有來源的 notebook 執行查詢指令，
驗證回應包含 grounded 答案與來源引用。

**使用情境描述**:

```
開發者 Alice 已透過 nbctl 將她的專案程式碼餵入 notebook "myproject"。
現在她想了解專案的認證流程。

$ nbctl exec "這個專案的認證流程是怎麼運作的？"

Agent 自動：
1. 判斷這是一個查詢（而非操作指令）
2. 在 NotebookLM UI 的對話區域輸入問題
3. 等待 Gemini 產生回答
4. 擷取回答文字與來源引用
5. 以結構化 JSON 回傳

Alice 收到回答：
{
  "success": true,
  "answer": "根據來源，專案使用 JWT 進行認證...",
  "citations": [
    { "source": "my-project (repo)", "excerpt": "auth.ts line 45-60..." }
  ]
}
```

**Acceptance Scenarios**:

1. **Given** active notebook "myproject" 有至少一個來源，
   **When** 使用者執行 `nbctl exec "這個專案的認證流程是怎麼運作的？"`，
   **Then** agent 在 NotebookLM 對話區輸入問題、等待回答、擷取結果，
   回應 JSON 包含 `answer` 欄位（Gemini 的回答）與 `citations` 陣列。

2. **Given** active notebook 沒有任何來源，
   **When** 使用者執行 `nbctl exec "任何問題"`，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "Notebook has no sources. Add sources before asking questions." }`。

3. **Given** 沒有 active notebook（未執行 `nbctl use`），
   **When** 使用者執行 `nbctl exec "任何問題"`，
   **Then** 回應錯誤 JSON `{ "success": false, "error": "No active notebook. Use 'nbctl use <id>' to select one." }`。

4. **Given** NotebookLM 回答產生超時，
   **When** 使用者正在等待回答，
   **Then** 回應 JSON `{ "success": false, "error": "Response timed out", "screenshot": "base64..." }`，
   附帶當前畫面截圖供除錯。

---

### User Story 11 - 對話歷史保持與多輪對話 (Priority: P11)

身為研究者，我希望能對同一個 notebook 進行多輪連續提問，
每一輪都能參考前一輪的對話脈絡，就像在 NotebookLM 網頁上
連續對話一樣。

**Why this priority**: 單次提問的價值有限，研究者通常需要
透過多輪追問來深入理解某個主題。若每次提問都是獨立的，
使用者會失去對話脈絡的連貫性。

**Independent Test**: 連續提問兩個相關問題，驗證第二個回答
能參考第一輪的對話脈絡。

**Acceptance Scenarios**:

1. **Given** 使用者已對 active notebook 提問了「這篇論文的方法論是什麼？」並收到回答，
   **When** 使用者再執行 `nbctl exec "這個方法的局限性是什麼？"`，
   **Then** agent 在同一個 NotebookLM 對話 session 中輸入追問，
   回答能正確參考前一輪的脈絡。

2. **Given** 使用者想開始全新的對話（不帶歷史），
   **When** 使用者執行 `nbctl exec "開始新對話，然後問：這篇論文的結論是什麼？"`，
   **Then** agent 先清除 NotebookLM 的對話歷史（點擊新對話按鈕），
   再輸入問題，回答不受前次對話影響。

---

### User Story 12 - 查詢結果輸出為檔案 (Priority: P12)

身為內容創作者，我希望能將 NotebookLM 的回答直接儲存為
本機檔案（Markdown 格式），方便後續整理或發布。

**Why this priority**: 終端機輸出的 JSON 不便於閱讀與分享，
將回答輸出為格式化的 Markdown 檔案大幅提升實用性。

**Independent Test**: 執行查詢並指定輸出路徑，驗證檔案內容
為格式化的 Markdown，包含問題、回答與引用。

**Acceptance Scenarios**:

1. **Given** active notebook 已開啟且有來源，
   **When** 使用者執行 `nbctl exec "摘要這篇論文，結果存到 ~/notes/summary.md"`，
   **Then** 回答以 Markdown 格式寫入指定檔案，包含問題標題、回答內容、來源引用，
   同時在 stdout 回應 JSON `{ "success": true, "outputPath": "~/notes/summary.md" }`。

2. **Given** 輸出路徑的目錄不存在，
   **When** 使用者執行上述指令，
   **Then** 系統自動建立目錄並儲存檔案。

---

### User Story 13 - 透過 MCP 協定暴露查詢能力 (Priority: P13)

身為 AI agent 開發者，我希望 controller 能以 MCP server 的方式
暴露 NotebookLM 操作能力，讓其他 AI 工具（Claude Code、Cursor、
Windsurf 等）能直接呼叫 NotebookLM 功能，取得 grounded 回答。

**Why this priority**: 透過 controller 的 daemon 架構，MCP server
能共用已管理的 notebook session，不需要額外啟動瀏覽器或重新登入，
大幅優於獨立的 notebooklm-mcp 方案。

**Independent Test**: 在 MCP-compatible 工具中配置 controller 的
MCP endpoint，執行查詢 tool call，驗證回應正確。

**使用情境描述**:

```
開發者 Carol 在 Claude Code 中工作。她的 .mcp.json 配置了
notebooklm-controller 的 MCP server。

Controller daemon 已在背景執行，管理著她的 "myproject" notebook。

在 Claude Code 中，AI 自動判斷需要查詢原始碼知識：
→ 呼叫 MCP tool "notebooklm_exec"
→ controller daemon 切換到指定 notebook 並執行自然語言指令
→ 回傳 grounded 回答

相比獨立的 notebooklm-mcp：
- 不需要額外啟動 Chrome（共用 daemon 的 browser instance）
- 不需要重新登入（共用 daemon 的 session）
- 不需要重新導航（daemon 記得已註冊的 notebook URL）
```

**Acceptance Scenarios**:

1. **Given** controller daemon 執行中且有已註冊的 notebook，
   **When** MCP client 呼叫 `notebooklm_exec` tool（帶 notebook ID 與自然語言指令），
   **Then** controller 切換到指定 notebook 並執行指令，
   回傳操作結果。

2. **Given** controller daemon 執行中，
   **When** MCP client 呼叫 `notebooklm_list_notebooks` tool，
   **Then** 回傳所有已註冊的 notebook 清單（ID、URL、description、來源數量）。

3. **Given** controller daemon 未執行，
   **When** MCP client 嘗試呼叫任何 tool，
   **Then** 回傳錯誤 `{ "error": "Controller daemon is not running. Start with 'nbctl start'." }`。

---

### User Story 14 - 智慧 Notebook 選擇 (Priority: P14)

身為使用者，當我有多個 notebook 時，我希望系統能根據我的指令
自動選擇最相關的 notebook，而不需要我先手動 `use` 切換。

**Why this priority**: 當使用者管理多個 notebook 時，記住哪個
notebook 包含哪些來源是一種認知負擔。自動選擇功能參考了
notebooklm-skill 的 library 管理概念。

**Independent Test**: 註冊多個有不同主題來源的 notebook，
在沒有指定 active notebook 的情況下提問，驗證系統選擇正確的 notebook。

**Acceptance Scenarios**:

1. **Given** daemon 管理了多個 notebook（如 "ml-papers"、"project-code"、"cooking-recipes"），
   目前沒有 active notebook，
   **When** 使用者執行 `nbctl exec "這個機器學習模型的 loss function 是什麼？"`，
   **Then** 系統根據各 notebook 的 description 與來源名稱比對指令內容，
   建議 "ml-papers"，並詢問使用者確認後切換並執行查詢。

2. **Given** 使用者已有 active notebook 但指令內容明顯與其他 notebook 更相關，
   **When** agent 判斷需要切換，
   **Then** agent 先詢問使用者確認是否切換 notebook，
   確認後才執行切換與查詢。

---

## Part E: 命名與資源管理 Stories

### User Story 15 - 來源重命名與標記 (Priority: P15)

身為使用者，我希望透過 nbctl 新增的來源能有清楚的命名，
而不是 NotebookLM 自動產生的模糊名稱（如「Pasted text」）。
由於透過「Copied text」方式貼上的來源在 NotebookLM 中
會顯示為通用名稱，系統 MUST 在新增後自動重命名為有意義的名稱。

**Why this priority**: NotebookLM 的自動命名非常不直觀，
當 notebook 中有大量來源時，使用者根本分不清每個來源是什麼。
好的命名是所有後續資源管理的基礎。

**Independent Test**: 新增一個 repo 來源後，在 NotebookLM UI 中
確認來源名稱已被重命名為有意義的名稱（如 repo 名稱），
而不是「Pasted text」。

**使用情境描述**:

```
開發者 Frank 剛將 3 個來源加入 notebook：
1. 一個 git repo（my-auth-service）
2. 一篇 PDF 論文（attention-is-all-you-need.pdf）
3. 一個爬取的網頁（https://docs.example.com/api）

在 NotebookLM 中，這三個來源全部顯示為「Pasted text」。
但透過 nbctl，agent 在新增後立即將它們重命名為：
- "my-auth-service (repo)"
- "Attention Is All You Need (PDF)"
- "docs.example.com/api (web)"

Frank 還可以手動改名：
$ nbctl exec "把來源 'my-auth-service (repo)' 改名為 'Auth Service v2.1'"
```

**Acceptance Scenarios**:

1. **Given** 透過 nbctl 新增了一個 repo 來源，
   **When** 來源新增完成後，
   **Then** agent 自動在 NotebookLM UI 中將來源重命名為
   `<repo-name> (repo)` 格式，local cache 同步記錄原始名稱與重命名後名稱。

2. **Given** 透過 nbctl 新增了一個 PDF 來源，
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<pdf-filename-without-extension> (PDF)` 格式。

3. **Given** 透過 nbctl 新增了一個 URL 來源（crawl 方式），
   **When** 來源新增完成後，
   **Then** agent 自動重命名為 `<domain/path> (web)` 格式。

4. **Given** 使用者想手動重命名某個來源，
   **When** 使用者執行 `nbctl exec "把來源 '<current-name>' 改名為 '<new-name>'"`，
   **Then** agent 在 NotebookLM UI 中執行重命名操作，
   local cache 同步更新。

---

### User Story 16 - 結構化 Local Cache（資源索引與追溯） (Priority: P16)

身為使用者，我希望系統在本機維護一份結構化的 local cache，
記錄每個 notebook 中的所有資源（來源、生成的文章、音檔）
以及它們的來歷（來自哪個 repo、哪個 URL、用什麼 prompt 產生的），
讓我能一個指令調出完整的內容索引，快速找到需要的資源。

**Why this priority**: NotebookLM 的 UI 不提供好的資源管理，
notebook 標題、來源名稱、生成文章的名稱都是自動產生且模糊的。
使用者需要一個「真相來源」（source of truth）來追溯每個資源的來歷。

**Independent Test**: 新增來源、產生 audio 後，透過 exec 查詢 catalog
驗證所有資源都有完整的來歷紀錄與清楚的索引。

**使用情境描述**:

```
研究者 Grace 管理了 3 個 notebook，每個有 5-10 個來源，
加上生成的文章和音檔。

她執行：
$ nbctl exec "列出所有 notebook 的完整資源索引"

輸出結構化的資源索引：
{
  "notebooks": [
    {
      "id": "ml-papers",
      "title": "機器學習論文集",
      "sources": [
        {
          "name": "Attention Is All You Need (PDF)",
          "origin": { "type": "pdf", "path": "/Downloads/attention.pdf", "addedAt": "2026-02-01" },
          "notebookDisplayName": "Pasted text",
          "renamedTo": "Attention Is All You Need (PDF)"
        },
        {
          "name": "BERT Paper (PDF)",
          "origin": { "type": "pdf", "path": "/Downloads/bert.pdf", "addedAt": "2026-02-02" },
          "notebookDisplayName": "Pasted text",
          "renamedTo": "BERT Paper (PDF)"
        }
      ],
      "artifacts": [
        {
          "type": "audio",
          "prompt": "產生 audio overview",
          "generatedAt": "2026-02-03",
          "localPath": "~/.nbctl/cache/ml-papers/audio-overview-20260203.wav",
          "duration": "12:30"
        }
      ]
    }
  ]
}

Grace 一眼就能看到所有資源的來歷和狀態。
```

**Acceptance Scenarios**:

1. **Given** 使用者已透過 nbctl 管理了多個 notebook 與來源，
   **When** 使用者執行 `nbctl exec "列出所有資源索引"`，
   **Then** 回應 JSON 包含所有受管理 notebook 的完整資源索引，
   每個來源包含 origin（原始路徑/URL）、addedAt、重命名紀錄。

2. **Given** 使用者想查看目前 active notebook 的資源索引，
   **When** 使用者執行 `nbctl exec "這個 notebook 有什麼資源？"`，
   **Then** 僅回應 active notebook 的資源索引。

3. **Given** 使用者透過 nbctl 觸發了 audio 或文章產生，
   **When** 產生完成後，
   **Then** local cache 自動記錄該 artifact 的產生 prompt、時間、
   以及下載後的本機路徑（如有）。

---

### User Story 17 - Prompt 與操作歷程紀錄 (Priority: P17)

身為使用者，我希望所有透過 nbctl 對 notebook 執行的操作
（新增來源、產生 audio、產生文章、查詢）都有操作紀錄，
包括當時使用的 prompt 和結果摘要，方便日後追溯。

**Why this priority**: 當 notebook 中的生成資源越來越多，
使用者容易忘記「這個音檔是怎麼來的」「這篇文章當初的提問是什麼」。
操作歷程是長期可維護性的關鍵。

**Independent Test**: 執行幾個操作後，查看操作歷程，驗證
每個操作都有完整的 prompt 紀錄與結果摘要。

**Acceptance Scenarios**:

1. **Given** 使用者對 active notebook 執行了多個操作，
   **When** 使用者執行 `nbctl exec "列出操作歷史"`，
   **Then** 回應 JSON 陣列包含所有操作紀錄，每筆包含
   timestamp、action type、原始指令文字、result summary。

2. **Given** 使用者執行 `nbctl exec "產生 audio overview，聚焦在方法論"`，
   **When** 操作完成後，
   **Then** local cache 自動記錄此操作：
   `{ "action": "generate_audio", "prompt": "產生 audio overview，聚焦在方法論", "result": "success", "timestamp": "..." }`。

3. **Given** 使用者想查看某個特定 artifact 的來歷，
   **When** 使用者執行 `nbctl exec "這個 audio 是怎麼來的？"`，
   **Then** agent 查詢 local cache，回應包含產生它的原始 prompt 與參數。

---

### User Story 18 - Notebook 標題管理 (Priority: P18)

身為使用者，我希望能透過 nbctl 重命名 notebook 的標題，
因為 NotebookLM 自動產生的標題通常不直觀（常常是來源內容的
片段截取），在有大量 notebook 時難以辨識。

**Why this priority**: 與來源重命名同理，notebook 標題的
可讀性是整個資源管理體驗的一環。

**Independent Test**: 重命名一個 notebook 的標題，驗證
NotebookLM UI 中的標題已更新，local cache 也同步。

**Acceptance Scenarios**:

1. **Given** active notebook 的 NotebookLM 標題為自動產生的模糊名稱，
   **When** 使用者執行 `nbctl exec "把 notebook 標題改為 '2026 Q1 機器學習論文集'"`，
   **Then** agent 在 NotebookLM UI 中修改 notebook 標題，
   local cache 記錄舊標題與新標題的對照，
   回應 JSON `{ "success": true, "oldTitle": "...", "newTitle": "2026 Q1 機器學習論文集" }`。

---

### User Story 19 - 資源清單的人類可讀輸出 (Priority: P19)

身為使用者，我希望除了 JSON 格式外，還能以人類可讀的
表格或 Markdown 格式查看資源清單，方便快速瀏覽。

**Why this priority**: JSON 適合程式處理但不適合人類閱讀。
當使用者想快速瀏覽「我有哪些 notebook、裡面有什麼來源」時，
需要更直觀的展示方式。

**Independent Test**: 透過 exec 指定輸出格式，
驗證輸出為格式化的表格或 Markdown。

**Acceptance Scenarios**:

1. **Given** 使用者管理了多個 notebook，
   **When** 使用者執行 `nbctl exec "用表格列出所有 notebook 和來源"`，
   **Then** 回應為格式化的 CLI 表格，包含 notebook 名稱、
   來源數量、最近操作時間等摘要資訊。

2. **Given** 使用者想匯出資源清單，
   **When** 使用者執行 `nbctl exec "把所有資源清單匯出為 Markdown 到 ~/notes/catalog.md"`，
   **Then** 輸出完整的 Markdown 格式資源清單到指定檔案。

---

### Edge Cases

- **iso-browser 突然關閉**：daemon 偵測斷線，暫停所有操作，
  定期重試連線，提供明確狀態回報。
- **NotebookLM UI 更新**：vision-based agent 應能適應 UI 變化，
  若關鍵元素無法辨識，回報錯誤而非崩潰。
- **同時多個 exec 指令**：daemon 接收到多個 exec 請求時，
  MUST 序列化執行（佇列排隊），因為同一瀏覽器同一時間只能操作一個 notebook。
- **超大內容超過 500K 字限制**：MVP 回報錯誤建議使用者手動分割。
- **無效 notebook URL**：驗證 URL 格式，拒絕非 NotebookLM 網域。
- **網路斷線中途**：agent 操作應有 timeout，失敗時回報當前狀態截圖。
- **NotebookLM 回答中包含圖片或表格**：agent 應擷取純文字內容，
  圖片以 `[Image: description]` 佔位符替代，表格轉為 Markdown 格式。
- **極長回答超過回應大小限制**：分段擷取，確保完整性。
- **NotebookLM 拒絕回答**（如問題與來源無關）：回傳 NotebookLM 的
  拒絕訊息，不偽造回答。
- **對話歷史過長影響回答品質**：使用者可透過 exec 指示 agent 開始新對話。
- **網路延遲導致回答不完整**：agent 應等待回答完全產生後才擷取，
  透過偵測「正在輸入」指示器判斷完成狀態。
- **來源重命名失敗**（NotebookLM UI 變更或元素無法定位）：
  local cache 仍記錄原始名稱與預期名稱，標記為 rename_pending，
  使用者可稍後重試。
- **add-all 過程中 notebook 清單超過 50 個**：分頁處理，
  每頁顯示 10 個 notebook 供使用者選擇。
- **local cache 與 NotebookLM 實際狀態不一致**（使用者在 UI 上
  手動操作後）：使用者可透過 exec 要求重新同步。
- **同一來源重複新增**：local cache 根據 origin 資訊偵測重複，
  警告使用者但不阻止（允許覆蓋）。
- **切換 notebook 時前一個 notebook 有進行中的操作**：
  daemon 等待當前操作完成後才切換，或回報錯誤要求等待。
- **agent 無法理解自然語言指令**：回報解析失敗並附上支援的操作範例清單。
- **Google session 過期或未登入**：agent 偵測到登入頁面時回報錯誤
  `{ "success": false, "error": "Not logged in. Run 'nbctl login' to authenticate." }`，
  不嘗試自動恢復。

---

## 需求 *(mandatory)*

### Functional Requirements

**Daemon & CLI**:
- **FR-001**: 系統 MUST 提供 `nbctl` CLI，支援以下結構化管理指令：
  `start`、`stop`、`status`、`list`、`open`、`close`、`use`、`add`、`add-all`、`login`。
- **FR-002**: 系統 MUST 提供 `nbctl exec "<自然語言>"` 指令，將自然語言指令
  傳送給 daemon agent，由 agent 自行解讀意圖並執行對應操作。
- **FR-003**: 系統 MUST 將 daemon 作為背景程序執行，暴露 HTTP API 於 127.0.0.1:19224
  （僅 localhost binding，不加額外認證）。若 port 19224 已被佔用，MUST 回報錯誤而非靜默失敗。
- **FR-004**: 系統 MUST 連接至單一 iso-browser Chrome instance（port 19223），
  同一時間只操作一個 notebook（active notebook）。
  不得以 multi-tab 方式在同一瀏覽器中並行操作多個 notebook。
- **FR-005**: 所有 CLI 輸出 MUST 為 JSON 格式（stdout），錯誤訊息亦為 JSON。
- **FR-006**: 系統 MUST 支援 `nbctl use <notebook-id>` 指令切換 active notebook，
  daemon 導航瀏覽器至該 notebook 的 URL。

**Agent 能力**:
- **FR-007**: Agent MUST 能透過 vision model 理解 NotebookLM UI 狀態。
- **FR-008**: Agent MUST 提供 browser tools（screenshot, click, type, scroll, paste, downloadFile）。
- **FR-009**: Agent MUST 提供 content tools：
  - repoToText：將 git repo 轉換為單一文字
  - urlToText：將網頁轉換為 Markdown
  - pdfToText：將 PDF 轉換為 Markdown
- **FR-010**: Agent MUST 能解讀自然語言指令，判斷使用者意圖（查詢、新增來源、
  產生 audio、截圖、重命名、查看狀態等），並自主呼叫對應 tools 完成操作。

**NotebookLM 互動**:
- **FR-011**: 系統 MUST 支援透過「Copied text」方式新增文字來源。
- **FR-012**: 系統 MUST 支援透過「Link」方式新增 URL 來源。
- **FR-013**: 系統 MUST 支援觸發 Audio Overview 產生。
- **FR-014**: 系統 MUST 支援下載已產生的 Audio Overview 到本機檔案。
- **FR-015**: 系統 MUST 能擷取 notebook 當前來源清單與狀態。

**查詢功能**:
- **FR-016**: Agent MUST 能在 NotebookLM UI 的對話區域輸入問題、
  等待回答產生完成、擷取回答文字與來源引用。
- **FR-017**: 查詢回答結果 MUST 包含結構化的 `answer`（回答全文）
  與 `citations`（來源引用陣列）欄位。
- **FR-018**: 系統 MUST 支援多輪對話，在同一個 NotebookLM 對話 session 中保持脈絡。
- **FR-019**: Agent MUST 能根據使用者指令清除對話歷史並開始新對話。

**查詢輸出**:
- **FR-020**: Agent MUST 能將回答以 Markdown 格式寫入使用者指定的檔案路徑。
- **FR-021**: Markdown 輸出 MUST 包含問題標題、回答內容、來源引用區段。

**狀態管理**:
- **FR-022**: 系統 MUST 在每次操作後更新 notebook 狀態快取（post-op sync）。
- **FR-023**: 系統 MUST 將已註冊 notebook 清單持久化至磁碟，支援重啟後復原。
- **FR-024**: 系統 MUST 在無法連接 Chrome 時提供清楚錯誤訊息，不崩潰。

**MCP 整合**:
- **FR-025**: 系統 MUST 內嵌 MCP server 於 daemon 程序中，隨 daemon 啟動/停止，
  透過 stdio transport 與 MCP client 通訊，提供 `notebooklm_exec` tool，
  接收 notebook ID 與自然語言指令。
- **FR-026**: MCP server MUST 直接共用 daemon 的 browser 連線與 agent session（同一程序內），
  不另外啟動瀏覽器或獨立程序。
- **FR-027**: MCP server MUST 提供 `notebooklm_list_notebooks` tool 供 client 查詢可用 notebook。

**智慧選擇**:
- **FR-028**: Agent MUST 能在使用者未指定 notebook 時，根據指令內容
  與各 notebook 的 description 及來源元資料，建議最相關的 notebook。
- **FR-029**: 智慧選擇 MUST 預設詢問使用者確認後再切換 notebook。

**Notebook Description 自動維護**:
- **FR-045**: 系統 MUST 在 add/open notebook 後，由 agent 根據 notebook
  的來源清單自動產生 1-2 句 description，記錄於 Notebook Registry。
- **FR-046**: 每次來源異動（新增/移除）後，系統 MUST 自動更新 description。
- **FR-047**: Agent MUST 能根據使用者 exec 指令手動覆寫 notebook description。

**操作排隊與觀測**:
- **FR-030**: 所有需要操作瀏覽器的指令（`exec`、`use`）MUST 序列化執行，
  同一時間只能有一個瀏覽器操作，後續請求排隊等待。
  純讀取記憶體狀態的指令（`list`、`status`）MUST 即時回應，不進入佇列。
- **FR-031**: 每個操作 MUST 有 timeout 機制避免無窮等待，
  超時回傳錯誤與截圖。具體 timeout 數值依操作類型於實測後決定。
- **FR-051**: Daemon MUST 對每個 agent 操作步驟記錄結構化日誌
  （進入/退出時間、tool 呼叫、截圖事件、錯誤），
  確保能事後診斷卡住或異常的操作。

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
- **FR-041**: Local cache 中的每個 artifact（audio、note 等）
  MUST 記錄產生它的原始 prompt 與時間。

**操作歷程**:
- **FR-042**: 系統 MUST 記錄所有透過 nbctl exec 執行的操作歷程
  （action type、原始指令文字、result summary、timestamp）。
- **FR-043**: Agent MUST 能根據使用者指令查詢並回傳操作歷程。

**同步**:
- **FR-044**: Agent MUST 能根據使用者指令，重新從 NotebookLM UI
  同步 notebook 狀態到 local cache。

**認證**:
- **FR-048**: 系統 MUST 依賴 iso-browser 的 browser profile（cookies）
  作為主要 Google 帳號認證方式，不自行管理帳號密碼。
- **FR-049**: 系統 MUST 提供 `nbctl login` 指令，開啟 iso-browser 並
  導航至 Google 登入頁面，讓使用者手動完成登入流程。
  登入完成後 cookies 持久化於 iso-browser profile 中。
- **FR-050**: 若 agent 在操作過程中遇到未登入狀態（如導航到 NotebookLM
  後出現 Google 登入頁面），MUST 回報錯誤並提示使用者執行 `nbctl login`。

### Key Entities

- **Daemon**：常駐背景程序，管理所有已註冊 notebook 的元資料，
  暴露 HTTP API，維護狀態快取，一次操作一個 active notebook。
- **Active Notebook**：當前 daemon 正在操作的 notebook。
  瀏覽器導航至該 notebook 的 URL，agent 的所有 UI 操作都針對它。
  類似 git 的 HEAD 概念，透過 `nbctl use` 切換。
- **Notebook Registry**：所有已註冊 notebook 的元資料清單
  （ID/別名、URL、標題、description、來源清單摘要），持久化於磁碟。
  其中一個可標記為 active。
  `description` 為 1-2 句自然語言摘要，由 agent 在 add/open 時根據
  notebook 來源自動產生，每次新增或移除來源後自動更新。
  使用者可透過 exec 手動覆寫。此欄位為智慧選擇（US14）的核心比對依據。
- **Agent**：daemon 內建的 AI agent session，具備 vision model 能力
  與 browser/content tools，接收自然語言指令並自主執行 NotebookLM UI 操作。
  Agent session 為 per-notebook 生命週期：`use` 切換到某 notebook 時建立
  （或恢復）該 notebook 的 agent session，切換離開時暫存。
  不同 notebook 的 agent session 互相隔離，避免對話脈絡汙染。
- **State Store**：記憶體中的狀態快取 + 磁碟持久化，儲存所有 notebook 的
  sources、settings、artifacts 狀態。
- **Browser Instance**：daemon 連接的單一瀏覽器實例。
  Vision-based agent 依賴 active tab 截圖，同一瀏覽器一次只能
  active 一個 tab。MVP 為 1 daemon : 1 browser instance，
  所有操作序列化執行（同一時間只操作一個 notebook）。
  架構預留擴展為多 browser instance（1 agent : 1 browser）的空間。
- **Content Pipeline**：將外部內容（repo、URL、PDF）轉換為 NotebookLM
  可接受的文字格式的工具集。
- **QueryResult**：查詢結果，包含 answer（Gemini 的回答）、
  citations（來源引用）、後設資料（耗時、notebook ID 等）。
- **Citation**：來源引用，包含 source name、引用段落摘要。
- **MCP Tool**：透過 MCP 協定暴露的操作 tool，接收 notebook ID
  與自然語言指令，供外部 AI 工具呼叫。
- **Local Cache**：結構化的本機資料庫，記錄所有受管理 notebook 的
  來源元資料、artifacts、操作歷程與命名對照，是使用者端的
  「真相來源」（source of truth）。
- **Source Origin**：來源的溯源紀錄，包含 type（repo/pdf/url/text）、
  原始路徑或 URL、新增時間、NotebookLM 原始顯示名稱、重命名後名稱。
- **Artifact**：NotebookLM 產生的衍生資源（audio overview、生成文章等），
  包含產生它的原始 prompt、產生時間、本機路徑（如有下載）。
- **Operation Log**：操作歷程紀錄，包含 action type、原始指令文字、
  result summary、timestamp，供日後追溯。
- **Operation Queue**：exec 請求的等待佇列。同一時間只執行一個操作，
  後續請求排隊等待，確保瀏覽器狀態一致性。

---

## Clarifications

### Session 2026-02-07

- Q: 當 daemon 已在執行中，使用者再執行 `nbctl start` 時應如何處理？ → A: 偵測到已有 daemon 執行，回報 JSON 錯誤 `"Daemon already running on port 19224"`，不啟動第二個實例。
- Q: FR-030 序列化執行的範圍？ → A: 只有操作瀏覽器的指令（`exec`、`use`）需要排隊序列化；純讀取記憶體狀態的指令（`list`、`status`）即時回應，不進佇列。
- Q: MCP server 與 daemon 的耦合方式？ → A: 內嵌於 daemon 程序中，隨 daemon 啟動/停止，透過 stdio transport 通訊，直接共用 browser session 和 agent state。
- Q: HTTP API 是否需要認證？ → A: MVP 只靠 localhost binding (127.0.0.1) 限制存取，不加 token。Port 衝突時回報錯誤。
- Q: Agent session 的生命週期？ → A: Per-notebook session。`use` 切換時建立或恢復該 notebook 的 session，離開時暫存。不同 notebook 的 session 互相隔離。
- Q: Notebook Registry 的 description 欄位來源應該是什麼？ → A: Agent 自動摘要 + 使用者可覆寫。add/open 時 agent 掃描 notebook 來源後自動產生 1-2 句描述，每次新增來源後自動更新。使用者可透過 exec 手動修改。
- Q: Google 帳號認證的處理方式？ → A: A+C 分層：(A) 依賴 iso-browser 現有 profile cookies 作為主要認證方式；(C) 提供 `nbctl login` 指令引導使用者在 iso-browser 中完成 Google 登入。不做自動偵測登入頁面恢復（B）。MVP 不含 cookie 匯入。
- Q: `nbctl exec` 的 timeout 是否對所有操作一律 60 秒？ → A: 不在 spec 中硬編碼 timeout 數值。各操作的合理 timeout 需實測後決定。spec 層級只要求：(1) 每個操作 MUST 有 timeout 機制避免無窮等待；(2) 透過充分的日誌記錄確保能觀測到卡住的操作。具體數值留到 implementation 階段。
- Q: `nbctl list` 輸出是否應包含 description？ → A: 是。`nbctl list` 與 MCP tool `notebooklm_list_notebooks` 的回應 MUST 包含 `description` 欄位。

---

## 成功指標 *(mandatory)*

### Measurable Outcomes

**效能指標**:
- **SC-001**: Daemon 啟動至 ready 狀態在 5 秒內完成（不含 Chrome 啟動）。
- **SC-002**: `nbctl list`、`nbctl status` 等管理指令在 100ms 內回應。
- **SC-003**: `nbctl use` 切換 notebook（含瀏覽器導航）在 10 秒內完成。
- **SC-004**: Agent 簡單操作（如截圖、查詢來源清單）在 15 秒內完成。
- **SC-005**: Agent 多步驟操作（如新增來源含重命名）在 60 秒內完成。

**可靠性指標**:
- **SC-006**: 來源新增操作成功率 > 90%（agent 自我修正後）。
- **SC-007**: Audio 下載操作成功率 > 95%。
- **SC-008**: Content 轉換（repo/URL/PDF → text）成功率 > 95%。

**容量指標**:
- **SC-009**: 支援註冊至少 20 個 notebook（元資料管理，非同時操作）。
- **SC-010**: Daemon 記憶體使用量 < 500MB（不含 Chrome）。

**查詢效能指標**:
- **SC-011**: 單次查詢（從輸入問題到取得回答）在 30 秒內完成（一般長度問題）。
- **SC-012**: 多輪對話中的追問回應速度與首次提問一致（差異 < 20%）。

**查詢可靠性指標**:
- **SC-013**: 查詢操作成功率 > 90%（agent 能正確擷取回答與引用）。
- **SC-014**: 來源引用擷取準確率 > 85%（引用對應正確的來源）。

**使用者價值指標**:
- **SC-015**: 使用者能在 5 分鐘內完成「啟動 daemon → 註冊 notebook → 新增第一個來源」的流程。
- **SC-016**: 使用者能在不讀文件的情況下，透過 `nbctl --help` 理解基本用法。
- **SC-017**: 使用者能在餵入資料後 1 分鐘內完成首次查詢並取得 grounded 回答。
- **SC-018**: 透過 MCP 整合，AI 工具能自動呼叫操作功能，使用者無需手動介入。
- **SC-019**: 結合餵入功能，使用者能完成「餵入 → 查詢 → 使用」的完整工作流，不需離開終端機。

**命名與資源管理指標**:
- **SC-020**: 透過 nbctl 新增的來源，100% 會被自動重命名為有意義的名稱（非「Pasted text」）。
- **SC-021**: 使用者能透過 exec 指令在 3 秒內取得 active notebook 的資源索引。
- **SC-022**: 每個 artifact 的操作歷程中包含產生它的原始 prompt，追溯率 100%。
- **SC-023**: 使用者管理 10 個以上 notebook 時，仍能透過 exec 快速找到目標資源，不需逐一開啟 NotebookLM UI。
- **SC-024**: `add-all` 批次納管流程能在 30 秒內處理單個 notebook（掃描 + 同步）。
