# 資料模型：NotebookLM Controller MVP

**Branch**: `001-mvp` | **Date**: 2026-02-12 | **Spec**: [spec.md](./spec.md)

## Entity Relationship Overview

```
DaemonState (singleton)
  ├── has many → NotebookEntry (via Notebook Registry)
  │                ├── has many → SourceRecord (via Local Cache)
  │                ├── has many → ArtifactRecord (via Local Cache)
  │                └── has many → OperationLogEntry (via Operation Log)
  ├── has many → AsyncTask (via Task Store)
  └── has many → NotificationMessage (via Inbox)

BrowserPool (runtime)
  └── has many → BrowserInstance (per active notebook operation)

AuthManager (runtime)
  └── has one → CookieStore (persisted cookies.json)

NetworkGate (runtime)
  └── has one → NetworkHealth

AgentSession (runtime, per notebook)
  ├── uses one → BrowserInstance (via BrowserPool.acquire())
  └── uses many → AgentSkill (loaded from files)
```

---

## Persisted Entities

### DaemonState

**Storage**: `~/.nbctl/state.json`
**Purpose**: Daemon 全域狀態，持久化於磁碟。啟動時載入，變更時 atomic write。

```typescript
interface DaemonState {
  version: 1;                          // Schema version for migration
  defaultNotebook: string | null;      // 預設 notebook alias（`nbctl use`）
  pid: number | null;                  // Daemon process PID
  port: number;                        // HTTP API port（預設 19224）
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
  | "operating"   // 正在使用 Chrome instance 執行操作
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
}
```

### OperationLogEntry

**Storage**: `~/.nbctl/cache/<notebook-alias>/operations.json`
**Purpose**: 所有透過 nbctl exec 執行的操作歷程（FR-042~043）。

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

```typescript
interface AsyncTask {
  taskId: string;                      // 唯一 ID（短 hash，如 "abc123"）
  notebookAlias: string;
  sessionId: string | null;            // CLI session ID（for notification routing）
  command: string;                     // 原始 exec 指令
  context: string | null;              // --context 附帶的情境描述（FR-104）
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
- `queued → cancelled`：使用者 `nbctl cancel`，從 queue 移除
- `running → completed`：agent 成功完成
- `running → failed`：agent 異常、timeout、Chrome instance 崩潰、daemon crash
- `running → cancelled`：使用者 `nbctl cancel`，agent 在安全點停止

### NotificationMessage

**Storage**: `~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`
**Purpose**: 非同步操作完成通知（FR-110~115）。

```typescript
interface NotificationMessage {
  taskId: string;
  status: "completed" | "failed";
  notebook: string;                    // Notebook alias
  result: object;                      // 操作結果
  originalContext: string | null;       // --context 描述
  command: string;                     // 原始指令
  sessionId: string;
  priority: "urgent" | "normal";       // urgent = failed，normal = completed
  timestamp: string;                   // ISO 8601
}
```

**Lifecycle**:
1. Daemon 寫入 `inbox/<session-id>/<priority>/task-<taskId>.json`（atomic write）
2. Hook 腳本讀取後 rename 到 `inbox/<session-id>/consumed/task-<taskId>.json`
3. Daemon 定期清理 >24h 的 consumed 通知

---

## Runtime-Only Entities

### BrowserInstance

**Purpose**: BrowserPool 為每個 agent session 分配的 Chrome instance 句柄。

```typescript
interface BrowserInstance {
  instanceId: string;                  // 唯一識別碼（UUID）
  notebookAlias: string;               // 目前操作的 notebook
  url: string;                         // Navigate 的目標 URL
  acquiredAt: string;                  // ISO 8601 取得時間
  timeoutAt: string;                   // ISO 8601 超時強制回收時間
  browser: Browser;                    // Puppeteer Browser instance（agent 有完整存取權）
  page: Page;                          // 主要 page（agent 可自行管理）
}
```

**設計說明**：Agent 取得完整 `Browser` 和 `Page` 物件，不是 bounded tools interface。
Agent 可自主截圖、click、type、scroll、關 modal、處理 dialog 等，具備完整自我修復能力。
Agent 不能自行關閉 Browser（由 BrowserPool 管理 lifecycle）。

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

### AgentSkill

**Storage**: `skills/<name>.yaml`（外部化定義檔案）或 `~/.nbctl/skills/<name>.yaml`
**Purpose**: 參數化的 agent 操作技能定義（FR-150~153）。

```typescript
interface AgentSkill {
  name: string;                        // 唯一名稱
  version: string;                     // Semver
  description: string;                 // 人類可讀描述
  promptTemplate: string;              // Agent prompt template（可含 {{variables}}）
  requiredTools: string[];             // 依賴的 tool 名稱（FR-153）
  parameters: Record<string, SkillParameter>;  // 可調整參數
}

interface SkillParameter {
  type: "string" | "number" | "boolean";
  description: string;
  default: string | number | boolean;
}
```

---

## CLI Response Shapes

### Standard Success Response

```typescript
interface SuccessResponse {
  success: true;
  [key: string]: unknown;              // 操作特定欄位
}
```

### Standard Error Response

```typescript
interface ErrorResponse {
  success: false;
  error: string;                       // 人類可讀錯誤訊息
  code?: string;                       // 機器可讀錯誤碼（optional）
}
```

### Async Submit Response

```typescript
interface AsyncSubmitResponse {
  taskId: string;
  status: "queued";
  notebook: string;
  hint: string;                        // 防遺忘提示（FR-105）
}
```

### Daemon Status Response

```typescript
interface DaemonStatusResponse {
  running: boolean;
  browserPool: {
    maxInstances: number;
    activeInstances: number;
    availableSlots: number;
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
| `~/.nbctl/profiles/chrome/` | `700` | Chrome userDataDir（含 cookies） |

Daemon 啟動時驗證權限，過於寬鬆則自動修正並輸出警告（FR-055）。
