# Canonical Atom Schema (B2.1 — ratification, not greenfield)

**Status:** Draft for B2 — ratifies the live `jarvis-os` project_state shape, extended.
**Date:** 2026-06-07
**SPEC mapping:** B2 (§49 source enum, §261 precedence). Informed by `audit/B1-SUMMARY.md`.
**Principle:** Truth / Index / View are separate layers (PLAN §Open Questions). This schema governs the **Index** layer only. The **Truth** layer (`conversation-history.jsonl` → future `truth-log.jsonl`) is event-shaped, not atom-shaped, and is out of scope here.

---

## 1. Why ratification

The 18 canonical atoms in `jarvis-os/.data/project-state/` already enforce a complete provenance schema (`source`, `source_path`, `owner`, `updated_at`, `visibility`, `phi`). B2 does **not** invent a schema — it documents that shape, extends the `type` enum beyond `project_state`, and adds the three fields the SPEC requires for precedence (`name`, `description`, `confidence`).

## 2. Canonical atom (frontmatter form)

```yaml
---
# identity
type: project_state            # see §3 type enum
name: "<short human title>"    # NEW — required; was implicit in filename
description: "<one-line>"      # NEW — recall hook (mirrors auto-memory)

# payload (type-specific; project_state shown)
project: jarvis-prime
status: in-progress
priority: 1
summary: "..."
next_action: "..."

# provenance (REQUIRED on every atom)
source: state-md-poller        # see §4 source enum
source_path: "jarvis-prime/.planning/STATE.md"
owner: prime
updated_at: "2026-05-30T14:30:00Z"   # ISO-8601 UTC; drives precedence tie-breaks
confidence: high               # NEW — high | medium | low | historical (§5)

# governance
visibility: mesh               # mesh | local | private
phi: false                     # hard-gated; phi:true atoms excluded from mesh surfaces
mcs_date: null                 # set only when source=mcs-confirmed (§4)
---

<body — markdown; type-specific>
```

Atoms whose payload is not `project_state` (e.g. `feedback`, `reference`) carry the identity + provenance + governance blocks and drop the `project/status/priority/summary/next_action` payload fields, using free-form body instead.

## 3. `type` enum (extended)

| type | origin | payload | notes |
|------|--------|---------|-------|
| `project_state` | STATE.md poller / `/note` | structured (project/status/…) | **canonical, live today** |
| `user` | persona | body | who Tripp is |
| `feedback` | corrections | body + **Why** / **How to apply** | from auto-memory |
| `project` | narrative | body | ongoing work not in a STATE.md |
| `reference` | pointers | body | URLs, dashboards, tickets |
| `session-summary` | summarizer | body | per-session rollup |
| `mcs-confirmed` | MCS write-back | body + `mcs_date` | **rank-2 authority** |
| `static-doc` | persona files | body | SOUL/USER/IDENTITY/… |
| `historical` | MEMORY.md import | body | migrated, possibly stale |

The first four (`user/feedback/project/reference`) **match the vault `notes` CHECK enum exactly**. The last five do **not** — see §6.

## 4. `source` enum (SPEC §49, extended by recon)

`human-direct` · `human-note` (`/note`) · `state-md-poller` · `dev-phase-hook` · `auto-memory` · `session-summary` · `mcs-confirmed` · `hippocampus` · `static-doc` · `prose-narrative` (MEMORY.md import)

> Recon added `state-md-poller`, `dev-phase-hook`, `human-note`, `prose-narrative` — all observed live in the canonical store; the SPEC's 5-value list was incomplete.

## 5. `confidence` derivation (B3 migration applies this)

| confidence | rule |
|------------|------|
| `high` | `mcs-confirmed`, OR human-direct/human-note < 7d |
| `medium` | auto-memory or poller < 7d, unreviewed |
| `low` | unreviewed > 7d, OR missing `updated_at` (SPEC §135) |
| `historical` | MEMORY.md prose import (SPEC §139) |

## 6. Precedence hierarchy (SPEC §261 — lives at the READ site, not write)

```
1  live conversation turn (current session)      ← Truth layer, not an atom
2  mcs-confirmed atom                             ← human-reviewed beats timestamp
3  auto-memory atom (recent < 7d)
4  session-summary atom (> 7d)
5  hippocampus atom (project_state)
6  static-doc (SOUL/USER/…)
7  historical atom (MEMORY.md import)
```
Higher rank wins. Same-rank conflicts → surfaced to next MCS, never auto-resolved. Implemented in B7.3 as a `ranked-source` resolver in `memory-surface-service.ts`.

## 7. Two open schema decisions for Tripp (from B1)

**D1 — the empty vault enum.** The vault `notes` table (currently 0 rows) constrains `type IN (user,feedback,project,reference)`. Five of our nine types don't fit. Options:
- **(a) Widen the CHECK** to all nine types → vault becomes the full Index. *(Prime's lean — keeps one index with FTS+embeddings+backlinks.)*
- **(b) Keep the vault narrow**; richer types live only as project_state-style files. → two index substrates to query.

**D2 — schema-variance normalization (B1.4).** 16/27 auto-memory files nest under `metadata:`; 11/27 are flat. Migration **lifts** `metadata.type`→`type` and maps `metadata.node_type`→`source`. Ratified here; executed in B3.

---

## 8. Next (B2.2 / B2.3 — code, not yet done)
- **B2.2:** discriminated-union TS types in `jarvis-os/src/services/hippocampus/atom-types.ts` for the nine types. *(Touches jarvis-os source — staged, awaiting go.)*
- **B2.3:** confirm `ProjectStateStore.upsert` generalizes to non-`project_state` types, or fork a sibling `AtomStore`. Architecture note to follow.
