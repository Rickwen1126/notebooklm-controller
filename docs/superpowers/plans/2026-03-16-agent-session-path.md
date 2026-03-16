# Agent Session Path Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Agent Session as a second execution path alongside Script, so Planner can dispatch operations that need LLM judgment (scan notebooks, smart rename, etc.).

**Architecture:** ExecutionStep gets a `mode` field ("script" | "agent"). runPipeline checks mode and dispatches to either `runScript()` (existing) or new `runAgentSession()`. Agent Session reuses Recovery session's browser tools but with task-specific prompts from revived agent config files (`agents/*.md`). Agent configs loaded by existing `agent-loader.ts`.

**Tech Stack:** Existing — @github/copilot-sdk, puppeteer-core CDP, agent-loader.ts, zod

---

## Key Decisions

1. **Reuse Recovery browser tools** — `createRecoveryBrowserTools()` already has screenshot/find/click/paste/type/read/wait. Extract to shared `createBrowserTools()`.
2. **Agent configs from `agents/` dir** — Revive YAML frontmatter + Markdown prompt format. Only create configs for agent-mode operations.
3. **Planner decides mode** — Catalog entries have `mode: "script" | "agent"`. Planner's submitPlan step includes mode.
4. **submitResult tool** — Agent Session uses same `submitResult` pattern as Recovery for structured output.

---

## File Structure

### Create
| File | Responsibility |
|------|---------------|
| `src/agent/agent-session.ts` | `runAgentSession()` — LLM session with browser tools + task prompt |
| `src/agent/browser-tools-shared.ts` | `createBrowserTools()` — extracted from recovery-session.ts |
| `agents/scan-notebooks.md` | Agent config: scroll homepage + screenshot + vision → list all notebooks |

### Modify
| File | Change |
|------|--------|
| `src/agent/recovery-session.ts` | Import shared browser tools instead of inline |
| `src/agent/session-runner.ts` | submitPlan adds `mode` field. runPipeline dispatches by mode. |
| `src/shared/types.ts` | ExecutionStep adds optional `mode` field |
| `src/scripts/index.ts` | Catalog entries add `mode: "script"` (default) |

---

## Chunk 1: Extract Shared Browser Tools

### Task 1: Extract createBrowserTools to shared module

**Files:**
- Create: `src/agent/browser-tools-shared.ts`
- Modify: `src/agent/recovery-session.ts`

- [ ] Extract `createRecoveryBrowserTools()` from `recovery-session.ts` into `browser-tools-shared.ts` as `createBrowserTools(cdp, page)`
- [ ] The function returns the 7 browser tools: screenshot, find, click, paste, type, read, wait
- [ ] `recovery-session.ts` imports from `browser-tools-shared.ts` instead of defining inline
- [ ] Run `npm test` — all pass (no behavior change)
- [ ] Commit: `refactor: extract shared browser tools from recovery-session`

---

## Chunk 2: Agent Session

### Task 2: Create runAgentSession

**Files:**
- Create: `src/agent/agent-session.ts`
- Test: `tests/unit/agent/agent-session.test.ts`

- [ ] Create `runAgentSession()` with this signature:
```typescript
interface AgentSessionOptions {
  client: CopilotClientSingleton;
  cdp: CDPSession;
  page: Page;
  agentConfig: AgentConfig;  // from agent-loader
  goal: string;              // what to accomplish
  model?: string;
  timeoutMs?: number;
}

interface AgentSessionResult {
  success: boolean;
  result: string | null;
  toolCalls: number;
  durationMs: number;
}
```

- [ ] Implementation: create session with browser tools + `submitResult` tool + agent config prompt as system message
- [ ] `submitResult` captures result via closure (same pattern as Recovery)
- [ ] No 10-call limit (agent tasks may need more exploration than recovery)
- [ ] Default timeout: 5 min (agent tasks take longer than scripts)
- [ ] Write tests: mock CopilotClient, verify submitResult capture, timeout handling
- [ ] Run `npm test` — all pass
- [ ] Commit: `feat: runAgentSession — LLM execution path with browser tools`

---

## Chunk 3: Pipeline Integration

### Task 3: ExecutionStep mode + Planner + Pipeline dispatch

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/agent/session-runner.ts`
- Modify: `src/scripts/index.ts`
- Modify: `tests/unit/agent/session-runner.test.ts`

- [ ] `types.ts`: Add `mode?: "script" | "agent"` to ExecutionStep (optional, default "script")
- [ ] `session-runner.ts` submitPlan: add `mode` optional field to z.object
- [ ] `session-runner.ts` handler: pass `s.mode` to params if present
- [ ] `session-runner.ts` runPipeline: check `step.params.mode ?? "script"`:
```typescript
if (mode === "agent") {
  // Load agent config by operation name
  const agentConfig = await loadAgentConfig(join(AGENTS_DIR, `${step.operation}.md`), {}, options.locale);
  if (!agentConfig) { /* fail: unknown agent */ }
  const agentResult = await runAgentSession({ client, cdp, page, agentConfig, goal });
  // handle result...
} else {
  // existing script path
  const scriptResult = await runScript(step.operation, step.params, ctx);
  // ...
}
```
- [ ] `index.ts`: All existing catalog entries keep `mode: "script"` (explicitly or by default)
- [ ] Update session-runner tests for new mode field
- [ ] Run `npm test` — all pass
- [ ] Commit: `feat: pipeline dispatches by mode — script or agent`

---

## Chunk 4: First Agent Config (scan-notebooks)

### Task 4: scan-notebooks agent config

**Files:**
- Create: `agents/scan-notebooks.md`

- [ ] Create agent config with YAML frontmatter:
```yaml
---
name: scan-notebooks
displayName: Scan Notebooks
description: Scan NotebookLM homepage and list all notebooks with their names and URLs
tools:
  - screenshot
  - find
  - click
  - read
  - wait
startPage: homepage
parameters: {}
---
```
- [ ] Markdown prompt body: instruct agent to scroll homepage, take screenshots, extract notebook names, click each to get URL, call submitResult with the full list
- [ ] Add to script catalog with `mode: "agent"`
- [ ] Commit: `feat: scan-notebooks agent config`

---

## Chunk 5: Acceptance Test

### Task 5: Real test with scan-notebooks

- [ ] Start daemon, exec "掃描所有 NotebookLM 筆記本"
- [ ] Verify Planner selects `scan-notebooks` with `mode: "agent"`
- [ ] Verify agent scrolls, screenshots, returns notebook list
- [ ] ISO Browser verify results match actual homepage
- [ ] Commit: `test: scan-notebooks agent session verified`

---

## Execution Order

```
Chunk 1 (Task 1): Extract browser tools     — refactor, no behavior change
Chunk 2 (Task 2): Agent session              — new module, isolated
Chunk 3 (Task 3): Pipeline integration       — wire it up
Chunk 4 (Task 4): First agent config         — scan-notebooks
Chunk 5 (Task 5): Real test                  — end-to-end verification
```
