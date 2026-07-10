# B1.4 Schema Variance + Normalization Plan — 2026-06-06

## Observed shapes

| store | type field | notes |
|---|---|---|
| hippocampus-project_state (jarvis-os) | flat `type: project_state` + full provenance | **canonical target** — has source/source_path/owner/updated_at/visibility/phi |
| hippocampus-vault index.db | SQL column `type` CHECK IN (user,feedback,project,reference) | **empty (0 rows)** — schema only; narrower type enum than atoms |
| claude-code-auto-memory | mixed flat vs nested `metadata.type` | see counts below |
| workspace-MEMORY.md | none (prose) | heading-derived; no machine schema |
| conversation-history.jsonl | `{role,content,timestamp}` | truth layer; no type/provenance |

## Auto-memory shape counts

- **nested**: 16 files
- **flat**: 11 files

## Normalization rules (for B3 migration)

1. Canonical schema = the jarvis-os project_state frontmatter (source, source_path, owner, updated_at, visibility, phi) extended with `name`, `description`, `confidence`.
2. Auto-memory **nested** (`metadata.type`/`metadata.node_type`) → lift to flat `type`; map `node_type` to `source` where present.
3. Auto-memory **flat** (`type:`) → pass through; backfill `updated_at` from mtime, `source: claude-code-auto-memory`.
4. Vault type enum (user/feedback/project/reference) is a **subset** — when migrating atoms of type session-summary/static-doc/mcs-confirmed INTO the vault, either widen the CHECK constraint or keep those types out of the vault and only in project_state-style files.
5. conversation-history turns are NOT atoms — they are TRUTH-layer events; migration extracts confirmed facts FROM them, never rewrites them (SPEC Q1).
