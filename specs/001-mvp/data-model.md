# 資料模型：NotebookLM Controller MVP

**Date**: 2026-02-07 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Entity Relationship Overview

```text
Daemon (singleton)
├── 1:1  BrowserConnection
├── 1:1  OperationQueue
├── 1:N  NotebookEntry (Notebook Registry)
│        ├── 1:N  SourceRecord
│        ├── 1:N  ArtifactRecord
│        └── 1:1  AgentSession (runtime only, per-notebook)
└── 1:N  OperationLogEntry
```

## Entities

### DaemonState

運行時的 daemon 全域狀態。

| Field | Type | Description |
|-------|------|-------------|
| pid | number | Daemon 程序 PID |
| port | number | HTTP API port（預設 19224） |
| browserPort | number | Chrome CDP port（預設 19223） |
| browserConnected | boolean | Chrome 連線狀態 |
| activeNotebookId | string \| null | 目前 active notebook ID |
| startedAt | ISO8601 string | 啟動時間 |

**Persisted**: No（runtime only）
**Identity**: singleton

---

### NotebookEntry

Notebook Registry 中每個受管理 notebook 的元資料。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | 使用者指定的別名（唯一，如 "research"） |
| url | string | yes | NotebookLM notebook URL |
| title | string | yes | NotebookLM 顯示的標題 |
| description | string | yes | Agent 自動產生的 1-2 句描述 |
| status | NotebookStatus | yes | 狀態（見下方） |
| addedAt | ISO8601 string | yes | 首次註冊時間 |
| lastAccessedAt | ISO8601 string | yes | 最後存取時間 |
| sourceCount | number | yes | 來源數量（來自 local cache） |

**Identity**: `id`（唯一）
**Uniqueness**: `id` 不可重複；`url` 不可重複
**Persisted**: Yes → `~/.nbctl/state.json`

#### NotebookStatus (enum)

| Value | Description |
|-------|-------------|
| `registering` | 正在註冊中（導航 + 掃描） |
| `ready` | 已註冊，可操作 |
| `stale` | URL 不可達或狀態過期 |

**State transitions**:
```text
(new) → registering → ready
                  ↗
ready → stale → ready  (重新同步後恢復)
```

---

### SourceRecord

每個 notebook 中的來源元資料（local cache）。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | UUID，local cache 內部 ID |
| notebookId | string | yes | 所屬 notebook ID（FK → NotebookEntry.id） |
| displayName | string | yes | 目前在 NotebookLM UI 上的顯示名稱 |
| originType | SourceOriginType | yes | 來源類型 |
| originPath | string | yes | 原始路徑或 URL |
| addedAt | ISO8601 string | yes | 新增時間 |
| renamedFrom | string \| null | no | 重命名前的名稱（如 "Pasted text"） |
| renameStatus | `done` \| `pending` \| `failed` | yes | 重命名狀態 |
| wordCount | number \| null | no | 字數（若可取得） |

**Identity**: `id`
**Persisted**: Yes → `~/.nbctl/cache/<notebookId>/sources.json`

#### SourceOriginType (enum)

| Value | Description |
|-------|-------------|
| `repo` | Git repository（via repoToText） |
| `pdf` | PDF 文件（via pdfToText） |
| `web` | 網頁爬取（via urlToText） |
| `url` | NotebookLM 原生 URL 來源 |
| `text` | 手動文字貼上 |

---

### ArtifactRecord

NotebookLM 產生的衍生資源。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | UUID |
| notebookId | string | yes | 所屬 notebook ID |
| type | ArtifactType | yes | 資源類型 |
| prompt | string | yes | 產生它的原始指令 |
| generatedAt | ISO8601 string | yes | 產生時間 |
| localPath | string \| null | no | 下載到本機的路徑 |
| metadata | Record<string, unknown> | no | 額外元資料（duration, size 等） |

**Identity**: `id`
**Persisted**: Yes → `~/.nbctl/cache/<notebookId>/artifacts.json`

#### ArtifactType (enum)

| Value | Description |
|-------|-------------|
| `audio` | Audio Overview |
| `note` | NotebookLM 生成的筆記 |

---

### OperationLogEntry

操作歷程紀錄。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | UUID |
| notebookId | string | yes | 操作的 notebook ID |
| action | string | yes | 動作類型（exec, use, add, open, close 等） |
| command | string | yes | 原始指令文字 |
| result | `success` \| `error` | yes | 結果 |
| resultSummary | string | yes | 結果摘要 |
| timestamp | ISO8601 string | yes | 時間戳 |
| durationMs | number | yes | 操作耗時（毫秒） |

**Identity**: `id`
**Persisted**: Yes → `~/.nbctl/cache/<notebookId>/operations.json`

---

### QueryResult

查詢結果（runtime，不持久化，但摘要記錄在 OperationLogEntry）。

| Field | Type | Description |
|-------|------|-------------|
| success | boolean | 是否成功 |
| answer | string | Gemini 的回答全文 |
| citations | Citation[] | 來源引用陣列 |
| notebookId | string | 查詢的 notebook ID |
| durationMs | number | 查詢耗時 |

### Citation

| Field | Type | Description |
|-------|------|-------------|
| source | string | 來源名稱 |
| excerpt | string | 引用段落摘要 |

---

### OperationQueueItem

Operation Queue 中的待處理請求（runtime only）。

| Field | Type | Description |
|-------|------|-------------|
| id | string | 請求 ID |
| type | `exec` \| `use` | 操作類型 |
| notebookId | string \| null | 目標 notebook（use 指令用） |
| command | string | 指令內容 |
| resolve | function | Promise resolve callback |
| reject | function | Promise reject callback |
| enqueuedAt | number | 入隊時間戳（Date.now()） |

**Persisted**: No（runtime only）

---

## Storage Layout

```text
~/.nbctl/
├── state.json                          # Notebook Registry + daemon meta
│   {
│     "notebooks": [ NotebookEntry, ... ],
│     "activeNotebookId": "research" | null,
│     "version": 1
│   }
│
├── cache/
│   └── <notebook-id>/
│       ├── sources.json                # SourceRecord[]
│       ├── artifacts.json              # ArtifactRecord[]
│       └── operations.json             # OperationLogEntry[]
│
├── logs/
│   └── daemon.log                      # Daemon 結構化日誌
│
└── daemon.pid                          # PID file for duplicate detection
```

## Validation Rules

- `NotebookEntry.id`: 1-50 chars, alphanumeric + hyphens, unique
- `NotebookEntry.url`: MUST match `https://notebooklm.google.com/notebook/*`
- `SourceRecord.originPath`: non-empty string
- `OperationLogEntry.command`: non-empty string
- `state.json` version: MUST be 1（未來 migration 用）
