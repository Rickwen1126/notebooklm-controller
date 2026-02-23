# Flow & User Case Coverage Checklist: NotebookLM Controller MVP

**Purpose**: Pre-planning inventory — validate that all end-to-end flows are documented, user stories cover all workflows, and acceptance scenarios are complete and consistent.
**Created**: 2026-02-12
**Feature**: [spec.md](../spec.md)
**Depth**: Standard
**Audience**: Author (pre-plan readiness gate)

## End-to-End Flow Completeness

- [ ] CHK001 - Is the complete first-time onboarding flow documented as a single traceable journey (install → start → Google auth → add notebook → feed source → query)? [Completeness, Gap — only described in comment block line 38, no dedicated US]
- [ ] CHK002 - Is the "create new notebook from content" flow (exec → agent creates notebook → captures URL → registers → adds source) covered with sufficient acceptance scenarios for error paths (e.g., NotebookLM creation fails, alias collision)? [Coverage, Spec §US2-AS12/AS13]
- [ ] CHK003 - Is the async notification delivery flow documented end-to-end (exec --async → daemon queues → agent runs → result written to inbox → hook reads → AI receives)? [Completeness — split across US13/US14/US16, no single traceable path]
- [ ] CHK004 - Is the reauth flow documented for mid-operation session expiry (agent detects 302 during exec → pauses → returns error → user runs reauth → resumes)? Does the spec define whether in-progress operations are retried or failed after reauth? [Coverage, Spec §US1-AS7/AS8, Gap]
- [ ] CHK005 - Is the daemon recovery flow documented (crash → restart → load persisted state → queued tasks resume → running tasks marked failed)? [Completeness, Spec §FR-108 — no dedicated AS in US9]
- [x] CHK006 - ~~Is the "update existing source" flow defined?~~ **RESOLVED**: Added US3-AS4 (source update/refresh) + FR-060.
- [x] CHK007 - ~~Is the "remove source from notebook" flow defined?~~ **RESOLVED**: Added US3-AS5 (source removal) + FR-061.
- [x] CHK008 - ~~Is the "unregister notebook" flow defined?~~ **RESOLVED**: Added US2-AS18 (`nbctl remove`) + FR-059.
- [ ] CHK009 - Is the cancel-during-vision-operation flow specified with enough detail? Does the spec define what "safe point" means for different operation types (mid-paste, mid-click, mid-scroll)? [Clarity, Spec §US13-AS9]
- [ ] CHK010 - Is the `add-all` → alias assignment flow complete? When batch-adding notebooks, how are aliases chosen? Does the user provide each alias interactively? What if user doesn't provide one — is there an auto-generate strategy? [Clarity, Spec §US2-AS8/AS9]

## User Story Coverage — Missing Stories

- [x] CHK011 - ~~Is there a user story covering `nbctl rename`?~~ **RESOLVED**: Added US2-AS15/AS16.
- [x] CHK012 - ~~Is there a user story for unregistering/removing a notebook?~~ **RESOLVED**: Added US2-AS18 + FR-059.
- [x] CHK013 - ~~Is there a user story for source removal?~~ **RESOLVED**: Added US3-AS5 + FR-061.
- [x] CHK014 - ~~Is there a user story for source update/refresh?~~ **RESOLVED**: Added US3-AS4 + FR-060.
- [x] CHK015 - ~~Is there a user story covering `nbctl status` with Network Manager health info?~~ **RESOLVED**: Updated US1-AS3 to include `network` field in status JSON.
- [ ] CHK016 - Is there a user story for the daemon process management model (how daemon detaches, PID file, signal handling for graceful stop)? [Gap — FR-003 says "背景程序" but no AS defines the daemonization mechanism]

## Acceptance Scenario Gaps Within Existing Stories

- [x] CHK017 - ~~US2-AS5 contradicts FR-053.~~ **RESOLVED**: Changed to `nbctl add <invalid-url>` error case.
- [ ] CHK018 - US1 has no AS for `nbctl start` when daemon is running but Chrome has crashed silently. How does daemon detect and recover from Chrome process death? [Coverage, Edge Case]
- [x] CHK019 - ~~US2 has no AS for duplicate URL detection.~~ **RESOLVED**: Added US2-AS17.
- [x] CHK020 - ~~US2 has no AS for `nbctl rename`.~~ **RESOLVED**: Added US2-AS15/AS16.
- [ ] CHK021 - US6 (Audio) has no AS for cancelling an in-progress audio generation. Since audio takes 5-10 minutes, users may want to cancel. [Coverage, Edge Case]
- [ ] CHK022 - US9 (State persistence) has no AS for daemon crash recovery (only covers graceful stop/restart). FR-108 defines crash recovery but no AS exercises it. [Gap, Spec §FR-108]
- [ ] CHK023 - US14 (Notifications) has no AS for multiple notifications arriving simultaneously in one hook invocation. Does the hook batch them or process one at a time? [Coverage, Edge Case]
- [ ] CHK024 - US14 has no AS for notification delivery when the originating CLI session has ended. Does the notification persist until a new session reads it? [Coverage, Edge Case]
- [ ] CHK025 - US19 (Smart select) has no AS for when all notebooks score equally low on relevance, or when there's only one notebook registered. [Coverage, Edge Case]
- [ ] CHK026 - US3/US4/US5 (Content feeding) have no AS for adding multiple sources in a single exec command (e.g., "加入 A.pdf 和 B.pdf"). Is batch source addition supported? [Coverage, Gap]

## Cross-Story Consistency

- [ ] CHK027 - The intro comment (line 38) states the workflow as "啟動 → 認證 → 納管 → 餵入 → 命名 → 查詢 → 使用" but does not include the async/notify cycle. Is this summary outdated? [Consistency]
- [x] CHK028 - ~~FR-001 command list not reflected in intro comment.~~ **RESOLVED**: Intro comment updated with all commands including `rename`, `remove`, `cancel`, plus `status` disambiguation.
- [x] CHK029 - ~~US2-AS5 uses `open` with URL.~~ **RESOLVED**: Changed to `add <invalid-url>`.
- [ ] CHK030 - The Async Task state machine (FR-106) defines 5 states. Do all AS across US13/US14 consistently use only these states (`queued`, `running`, `completed`, `failed`, `cancelled`)? [Consistency]
- [x] CHK031 - ~~`nbctl status` overloaded between daemon and task status.~~ **RESOLVED**: FR-101 updated with 4-mode disambiguation. US1-AS3 updated with full daemon status JSON including network health.
- [ ] CHK032 - US2-AS7 (`add`) returns `sources` in JSON but this field isn't defined in any data model. Is the JSON response shape for `add` consistent with Notebook Registry entity definition? [Consistency, Spec §US2-AS7 vs Key Entities]

## Command Coverage Matrix

- [x] CHK033 - ~~Not every command has AS.~~ **PARTIALLY RESOLVED**: `rename` (US2-AS15/AS16), `remove` (US2-AS18) now covered. `export-skill` still has no AS.
- [ ] CHK034 - Is there an AS for `nbctl export-skill`? FR-133 defines it but no US/AS shows the output format. [Gap, Spec §FR-133]
- [ ] CHK035 - Is there an AS for `nbctl skills`? US18-AS2 covers it but the JSON response shape is vague ("列出所有 skill 名稱、描述與版本"). Is the output schema defined? [Clarity, Spec §US18-AS2]
- [x] CHK036 - ~~`status --recent` vs `--all` ambiguous.~~ **RESOLVED**: FR-101 now explicitly lists `--recent` as separate mode (recently completed, unconsumed notifications).

## Edge Case & Error Flow Coverage

- [ ] CHK037 - Is the error flow for "daemon not running when CLI command issued" defined with consistent JSON error format across all commands? [Completeness — mentioned in edge cases but no AS]
- [ ] CHK038 - Is the error flow for "Chrome unexpectedly killed while daemon still running" documented? [Gap, Edge Case]
- [ ] CHK039 - Is the flow for "notebook URL becomes invalid after registration" (e.g., notebook deleted in NotebookLM web UI) fully specified beyond the stale marker in US9-AS2? [Clarity, Spec §US9-AS2]
- [ ] CHK040 - Is the "partial failure in multi-step operations" flow defined (e.g., source added successfully but rename fails)? US20 mentions `rename_pending` in edge cases but no AS exercises it. [Coverage, Edge Case]
- [ ] CHK041 - Is concurrent access to the same daemon from multiple CLI processes defined? (Two terminals running `nbctl exec` to the same notebook simultaneously) [Gap, Edge Case]
- [ ] CHK042 - Are requirements defined for what happens when `add-all` encounters a notebook that's already registered? (Skip silently? Warn? Count as skipped?) [Coverage, Edge Case]

## Notes

- Check items off as completed: `[x]`
- Items marked `[Gap]` indicate missing requirements that should be added before planning
- Items marked `[Conflict]` indicate contradictions that must be resolved
- Items marked `[Ambiguity]` indicate unclear requirements needing clarification
- Items are numbered sequentially (CHK001–CHK042) for easy reference
