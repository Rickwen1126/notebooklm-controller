# Flow & Scenario Coverage Checklist: NotebookLM Controller MVP

**Purpose**: Validate that end-to-end flows are complete, acceptance scenarios cover all paths, and cross-story requirements are consistent
**Created**: 2026-03-12
**Feature**: [spec.md](../spec.md) | [quickstart.md](../quickstart.md)
**Depth**: Standard | **Audience**: Author (pre-implementation)

## End-to-End Flow Completeness

- [x] CHK001 - Is the complete onboarding flow (install → start → auth → add notebook → feed source → query) traceable as a single journey across US1→US2→US3→US10? [Completeness, quickstart.md]
- [x] CHK002 - Is the reauth mid-operation flow specified (agent detects 302 → returns error → user calls reauth → does the original operation retry or require re-submission)? [Gap, Spec §US1-AS7/AS8] — Fixed: FR-148 added, reauth only restores session, user must resubmit manually
- [x] CHK003 - Is the daemon startup → crash → restart → recovery flow documented with enough detail for all entity states (DaemonState, AsyncTask, TabManager)? [Completeness, Spec §FR-108]
- [x] CHK004 - Is the content pipeline flow (repo/URL/PDF → text → paste → rename → cache update) specified as a consistent pattern across US3/US4/US5? [Consistency]

## Acceptance Scenario Gaps

- [x] CHK005 - Is the `exec` tool behavior specified when the target notebook's status is "stale" or "error"? [Gap, Spec §US2] — Fixed: FR-025 added, stale→error, error→retry once, closed→auto open
- [x] CHK006 - Are error messages across all 14 MCP tools using consistent language and structure? [Consistency, Spec §FR-005]
- [x] CHK007 - Is the notebook description auto-update timing specified (FR-045/046) — does it happen synchronously during add_notebook or asynchronously after? [Clarity, Spec §FR-045] — 實作時決定：intent 是 add_notebook 後同步掃描取得，tasks 已涵蓋
- [x] CHK008 - Is the `add_notebook` scan behavior specified — what exactly does "掃描 notebook 狀態" include (source list, title, description, audio status)? [Clarity, Spec §FR-033]

## Cross-Story Consistency

- [x] CHK009 - Is the `notebook` parameter resolution consistent across all tools that accept it (exec, get_status with notebook filter)? [Consistency]
- [x] CHK010 - Are the NotebookStatus values used consistently in acceptance scenarios vs data-model.md vs contracts? [Consistency, data-model.md §NotebookStatus]
- [x] CHK011 - Is the `exec` tool output format consistent across different operation types (sourceAdded vs answer+citations vs screenshot vs audioStatus)? Or is polymorphic output intentional and documented? [Clarity, contracts/mcp-tools.md §exec] — Not an issue: exec output is agent's natural language result, not a typed schema. Structured data lives in OperationLogEntry/AsyncTask/cache, not exec response
- [x] CHK012 - Are the FR alias pairs (FR-170↔004, FR-171↔030, FR-204↔110, FR-145↔048, FR-181↔049) consistent in wording, or do aliases introduce subtle discrepancies? [Consistency]

## Non-Functional Requirements

- [x] CHK013 - Are timeout values specified at requirements level for different operation categories, or is "實測後決定" the only guidance? [Clarity, Spec §FR-031] — Deferred by design: 實測後決定是有意的，MVP 先跑再調
- [x] CHK014 - Is the structured logging requirement (FR-051) specified with log levels, retention, and rotation policy? [Completeness, Spec §FR-051] — Fixed: FR-051 已補充 JSON 格式、log levels（info/warn/error）、correlation fields（taskId/notebookAlias/actionType）。Retention/rotation 實作時決定
- [x] CHK015 - Is the content size limit (500K words for repo) defined for URL and PDF content types as well? [Gap, Spec §US3-AS3] — Fixed: spec 已泛化為所有文字來源（repo/URL/PDF）共用 500K 字上限，實測後確認具體值

## Notes

- Check items off as completed: `[x]`
- 15 items across 4 categories
- Focus: end-to-end flow traceability, scenario gaps, cross-story consistency, NFR clarity
