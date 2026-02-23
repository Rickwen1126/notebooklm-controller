# notebooklm-controller Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-24

## Active Technologies

- TypeScript 5.x, Node.js 22 LTS + `@anthropic-ai/claude-agent-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse` (001-mvp)
- Storage: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）(001-mvp)
- Testing: Vitest (001-mvp)

## Project Structure

```text
src/
  daemon/         # MCP Server daemon (Streamable HTTP, @modelcontextprotocol/sdk)
  tab-manager/    # Single Chrome multi-tab management (puppeteer-core, CDP)
  network-gate/   # Centralized traffic gate (permit-based)
  agent/          # AI agent sessions (Claude Agent SDK V2)
  content/        # Content pipeline (repo/URL/PDF → text)
  state/          # JSON state persistence
  notification/   # MCP notification (async task completion)
  skill/          # Agent skill definitions
  shared/         # Shared utilities
skills/           # Agent skill YAML files
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x, Node.js 22 LTS: Follow standard conventions

## Recent Changes

- 001-mvp: MCP Server architecture (8 modules: daemon, tab-manager, network-gate, agent, content, state, notification, skill)
- 001-mvp: CLI + HTTP API → MCP Server (Streamable HTTP); BrowserPool → TabManager (Single Browser Multi-tab)

<!-- MANUAL ADDITIONS START -->

## Checkpoint

Run /save at: milestone completion, important decisions, tests passing, before ending session.

<!-- MANUAL ADDITIONS END -->
