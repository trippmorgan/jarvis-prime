# Track B — Wave B1 Audit Summary (read-only)

**Date:** 2026-06-07
**Owner:** Prime
**Mutations:** none (all source stores untouched; outputs confined to `audit/`)
**SPEC mapping:** satisfies B1.1–B1.5.

## Deliverables in this dir
- `atom-inventory.json` — 151 atoms, uniform model `{store,id,type,ts,source,phi,...}` (B1.1)
- `conflicts.md` — 19 conflict candidates in 3 classes (B1.2)
- `phi-scan.log` — **CLEAN**; 1 benign self-reference in the policy doc (B1.3)
- `schema-normalization-plan.md` — variance + 5 migration rules (B1.4)
- `stale-candidates.md` — 7 atoms >60d (6 are KEEP persona docs) (B1.5)
- `build-inventory.py` / `analyze.py` — re-runnable, read-only

## Store inventory (truth as of 2026-06-07)

| Store | Atoms | Health |
|-------|------:|--------|
| workspace-MEMORY.md (prose, by §) | 58 | prose-heavy; not atomic; richest conflict source |
| claude-code-auto-memory | 27 | **16 nested / 11 flat** frontmatter — variance confirmed |
| conversation-history.jsonl | 34 | TRUTH layer; auto-trims (B7 blocker) |
| hippocampus project_state (jarvis-os) | 18 | **canonical** — full provenance schema |
| workspace context docs | 11 | static persona; expected-stale |
| hippocampus project_state (jarvis-prime ORPHAN) | 3 | **stale stubs — delete candidates** |
| hippocampus vault index.db | 0 | **EMPTY** (see finding #1) |
| **total** | **151** | |

## Findings that change the PLAN

1. **The OpenClaw hippocampus vault (Store 6) is EMPTY.** `index.db` has 0 notes, 0 FTS rows, 0 embeddings; schema initialized 2026-05-29, never populated. The PLAN's inventory ("active; 358 chunks / 768 d") and Recon finding #6 were **wrong**. Consequence: there is no vector store to migrate *from* or reconcile *against* — Track B's "six stores" is effectively **five live + one empty shell**. The vault's `notes` CHECK enum (`user/feedback/project/reference`) is also **narrower** than the atom type set; B2 schema must decide whether to widen it or keep richer types out of the vault.

2. **A third, orphaned `project_state` store exists** at `jarvis-prime/.data/hippocampus/project_state/` — 3 stub atoms (`frank-v3`, `jarvis-prime`, `pretoria-fields`, all "Needs state review", 2026-05-28) left behind when the store moved to `jarvis-os/.data/project-state/`. Not mentioned in SPEC or PLAN. **Cleanest fix: delete in B3** (canonical jarvis-os atoms supersede them) — but per "archive not delete" rule, archive first.

3. **Schema variance is larger than recon stated.** Recon said 3/8 nested; truth is **16/27 nested, 11/27 flat**. B1.4 normalization plan handles both shapes; the migration must lift `metadata.type`/`metadata.node_type` to flat keys.

4. **PHI scan is clean.** The lone regex hit was the MRN pattern *inside* `PHI-SECURITY-EDICT.md` — the policy documenting itself. Scanner now classifies policy-doc matches as BENIGN-SELFREF and does not halt. No real PHI in any memory store.

## Conflict classes (19 candidates)

- **duplicate-store (3):** orphan stubs vs canonical jarvis-os atoms (finding #2).
- **prose-vs-atom (5):** MEMORY.md narrative sections asserting project state that may lag the canonical atom (e.g. `athena-emr` prose vs atom `status=paused`).
- **auto-memory-vs-atom (11):** Claude-Code project files running a parallel narrative to project_state atoms. **Caveat:** the matcher keys on a name prefix, so `jarvis-prime`/`jarvis-os`/`jarvis-os-v1` over-count (each pulls the 5 `jarvis_*` files). Over-inclusive by design — a human-review shortlist, not a final merge list. B3.3 conflict review resolves per-atom.

## Recommended PLAN deltas (for Tripp)
- **B2:** add an explicit decision on the empty vault — populate it as the INDEX layer, or retire it and let `project-state/`-style files be the index. (My lean: populate it; it's the only store with FTS + embeddings + backlinks built in.)
- **B3:** add archive-then-delete of the 3 orphan stubs as an explicit task.
- **STATE.md inventory table:** correct Store 6 from "358 chunks / active" to "0 rows / empty shell".
