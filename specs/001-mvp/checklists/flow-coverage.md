# Flow & Scenario Coverage Checklist: NotebookLM Controller MVP

**Purpose**: Validate that end-to-end flows are complete, acceptance scenarios cover all paths, and cross-story requirements are consistent
**Created**: 2026-03-12
**Feature**: [spec.md](../spec.md) | [quickstart.md](../quickstart.md)
**Depth**: Standard | **Audience**: Author (pre-implementation)

## End-to-End Flow Completeness

- [ ] CHK001 - Is the complete onboarding flow (install → start → auth → add notebook → feed source → query) traceable as a single journey across US1→US2→US3→US10? [Completeness, quickstart.md]
- [ ] CHK002 - Is the reauth mid-operation flow specified (agent detects 302 → returns error → user calls reauth → does the original operation retry or require re-submission)? [Gap, Spec §US1-AS7/AS8]
- [ ] CHK003 - Is the daemon startup → crash → restart → recovery flow documented with enough detail for all entity states (DaemonState, AsyncTask, TabManager)? [Completeness, Spec §FR-108]
- [ ] CHK004 - Is the content pipeline flow (repo/URL/PDF → text → paste → rename → cache update) specified as a consistent pattern across US3/US4/US5? [Consistency]

## Acceptance Scenario Gaps

- [ ] CHK005 - Is the `exec` tool behavior specified when the target notebook's status is "stale" or "error"? [Gap, Spec §US2]
- [ ] CHK006 - Are error messages across all 14 MCP tools using consistent language and structure? [Consistency, Spec §FR-005]
- [ ] CHK007 - Is the notebook description auto-update timing specified (FR-045/046) — does it happen synchronously during add_notebook or asynchronously after? [Clarity, Spec §FR-045]
- [ ] CHK008 - Is the `add_notebook` scan behavior specified — what exactly does "掃描 notebook 狀態" include (source list, title, description, audio status)? [Clarity, Spec §FR-033]

## Cross-Story Consistency

- [ ] CHK009 - Is the `notebook` parameter resolution consistent across all tools that accept it (exec, get_status with notebook filter)? [Consistency]
- [ ] CHK010 - Are the NotebookStatus values used consistently in acceptance scenarios vs data-model.md vs contracts? [Consistency, data-model.md §NotebookStatus]
- [ ] CHK011 - Is the `exec` tool output format consistent across different operation types (sourceAdded vs answer+citations vs screenshot vs audioStatus)? Or is polymorphic output intentional and documented? [Clarity, contracts/mcp-tools.md §exec]
- [ ] CHK012 - Are the FR alias pairs (FR-170↔004, FR-171↔030, FR-204↔110, FR-145↔048, FR-181↔049) consistent in wording, or do aliases introduce subtle discrepancies? [Consistency]

## Non-Functional Requirements

- [ ] CHK013 - Are timeout values specified at requirements level for different operation categories, or is "實測後決定" the only guidance? [Clarity, Spec §FR-031]
- [ ] CHK014 - Is the structured logging requirement (FR-051) specified with log levels, retention, and rotation policy? [Completeness, Spec §FR-051]
- [ ] CHK015 - Is the content size limit (500K words for repo) defined for URL and PDF content types as well? [Gap, Spec §US3-AS3]

## Notes

- Check items off as completed: `[x]`
- 15 items across 4 categories
- Focus: end-to-end flow traceability, scenario gaps, cross-story consistency, NFR clarity
