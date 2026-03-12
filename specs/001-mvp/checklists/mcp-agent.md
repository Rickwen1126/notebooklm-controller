# MCP & Agent Runtime Checklist: NotebookLM Controller MVP

**Purpose**: Validate requirements quality for MCP Server interface, Copilot SDK agent runtime, tool definitions, and async task lifecycle
**Created**: 2026-03-12
**Feature**: [spec.md](../spec.md) | [contracts/mcp-tools.md](../contracts/mcp-tools.md)
**Depth**: Standard | **Audience**: Author (pre-implementation)

## MCP Tool Definition Completeness

- [ ] CHK001 - Are input schemas defined with Zod types for all 14 MCP tools? [Completeness, contracts/mcp-tools.md]
- [ ] CHK002 - Are error response formats specified for every tool, covering all documented failure modes in acceptance scenarios? [Completeness, Spec §FR-005]
- [ ] CHK003 - Is the `exec` tool's behavior when both `notebook` param and `defaultNotebook` are absent clearly specified? [Clarity, Spec §FR-002]
- [ ] CHK004 - Are the 4 query modes of `get_status` (no params, taskId, all, recent) distinguishable by input alone, or could ambiguous combinations occur? [Clarity, Spec §FR-101]
- [ ] CHK005 - Is the `list_agents` output schema specified with enough detail (which fields from AgentConfig are exposed)? [Completeness, contracts/mcp-tools.md §list_agents]

## Agent Runtime & Copilot SDK

- [ ] CHK006 - Is the mapping from AgentConfig fields to SDK's CustomAgentConfig explicitly documented (which fields pass through, which are our extensions)? [Clarity, data-model.md §AgentConfig]
- [ ] CHK007 - Is the `infer` field's interaction with the `tools` whitelist clearly specified (what happens when infer=true AND tools is non-empty)? [Clarity, data-model.md §AgentConfig]
- [ ] CHK008 - Are SessionHooks error routing semantics (retry/skip/abort) defined with conditions for each path? [Completeness, Spec §Agent Session]
- [ ] CHK009 - Is the `acquirePermit` timeout constraint relative to `sendAndWait` timeout explicitly quantified or left to implementation? [Clarity, tasks.md §T026]
- [ ] CHK010 - Are agent config template variables (`{{variables}}`) documented with available variables and rendering rules? [Gap]

## Async Task Lifecycle

- [ ] CHK011 - Are all 5 state transitions in the AsyncTask state machine (FR-106) consistently referenced across spec, data-model, and contracts? [Consistency, Spec §FR-106]
- [ ] CHK012 - Is the `cancel_task` "safe point" concept defined with enough specificity for implementation (what constitutes a safe point per operation type)? [Clarity, Spec §FR-107]
- [ ] CHK013 - Is the TTL cleanup rule (24h, FR-113) consistent with the `recent` query mode behavior (what if a task expires before client pulls)? [Consistency, Spec §FR-113 vs FR-101]
- [ ] CHK014 - Is the daemon crash recovery behavior (FR-108) specified with regard to partially-written task files (atomic write guarantee)? [Completeness, Spec §FR-108]

## MCP Notification

- [ ] CHK015 - Is the notification payload schema in contracts/mcp-tools.md consistent with TaskNotificationPayload in data-model.md? [Consistency]
- [ ] CHK016 - Is "fire-and-forget" behavior defined clearly enough — does the daemon retry on transport error, or truly fire once? [Clarity, Spec §FR-110]
- [ ] CHK017 - Is the `urgent` flag for failure notifications mentioned in tasks.md (T036) defined in the notification payload schema? [Consistency, contracts/mcp-tools.md vs tasks.md]

## Notes

- Check items off as completed: `[x]`
- 17 items across 4 categories
- Focus: MCP tool schemas, Copilot SDK integration, async lifecycle, notification
