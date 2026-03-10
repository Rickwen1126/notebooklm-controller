# notebooklm-controller Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-24

## Active Technologies

- TypeScript 5.x, Node.js 22 LTS + `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse` (001-mvp)
- Storage: JSON 檔案（`~/.nbctl/`），atomic write（temp + rename）(001-mvp)
- Testing: Vitest (001-mvp)

## Project Structure

```text
src/
  daemon/         # MCP Server daemon (Streamable HTTP, @modelcontextprotocol/sdk)
  tab-manager/    # Single Chrome multi-tab management (puppeteer-core, CDP)
  network-gate/   # Centralized traffic gate (permit-based)
  agent/          # Copilot SDK agent adapter + config loader
    client.ts     # CopilotClient singleton (manages CLI process)
    session-runner.ts  # Per-task: createSession → sendAndWait → disconnect
    hooks.ts      # SessionHooks (NetworkGate integration, error recovery)
    agent-loader.ts  # Load YAML → CustomAgentConfig[] (SDK native type)
    tools/        # defineTool() + Zod (browser-tools, content-tools, state-tools)
  content/        # Content pipeline (repo/URL/PDF → text, pure functions)
  state/          # JSON state persistence
  notification/   # MCP notification (async task completion)
  shared/         # Shared utilities
agents/           # Agent config YAML files (→ CustomAgentConfig)
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x, Node.js 22 LTS: Follow standard conventions

## Recent Changes
- 001-mvp: Added TypeScript 5.x, Node.js 22 LTS + `@github/copilot-sdk`, `puppeteer-core`, `@modelcontextprotocol/sdk`, `repomix`, `zod`, `@mozilla/readability`, `jsdom`, `pdf-parse`

- 001-mvp: MCP Server architecture (7 modules: daemon, tab-manager, network-gate, agent, content, state, notification)
- 001-mvp: CLI + HTTP API → MCP Server (Streamable HTTP); BrowserPool → TabManager (Single Browser Multi-tab)

<!-- MANUAL ADDITIONS START -->

## CRITICAL: AI Agent SDK

**使用 `@github/copilot-sdk`（GitHub Copilot SDK），不是 Claude Agent SDK。**
這是專案核心決策，不可更改。所有 agent session 管理、tool 注入、vision 操作都透過 Copilot SDK 的 agent runtime。

**SDK 標準寫法**：
- `CopilotClient` singleton（daemon 層級，autoRestart: true）
- `client.createSession({ tools, agent, hooks })` per-task
- `defineTool(name, { description, parameters: z.object(...), handler })` 定義 tool
- `ToolResultObject.binaryResultsForLlm` 回傳截圖（Tool 自包原則）
- `CustomAgentConfig { name, prompt, tools }` 對應 agent config YAML（`agents/` 目錄）
- `session.sendAndWait({ prompt })` 執行操作
- `SessionHooks.onPreToolUse` → NetworkGate acquirePermit()

## Checkpoint

Run /save at: milestone completion, important decisions, tests passing, before ending session.

<!-- MANUAL ADDITIONS END -->
