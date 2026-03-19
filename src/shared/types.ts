import type { CDPSession, Page } from "puppeteer-core";

/** Status of a notebook managed by the daemon. */
export type NotebookStatus =
  | "ready"
  | "operating"
  | "stale"
  | "error";

/** A notebook entry embedded in DaemonState.notebooks. */
export interface NotebookEntry {
  alias: string;
  url: string;
  title: string;
  description: string;
  status: NotebookStatus;
  /** ISO 8601 */
  registeredAt: string;
  /** ISO 8601 */
  lastAccessedAt: string;
  sourceCount: number;
}

/** Singleton daemon state, persisted at ~/.nbctl/state.json. */
export interface DaemonState {
  version: 1;
  defaultNotebook: string | null;
  pid: number | null;
  port: number;
  /** ISO 8601 */
  startedAt: string | null;
  notebooks: Record<string, NotebookEntry>;
}

/** Origin metadata describing how a source was ingested. */
export interface SourceOrigin {
  type: "repo" | "url" | "url-native" | "pdf" | "manual";
  path: string | null;
  url: string | null;
  repomixConfig: object | null;
}

/** A source record, stored at ~/.nbctl/cache/<alias>/sources.json. */
export interface SourceRecord {
  id: string;
  notebookAlias: string;
  displayName: string;
  expectedName: string;
  renameStatus: "done" | "pending" | "failed";
  origin: SourceOrigin;
  wordCount: number | null;
  /** ISO 8601 */
  addedAt: string;
  /** ISO 8601 */
  updatedAt: string | null;
  /** ISO 8601, soft delete marker */
  removedAt: string | null;
}

/** An artifact record (audio, note, etc.), stored at ~/.nbctl/cache/<alias>/artifacts.json. */
export interface ArtifactRecord {
  id: string;
  notebookAlias: string;
  type: "audio" | "note" | "other";
  prompt: string;
  localPath: string | null;
  duration: string | null;
  size: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601, soft delete marker */
  removedAt: string | null;
}

/** Action types that can appear in operation logs. */
export type OperationActionType =
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

/** An operation log entry, stored at ~/.nbctl/cache/<alias>/operations.json. */
export interface OperationLogEntry {
  id: string;
  taskId: string | null;
  notebookAlias: string;
  command: string;
  actionType: OperationActionType;
  status: "success" | "failed" | "cancelled";
  resultSummary: string;
  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601 */
  completedAt: string;
  durationMs: number;
}

/** Lifecycle status of an async task. */
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** A single status transition within an async task's history. */
export interface TaskStatusChange {
  from: TaskStatus | null;
  to: TaskStatus;
  /** ISO 8601 */
  timestamp: string;
  reason: string | null;
}

/** An async task, stored at ~/.nbctl/tasks/<taskId>.json. */
export interface AsyncTask {
  taskId: string;
  notebookAlias: string;
  command: string;
  context: string | null;
  status: TaskStatus;
  result: object | null;
  error: string | null;
  errorScreenshot: string | null;
  history: TaskStatusChange[];
  /** ISO 8601 */
  createdAt: string;
}

/** Payload pushed via MCP notification when an async task completes or fails. */
export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed";
  notebook: string;
  result: object;
  originalContext: string | null;
  command: string;
  /** ISO 8601 */
  timestamp: string;
}

/** Runtime-only handle to an active Chrome tab managed by TabManager. */
export interface TabHandle {
  tabId: string;
  notebookAlias: string;
  url: string;
  /** Pool state: "active" = occupied by task, "idle" = available for reuse. */
  state: "active" | "idle";
  /** ISO 8601 */
  acquiredAt: string;
  /** ISO 8601 */
  timeoutAt: string;
  /** ISO 8601, set when released back to pool. */
  releasedAt: string | null;
  cdpSession: CDPSession;
  page: Page;
}

/** Runtime-only network health snapshot from NetworkGate. */
export interface NetworkHealth {
  status: "healthy" | "throttled" | "disconnected";
  /** ISO 8601 */
  backoffUntil: string | null;
  backoffRemainingMs: number | null;
  /** ISO 8601 */
  lastCheckedAt: string;
  recentLatencyMs: number | null;
}

/** A parameter definition within an agent config. */
export interface AgentParameter {
  type: "string" | "number" | "boolean";
  description: string;
  default: string | number | boolean;
}

/** Agent configuration (legacy — G2 uses scripts instead). */
export interface AgentConfig {
  name: string;
  displayName: string;
  description: string;
  tools: string[];
  prompt: string;
  infer: boolean;
  /** Expected starting page for Executor pre-navigate hint. */
  startPage: "homepage" | "notebook";
  parameters: Record<string, AgentParameter>;
}

/** Response returned by the exec tool when a task is submitted asynchronously. */
export interface AsyncSubmitResult {
  taskId: string;
  status: "queued";
  notebook: string;
  hint: string;
}

/** Response returned by the get_status tool. */
export interface DaemonStatusResult {
  running: boolean;
  tabPool: {
    usedSlots: number;
    maxSlots: number;
    idleSlots: number;
  };
  network: NetworkHealth;
  activeNotebooks: string[];
  defaultNotebook: string | null;
  pendingTasks: number;
  runningTasks: number;
  agentHealth: {
    healthy: boolean;
    consecutiveTimeouts: number;
    degraded: boolean;
  };
  /** Whether Google session was valid at daemon startup. */
  googleSessionValid: boolean;
}

// ---------------------------------------------------------------------------
// Two-Session Planner+Executor (Phase 5.5)
// ---------------------------------------------------------------------------

/** A single step in an execution plan produced by the Planner session. */
export interface ExecutionStep {
  operation: string;
  params: Record<string, string>;
}

/** Structured execution plan captured from the Planner session via submitPlan tool. */
export interface ExecutionPlan {
  steps: ExecutionStep[];
  reasoning: string;
}

/** A single tool call recorded during a Recovery session. */
export interface RecoveryToolCall {
  tool: string;
  input: string;   // truncated
  output: string;  // truncated
}

/** Repair log entry persisted at ~/.nbctl/repair-logs/. */
export interface RepairLog {
  operation: string;
  failedAtStep: number | null;
  failedSelector: string | null;
  uiMapValue: Record<string, unknown> | null;
  scriptLog: Array<{
    step: number;
    action: string;
    status: "ok" | "warn" | "fail";
    detail: string;
    durationMs: number;
  }>;
  recovery: {
    success: boolean;
    model: string;
    toolCalls: number;
    durationMs: number;
    result: string | null;
    analysis: string | null;
    toolCallLog: RecoveryToolCall[];
    agentMessages: string[];
    finalScreenshotPath: string | null;
  };
  suggestedPatch: {
    elementKey: string;
    oldValue: string;
    newValue: string;
    confidence: number;
  } | null;
  timestamp: string;
}

/** A single UI element entry in the locale-specific UI map. */
export interface UIMapElement {
  text: string;
  match?: "text" | "placeholder" | "aria-label";
  disambiguate?: string;
}

/** Locale-specific UI element map for NotebookLM, loaded from src/config/ui-maps/. */
export interface UIMap {
  locale: string;
  verified: boolean;
  elements: Record<string, UIMapElement>;
  selectors: Record<string, string>;
}
