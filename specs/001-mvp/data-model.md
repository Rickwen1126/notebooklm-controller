# 資料模型：NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Version**: v2 — 對齊 spec v6（MCP Server + Single Browser Multi-tab）

## Entity Relationship Overview

```
DaemonState (singleton)
  ├── has many → NotebookEntry (via Notebook Registry)
  │                ├── has many → SourceRecord (via Local Cache)
  │                ├── has many → ArtifactRecord (via Local Cache)
  │                └── has many → OperationLogEntry (via Operation Log)
  └── has many → AsyncTask (via Task Store)

TabManager (runtime)
  └── has many → TabHandle (per active notebook tab)

NetworkGate (runtime)
  └── has one → NetworkHealth

AgentSession (runtime, per notebook)
  ├── uses one → TabHandle (via TabManager.openTab())
  └── uses many → AgentConfig (loaded from agents/*.md)
```

---

## Persisted Entities

### DaemonState

**Storage**: `~/.nbctl/state.json`
**Purpose**: Daemon 全域狀態，持久化於磁碟。啟動時載入，變更時 atomic write。

```typescript
interface DaemonState {
  version: 1;                          // Schema version for migration
  defaultNotebook: string | null;      // 預設 notebook alias（`set_default` MCP tool）
  pid: number | null;                  // Daemon process PID
  port: number;                        // MCP Server port（預設 19224, Streamable HTTP）
  startedAt: string | null;            // ISO 8601 timestamp
  notebooks: Record<string, NotebookEntry>;  // alias → entry
}
```

### NotebookEntry

**Storage**: Embedded in `DaemonState.notebooks`
**Purpose**: 單個已註冊 notebook 的元資料。

```typescript
interface NotebookEntry {
  alias: string;                       // 全域唯一別名（FR-056）
  url: string;                         // NotebookLM URL（全域唯一，FR-057）
  title: string;                       // NotebookLM 上的標題
  description: string;                 // Agent 自動產生的 1-2 句摘要（FR-045）
  active: boolean;                     // 是否標記為 active（可被操作）
  status: NotebookStatus;             // 目前狀態
  registeredAt: string;                // ISO 8601 首次註冊時間
  lastAccessedAt: string;              // ISO 8601 最後操作時間
  sourceCount: number;                 // 來源數量快取（避免讀取 local cache）
}

type NotebookStatus =
  | "ready"       // 已註冊且可操作
  | "operating"   // 正在使用 Chrome tab 執行操作
  | "closed"      // 已標記為 closed（非 active）
  | "stale"       // URL 無效或 NotebookLM 回報不存在
  | "error";      // 連線錯誤
```

**Validation**:
- `alias`: 非空字串，英數字 + 連字號，1-50 字元，全域唯一
- `url`: 必須符合 `https://notebooklm.google.com/notebook/<id>` 格式（FR-057）
- `description`: 由 agent 自動產生，使用者可覆寫（FR-045~047）

### SourceRecord

**Storage**: `~/.nbctl/cache/<notebook-alias>/sources.json`
**Purpose**: Notebook 中每個來源的追溯元資料（FR-039~041）。

```typescript
interface SourceRecord {
  id: string;                          // 唯一 ID（UUID v4）
  notebookAlias: string;               // 所屬 notebook
  displayName: string;                 // NotebookLM 上顯示的名稱
  expectedName: string;                // 預期的重命名結果（FR-037）
  renameStatus: "done" | "pending" | "failed";
  origin: SourceOrigin;               // 來源追溯
  wordCount: number | null;            // 文字字數（如適用）
  addedAt: string;                     // ISO 8601
  updatedAt: string | null;            // 最後更新時間
  removedAt: string | null;            // 移除時間（soft delete）
}

interface SourceOrigin {
  type: "repo" | "url" | "url-native" | "pdf" | "manual";
  path: string | null;                 // repo 路徑或 PDF 路徑
  url: string | null;                  // URL 來源
  repomixConfig: object | null;        // repomix 轉換參數（如使用）
}
```

**Naming rules** (FR-037):
| Origin type | Display name format |
|-------------|-------------------|
| `repo` | `<repo-name> (repo)` |
| `pdf` | `<filename> (PDF)` |
| `url` | `<domain/path> (web)` |
| `url-native` | 原始 URL（NotebookLM 原生 Link 功能） |
| `manual` | 使用者自訂 |

**Soft delete 查詢行為**：`removedAt !== null` 的 SourceRecord 和 ArtifactRecord 預設不出現在查詢結果中（list-sources、資源索引等）。使用者明確要求時（如「列出包含已刪除的來源」）才包含。

### ArtifactRecord

**Storage**: `~/.nbctl/cache/<notebook-alias>/artifacts.json`
**Purpose**: NotebookLM 產生的衍生資源（audio、note 等）（FR-041）。

```typescript
interface ArtifactRecord {
  id: string;                          // 唯一 ID
  notebookAlias: string;
  type: "audio" | "note" | "other";
  prompt: string;                      // 產生它的原始指令
  localPath: string | null;            // 下載到本機的路徑（如適用）
  duration: string | null;             // Audio 長度（如適用）
  size: string | null;                 // 檔案大小
  createdAt: string;                   // ISO 8601
  removedAt: string | null;            // soft delete（待補：artifact 雖有本機副本，
                                       // 但雲端狀態仍需追溯，與 SourceRecord 同理）
}
```

### OperationLogEntry

**Storage**: `~/.nbctl/cache/<notebook-alias>/operations.json`
**Purpose**: Client 工單紀錄（FR-042~043）。
  記錄每個 exec call 的輸入與結果——「誰對這本 notebook 下了什麼指令、結果如何、花多久」。
  一個 exec call = 一筆 entry。Daemon 在 session 結束後寫入。
  用途：(1) 人類查歷史；(2) agent 接手任務時了解「這本 notebook 之前被做過什麼」。

```typescript
interface OperationLogEntry {
  id: string;                          // 唯一 ID
  taskId: string | null;               // 對應的 async task ID（如適用）
  notebookAlias: string;
  command: string;                     // 原始 exec 指令文字
  actionType: OperationActionType;     // 操作類型
  status: "success" | "failed" | "cancelled";
  resultSummary: string;               // 結果摘要（一句話）
  startedAt: string;                   // ISO 8601
  completedAt: string;                 // ISO 8601
  durationMs: number;
}

type OperationActionType =
  | "add-source"
  | "update-source"
  | "remove-source"
  | "query"
  | "generate-audio"
  | "download-audio"
  | "screenshot"
  | "rename-source"
  | "rename-notebook"
  | "list-sources"
  | "create-notebook"
  | "sync"
  | "other";
```

### AsyncTask

**Storage**: `~/.nbctl/tasks/<taskId>.json`
**Purpose**: 非同步操作的追蹤紀錄（FR-100~109）。
  刻意與 OperationLogEntry 分離：agent 執行任務時只載入 AsyncTask（集中上下文）；
  需要歷史回顧時才按需載入 OperationLog。合併會讓歷史 log 污染任務上下文，
  浪費 token 並干擾 agent 決策。資料模型設計為 agent context 管理服務。

> **⚠️ 開發注意：三層紀錄模型**
>
> 系統有三層紀錄，各自視角不同，**不可合併實作**：
>
> | 層級 | 實體 | 視角 | 粒度 | 誰寫 | 類比 |
> |------|------|------|------|------|------|
> | 工單 | OperationLogEntry | Client | 1 筆 / exec call | Daemon（session 結束後） | 外送單（下單→送達） |
> | 調度 | AsyncTask.history | Daemon | 狀態機轉換 | Daemon（狀態變更時） | 調度系統（接單→派車→送達） |
> | 執行 | Structured Logs (FR-051) | Agent | 每個 tool call | Hooks (`onPreToolUse`) | 外送員 GPS 軌跡 |
>
> **恢復流程**：Agent 失敗或中斷後重接任務時：
> 1. 讀 AsyncTask.history 知道「任務狀態：failed, reason」
> 2. 讀 OperationLogEntry 知道「這本 notebook 之前被做過什麼」
> 3. **截圖分析當前 UI 狀態**（最可靠的恢復手段）
> 4. 自主決定從哪一步繼續——不需要精密 checkpoint，vision agent 看一眼就知道
>
> Structured Logs 對恢復是 nice-to-have，不是必要。Agent 最可靠的恢復工具是 screenshot。

```typescript
interface AsyncTask {
  taskId: string;                      // 唯一 ID（短 hash，如 "abc123"）
  notebookAlias: string;
  command: string;                     // 原始 exec 指令
  context: string | null;              // context 附帶的情境描述（FR-104）
  status: TaskStatus;
  result: object | null;               // 完成結果（status=completed 時）
  error: string | null;                // 錯誤訊息（status=failed 時）
  errorScreenshot: string | null;      // Base64 截圖（status=failed 時）
  history: TaskStatusChange[];         // 完整狀態歷程（FR-109）
  createdAt: string;                   // ISO 8601
}

type TaskStatus =
  | "queued"      // 在 daemon queue 中等待 agent 取走
  | "running"     // Agent 已取走並開始執行
  | "completed"   // 執行成功
  | "failed"      // 執行失敗（非預期錯誤）
  | "cancelled";  // 使用者主動取消

interface TaskStatusChange {
  from: TaskStatus | null;             // null for initial creation
  to: TaskStatus;
  timestamp: string;                   // ISO 8601
  reason: string | null;               // 如 "daemon interrupted"、"user cancelled"
}
```

**State machine** (FR-106):
```
            ┌──────────┐
     ──────→│  queued   │──────────────────────────→ cancelled
            └────┬─────┘                              ↑
                 │                                    │
                 ↓                                    │
            ┌──────────┐                              │
            │ running   │─────────────────────────────┘
            └──┬────┬──┘
               │    │
               ↓    ↓
         completed  failed
```

**Transitions**:
- `queued → running`：scheduler 將任務交給 agent
- `queued → cancelled`：使用者透過 `cancel_task` MCP tool，從 queue 移除
- `running → completed`：agent 成功完成
- `running → failed`：agent 異常、timeout、tab 崩潰、daemon crash
- `running → cancelled`：使用者透過 `cancel_task` MCP tool，agent 在安全點停止

### MCP Notification Payload

**Storage**: 無（直接透過 MCP notification 推送至連線中的 client）
**Purpose**: 非同步操作完成通知（FR-110~115）。

```typescript
interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed";
  notebook: string;                    // Notebook alias
  result: object;                      // 操作結果
  originalContext: string | null;       // context 描述
  command: string;                     // 原始指令
  timestamp: string;                   // ISO 8601
}
```

**Lifecycle**:
1. Agent 完成非同步操作 → Daemon 更新 AsyncTask 狀態
2. Daemon 透過 MCP notification 推送 payload 至所有連線中的 client
3. 若無 client 連線，通知資訊保留在 AsyncTask 狀態中，client 可透過 `get_status` tool 查詢

**⚠️ 設計決策：Notification 是 best-effort，不是核心依賴**

MCP notification 的接收行為由 MCP client 實作決定——client 怎麼把通知轉給 LLM
沒有標準規範，各家實作不同，我們無法控制也不應該假設。

**可靠通道是 Pull（`get_status`）**，不是 Push（notification）：
- 使用者送出 async 操作後，**自己負責記得去拉結果**
- `exec` 回傳的 `hint` 欄位會明確提示「這是 async，記得用 `get_status` 查」
- Notification 是即時提醒的加分，送出去就結束，不補發、不確認

**替代方案**：不想等 async？
- 派 sub-agent 定期呼叫 `get_status` 輪詢
- 或直接用同步模式（exec 不帶 `async: true`）

---

## Runtime-Only Entities

### TabHandle

**Purpose**: TabManager 為每個 agent session 分配的 tab 句柄（CDP session）。

```typescript
interface TabHandle {
  tabId: string;                       // 唯一識別碼（UUID）
  notebookAlias: string;               // 目前操作的 notebook
  url: string;                         // Navigate 的目標 URL
  acquiredAt: string;                  // ISO 8601 取得時間
  timeoutAt: string;                   // ISO 8601 超時強制回收時間
  cdpSession: CDPSession;             // CDP session（agent 透過底層 API 操作）
  page: Page;                          // Puppeteer page 物件（用於初始化）
}
```

**設計說明**：Agent 取得獨立的 tab（CDP session），透過 CDP 底層 API
（`Input.dispatchMouseEvent`、`Page.captureScreenshot`）操作，
background tab 操作完全可靠（實驗驗證）。Agent 可自主截圖分析、retry、
關 modal、處理 dialog 等，具備完整自我修復能力。
Agent 不能自行啟動/關閉 Chrome（由 TabManager 管理 lifecycle）。
認證透過 `userDataDir` 共享，不需獨立 cookie injection。

### NetworkHealth

**Purpose**: NetworkGate 監控的網路健康狀態（FR-194）。

```typescript
interface NetworkHealth {
  status: "healthy" | "throttled" | "disconnected";
  backoffUntil: string | null;         // ISO 8601（throttled 時的 backoff 結束時間）
  backoffRemainingMs: number | null;
  lastCheckedAt: string;               // ISO 8601
  recentLatencyMs: number;             // 最近 N 次請求的平均延遲
}
```

### AgentConfig（原 AgentSkill，待更名）

**Storage**: `agents/<name>.md`（YAML frontmatter + Markdown prompt body）或 `~/.nbctl/agents/<name>.md`
**Purpose**: 參數化的 agent 操作定義（FR-150~153）。對應 SDK 的 `CustomAgentConfig`。

```typescript
// 對齊 SDK CustomAgentConfig + 我們的擴展欄位
interface AgentConfig {
  name: string;                        // 唯一名稱（對應 CustomAgentConfig.name）
  displayName: string;                 // 顯示名稱（對應 CustomAgentConfig.displayName）
  description: string;                 // 人類可讀描述（對應 CustomAgentConfig.description）
  tools: string[];                     // tool 白名單（對應 CustomAgentConfig.tools）
  prompt: string;                      // Markdown body，agent-loader 做 template rendering 後傳給 SDK
  infer: boolean;                      // 是否讓 Copilot CLI 自主推斷可用 tools（預設 true）。false 時 subagent 只能用 tools 列表中的工具
  // --- 以下為我們的擴展，不傳給 SDK ---
  parameters: Record<string, AgentParameter>;  // 動態 prompt template 變數
}

interface AgentParameter {
  type: "string" | "number" | "boolean";
  description: string;
  default: string | number | boolean;
}
```

**載入流程**：`agents/*.md` → `agent-loader.ts` 讀 YAML frontmatter + Markdown body
→ template rendering（用 parameters 替換 `{{variables}}`）→ `CustomAgentConfig`（SDK 原生型別）。
SDK 拿到的是已渲染的靜態 prompt。

---

## MCP Tool Response Shapes

MCP tool 回應遵循 MCP protocol 標準格式（`CallToolResult`）。以下為專案內部使用的
結構化回應資料，嵌入於 MCP tool result 的 `content` 欄位中。

### Async Submit Result

```typescript
// exec tool 帶 async: true 時回傳
interface AsyncSubmitResult {
  taskId: string;
  status: "queued";
  notebook: string;
  hint: string;                        // 防遺忘提示（FR-105）
}
```

### Daemon Status Result

```typescript
// get_status tool 回傳
interface DaemonStatusResult {
  running: boolean;
  tabManager: {
    activeTabs: number;
    maxTabs: number;
  };
  network: NetworkHealth;
  activeNotebooks: string[];           // Alias 列表
  defaultNotebook: string | null;
  pendingTasks: number;
  runningTasks: number;
}
```

---

## File Permission Model

| Path | Permission | Notes |
|------|-----------|-------|
| `~/.nbctl/` | `700` (drwx------) | 主目錄（FR-054） |
| `~/.nbctl/**/*` (dirs) | `700` | 所有子目錄 |
| `~/.nbctl/**/*` (files) | `600` (-rw-------) | 所有檔案（FR-054） |
| `~/.nbctl/profiles/` | `700` | Chrome userDataDir（含 session + cookies，共享認證） |

Daemon 啟動時驗證權限，過於寬鬆則自動修正並輸出警告（FR-055）。
