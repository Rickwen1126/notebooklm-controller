# notebooklm-controller — AI Collaborator Guidelines

## Architecture Overview

Current execution chain:

`MCP tool` → `Scheduler` → `createRunTask()` dispatcher → `TaskRunner` → deterministic script → `runRecoverySession()` on failure

Happy path = deterministic browser automation. Recovery LLM exists only for failure handling and repair logging.

```text
src/
  daemon/         # MCP Server, scheduler, dispatcher, tool registration
  tab-manager/    # Single Chrome multi-tab (puppeteer-core, CDP)
  network-gate/   # Centralized traffic gate (permit-based)
  agent/
    session-runner.ts         # default pipeline runner: planner -> script -> recovery
    scan-notebooks-runner.ts  # homepage scan/register_all_notebooks runner
    create-notebook-runner.ts # homepage create_notebook runner
    recovery-session.ts       # GPT-5-mini failure recovery only
    repair-log.ts             # error log + screenshot persistence
    tools/                    # defineTool() + Zod browser tools for recovery
  scripts/        # Deterministic DOM scripts
    operations.ts # scripted operations
    index.ts      # runScript dispatcher + planner-visible catalog
  content/        # repo/URL/PDF -> text
  state/          # JSON persistence (~/.nbctl/)
  notification/   # MCP async task notifications
  shared/         # config, locale, logger, types
tests/
```

## Tech Stack

TypeScript 5.x, Node.js 22 LTS, `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`, Vitest

## Commands

```bash
npm test          # unit/integration tests
npm run lint      # ESLint
npm run build     # TypeScript build
/test-real        # E2E against live daemon + ISO Browser verification
```

---

## Design Decisions

### AI Agent SDK

**`@github/copilot-sdk` (GitHub Copilot SDK) — NOT Claude Agent SDK.**

This is a core decision. All recovery sessions, tool injection, and vision go through Copilot SDK runtime.

- `CopilotClient` singleton (daemon-level, autoRestart: true)
- `client.createSession({ tools, customAgents, hooks })` per task
- `defineTool(name, { description, parameters: z.object(...), handler })`
- `session.sendAndWait({ prompt })` with timeout

### Execution Layering Is a Contract

**MCP tool handlers are submitters, not executors.**

Formal ownership:

- `MCP tool layer`: validate input, resolve defaults, submit tasks, wait/poll, format result
- `Scheduler`: queueing, cancellation, task lifecycle
- `Dispatcher` (`createRunTask`): resolve URL, acquire/release tab, set viewport, dispatch runner, record operation log
- `Runner`: owns execution logic for a task family
- `Scripts`: deterministic DOM primitives
- `Recovery`: failure-only path inside runner/pipeline

If a new flow needs browser execution and does not fit the default pipeline, add a runner. Do not create a second execution path inside an MCP tool handler.

### Viewport 1920x1080 is a Contract

**All scripts are tested and run at 1920x1080.**

- `Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false })`
- Scripts use `getBoundingClientRect()` + CDP input events. Coordinates are viewport-relative.
- Changing viewport means scripts may break and requires real verification.
- 800x600 triggers NotebookLM mobile tab view. 1440x900 clips homepage controls.

### Content Pipeline

`addSource` supports `sourceType`: text, repo, url, pdf. Content > 100K chars auto-splits into multiple sources. Auto-rename after paste depends on planner/scripted source naming.

---

## Critical Rules (Hard-won Lessons)

### MCP Layer Boundaries

**Do not bypass the execution architecture.**

Forbidden in MCP tool handlers:

- `TabManager.acquireTab()` / `releaseTab()`
- direct access to `page`, `cdpSession`, or `buildScriptContext()`
- DOM queries, clicks, waits, script loops, browser-state-driven writeback
- exposing `TabHandle` or execution context through ad hoc injection

Required pattern:

- validate input
- resolve defaults
- submit scheduler task
- optionally wait/poll
- format result

`buildScriptContext()` is for runner-family code only. `ctx injection` is an internal script pattern, not permission to leak tab/page handles across layers.

### Runner Design

- New execution capability first asks: can the default pipeline handle this?
- If no, add a specialized runner and register it in `RUNNER_REGISTRY`.
- Homepage flows (`register_all_notebooks`, `create_notebook`) run on `__homepage__` queue.
- Browser state is the authority for dynamic NotebookLM URLs after creation/recovery.
- Runner-internal scripts may be imported directly by runners, but they do not belong in the planner-visible catalog unless they are safe public operations.

### Copilot SDK `defineTool` Limitations

**`z.record()`, `z.map()`, and dynamic key types are not supported.**

Runtime crash: `Cannot read properties of undefined (reading '_zod')`.
Use expanded optional fields instead; handler converts back to `Record`.

### Dialog Button Search Scope

**Dialog buttons must be searched inside overlay containers, not across the full page.**

User content can contain button text like "儲存", "刪除", or "插入". Full-page text search creates false positives.

Rules:

- Dialog buttons: search within `.cdk-overlay-pane, [role=dialog]`
- Page-level fixed UI: scoped page search is acceptable
- Ambiguous matches: add disambiguation
- Angular Material inputs: use native value setter + `dispatchEvent("input")`

These rules also apply to recovery-session UIMap patch suggestions.

### i18n

**No hardcoded Chinese/English UI strings in scripts.** All UI text comes from `ctx.uiMap.elements.*`.

Locale auto-detected from Chrome `navigator.language`, overridable via `~/.nbctl/config.json`.

### Auto-Rename Limitation

Auto-rename after addSource only works when exactly one unnamed source exists. If multiple unnamed sources exist, skip rename and warn. This is by design.

### Never Kill User's Chrome

**Never run `pkill -f "Google Chrome"` or any command that kills the user's main Chrome browser.**

To stop the daemon: `pkill -f "tsx src/daemon/launcher"` only.
If Chrome profile is locked, wait or use a different `userDataDir`.

---

## Development Workflow

Before starting a feature:

1. Check `git status`.
2. Decide whether work belongs on current branch/worktree.
3. Scope check:
   - small fix → update `specs/improvement.md`
   - feature / behavior rebaseline → update `specs/spec.md`
   - major architectural change → create a dedicated spec
4. If the change addresses a known limitation, update `specs/improvement.md`

`specs/spec.md` is the living project spec. `specs/improvement.md` tracks known issues + future plans. `specs/001-mvp/` is historical archive.

## Git Hooks

Pre-push hook blocks push if `npm run build` fails. Install with:

```bash
sh scripts/install-hooks.sh
```

## E2E Testing Protocol

**Any change to core functionality must run `/test-real` before commit.**

Core functionality includes scripts, runners, dispatcher wiring, content pipeline, and UIMap-sensitive logic.

Minimum E2E checklist:

1. `npm test`
2. `/test-real` Phase 2 for affected operations
3. `/iso-browser` visual verification
4. If dialog/overlay logic changed, test polluted notebooks
5. If viewport/coordinate logic changed, rerun full scripted flow
6. If content pipeline changed, rerun repo/URL/PDF/text coverage

Skip only for pure documentation or test-only changes.

## Checkpoint

Run `/save` at milestone completion, after major decisions, after tests pass, and before ending the session.
