# Architecture & Integration Checklist: NotebookLM Controller MVP

**Purpose**: Validate requirements quality for daemon↔browser↔agent↔MCP integration boundaries, serialization model, and infrastructure constraints
**Created**: 2026-02-07
**Feature**: [spec.md](../spec.md)
**Depth**: Standard | **Audience**: Author (self-review)

## Daemon Lifecycle & Process Management

- [ ] CHK001 - Are daemon process management requirements defined (PID file, orphan cleanup, signal handling)? [Gap]
- [ ] CHK002 - Is the daemon startup sequence (connect browser → expose API → ready) specified with ordering constraints? [Completeness, Spec §FR-003]
- [ ] CHK003 - Are requirements defined for what happens when `nbctl start` is called while a daemon is already running? [Edge Case, Gap]
- [ ] CHK004 - Is "background process" specified with enough detail — daemonization method, stdout/stderr handling, log destination? [Clarity, Spec §FR-003]
- [ ] CHK005 - Are graceful vs forced shutdown requirements distinguished for `nbctl stop`? [Clarity, Spec §US1-AS3]

## Browser Connection & Isolation

- [ ] CHK006 - Is the reconnection behavior defined when Chrome connection drops mid-operation vs at idle? [Completeness, Edge Cases §iso-browser]
- [ ] CHK007 - Are requirements for validating Chrome is an iso-browser instance (vs user's main Chrome) specified? [Gap]
- [ ] CHK008 - Is port 19223 hardcoded in spec or configurable? Are port conflict requirements defined? [Clarity, Spec §FR-004]
- [ ] CHK009 - Is the Chrome DevTools Protocol (or equivalent) connection mechanism specified at requirements level (what capabilities are needed)? [Completeness, Spec §FR-004]
- [ ] CHK010 - Are requirements defined for browser tab state when no notebook is active (what does the browser show)? [Gap]

## Active Notebook & Serialization Model

- [ ] CHK011 - Is the state transition diagram for notebook status (registering → ready → active → stale) defined? [Completeness, Key Entities §Notebook Registry]
- [ ] CHK012 - Are requirements for `nbctl use` when the target notebook's URL is unreachable specified? [Edge Case, Gap]
- [ ] CHK013 - Is "serialized execution" (FR-030) clearly scoped — does it apply only to `exec` or also to management commands like `list`, `status`? [Ambiguity, Spec §FR-030]
- [ ] CHK014 - Are queue overflow/backpressure requirements defined (max queue depth, rejection behavior)? [Gap, Spec §FR-030]
- [ ] CHK015 - Is the behavior specified when a user runs `nbctl use <other>` while an `exec` operation is in-flight on the current notebook? [Edge Case, Gap]

## HTTP API Surface

- [ ] CHK016 - Are HTTP API endpoint paths and methods defined (REST conventions, versioning)? [Gap, Spec §FR-003]
- [ ] CHK017 - Are authentication/authorization requirements for the HTTP API specified (localhost-only? token?)? [Gap, Spec §FR-003]
- [ ] CHK018 - Is the HTTP API error response schema consistent with CLI JSON output schema? [Consistency, Spec §FR-005]
- [ ] CHK019 - Are health check endpoint response fields defined beyond status code 200? [Clarity, Spec §US1-AS1]

## MCP Server Integration

- [ ] CHK020 - Is the MCP server transport type specified (stdio, SSE, HTTP)? [Gap, Spec §FR-025]
- [ ] CHK021 - Are MCP tool input schemas (parameters, types, required fields) defined for `notebooklm_exec` and `notebooklm_list_notebooks`? [Completeness, Spec §FR-025/FR-027]
- [ ] CHK022 - Is the relationship between MCP server lifecycle and daemon lifecycle specified (co-process? embedded?)? [Clarity, Spec §FR-025]
- [ ] CHK023 - Are requirements for MCP tool responses consistent with CLI `nbctl exec` JSON output? [Consistency, Spec §FR-025 vs FR-005]
- [ ] CHK024 - Is the MCP server's behavior when the operation queue is full specified? [Gap, Spec §FR-025 + FR-030]

## State Persistence & Recovery

- [ ] CHK025 - Is the persistent storage format for Notebook Registry specified (JSON file, SQLite, etc.) at requirements level? [Gap, Spec §FR-023]
- [ ] CHK026 - Are concurrent access requirements defined (multiple CLI invocations reading/writing state simultaneously)? [Gap, Spec §FR-023]
- [ ] CHK027 - Is the recovery strategy for corrupted state files defined? [Edge Case, Gap]
- [ ] CHK028 - Are requirements for local cache location/path configurable or hardcoded? Is the default path specified? [Clarity, Spec §FR-039]

## Agent Session Management

- [ ] CHK029 - Is "agent session" lifecycle defined — when is it created, when destroyed, what state does it hold? [Clarity, Key Entities §Agent]
- [ ] CHK030 - Are requirements for agent session isolation between different notebooks specified (shared context vs fresh per notebook)? [Gap]
- [ ] CHK031 - Is the relationship between NotebookLM's in-browser chat session and the daemon's agent session clearly distinguished? [Ambiguity, Spec §FR-018]

## Cross-Boundary Consistency

- [ ] CHK032 - Are error code/message conventions consistent across CLI, HTTP API, and MCP tool responses? [Consistency, Spec §FR-005]
- [ ] CHK033 - Is the `nbctl login` flow's interaction with daemon state specified (does daemon need restart after login)? [Gap, Spec §FR-049]
- [ ] CHK034 - Are requirements for daemon port (19224) conflict detection and error reporting defined? [Edge Case, Gap]

## Notes

- Check items off as completed: `[x]`
- Add comments or findings inline
- Items are numbered sequentially for easy reference
- Focus: gaps and ambiguities for the spec author to address before planning
