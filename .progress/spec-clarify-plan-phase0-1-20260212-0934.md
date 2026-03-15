## 2026-02-12 15:14 — Architecture pivot + deep design: multi-tab, notify adapter, connection manager

**Goal**: Pivot architecture from MCP to CLI + Skill + Notify, then deep-dive concurrency and notification routing design

**Done**:
- Research: Patchright, curl-cffi, community projects, MCP async limitations, Claude Code hooks
- Architecture decision: Drop MCP, use CLI + Skill + Inbox + Hook pattern
- New spec written: `specs/002-abstract-cli-notify/spec.md` (branch `002-abstract-cli-notify`)
- Checklist: `specs/002-abstract-cli-notify/checklists/requirements.md` — 16/16 PASS
- Deep design discussion: multi-notebook parallelism, inbox concurrency, notification routing
- Research: Claude Code hook stdin JSON includes `session_id` (not env var, parsed from stdin)
- Spec v2 update: rewrote `specs/002-abstract-cli-notify/spec.md` with all new FRs (FR-105, FR-115, FR-120~127, FR-140~144, FR-170~175, FR-180~184) and updated Key Entities, Clarifications, Success Metrics

**Decisions**:
- MCP removed entirely — blocking tool calls + no server-push = worse than CLI
- **Multi-tab broker**: 1 daemon, 1 Chrome (headless), N tabs. Each notebook = 1 tab. Cross-notebook parallel, intra-notebook serial.
- **Connection Manager** replaces Browser Strategy: abstraction at connection manager layer, not strategy pattern. Agent gets pageId + closure-bound tools, never sees Puppeteer.
- **Headless + headed auth**: first login headed (user does Google auth), cookies persisted to `~/.nbctl/profiles/`, subsequent runs headless. `nbctl reauth` for session expiry.
- **Notification Adapter** (per-tool best practice, NOT lowest-common-denominator): Claude Code adapter uses `session_id` from hook stdin for per-session inbox routing + full push. Generic adapter = pull-based fallback.
- **Per-session inbox**: `~/.nbctl/inbox/<session-id>/<priority>/task-<taskId>.json`. No cross-session notification leakage.
- **Consume = rename to consumed/** (not delete): atomic, preserves audit trail, daemon cleans consumed/ after 24h.
- **Multi-layer anti-forget**: (1) CLI hint in async response, (2) hook push, (3) Stop hook blocks on urgent, (4) Skill template guidance.
- Patchright: not needed now, but Connection Manager interface reserved for future swap
- curl-cffi: rejected (no JS runtime, Python ecosystem mismatch)

**State**: Branch `002-abstract-cli-notify`. Spec v2 complete with all design decisions integrated. Checklist may need re-run against v2 spec. 001-mvp plan artifacts need update for new modules (connection-manager, notify-adapter, multi-tab).

---

## 2026-02-12 09:34 — Spec clarify + plan Phase 0-1 complete

**Goal**: Complete speckit workflow: checklist → clarify → plan for 001-mvp feature

**Done**:
- Architecture checklist generated: `specs/001-mvp/checklists/architecture.md` (34 items)
- Clarify session completed (5 questions): duplicate start, serialization scope, MCP coupling, HTTP API auth, agent session lifecycle
- All clarifications integrated into `specs/001-mvp/spec.md` (Clarifications section + inline updates to FR-003, FR-025/026, FR-030, Key Entities §Agent, US1-AS5)
- Phase 0 research: `specs/001-mvp/research.md` — Agent SDK V2, puppeteer-core CDP, MCP SDK stdio, repomix, Fastify, JSON file storage, Vitest
- Phase 1 plan: `specs/001-mvp/plan.md` — 7-module structure (cli/daemon/agent/browser/content/state/mcp), constitution check all PASS
- Phase 1 data model: `specs/001-mvp/data-model.md` — NotebookEntry, SourceRecord, ArtifactRecord, OperationLogEntry, DaemonState, OperationQueueItem
- Phase 1 contracts: `specs/001-mvp/contracts/http-api.yaml` (OpenAPI), `specs/001-mvp/contracts/mcp-tools.md` (2 MCP tools)
- Phase 1 quickstart: `specs/001-mvp/quickstart.md`
- CLAUDE.md auto-updated with tech stack
- Port migration: all specs/ files updated from 9223→19223, 9224→19224 (avoid iso-browser port collision)

**Decisions**:
- `nbctl start` while daemon running → error, no second instance
- Serialization: only browser-touching ops (`exec`, `use`) queued; `list`/`status` instant
- MCP: embedded in daemon, stdio transport, closures share state
- HTTP API: localhost-only (127.0.0.1), no token auth for MVP
- Agent session: per-notebook lifecycle, isolated between notebooks
- Ports: 19223 (Chrome CDP), 19224 (daemon HTTP API)

**State**: Branch `001-mvp`. All Phase 0+1 artifacts generated. No code written yet. `docs/` files still reference old ports (intentionally — historical reference docs).
