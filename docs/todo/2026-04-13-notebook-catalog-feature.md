# Notebook Catalog Feature

Created: 2026-04-13
Last Updated: 2026-04-14
Status: in progress

## Why This Exists

The local notebook set has now been curated into a meaningful working collection.
At this point, raw alias cleanup is no longer the main problem.

The next problem is discoverability:
- a user should be able to see which notebook is the best first choice for a topic
- a user should be able to distinguish `canonical`, `reference`, `practice`, `guide`, `source`, `strategy`, and similar roles without re-reading the whole registry
- this should eventually become an `nbctl` capability rather than a manual session workflow

This note exists so the idea does not get lost before it is productized.

## Current Temporary State

Right now the project has:
- curated aliases in local `nbctl` state
- a working curation rulebook in [notebook-curation.md](/Users/rickwen/code/notebooklm-controller/docs/reference/notebook-curation.md)
- implicit notebook grouping encoded into alias prefixes and role markers
- a read-only grouped index via `list_notebook_index`
- a local metadata mutation tool via `set_notebook_catalog`

This is already useful, but it has clear limits:
- the grouping is only visible if someone manually inspects aliases
- there is no first-class notebook catalog view
- there is no stored metadata beyond alias/title/url/state
- role assignment is encoded in alias naming, not in structured data

## Product Direction

The more valuable direction is to make notebook curation discoverable inside `nbctl`.

Instead of relying on manual review of aliases, `nbctl` should expose a notebook catalog layer.

## Proposed Capability

### 1. Structured Catalog Metadata

Store optional local metadata per notebook, for example:
- `domain`
- `role`
- `status`
- `canonicalFor`
- `notes`

Example roles:
- `canonical`
- `reference`
- `practice`
- `guide`
- `idioms`
- `blueprint`
- `source`
- `strategy`

Example statuses:
- `keep`
- `review-needed`
- `deprecated`

This metadata should remain local to `nbctl` and not depend on remote NotebookLM changes.

### 2. Catalog View / Tool

Possible future tool shapes:
- `list_notebooks(grouped=true)`
- `list_notebook_catalog()`
- `describe_notebook_group(domain="go")`

Minimum useful output:
- grouped by domain
- ordered by role
- clearly show the best first notebook for each cluster

Example outcome:
- `go`
  - `canonical`: `go-concurrency-canonical`
  - `reference`: `go-concurrency-reference`
  - `practice`: `go-concurrency-practice`
  - `idioms`: `go-language-idioms`

### 3. Curation Workflow Support

Possible future operations:
- mark notebook role
- mark notebook domain
- promote notebook to canonical
- demote notebook to reference
- mark overlap candidates
- mark review-needed

This would let notebook curation become an explicit workflow instead of ad hoc rename decisions.

## Suggested Implementation Direction

### Phase 1

Keep it local and lightweight:
- extend local notebook state with optional curation metadata
- do not change remote NotebookLM
- do not block existing tools if metadata is missing

Status:
- done

### Phase 2

Expose read-only catalog output:
- grouped notebook listing
- canonical notebook per domain
- overlap visibility

Status:
- partially done through `list_notebook_index`
- currently grouped by `domain -> topic -> notebooks`
- currently derives canonical notebook from `role=canonical`, else `role=core`
- now exposes `catalogSource` so alias-inferred vs metadata-backed grouping is visible

### Phase 3

Add mutation tools:
- set notebook role
- set notebook domain
- set canonical notebook
- attach local notes

Status:
- first mutation tool done: `set_notebook_catalog`
- still missing bulk operations, promotion helpers, and higher-level curation flows

## Important Design Constraint

Alias naming is still useful, but alias should not be the only place where curation meaning lives.

Reason:
- alias is readable but lossy
- role and domain are structured concepts
- future UI / CLI / MCP outputs should be able to sort and filter by metadata directly

## Related Problems This Could Solve

- avoid repeatedly asking “which notebook should I use for this topic?”
- reduce overlap confusion inside dense domains
- make curated notebook sets portable across sessions
- reduce dependence on fragile query-based notebook reclassification

## Near-Term Follow-Up

Before implementing the feature:
- keep using alias-based role naming
- maintain curation logic in [notebook-curation.md](/Users/rickwen/code/notebooklm-controller/docs/reference/notebook-curation.md)
- treat this file as the handoff note for turning current manual curation into a real `nbctl` feature
