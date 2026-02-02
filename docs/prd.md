# Product Requirements Document: NotebookLM Controller

## 1. Problem Statement

Google NotebookLM is a powerful AI research tool that synthesizes answers from user-uploaded documents with zero hallucinations. However, it lacks any programmatic API. The only existing automation ([notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp)) is limited to Q&A — it cannot manage sources, generate artifacts, download audio, or configure settings.

This forces users to manually:
- Upload documents one by one through the web UI
- Click through multiple dialogs to add each source
- Wait for audio overviews to generate, then manually download
- Manage notebook settings by hand
- Copy-paste content between tools and NotebookLM

For power users who maintain multiple notebooks and frequently update sources, this manual workflow is a significant bottleneck.

## 2. Product Vision

**NotebookLM Controller** is an always-on daemon that gives any CLI AI tool (Claude Code, Cursor, Codex, etc.) full programmatic control over Google NotebookLM through vision-capable AI agents and browser automation.

Each notebook gets a dedicated browser tab paired with an AI agent that can see the screen, understand the UI state, and execute any operation a human could — without relying on fragile CSS selectors.

### One-liner

> A persistent, AI-powered browser automation daemon that turns Google NotebookLM into a fully programmable knowledge management platform.

## 3. Target Users

| User | Need |
|------|------|
| **Developer using AI coding tools** | Feed project documentation into NotebookLM as source-grounded context, keep it updated as docs change |
| **Researcher** | Batch-upload papers, generate audio summaries, extract structured knowledge via mind maps |
| **Content creator** | Automate podcast generation from NotebookLM audio overviews across multiple notebooks |
| **Knowledge worker** | Maintain multiple domain-specific notebooks, query them via external AI tools |

## 4. Goals & Non-Goals

### Goals

- **G1**: Provide full programmatic control over all NotebookLM operations not covered by notebooklm-mcp
- **G2**: Support any CLI AI tool as a caller (tool-agnostic via HTTP + CLI)
- **G3**: Maintain real-time state of all notebooks (sources, notes, settings, artifacts)
- **G4**: Handle concurrent operations across multiple notebooks via multi-tab agents
- **G5**: Convert external content (repos, URLs, PDFs) and add as NotebookLM sources without touching system file dialogs

### Non-Goals

- **NG1**: Replace notebooklm-mcp for Q&A — that tool handles chat well, this focuses on everything else
- **NG2**: Handle Google authentication — users log in themselves via iso-browser
- **NG3**: Provide a web UI or dashboard — this is a headless daemon with CLI interface
- **NG4**: Support browsers other than Chrome (iso-browser dependency)
- **NG5**: Work without GitHub Copilot subscription (Copilot SDK dependency)

## 5. Functional Requirements

### 5.1 Daemon Lifecycle

| ID | Requirement | Priority |
|----|-------------|----------|
| D1 | Daemon starts via `nbctl start` and runs as a background process | P0 |
| D2 | Daemon connects to iso-browser Chrome on port 9223 at startup | P0 |
| D3 | Daemon exposes HTTP API on localhost:9224 | P0 |
| D4 | Daemon auto-discovers existing NotebookLM tabs on startup | P1 |
| D5 | Daemon gracefully shuts down via `nbctl stop` (disconnect browser, save state) | P0 |
| D6 | Daemon persists state to disk and restores on restart | P1 |

### 5.2 Notebook Management

| ID | Requirement | Priority |
|----|-------------|----------|
| N1 | Open a notebook by URL → creates tab + agent session | P0 |
| N2 | List all active notebooks (from state cache) | P0 |
| N3 | Close a notebook → destroys tab + agent session | P0 |
| N4 | Create a new notebook on NotebookLM | P2 |
| N5 | Assign human-readable aliases to notebooks (e.g., "research") | P0 |

### 5.3 Source Management

| ID | Requirement | Priority |
|----|-------------|----------|
| S1 | Add text source via "Copied text" (paste content, avoid file dialog) | P0 |
| S2 | Add URL source (website or YouTube) | P0 |
| S3 | List all sources in a notebook | P0 |
| S4 | Select/deselect specific sources for targeted queries | P1 |
| S5 | Delete a source from a notebook | P2 |
| S6 | Batch add multiple sources in a single command | P1 |

### 5.4 Content Pipeline

| ID | Requirement | Priority |
|----|-------------|----------|
| C1 | Convert git repository to text via repomix, add as source | P0 |
| C2 | Convert URL to markdown via crawl4ai, add as source | P0 |
| C3 | Convert PDF to markdown via pymupdf4llm, add as source | P0 |
| C4 | Auto-split content exceeding 500K word limit into multiple sources | P1 |
| C5 | Agent autonomously decides conversion method based on input type | P1 |

### 5.5 Studio Artifacts

| ID | Requirement | Priority |
|----|-------------|----------|
| A1 | Generate audio overview with optional custom prompt and length | P0 |
| A2 | Download generated audio overview to local filesystem | P0 |
| A3 | Check audio generation status (generating / ready) | P0 |
| A4 | Generate mind map and extract as structured JSON | P1 |
| A5 | Generate study guide / FAQ / briefing / timeline | P2 |
| A6 | Read/extract text content from generated artifacts | P1 |

### 5.6 Settings & Configuration

| ID | Requirement | Priority |
|----|-------------|----------|
| T1 | Set notebook persona / custom instructions (up to 5,000 chars) | P1 |
| T2 | Set response length (short / default / long) | P1 |
| T3 | Read current notebook settings | P1 |

### 5.7 Notes

| ID | Requirement | Priority |
|----|-------------|----------|
| O1 | List all notes in a notebook | P2 |
| O2 | Save chat response as a note | P2 |
| O3 | Read note content | P2 |

### 5.8 State Management

| ID | Requirement | Priority |
|----|-------------|----------|
| ST1 | Query full notebook state instantly (from in-memory cache) | P0 |
| ST2 | Agent updates state after every operation (post-op sync) | P0 |
| ST3 | Periodic background sync via screenshot → AI state extraction | P2 |
| ST4 | State persists to disk, survives daemon restart | P1 |

### 5.9 CLI Interface

| ID | Requirement | Priority |
|----|-------------|----------|
| L1 | `nbctl start` / `nbctl stop` — daemon lifecycle | P0 |
| L2 | `nbctl status` — daemon health + browser + notebook count | P0 |
| L3 | `nbctl open <url> [--name id]` — add notebook | P0 |
| L4 | `nbctl list` — list active notebooks | P0 |
| L5 | `nbctl state <id>` — full notebook state | P0 |
| L6 | `nbctl exec <id> "instruction"` — natural language instruction to agent | P0 |
| L7 | `nbctl screenshot <id>` — visual capture for confirmation | P0 |
| L8 | `nbctl close <id>` — remove notebook | P0 |
| L9 | All commands output JSON to stdout for machine consumption | P0 |

## 6. Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NF1 | State queries (`nbctl state`, `nbctl list`) respond in <100ms | From in-memory cache |
| NF2 | Agent operations (source add, audio generate) complete within 60s | Vision model latency + browser interaction |
| NF3 | Support at least 10 concurrent notebook tabs | Chrome tab limit, memory dependent |
| NF4 | Daemon memory usage <500MB baseline (excluding Chrome) | Node.js process |
| NF5 | State persists across daemon restarts | disk-backed state.json |
| NF6 | Graceful degradation if iso-browser is not running | Clear error message, no crash |

## 7. Architecture Overview

### Components

```
┌────────────┐     HTTP :9224     ┌──────────────────────────────────┐
│  nbctl CLI │ ────────────────── │  Daemon                          │
│  (or curl) │                    │                                  │
└────────────┘                    │  ┌─────────┐  ┌──────────────┐  │
                                  │  │ Fastify  │  │ State Store  │  │
                                  │  │ Router   │  │ (in-memory)  │  │
                                  │  └────┬─────┘  └──────────────┘  │
                                  │       │                          │
                                  │  ┌────▼─────────────────────┐    │
                                  │  │ Agent Pool               │    │
                                  │  │ (Copilot SDK)            │    │
                                  │  │                          │    │
                                  │  │  Session per notebook    │    │
                                  │  │  vision model + tools    │    │
                                  │  └────┬─────────────────────┘    │
                                  │       │                          │
                                  │  ┌────▼─────────────────────┐    │
                                  │  │ Page Pool                │    │
                                  │  │ (Puppeteer Core)         │    │
                                  │  │ Tab per notebook         │    │
                                  │  └────┬─────────────────────┘    │
                                  └───────┼──────────────────────────┘
                                          │ CDP
                                          ▼
                                   iso-browser :9223
```

### Agent Model

Each agent is a Copilot SDK session with:

- **Vision model** — receives screenshots as base64 PNG, understands UI state
- **Browser tools** — screenshot, click, type, scroll, readDOM, paste, downloadFile
- **Content tools** — repoToText, urlToText, pdfToText
- **System prompt** — teaches the agent NotebookLM's UI layout and common operations
- **Conversation context** — multi-step operations maintain history within a session

### Communication Flow

```
1. User: nbctl exec research "add source from /tmp/paper.pdf"
2. CLI → HTTP POST /exec/research { prompt: "add source from /tmp/paper.pdf" }
3. Daemon → finds agent session for "research"
4. Agent → session.sendAndWait({ prompt: "..." })
5. Copilot SDK AI:
   a. Calls screenshot tool → sees NotebookLM page
   b. Calls pdfToText tool → gets markdown content
   c. Calls click tool → clicks "Add source"
   d. Calls screenshot → sees dialog
   e. Calls click → "Copied text"
   f. Calls type(method="paste") → pastes content
   g. Calls click → "Insert"
   h. Calls screenshot → verifies success
6. Agent returns result → daemon updates state
7. Daemon → HTTP 200 { success: true, message: "..." }
8. CLI → prints result to user
```

## 8. Technology Stack

| Component | Technology | Reason |
|-----------|------------|--------|
| Runtime | Node.js (ESM) | Matches iso-browser ecosystem, Copilot SDK native support |
| AI Agent | @github/copilot-sdk | Vision-capable multi-session agents, tool orchestration, model-agnostic |
| Browser | puppeteer-core | CDP connection to existing Chrome, lightweight (no bundled browser) |
| HTTP Server | Fastify | Fast, low overhead, good for daemon workloads |
| Schema | Zod | Tool parameter validation, Copilot SDK integration |
| Isolated Chrome | iso-browser (port 9223) | Pre-existing user infrastructure, separate profile for persistent auth |
| Content: Repos | repomix | Repository → single text file conversion |
| Content: URLs | crawl4ai | Web page → clean markdown conversion |
| Content: PDFs | pymupdf4llm | PDF → markdown with structure preservation |

## 9. Dependencies & Prerequisites

| Dependency | Type | Required |
|------------|------|----------|
| iso-browser skill | External | User must have iso-browser installed and Chrome running on :9223 |
| Google account | External | User must be logged into Google in iso-browser Chrome |
| GitHub Copilot subscription | External | Required for Copilot SDK (billed per prompt against premium quota) |
| Copilot CLI | External | Must be installed (`copilot` command available) |
| Node.js >= 22 | Runtime | For ESM support and modern APIs |
| Python 3 | Optional | Required for crawl4ai and pymupdf4llm content tools |
| repomix | Optional | Required for repository-to-text conversion |

## 10. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| NotebookLM UI changes break automation | Medium | High (Google ships frequently) | Vision-based agent adapts to UI changes; no hard-coded selectors in the critical path |
| Copilot SDK in Technical Preview, API may change | Medium | Medium | Isolate SDK usage in `agent/` module; easy to swap |
| Google rate limits (50 queries/day free) | Low | Medium | Controller focuses on non-chat operations (source add, audio, etc.); rate limits mainly affect Q&A |
| Vision model latency makes operations slow | Medium | High | Hybrid approach: use known selectors as fast path for stable operations, vision for complex/unknown states |
| Multiple tabs on same notebook cause state conflicts | Medium | Low | MVP: one tab per notebook. Later: session pool with locking |
| iso-browser Chrome crashes or is closed | Low | Medium | Daemon detects disconnect, pauses operations, waits for reconnection |

## 11. Success Metrics

| Metric | Target |
|--------|--------|
| Source addition success rate | >90% (vision agent self-corrects on failure) |
| Audio download success rate | >95% (well-understood flow) |
| State accuracy vs manual inspection | >85% for post-op sync |
| Agent operation latency (simple action) | <15s |
| Agent operation latency (multi-step, e.g. add source) | <45s |
| Concurrent notebook support | >= 5 notebooks simultaneously |

## 12. MVP Scope (v0.1)

The minimum viable product includes:

1. **Daemon** — starts, connects to iso-browser, exposes HTTP API
2. **CLI** — nbctl with start/stop/status/open/list/state/exec/screenshot/close
3. **Page Pool** — manage multiple tabs in iso-browser
4. **Agent** — one Copilot SDK session per notebook with browser tools + content tools
5. **Source add (text)** — convert content + paste as text source (the core feature)
6. **Source add (URL)** — add website/YouTube URL
7. **Audio generate + download** — trigger audio overview, download when ready
8. **State store** — in-memory with disk persistence, post-operation sync
9. **SKILL.md** — Claude Code skill integration

### Deferred to v0.2+

- Background periodic state sync (screenshot → AI parse)
- Notebook creation from CLI
- Notes management (list, read, save)
- Study guide / FAQ / timeline generation
- Source deletion
- Session pool for same-notebook concurrency
- Auto-split large content into multiple sources
- launchd/systemd integration for auto-start

## 13. Open Questions

| # | Question | Impact |
|---|----------|--------|
| 1 | Which vision models are available via Copilot SDK and what are their costs? | Model selection, cost per operation |
| 2 | Can Copilot SDK sessions handle image inputs reliably for UI automation? | Core architecture viability |
| 3 | What is the "Copied text" source type chip's exact label across locales? | Source add flow reliability |
| 4 | Does opening multiple tabs to the same NotebookLM notebook cause issues? | Concurrency strategy for v0.2+ |
| 5 | What are Copilot SDK's actual rate limits / premium request costs? | Operational cost model |

## 14. Glossary

| Term | Definition |
|------|------------|
| **Daemon** | The always-running background Node.js process that manages agents and browser tabs |
| **Agent** | A Copilot SDK session paired with a browser tab, capable of vision + tool execution |
| **Page Pool** | Puppeteer-managed collection of Chrome tabs, one per notebook |
| **State Store** | In-memory + disk-persisted cache of all notebook states |
| **nbctl** | Thin CLI client that communicates with the daemon via HTTP |
| **iso-browser** | Isolated Chrome instance running on port 9223 with a separate user profile |
| **notebooklm-mcp** | Existing MCP server for NotebookLM Q&A (complementary, not replaced) |
| **Content pipeline** | Tools that convert external content (repos, URLs, PDFs) to text for source addition |
