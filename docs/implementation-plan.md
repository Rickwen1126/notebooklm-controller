# NotebookLM Controller - Implementation Plan

## Overview

A persistent daemon service that controls Google NotebookLM through **Copilot SDK AI agents + Puppeteer browser automation**. Each notebook gets its own dedicated tab + AI agent session with vision capabilities. The agent sees the screen, understands state, and executes actions — no fragile CSS selectors needed.

Complements `notebooklm-mcp` (Q&A only) by handling everything else: source management, studio artifacts, audio, settings, notes.

## Architecture

```
Any CLI AI Tool (Claude Code / Cursor / Codex / any)
    │
    │  $ nbctl exec research "add source from /tmp/paper.pdf"
    │  $ nbctl state research
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  nbctl CLI (thin client)                                     │
│  sends JSON command via HTTP → daemon                        │
└──────────┬───────────────────────────────────────────────────┘
           │  HTTP localhost:9224
           ▼
┌──────────────────────────────────────────────────────────────┐
│  notebooklm-controller daemon (always running)               │
│                                                              │
│  ┌────────────────┐  ┌────────────────────────────────────┐  │
│  │  HTTP Server    │  │  State Store (in-memory + persist) │  │
│  │  (Fastify)     │  │                                    │  │
│  │  POST /exec    │  │  research: {                       │  │
│  │  GET  /state   │  │    url, title,                     │  │
│  │  GET  /list    │  │    sources: [...],                 │  │
│  │  POST /open    │  │    notes: [...],                   │  │
│  │  GET  /screen  │  │    audio: { status, url },         │  │
│  │  ...           │  │    settings: {...}                 │  │
│  └───────┬────────┘  │  }                                 │  │
│          │           │  project-x: { ... }                │  │
│          │           └────────────────────────────────────┘  │
│          ▼                                                   │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  Agent Pool (Copilot SDK)                             │   │
│  │                                                       │   │
│  │  CopilotClient ─┬─ Session "research"                 │   │
│  │                 │   model: vision-capable              │   │
│  │                 │   tools: [screenshot, click, type,   │   │
│  │                 │           scroll, readDOM, paste,    │   │
│  │                 │           downloadFile, repoToText,  │   │
│  │                 │           urlToText, pdfToText]      │   │
│  │                 │   page: Tab 1 (Notebook "Research")  │   │
│  │                 │                                      │   │
│  │                 ├─ Session "project-x"                 │   │
│  │                 │   page: Tab 2 (Notebook "Project X") │   │
│  │                 │                                      │   │
│  │                 └─ Session "study"                     │   │
│  │                    page: Tab 3 (Notebook "Study")      │   │
│  └──────────┬────────────────────────────────────────────┘   │
│             │                                                │
│  ┌──────────▼──────┐                                         │
│  │  Page Pool       │  Puppeteer Core, persistent connection │
│  │  Tab 1..N        │  connect once, reuse forever           │
│  └──────────┬──────┘                                         │
└─────────────┼────────────────────────────────────────────────┘
              │  CDP
              ▼
       iso-browser :9223
```

## Core Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| **AI per tab** | Copilot SDK session + vision model | UI-resilient: AI sees screenshot, doesn't rely on selectors. Self-healing when Google changes UI. |
| **Communication** | HTTP server (localhost:9224) | Any tool can call via curl. Simple, debuggable, truly concurrent requests. |
| **Browser** | Puppeteer Core → iso-browser :9223 | Reuses existing isolated Chrome. One persistent connection, multiple tabs. |
| **Auth** | None. User logs in themselves. | iso-browser Chrome profile persists login state. |
| **File uploads** | Convert first (repomix/crawl4ai/pymupdf4llm), paste as text | Avoids system file dialog entirely. Agent tools handle conversion. |
| **State** | In-memory store, persisted to disk, synced from agents | Instant `nbctl state` queries. Agents update after every operation. |
| **Lifecycle** | System startup / launchd / manual `nbctl start` | Always-on daemon. Monitors notebooks continuously. |

## Why Copilot SDK + Vision (Not Pure Selectors)

The AI agent for each tab:
1. Takes screenshot → sends as `binaryResultsForLlm` (base64 PNG)
2. Vision model understands the current UI state
3. AI decides what to click/type based on what it SEES
4. Plans multi-step operations autonomously
5. Detects errors visually and self-corrects

Hybrid approach: known-stable operations (typing in input, clicking by coordinates) use fast direct DOM tools. Complex/uncertain states use vision.

## Project Structure

```
notebooklm-controller/
├── package.json                      # puppeteer-core, @github/copilot-sdk, fastify, zod
├── src/
│   ├── daemon.js                     # Entry point: start HTTP server + CopilotClient
│   ├── server/
│   │   └── routes.js                 # HTTP API routes (POST /exec, GET /state, etc.)
│   ├── agent/
│   │   ├── create.js                 # Create CopilotSession for a notebook tab
│   │   ├── tools.js                  # Tool definitions (screenshot, click, type, etc.)
│   │   ├── content-tools.js          # Content pipeline tools (repoToText, urlToText, pdfToText)
│   │   └── system-prompt.js          # NotebookLM-specialized system prompt for agents
│   ├── browser/
│   │   ├── pool.js                   # Page pool: manage tabs, connect to iso-browser
│   │   └── helpers.js                # Low-level: screenshot+resize, fastPaste, download
│   ├── state/
│   │   ├── store.js                  # In-memory state store with disk persistence
│   │   └── sync.js                   # Background state sync (periodic screenshot → AI parse)
│   └── cli/
│       └── nbctl.js                  # Thin CLI client → HTTP calls to daemon
└── data/
    ├── state.json                    # Persisted state
    └── downloads/                    # Audio and artifact downloads
```

## Implementation Phases

### Phase 1: Skeleton — Daemon + Browser Pool + CLI

**Goal**: Daemon starts, connects to iso-browser, manages tabs. CLI can talk to daemon.

#### 1.1 `package.json`
```json
{
  "name": "notebooklm-controller",
  "version": "0.1.0",
  "type": "module",
  "bin": { "nbctl": "./src/cli/nbctl.js" },
  "dependencies": {
    "@github/copilot-sdk": "latest",
    "puppeteer-core": "^24.0.0",
    "fastify": "^5.0.0",
    "zod": "^3.23.0"
  }
}
```

#### 1.2 `src/browser/pool.js` — Page Pool
```
connect()          → connect to iso-browser :9223, store browser handle
createPage(url)    → open new tab, navigate to url, return page handle
getPage(id)        → get existing page by notebook id
listPages()        → list all managed pages
closePage(id)      → close a tab
```
- Connect once on daemon startup, reuse forever
- `browser.disconnect()` on shutdown (never `browser.close()`)
- Each page maps to a notebook by ID (derived from URL)

#### 1.3 `src/browser/helpers.js` — Low-Level Browser Utils
```
screenshot(page)        → PNG buffer (auto-resize if >1800px via sips)
fastPaste(page, text)   → CDP Input.insertText (for large content)
downloadFile(page, url) → extract cookies + node fetch
clickAt(page, x, y)     → page.mouse.click with random offset
typeText(page, text)    → char-by-char with human-like delays (25-75ms)
scrollTo(page, dx, dy)  → page.mouse.wheel
readDOM(page, selector) → page.$eval, fast path for known elements
findByRole(page, role, name) → aria-label/text search
```

#### 1.4 `src/server/routes.js` — HTTP API
```
POST /start              → start daemon (if not running)
GET  /status             → daemon health + iso-browser status + notebook count
POST /open               → open notebook URL → create tab + agent
GET  /list               → list all active notebooks (from state store)
GET  /state/:id          → full state for one notebook
POST /exec/:id           → send natural language instruction to notebook's agent
GET  /screenshot/:id     → take screenshot of notebook tab
POST /close/:id          → close tab + destroy agent session
POST /stop               → graceful shutdown
```

#### 1.5 `src/cli/nbctl.js` — Thin CLI Client
```bash
#!/usr/bin/env node
# All commands just HTTP to localhost:9224

nbctl start                     # POST /start (or spawn daemon)
nbctl status                    # GET /status
nbctl open <url> [--name id]    # POST /open { url, name }
nbctl list                      # GET /list
nbctl state <id>                # GET /state/:id
nbctl exec <id> "instruction"   # POST /exec/:id { prompt: "instruction" }
nbctl screenshot <id>           # GET /screenshot/:id → saves & outputs path
nbctl close <id>                # POST /close/:id
nbctl stop                      # POST /stop
```

Output format: JSON for machine consumption, human-readable summary to stderr.

#### 1.6 `src/daemon.js` — Entry Point
```js
1. Start Fastify HTTP server on :9224
2. Connect to iso-browser :9223 via page pool
3. Scan existing NotebookLM tabs → create agent sessions for each
4. Load persisted state from data/state.json
5. Start background state sync
6. Log readiness
```

### Phase 2: Agent — Copilot SDK Sessions + Tools

**Goal**: Each notebook tab gets a Copilot SDK AI session with browser tools.

#### 2.1 `src/agent/tools.js` — Browser Tool Definitions

Using Copilot SDK's `defineTool()` with Zod schemas:

```js
// Each tool wraps a browser/helpers.js function
// Tools return { textResultForLlm, binaryResultsForLlm, resultType }

screenshot(page)
  → takes screenshot, returns base64 PNG as binaryResultsForLlm
  → agent SEES the page

click({ x, y, description })
  → clicks at coordinates, takes screenshot after
  → returns screenshot so agent sees result

type({ text, method: "human" | "paste" })
  → "human": char-by-char typing with delays
  → "paste": CDP Input.insertText for large content
  → returns confirmation

scroll({ direction: "up" | "down", amount })
  → scrolls page
  → returns screenshot after

readDOM({ selector, attribute })
  → fast path: read text/attribute from known selector
  → returns text content

waitFor({ seconds })
  → waits, then returns screenshot
  → useful between async operations

downloadFile({ url, filename })
  → extracts cookies from page, downloads with cookie header
  → returns { success, filePath, size }
```

#### 2.2 `src/agent/content-tools.js` — Content Pipeline Tools

```js
repoToText({ path })
  → exec('npx repomix <path> --stdout')
  → returns { text, charCount, estimatedWords }

urlToText({ url })
  → exec crawl4ai Python snippet
  → returns { text, charCount }

pdfToText({ path })
  → exec pymupdf4llm Python snippet
  → returns { text, charCount, pages }
```

These let the agent autonomously convert content before pasting.

#### 2.3 `src/agent/system-prompt.js` — NotebookLM System Prompt

The system prompt teaches the agent about NotebookLM's UI:

```
You are a browser automation agent controlling a Google NotebookLM tab.
Your job is to execute user instructions by looking at screenshots and
interacting with the page through your tools.

## NotebookLM UI Layout
- LEFT: Sources panel (list of uploaded documents)
- CENTER: Chat interface (Q&A with AI)
- RIGHT: Studio panel (artifacts: audio overview, mind map, study guide, etc.)

## Common Operations
- Add source: Click "Add source" button → choose type → fill content → Insert
- For text sources: choose "Copied text", use type(method="paste") for content
- Generate audio: find Audio Overview section in Studio → click Generate
- Download audio: click audio options → click Download link → use downloadFile
- Settings: click configure icon (top-right of chat) → set persona/length

## Important
- Always screenshot first to understand current state before acting
- After each action, screenshot to verify the result
- Report what you see and what you did in plain language
- If something unexpected happens, screenshot and describe the issue
- Update the state after completing operations

## Known Selectors (fast path, use readDOM when confident)
- Query input: textarea.query-box-input
- Add source button: button with text "Add source"
- Source type chips: span.mdc-evolution-chip__text-label
- URL input: [formcontrolname='newUrl']
- Source containers: div.single-source-container
- Loading spinner: .mat-mdc-progress-spinner
- Notebook title: h1.notebook-title
```

#### 2.4 `src/agent/create.js` — Session Factory

```js
async function createAgent(client, notebookId, page) {
  const session = await client.createSession({
    sessionId: `notebook-${notebookId}`,
    model: "gpt-4-vision",  // or best available vision model
    tools: [
      ...browserTools(page),    // screenshot, click, type, scroll, readDOM, etc.
      ...contentTools(),        // repoToText, urlToText, pdfToText
    ],
    systemMessage: NOTEBOOKLM_SYSTEM_PROMPT,
  });
  return session;
}
```

Each agent:
- Has vision via screenshot tool → `binaryResultsForLlm` with base64 PNG
- Has browser action tools scoped to its own page/tab
- Has content pipeline tools for converting external content
- Maintains conversation context (multi-step operations remember what they've done)

### Phase 3: State Store + Sync

**Goal**: Real-time state of all notebooks, queryable instantly.

#### 3.1 `src/state/store.js`

```js
// In-memory store, persisted to data/state.json on change
const state = {
  notebooks: {
    "research": {
      id: "research",
      url: "https://notebooklm.google.com/notebook/abc123",
      title: "My Research",
      sources: [
        { name: "paper.pdf", selected: true, type: "pdf" },
        { name: "repo-summary", selected: true, type: "text" }
      ],
      notes: [
        { title: "Key Findings", pinned: true }
      ],
      settings: {
        persona: "You are a senior researcher...",
        responseLength: "long"
      },
      audio: {
        status: "ready",        // null | "generating" | "ready"
        downloadUrl: "https://..."
      },
      artifacts: {
        mindmap: "ready",       // null | "generating" | "ready"
        faq: null,
        studyGuide: null
      },
      lastSynced: "2026-02-02T10:00:00Z"
    }
  }
};

// API
getState(notebookId)            → full state for one notebook
getAllStates()                   → all notebooks
updateState(notebookId, patch)  → merge patch into state
persist()                       → write to data/state.json
load()                          → read from data/state.json on startup
```

#### 3.2 `src/state/sync.js` — Background State Sync

Two sync strategies:

**Strategy 1: Post-operation update (primary)**
After every `exec` command, the agent reports what changed:
```
Agent: "I added source 'paper.pdf'. Sources now: [paper.pdf, repo-summary]"
→ Parse agent response → update state store
```

**Strategy 2: Periodic full sync (background, catch external changes)**
Every 60 seconds for each active tab:
1. Take screenshot
2. Send to agent: "Describe the current state of this notebook: sources, notes, audio status"
3. Agent returns structured state
4. Update state store

For MVP: Strategy 1 only. Strategy 2 added later.

### Phase 4: Content Pipeline Integration

Agent receives instructions like "add this PDF as source" and autonomously:
1. Calls `pdfToText({ path: "/tmp/paper.pdf" })` tool
2. Gets back markdown text
3. Screenshots the page to see current state
4. Clicks "Add source" → "Copied text"
5. Pastes the content via `type({ text: content, method: "paste" })`
6. Fills the title
7. Clicks Insert
8. Waits and verifies

All orchestrated by the AI agent within a single `exec` call.

### Phase 5: SKILL.md (Claude Code Integration)

```markdown
---
name: notebooklm-controller
description: Control NotebookLM via persistent daemon. Manage sources, generate audio/artifacts, sync state.
---

# NotebookLM Controller

Persistent daemon for NotebookLM automation. Each notebook = dedicated tab + AI agent.

## Prerequisites
- iso-browser running (port 9223)
- User logged into Google in iso-browser
- Daemon running: `nbctl start`

## Quick Start
nbctl start                                    # Start daemon
nbctl open <notebook-url> --name research      # Open notebook
nbctl state research                           # Check state
nbctl exec research "add source from file /tmp/paper.pdf titled 'Paper ABC'"
nbctl exec research "generate audio overview focusing on chapter 3"
nbctl exec research "download audio to ./output/"

## Commands
nbctl status                    # Daemon + browser health
nbctl list                      # All active notebooks
nbctl state <id>                # Full notebook state (instant, from cache)
nbctl exec <id> "instruction"   # Execute natural language instruction
nbctl screenshot <id>           # Visual confirmation
nbctl open <url> [--name id]    # Add notebook
nbctl close <id>                # Remove notebook

## Smart Patterns
# Mind map navigation: get structure first, then targeted queries
nbctl exec research "generate mind map and return as JSON"
# Use the mind map topics for sequential Q&A via notebooklm-skill

# Batch source addition
nbctl exec research "add these URLs as sources: url1, url2, url3"

# State-aware operations
nbctl state research  # Check what exists before acting
```

## Verification Plan

1. **Phase 1**: `npm install` → `node src/daemon.js` → daemon starts on :9224 → `nbctl status` returns healthy
2. **Phase 2**: `nbctl open <url> --name test` → tab opens → agent takes initial screenshot → state populated
3. **Phase 3**: `nbctl state test` → returns `{ sources: [...], notes: [...], ... }` from cache
4. **Phase 4**: `nbctl exec test "add a text source with content 'Hello World' titled 'Test'"` → agent screenshots, clicks, pastes, confirms
5. **Phase 5**: `nbctl exec test "generate audio overview"` → agent triggers generation
6. **Phase 6**: `nbctl exec test "download audio to ./data/"` → audio file saved
7. **E2E**: `nbctl exec test "convert repo at /tmp/myrepo to text and add as source"` → agent calls repoToText → pastes → verifies

## Critical Files to Reference

| File | Purpose |
|------|---------|
| `~/.claude/skills/iso-browser/scripts/start.js` | Chrome connection pattern, port 9223 |
| `~/.claude/skills/iso-browser/scripts/screenshot.js` | Screenshot + sips resize logic |
| `~/.claude/skills/notebooklm-skill/scripts/config.py` | Known NotebookLM selectors |
| `/tmp/notebooklm_source_automation/functions/links.py` | Source add flow + selectors |
| `/tmp/notebooklm-podcast-automator/src/notebooklm_automator/core.py` | Audio download with cookies |
| `/tmp/notebooklm-podcast-automator/src/notebooklm_automator/links.py` | i18n text mapping + audio generation |

## Implementation Order

1. `package.json` + npm install
2. `src/browser/pool.js` + `src/browser/helpers.js` — connect to iso-browser, basic page ops
3. `src/server/routes.js` + `src/daemon.js` — HTTP server skeleton with /status, /open, /list
4. `src/cli/nbctl.js` — thin client (verify daemon communication works)
5. `src/agent/tools.js` — define browser tools with Copilot SDK defineTool()
6. `src/agent/system-prompt.js` — NotebookLM-specialized prompt
7. `src/agent/create.js` — session factory, wire tools + page + prompt
8. `src/agent/content-tools.js` — repomix, crawl4ai, pymupdf4llm wrappers
9. Wire /exec route → dispatch to agent session.sendAndWait()
10. `src/state/store.js` — in-memory state + disk persistence
11. Wire agent results → state updates
12. `SKILL.md` — Claude Code skill definition
13. Test end-to-end flows
