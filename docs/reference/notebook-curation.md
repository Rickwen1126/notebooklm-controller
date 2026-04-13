# Notebook Curation Reference

Created: 2026-04-13
Last Updated: 2026-04-13
Status: active working reference

## Purpose

This document records the current curation model for the local `nbctl` notebook registry.
It exists so future cleanup, alias normalization, and notebook triage do not have to restart from scratch each session.

This is not a product spec. It is a working reference for notebook-governance decisions.

## Current Snapshot

- Curation is local to `nbctl` registry only.
- `unregister_notebook` removes a notebook from local management; it does not delete the remote NotebookLM notebook.
- As of 2026-04-13, the local registry has been reduced from a noisy mixed set to a curated working set of roughly technical and AI-development notebooks.

## Curation Goals

- Keep the local registry small enough to be searchable and mentally navigable.
- Make alias names self-describing enough that category is obvious from alias alone.
- Prefer single-theme notebooks over mixed libraries.
- Keep notebooks that materially support:
  - software architecture and design work
  - AI coding / agent / MCP development
  - core technical reference work
- Remove notebooks that are:
  - test artifacts
  - personal one-off domains unrelated to current work
  - mixed “library” notebooks with weak query boundaries
  - broad social / career / market-analysis notebooks that do not support day-to-day engineering work

## Decision States

### Keep

Use `keep` when a notebook has a clear ongoing role in the working set.

Typical keep cases:
- focused technical reference
- focused tool guide
- focused engineering workflow notebook
- meaningful codebase / implementation reference

### Remove

Use `remove` when a notebook should no longer be managed by `nbctl`.

Typical remove cases:
- temporary test notebook
- low-value or off-topic notebook
- mixed source library that is hard to query reliably
- notebook whose scope is too broad for practical day-to-day use

### Review-Needed

Use `review-needed` when triage information is incomplete or conflicting.

Typical review-needed cases:
- query summary conflicts with notebook title
- notebook appears to overlap with another notebook, but canonical one is unclear
- notebook may be useful, but likely belongs in another domain collection

## Alias Rules

### General Rules

- Use English `kebab-case`.
- Alias should expose category, not just title.
- Prefer stable semantic names over literal transliteration.
- If a notebook belongs to a reusable domain, use a prefix.
- When multiple notebooks overlap in the same domain, alias must expose both:
  - domain
  - role in the cluster

Recommended role markers:
- `canonical`: best first-choice notebook for the topic
- `reference`: broad or official reference notebook
- `practice`: applied or hands-on notebook
- `guide`: operational or tool-oriented guide
- `idioms`: style / mindset / language-idiom notebook
- `blueprint`: architecture or system-shape notebook
- `strategy`: market / positioning / career / planning notebook
- `source`: source-code-oriented notebook used to inspect framework or implementation internals

### Current Prefixes

- `arch-`: software architecture
- `ddd-`: domain-driven design
- `pattern-`: design patterns / refactoring
- `browser-`: browser internals / rendering / network
- `network-`: networking and packet analysis
- `ux-`: usability / interaction design
- `go-`: Go language and ecosystem
- `ffmpeg-`: FFmpeg and multimedia processing
- `agent-`: agent engineering and agent workflow
- `ai-tool-`: AI coding tools and practical tool guides
- `prompt-`: prompt / instruction / chat-mode workflow
- `mcp-`: MCP-specific protocol or implementation references

## Current Heuristics

### Async Scan and Inventory

- For large accounts, default to `register_all_notebooks(async=true)`.
- For notebook triage, prefer async `exec` inventory prompts rather than sync calls.

### Query-Based Classification

Query-based notebook summaries are useful for triage, but they are not authoritative enough for canonical alias naming on their own.

Required cross-check:
- notebook title
- source inventory when needed

If query summary and title disagree:
- do not auto-rename
- mark as `review-needed`

### False Success Risk

One known failure mode is:
- task status = `completed`
- result text = readback failure message such as “No answer was found in the page”

This should not be treated as a trustworthy notebook summary.

## Practical Workflow

1. Scan notebooks into local management.
2. Remove obvious noise first:
   - test notebooks
   - unrelated personal notebooks
   - generic aliases with no working value
3. Use async query for notebook-level triage:
   - topic
   - source type
   - likely category
   - keep/remove recommendation
4. Cross-check title before alias changes.
5. Rename into stable prefix-based aliases.
6. Remove mixed or low-signal notebooks from local management.

## Known Improvements

- Add a dedicated notebook-inventory / classify tool instead of relying on general `exec` prompts.
- Expose structured query readback outcomes such as:
  - `readback_failed`
  - `retry_recommended`
- Improve canonical-intro selection workflow for overlapping notebook clusters.
- Consider recording notebook groups explicitly:
  - canonical notebook
  - overlapping alternatives
  - removed notebooks

## Suggested Future Sections

When needed, extend this document with:
- curated notebook groups by domain
- canonical notebook per topic
- alias mapping history
- notebooks intentionally removed from local management
