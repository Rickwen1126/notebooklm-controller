# Browser & State Management Checklist: NotebookLM Controller MVP

**Purpose**: Validate requirements quality for TabManager, CDP operations, NetworkGate, state persistence, and local cache
**Created**: 2026-03-12
**Feature**: [spec.md](../spec.md) | [data-model.md](../data-model.md)
**Depth**: Standard | **Audience**: Author (pre-implementation)

## TabManager & CDP

- [x] CHK001 - Is the TabHandle timeout mechanism specified with concrete values or calculation rules (how is `timeoutAt` determined per operation type)? [Clarity, data-model.md §TabHandle] — Deferred by design: 實測後決定具體值，spec 已標注意圖
- [x] CHK002 - Is the tab crash recovery flow defined (single tab crash vs Chrome process crash)? Are they handled differently per FR-174? [Completeness, Spec §FR-174]
- [x] CHK003 - Is the "底層實作可替換" requirement (FR-142/143) specified with an abstraction interface, or just stated as intent? [Clarity, Spec §FR-142] — Resolved: 替換在 AgentConfig.tools 白名單層（換 tool 不換 TabManager 底層），SDK 已提供機制，不需額外 abstraction interface
- [x] CHK004 - Are the CDP operations required by browser-tools (screenshot, click, type, scroll, paste) enumerated with their CDP protocol method names? [Completeness, Spec §FR-008] — CDP method names 是實作細節，spec 層列舉 high-level tools（screenshot/click/type/scroll/paste）已足夠
- [x] CHK005 - Is the headless screenshot rendering consistency requirement (FR-184) measurable or just aspirational? [Measurability, Spec §FR-184] — Wait-and-see: 實測後若座標精度有問題再量化，目前 aspirational 可接受

## NetworkGate

- [x] CHK006 - Are the specific signals that trigger `reportAnomaly()` enumerated (HTTP 429, 503, CAPTCHA page, timeout threshold)? [Completeness, Spec §FR-191]
- [x] CHK007 - Is the exponential backoff specification (initial 5s, max 5min) consistent between spec and config module requirements? [Consistency, Spec §FR-192 vs tasks.md §T007]
- [x] CHK008 - Is the "fail-open" behavior for `acquirePermit()` defined (what happens if NetworkGate itself errors)? [Gap, tasks.md §T025] — Fixed: FR-195 added, acquirePermit 內部錯誤時 fail-open（放行 + warn log）
- [x] CHK009 - Is the interaction between NetworkGate backoff and per-notebook operation queue specified (does backoff block the queue or individual operations)? [Clarity, Spec §FR-190 vs FR-030] — acquirePermit 是 blocking call，backoff 期間所有需要 permit 的操作都等待，邏輯上自然阻塞整個 queue

## State Persistence

- [x] CHK010 - Is the atomic write mechanism (temp + rename) specified with failure modes (disk full, permission denied mid-write)? [Completeness, data-model.md §DaemonState] — 標準 temp+rename pattern，OS 層級失敗（disk full 等）由 Node.js fs error 自然浮出，不需 spec 層額外定義
- [x] CHK011 - Is the DaemonState schema versioning (`version: 1`) specified with migration strategy for future versions? [Gap, data-model.md §DaemonState] — Deferred: MVP v1 不需要 migration strategy，版本號預留給未來使用
- [x] CHK012 - Is the relationship between `NotebookEntry.sourceCount` cache and actual SourceRecord count specified (when to sync, staleness tolerance)? [Clarity, data-model.md §NotebookEntry] — FR-022 post-op sync 足夠：每次操作後同步，不需定義 staleness tolerance
- [x] CHK013 - Are file permission enforcement requirements (FR-054/055) specified for all file types in `~/.nbctl/` including newly created files during runtime? [Completeness, Spec §FR-054]

## Local Cache & Data Model

- [x] CHK014 - Is the `SourceRecord.renameStatus` state machine (done/pending/failed) specified with transitions and retry behavior? [Clarity, data-model.md §SourceRecord] — 簡單轉換（pending→done/failed），不需完整 state machine 定義，retry 由 agent 判斷
- [x] CHK015 - Is the soft delete semantics for SourceRecord and ArtifactRecord (`removedAt`) defined with regard to query behavior (are deleted records returned by default)? [Clarity, data-model.md] — Fixed: data-model 已補充 `removedAt !== null` 預設排除，需要時可帶參數查詢
- [x] CHK016 - Is the OperationLogEntry's dual purpose (human history + agent external memory) reflected in query requirements (different query patterns for each use case)? [Completeness, data-model.md §OperationLogEntry] — Resolved: 三層紀錄模型重寫後，OperationLogEntry 定位為「Client 工單紀錄」，不再是雙重用途，query pattern 單一化

## Notes

- Check items off as completed: `[x]`
- 16 items across 4 categories
- Focus: TabManager lifecycle, NetworkGate semantics, atomic persistence, cache consistency
