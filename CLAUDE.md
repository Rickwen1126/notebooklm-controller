# notebooklm-controller Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-12

## Active Technologies

- TypeScript 5.x, Node.js 22 LTS + `@anthropic-ai/claude-agent-sdk`, `puppeteer-core`, `fastify`, `commander`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse` (001-mvp)
- Storage: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）(001-mvp)
- Testing: Vitest (001-mvp)

## Project Structure

```text
src/
  cli/            # CLI entry point (Commander.js)
  daemon/         # Daemon HTTP API (Fastify)
  browser-pool/   # Chrome instance pool management (puppeteer-core)
  auth/           # Google auth cookie management
  network-gate/   # Centralized traffic gate (permit-based)
  agent/          # AI agent sessions (Claude Agent SDK V2)
  content/        # Content pipeline (repo/URL/PDF → text)
  state/          # JSON state persistence
  notification/   # Inbox + notification adapters
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

- 001-mvp: Removed MCP SDK (architecture pivot to CLI + Skill + Notify)
- 001-mvp: BrowserPool architecture (10 modules: cli, daemon, browser-pool, auth, network-gate, agent, content, state, notification, skill)

<!-- MANUAL ADDITIONS START -->

## Checkpoint

Run /save at: milestone completion, important decisions, tests passing, before ending session.

<!-- MANUAL ADDITIONS END -->
