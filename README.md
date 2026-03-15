# notebooklm-controller

MCP Server for automating Google NotebookLM via Chrome. Feed repos, URLs, and PDFs as knowledge sources, then query them — all from your AI coding tool.

## What It Does

Your AI tool (Claude Code, etc.) connects to this daemon via MCP protocol and can:

- **Add sources** — paste text, import git repos (via repomix), crawl URLs, convert PDFs. Large content auto-splits into multiple sources.
- **Query notebooks** — ask questions grounded in your uploaded sources (no hallucination).
- **Manage notebooks** — create, rename, delete, list. Multi-notebook parallel operations.
- **Async operations** — submit long tasks, poll for completion, cancel if needed.

All through natural language: `"把 ~/code/my-project 加入 NotebookLM 來源"` → Planner selects operation → deterministic script executes.

## Architecture

```
User NL prompt
    ↓
Planner LLM (gpt-4.1) — selects operation + params
    ↓
Deterministic Script — DOM automation via CDP (0 LLM cost)
    ├── success → return result
    └── failure ↓
        Recovery LLM (gpt-5-mini) — completes task from current state
            ├── success → return result + save repair log
            └── analysis → UIMap patch suggestion (self-healing)
                           saved to ~/.nbctl/repair-logs/
```

**G2 Script-first**: happy path uses zero LLM tokens for execution. Scripts handle all 10 NotebookLM operations (query, addSource, listSources, removeSource, renameSource, clearChat, listNotebooks, createNotebook, renameNotebook, deleteNotebook).

### Modules

| Module | Responsibility |
|--------|---------------|
| `daemon/` | MCP Server (Streamable HTTP), scheduler, task management |
| `tab-manager/` | Chrome tab pool (max 10), CDP session management |
| `scripts/` | 10 deterministic DOM operations + wait primitives |
| `agent/` | Planner session, Recovery session, repair log |
| `content/` | repo→text (repomix), URL→text (readability), PDF→text |
| `network-gate/` | Rate limit protection (permit-based backoff) |
| `state/` | JSON persistence (~/.nbctl/), cache, task store |

## Quick Start

### Prerequisites

- Node.js 22 LTS
- Google Chrome installed
- GitHub Copilot license (required for `@github/copilot-sdk` — the Planner and Recovery LLM sessions run through Copilot's agent runtime)
- A Google account with access to [NotebookLM](https://notebooklm.google.com)

### Setup

```bash
# Install
npm install

# First run — opens Chrome for Google login
npx tsx src/daemon/launcher.ts

# Complete Google login in the Chrome window, then restart headless
npx tsx src/daemon/launcher.ts
```

### Connect from Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "notebooklm": {
      "url": "http://127.0.0.1:19224/mcp"
    }
  }
}
```

Then use natural language: `"把 ~/code/my-project 加入 NotebookLM 來源"`

### MCP Tools

| Tool | Description |
|------|-------------|
| `exec` | Execute NL command (query, add source, etc.) |
| `list_notebooks` | List registered notebooks |
| `register_notebook` | Register existing NotebookLM notebook by URL |
| `set_default` | Set default notebook |
| `get_status` | Daemon + task status |
| `cancel_task` | Cancel async task |
| `list_agents` | List available scripted operations |

## Design Decisions

1. **Script-first, not Agent-first** — deterministic scripts for happy path (15-20s per query vs 70s with LLM executor). LLM only recovers failures and produces repair logs for self-healing.

2. **Viewport is a contract** — 1920x1080. All scripts tested at this resolution. Changing it breaks coordinate-based interactions.

3. **UIMap i18n** — all UI text from locale JSON files (`src/config/ui-maps/`). Supports zh-TW, zh-CN, en. No hardcoded strings in scripts.

4. **Content auto-split** — sources > 100K chars split into multiple chunks, each pasted as separate source with auto-naming (`"my-project (repo) (part 1/20)"`).

## Testing

```bash
# Unit + integration tests (45 files, 688 test cases)
npm test

# Lint
npm run lint

# E2E against live daemon (requires Chrome + Google login)
# Uses ISO Browser for independent DOM verification
/test-real
```

| Layer | Where | When |
|-------|-------|------|
| `npm test` + lint | GitHub Actions CI | Every push/PR |
| `/test-real` (8-phase E2E) | Local | Core changes + before release |

## Tech Stack

TypeScript 5.x, Node.js 22 LTS, @github/copilot-sdk, puppeteer-core (CDP), @modelcontextprotocol/sdk, repomix, zod, Vitest

## Roadmap

- **Self-repair CLI** (`nbctl repair`) — Recovery Agent 失敗時產生 repair log（問題分析 + suggestedPatch）。CLI 工具讀取 log，自動修補 script 並替換 happy path。可行因為 script 用 ctx injection 零依賴設計，可直接熱替換。刻意不做成 MCP tool — 修改 happy path script 必須 human-in-the-loop。

## License

MIT
