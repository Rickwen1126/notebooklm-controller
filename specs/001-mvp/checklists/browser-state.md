# Browser & State Management Checklist: NotebookLM Controller MVP

**Purpose**: Validate requirements quality for TabManager, CDP operations, NetworkGate, state persistence, and local cache
**Created**: 2026-03-12
**Feature**: [spec.md](../spec.md) | [data-model.md](../data-model.md)
**Depth**: Standard | **Audience**: Author (pre-implementation)

## TabManager & CDP

- [ ] CHK001 - Is the TabHandle timeout mechanism specified with concrete values or calculation rules (how is `timeoutAt` determined per operation type)? [Clarity, data-model.md §TabHandle]
- [ ] CHK002 - Is the tab crash recovery flow defined (single tab crash vs Chrome process crash)? Are they handled differently per FR-174? [Completeness, Spec §FR-174]
- [ ] CHK003 - Is the "底層實作可替換" requirement (FR-142/143) specified with an abstraction interface, or just stated as intent? [Clarity, Spec §FR-142]
- [ ] CHK004 - Are the CDP operations required by browser-tools (screenshot, click, type, scroll, paste) enumerated with their CDP protocol method names? [Completeness, Spec §FR-008]
- [ ] CHK005 - Is the headless screenshot rendering consistency requirement (FR-184) measurable or just aspirational? [Measurability, Spec §FR-184]

## NetworkGate

- [ ] CHK006 - Are the specific signals that trigger `reportAnomaly()` enumerated (HTTP 429, 503, CAPTCHA page, timeout threshold)? [Completeness, Spec §FR-191]
- [ ] CHK007 - Is the exponential backoff specification (initial 5s, max 5min) consistent between spec and config module requirements? [Consistency, Spec §FR-192 vs tasks.md §T007]
- [ ] CHK008 - Is the "fail-open" behavior for `acquirePermit()` defined (what happens if NetworkGate itself errors)? [Gap, tasks.md §T025]
- [ ] CHK009 - Is the interaction between NetworkGate backoff and per-notebook operation queue specified (does backoff block the queue or individual operations)? [Clarity, Spec §FR-190 vs FR-030]

## State Persistence

- [ ] CHK010 - Is the atomic write mechanism (temp + rename) specified with failure modes (disk full, permission denied mid-write)? [Completeness, data-model.md §DaemonState]
- [ ] CHK011 - Is the DaemonState schema versioning (`version: 1`) specified with migration strategy for future versions? [Gap, data-model.md §DaemonState]
- [ ] CHK012 - Is the relationship between `NotebookEntry.sourceCount` cache and actual SourceRecord count specified (when to sync, staleness tolerance)? [Clarity, data-model.md §NotebookEntry]
- [ ] CHK013 - Are file permission enforcement requirements (FR-054/055) specified for all file types in `~/.nbctl/` including newly created files during runtime? [Completeness, Spec §FR-054]

## Local Cache & Data Model

- [ ] CHK014 - Is the `SourceRecord.renameStatus` state machine (done/pending/failed) specified with transitions and retry behavior? [Clarity, data-model.md §SourceRecord]
- [ ] CHK015 - Is the soft delete semantics for SourceRecord and ArtifactRecord (`removedAt`) defined with regard to query behavior (are deleted records returned by default)? [Clarity, data-model.md]
- [ ] CHK016 - Is the OperationLogEntry's dual purpose (human history + agent external memory) reflected in query requirements (different query patterns for each use case)? [Completeness, data-model.md §OperationLogEntry]

## Notes

- Check items off as completed: `[x]`
- 16 items across 4 categories
- Focus: TabManager lifecycle, NetworkGate semantics, atomic persistence, cache consistency
