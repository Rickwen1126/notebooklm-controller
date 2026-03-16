# notebooklm-controller — AI Collaborator Guidelines

## Architecture Overview

G2 Script-first: `Planner LLM (gpt-4.1)` → `runScript()` → (fail?) `runRecoverySession() (gpt-5-mini)` + `saveRepairLog()`

Happy path = **0 LLM cost** (deterministic script). LLM only on failure (Recovery).

```text
src/
  daemon/         # MCP Server (Streamable HTTP, @modelcontextprotocol/sdk)
  tab-manager/    # Single Chrome multi-tab (puppeteer-core, CDP)
  network-gate/   # Centralized traffic gate (permit-based)
  agent/          # Copilot SDK adapter
    session-runner.ts  # runPipeline: Planner → Script → Recovery
    recovery-session.ts  # GPT-5-mini (only on script failure)
    repair-log.ts  # Error log + screenshot persistence
    tools/        # defineTool() + Zod (browser, content, state tools)
  scripts/        # Deterministic DOM scripts (0 LLM cost)
    operations.ts # 10 scripted operations
    index.ts      # runScript dispatcher + content pipeline preprocessing
  content/        # repo/URL/PDF → text (repomix, readability, pdf-parse)
  state/          # JSON persistence (~/.nbctl/)
  notification/   # MCP async task notifications
  shared/         # Config, types, locale, logger
tests/
```

## Tech Stack

TypeScript 5.x, Node.js 22 LTS, `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`, Vitest

## Commands

```bash
npm test          # 688 unit/integration tests (Vitest)
npm run lint      # ESLint
/test-real        # E2E against live daemon + ISO Browser verification
```

---

## Design Decisions

### AI Agent SDK

**`@github/copilot-sdk` (GitHub Copilot SDK) — NOT Claude Agent SDK.**

This is a core decision, not negotiable. All agent sessions, tool injection, and vision go through Copilot SDK runtime.

- `CopilotClient` singleton (daemon-level, autoRestart: true)
- `client.createSession({ tools, customAgents, hooks })` per-task
- `defineTool(name, { description, parameters: z.object(...), handler })`
- `session.sendAndWait({ prompt })` with timeout

### Viewport 1920x1080 is a Contract

**All scripts tested and run at 1920x1080. This is a contract, not a preference.**

- `Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false })`
- Scripts use `getBoundingClientRect()` → `dispatchClick(x, y)`. Coordinates are viewport-relative.
- **Changing viewport = all scripts may break.** Must re-run full real test.
- 800x600 triggers NotebookLM mobile tab view. 1440x900 clips homepage more_vert icons.

### Content Pipeline

addSource supports `sourceType`: text (direct paste), repo (repomix → chunks), url (readability → paste), pdf (pdf-parse → paste). Content > 100K chars auto-split into multiple sources. Auto-rename after paste (Planner provides `sourceName`).

---

## Critical Rules (Hard-won Lessons)

### Copilot SDK `defineTool` Limitations

**`z.record()`, `z.map()` and dynamic key types are NOT supported.**
Runtime crash: `Cannot read properties of undefined (reading '_zod')`.
Use expanded optional fields instead; handler converts back to Record.

### Dialog Button Search Scope

**Dialog buttons MUST be searched within overlay container, not full page.**

User notebook/source names may contain UI button text ("儲存", "刪除", "插入"). `findElementByText` on full page matches wrong elements (false positive — script reports success but operation didn't work).

Rules:
- Dialog buttons: `page.evaluate` within `.cdk-overlay-pane, [role=dialog]` using `querySelectorAll` (not `querySelector` — multiple overlays may stack)
- Page-level fixed UI ("新增來源", "開始輸入"): `findElementByText` OK
- Ambiguous full-page search: add `disambiguate` filter (e.g. `y > 400`)
- Angular Material inputs: use `HTMLInputElement.prototype.value` native setter + `dispatchEvent('input')`. CDP `Input.insertText` does NOT trigger Angular change detection.

These rules also apply to Recovery Agent's UIMap patch suggestions.

### i18n — All UI Text from UIMap

**No hardcoded Chinese/English strings in scripts.** All UI text comes from `ctx.uiMap.elements.*`.
Locale auto-detected from Chrome `navigator.language`, overridable via `~/.nbctl/config.json { "locale": "zh-TW" }`.

### Auto-Rename Limitation

Auto-rename after addSource only works when exactly 1 unnamed source ("貼上的文字") exists. If >= 2 unnamed sources: skip rename, warn user. This is by design — system-managed notebooks always satisfy this constraint.

---

## CRITICAL: Never Kill User's Chrome

**NEVER run `pkill -f "Google Chrome"` or any command that kills the user's main Chrome browser.**

To stop the daemon: `pkill -f "tsx src/daemon/launcher"` only.
If Chrome profile is locked, wait or use a different `userDataDir` — do NOT kill Chrome processes.

---

## Development Workflow

Before starting any new feature:
1. **Check git status** — clean working tree? On correct branch?
2. **Decide branching** — new feature branch or continue on main?
3. **Scope check** — small fix → update `specs/improvement.md`. New feature → update `specs/spec.md`. **Major architectural change → use speckit to create a new spec** (`/speckit.specify`)
4. **Update improvement.md** — if the feature addresses a known limitation, mark it

`specs/spec.md` is the living project spec. `specs/improvement.md` tracks known issues + future plans. `specs/001-mvp/` is historical archive.

---

## Git Hooks

Pre-push hook blocks push if `npm run build` fails. Install: `sh scripts/install-hooks.sh`

---

## E2E Testing Protocol

**Any change to core functionality MUST run `/test-real` before commit.**

Core functionality = scripts (`src/scripts/`), session-runner, daemon wiring, content pipeline, UIMap.

Minimum E2E checklist:
1. `npm test` — all unit/integration tests pass
2. `/test-real` Phase 2 — S01-S12 all-ops happy path (at least the operations affected by the change)
3. `/iso-browser` local skill independent DOM verification — don't trust daemon's text response, verify visually
4. If dialog/overlay logic changed → test on notebook with multiple sources (user content pollution)
5. If viewport/coordinate logic changed → full S01-S12 rerun
6. If content pipeline changed → CP01-CP04 (repo/URL/PDF/text)

Skip only if the change is purely documentation or test-only.

## Checkpoint

Run `/save` at: milestone completion, important decisions, tests passing, before ending session.
