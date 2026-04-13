# notebooklm-controller

`notebooklm-controller` is an MCP daemon for operating Google NotebookLM through Chrome automation.

It exposes notebook management and natural-language execution tools over MCP, so an AI coding client can:

- bring existing NotebookLM notebooks under management,
- create new notebooks,
- add sources from repos, URLs, PDFs, or plain text,
- query NotebookLM and inspect notebook state,
- run long operations asynchronously.

Current status: usable MVP for day-to-day NotebookLM workflows. Some advanced capabilities are still incomplete.

## What is this

This project runs a local daemon that launches Chrome, connects to NotebookLM, and exposes MCP tools at `http://127.0.0.1:19224/mcp`.

The public API is MCP-first:

- notebook management tools such as `register_all_notebooks` and `create_notebook`,
- `exec` for natural-language operations,
- task/status tools such as `get_status` and `cancel_task`.

Internally, execution follows:

`MCP tool -> Scheduler -> dispatcher -> runner -> deterministic script -> recovery on failure`

The happy path is deterministic browser automation. Recovery LLM is fallback-only.

## How to use

### Prerequisites

- Node.js 22+
- Google Chrome installed locally
- A usable GitHub Copilot account for `@github/copilot-sdk`
- A Google account with access to [NotebookLM](https://notebooklm.google.com)

### Install

```bash
npm install
npm run build
```

### First run

For the first login, start the daemon in headed mode:

```bash
npx tsx src/daemon/launcher.ts --no-headless
```

Then:

1. Complete Google / NotebookLM login in the Chrome window.
2. Confirm you can access NotebookLM normally.
3. Stop the daemon.
4. Restart it in the default headless mode:

```bash
npx tsx src/daemon/launcher.ts
```

If your Google session expires later, use `reauth`:

- `reauth(headless=false)` to switch to headed mode and log in again
- `reauth(headless=true)` to switch back to headless mode

### Connect your MCP client

Add this MCP server to your client configuration:

```json
{
  "mcpServers": {
    "notebooklm": {
      "url": "http://127.0.0.1:19224/mcp"
    }
  }
}
```

The daemon must already be running before your MCP client connects.

### Basic workflow

1. Start the daemon.
2. Bring notebooks under management.
3. Optionally set a default notebook.
4. Use `exec` for day-to-day work.

Bring notebooks under management in one of these ways:

- `register_all_notebooks` scans existing notebooks from your NotebookLM account.
- `register_notebook` registers a notebook when you already know its URL.
- `create_notebook` creates and registers a new notebook.

If you already use NotebookLM, start with `register_all_notebooks`.

### Minimal examples

Scan existing notebooks:

- `register_all_notebooks`

Create a notebook:

- `create_notebook(title="My Research", alias="my-research")`

Set a default notebook:

- `set_default(alias="my-research")`

Use `exec` for daily work:

- `exec(prompt="把 ~/code/my-project 加入來源")`
- `exec(prompt="這個專案的認證流程是什麼？")`

Exact tool-call syntax depends on your MCP client, but the tool names and parameters are the same.

## MCP tools

### Notebook management

| Tool | Description |
|------|-------------|
| `create_notebook` | Create a new NotebookLM notebook, register it locally, and return its alias, URL, and title. |
| `register_notebook` | Register an existing NotebookLM notebook by URL. |
| `register_all_notebooks` | Scan the NotebookLM homepage and batch-register notebooks from your account. |
| `list_notebooks` | List all locally registered notebooks. |
| `set_default` | Set the default notebook alias used by `exec` when `notebook` is omitted. |
| `rename_notebook` | Rename a local notebook alias. |
| `unregister_notebook` | Remove a notebook from local registry and cache without deleting the remote notebook. |

### Execution and tasks

| Tool | Description |
|------|-------------|
| `exec` | Execute a natural-language instruction against a notebook. |
| `get_status` | Show daemon health, queue state, active notebooks, or inspect a specific task. |
| `cancel_task` | Cancel a queued or running task. |

### Session and discovery

| Tool | Description |
|------|-------------|
| `reauth` | Switch Chrome to headed mode for Google re-authentication, then back to headless mode. |
| `list_agents` | Legacy tool name. Returns the scripted operation catalog used behind `exec`. |

## Architecture

Current execution chain:

`MCP tool` -> `Scheduler` -> `createRunTask()` dispatcher -> `TaskRunner` -> deterministic script -> `runRecoverySession()` on failure

Key modules:

| Module | Responsibility |
|--------|---------------|
| `daemon/` | MCP server, scheduler, dispatcher, tool registration |
| `tab-manager/` | Single Chrome multi-tab management and CDP sessions |
| `agent/` | Pipeline runner, specialized runners, recovery session, repair logs |
| `scripts/` | Deterministic DOM operations and wait primitives |
| `content/` | repo / URL / PDF to NotebookLM-ready text |
| `state/` | JSON persistence under `~/.nbctl/` |
| `network-gate/` | Rate-limit / backoff protection |

Happy path = deterministic execution. Recovery is failure-only.

## Limitations

- Viewport is a contract: scripts are tested at `1920x1080`.
- Recovery is fallback, not the primary execution path.
- Google login and a usable local Chrome session are required.
- Some capabilities are still incomplete:
  - audio generation / download workflows
  - query-result export to files
  - smart notebook selection

## Testing

```bash
npm run build
npm test
npm run lint
```

For live verification against NotebookLM:

```bash
/test-real
```

Use `/test-real` before release or after changing scripts, runners, dispatcher wiring, or UI-sensitive flows.

## Runtime data

All persistent runtime data lives in `~/.nbctl/`:

| Path | Purpose |
|------|---------|
| `state.json` | Daemon state and registered notebooks |
| `config.json` | User config (for example locale override) |
| `tasks/` | Async task records |
| `cache/<alias>/` | Per-notebook sources, artifacts, and operation logs |
| `screenshots/` | Operation screenshots |
| `repair-logs/` | Recovery analysis and suggested fixes |
| `ui-maps/` | User UI-map overrides |
| `tmp/` | Content-pipeline temp files |
| `chrome-profile/` | Chrome profile and Google login session |

## License

MIT
