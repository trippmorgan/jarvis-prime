# SPEC: Memory Architecture + Graphify Observability

**Phase:** 0 — Spec
**Status:** Draft — awaiting human approval
**Date:** 2026-06-06
**Tracks:** A (Graphify) | B (Memory)

---

## Problem Statement

### Track A — Graphify (Code-Structure Observability)

jarvis-prime has no code-structure observability. Prime reasons about its own architecture from grep and stale memory — both brittle at Wave 9+ complexity. The codebase spans brain/router, orchestrator, skills, delivery, lieutenant, and MCP integrations with non-obvious coupling. Planning sessions produce god-node blindspots and unexpected breakage.

Graphify (KG builder, MIT license, `graphifyy` v0.8.33) can produce a queryable dependency graph of any codebase. Phase 1 uses it as a sidecar on the jarvis-prime repo. Phase 2 surfaces the graph permanently on the jarvis-os GUI via Cytoscape.js/D3 — giving Tripp and Prime a shared visual model of the codebase during planning.

### Track B — Memory Architecture

There are six distinct memory stores across the Jarvis mesh that can disagree with each other and with the actual conversation:

| # | Store | Location | Type | Last Updated |
|---|-------|----------|------|-------------|
| 1 | Workspace narrative | `workspace/MEMORY.md` | Free-text | 2026-04-21 (stale) |
| 2 | Claude Code auto-memory | `.claude/projects/.../memory/` | Typed atoms (user/feedback/project/reference) | Ongoing |
| 3 | Conversation history | `jarvis-prime/.data/conversation-history.jsonl` | Raw turns | Ongoing |
| 4 | OpenClaw vector store | `~/.openclaw/` (nomic-embed-text, 358 chunks, 768d) | Embeddings over #1 and workspace files | As-indexed |
| 5 | Hippocampus / portfolio-surface | `jarvis-os/.data/project-state/` | `project_state` atoms | Via `/note` |
| 6 | Session context files | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md` | Static persona docs | Manual |

Current search surface: grep + `/note` writer-list. No provenance. No conflict detection. When stores #1 and #3 disagree, there is no rule to pick a winner. This produces stale context bleed into active planning.

**Three locked Phase 0 answers:**
- **Q1 — Precedence:** conversation-history.jsonl outranks summarized stores when they disagree. "Most recent confirmed statement wins; older summaries are evidence, not ground truth."
- **Q2 — v1 deliverable:** Deduplicate the six stores down to one canonical typed atom store (define consolidation target and migrate; retain conversation-history.jsonl as source-of-truth read path, not a write target).
- **Q3 — Integration:** Provenance map must beat grep+writer-list in `/note` AND the atom store must integrate with jarvis-os.

---

## In-Scope v1

### Track A
1. **Phase 1 — Pilot:** Frank (Voldemort) builds graph artifacts for jarvis-prime codebase using graphify Python toolchain. Output: `graph.json` + `GRAPH_REPORT.md` (god-nodes, community clusters, god-edge density).
2. **MCP sidecar:** `graphify serve graph.json` runs on SuperServer during active Claude Code sessions, giving Prime graph-query tools without a round-trip to Frank.
3. **Phase 2 — GUI viewer:** jarvis-os Node service exposes `GET /api/graph/jarvis-prime` → returns `graph.json`. GUI route `/graph` renders via Cytoscape.js (D3 fallback). Route accessible from the existing jarvis-os GUI nav.

### Track B
1. **Audit:** Map all six stores — identify overlapping atoms, conflicts, schema differences, and any PHI-at-risk entries.
2. **Canonical schema:** Define typed atom format (type, name, body, provenance: {source, ts, confidence}, tags). Source field values: `human-direct`, `session-summary`, `auto-memory`, `hippocampus`, `static-doc`.
3. **Consolidation target:** Claude Code auto-memory store (`.claude/projects/.../memory/`) becomes the single canonical store, extended with provenance fields. The workspace MEMORY.md becomes a generated narrative view (read-only, regenerated from atoms).
4. **Migration:** Script deduplicates and imports atoms from all six stores. Conflicts surfaced to Tripp before resolution; no silent lossy merges.
5. **`/note` integration:** `/note` search returns provenance alongside content (source, ts, confidence). Replaces grep+writer-list as primary lookup surface.
6. **jarvis-os API:** `GET /api/memory/atoms` — filterable by type, source, date range. Minimal surface; feeds dashboard if one is added in v2.

---

## In-Scope v2

### Track A
- Scheduled re-analysis (nightly or on commit via git hook on jarvis-prime)
- PretoriaFields codebase graph (Use Case 2 from graphify-integration SPEC)
- Multi-repo overlay (jarvis-prime + jarvis-os shown together)

### Track B
- Vector search over atom store (Ollama nomic-embed-text, replaces current OpenClaw 358-chunk index)
- Cross-session contradiction detection (flag when a new atom contradicts an existing one by cosine similarity + type match)
- Automated memory pruning (kernel-janitor pattern: archive stale project atoms past N days)
- Push-to-Telegram on conflict detection (Tripp notified when resolution is ambiguous)

---

## Out of Scope

- Neo4j integration — operational complexity not justified by current use cases
- Clinical document ingestion into graphify — hard PHI constraint, permanently blocked unless a redaction pipeline exists first
- Real-time graph updates (reactive to file saves) — batch builds sufficient for Phase 1
- Memory stores for other nodes (Frank, Pretoria, Station) — v1 is SuperServer only
- Replacing conversation-history.jsonl with a structured store — it is source-of-truth by rule; it is read, not rewritten
- Graphify on Argus or Scalpel — no use case identified
- Video/audio transcription via graphify's whisper feature — not relevant

---

## Acceptance Criteria

### Track A

| # | Criterion |
|---|-----------|
| A1 | `graphify .` on jarvis-prime workspace runs on Frank and produces `graphify-out/graph.json` + `GRAPH_REPORT.md` |
| A2 | GRAPH_REPORT.md identifies at least one god-node and one high-density community cluster |
| A3 | MCP sidecar (`graphify serve`) starts on SuperServer and responds to at least one tool query from Claude Code |
| A4 | `GET /api/graph/jarvis-prime` on jarvis-os returns valid graph.json |
| A5 | GUI route `/graph` renders in browser; nodes and edges visible; basic zoom/pan functional |
| A6 | No PHI paths in any graphify run; CI gate rejects runs targeting clinical-archive |

### Track B

| # | Criterion |
|---|-----------|
| B1 | Audit document lists all atoms across six stores with overlap/conflict map |
| B2 | Canonical atom schema defined with provenance fields; no unresolvable ambiguity in source enumeration |
| B3 | Migration script runs without data loss; conflict report surfaced to Tripp before any deletion |
| B4 | `/note` search returns provenance (source, ts, confidence) alongside atom body |
| B5 | `/note` write path rejects atoms containing PHI patterns at write time |
| B6 | `GET /api/memory/atoms` returns filterable atom list from jarvis-os |
| B7 | Precedence rule demonstrably enforced: given a conflict between conversation-history atom and MEMORY.md atom on the same fact, the conversation-history atom wins |

---

## Dependencies

### Track A
- Frank reachable on 192.168.0.108 (LAN) with Python ≥ 3.10 and `uv` available
- graphify installable: `uv tool install graphifyy[mcp,leiden,svg]`
- jarvis-os GUI exists with a routing structure for new routes (verify before Phase 2 plan)
- Track A Phase 2 depends on Track A Phase 1 (graph artifacts must exist)

### Track B
- conversation-history.jsonl readable by migration tooling (format: JSONL with ts field)
- jarvis-os running with writable API surface and port accessible from SuperServer
- `/note` skill source (`skills/note/note.sh` + `note.md`) accessible for modification
- Track B migration depends on audit (B1 must complete before B3)

### Cross-track
- Both tracks share the jarvis-os GUI as a render target — Track A Phase 2 and Track B `/api/memory/atoms` both need jarvis-os to be running and addressable. Coordinate deployment windows.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Python-on-Node-host runtime mix** (jarvis-os is Node/TS; graphify is Python) | Medium | Frank owns all Python execution. jarvis-os calls Frank via HTTP to trigger builds and fetches artifacts. No Python process on SuperServer except the lightweight MCP sidecar. |
| **conversation-history.jsonl as source-of-truth operationalization** — "most recent wins" requires timestamp-aware conflict resolution; unresolvable if ts missing | Medium | Canonical schema requires `ts` field. Atoms without ts get `confidence: low`; conflicts with low-confidence atoms surfaced rather than auto-resolved. |
| **Deduplication migration risk** — lossy merge loses nuance; a bad migration is worse than no migration | High | Phase 0 audit is non-destructive. Migration script archives, does not delete. All conflicts surfaced to Tripp in a review file before the merge runs. |
| **Graph viewer performance** — Cytoscape.js handles ~5k nodes; a medium TS repo could exceed this | Low-Medium | Phase 1 measures node count before committing to renderer. If > 3k nodes, apply community-level collapse (show clusters, expand on click). |
| **`/note` skill scope creep** — current skill is a narrow `project_state` upsert; adding provenance and search is a behavioral change | Low | /note search path is additive. Existing upsert path unchanged. New `--search` flag added alongside. |
| **Stale workspace MEMORY.md** — last updated 2026-04-21; migration will encounter many outdated atoms | Low | Migration marks workspace MEMORY.md atoms as `confidence: historical`. They are preserved but ranked below recent sources. Tripp reviews flagged conflicts. |

---

## PHI Boundary

**Track A — Graphify:**
- graphify must never be pointed at `/home/tripp/Documents/claude-team/clinical-archive/` or any path containing patient data
- CI gate: build script has an allowlist of permitted source paths; any run targeting a non-allowlisted path aborts
- Ingest URL feature disabled in default invocation (requires explicit flag)
- `graph.json` is not encrypted — keep it in the local graph output directory, not in any shared path

**Track B — Memory:**
- PHI-SECURITY-EDICT applies to all atoms. Atoms are stored plain text and indexed — a single PHI leak contaminates the store
- `/note` write path must reject atoms matching PHI patterns (SSN, MRN, name+DOB combos, insurance numbers) at write time with a hard error, not a warning
- conversation-history.jsonl must NOT be parsed for PHI-containing turns during migration — if any turn is flagged as PHI-containing, that turn is excluded from atom extraction
- Hippocampus `project_state` atoms are not PHI-bearing by design; the migration must confirm this before importing

---

## Track A Subdirectory

`.planning/graphify-integration/` — existing SPEC.md (graphify tool evaluation, use case ranking, dependency surface, license analysis) and STATE.md from the prior research session are preserved here as reference material. Track A Phase 1 plan will supersede the graphify-integration SPEC but retains it for provenance.

The go-forward planning artifacts for Track A live in this directory (`.planning/memory-and-graphify/`).

---

## Track B Primitive: Memory Consolidation Session (MCS)

**Added:** 2026-06-06 — right-hemisphere pass; not yet approved

### What it is

The MCS is the governance layer that sits above the atom store, the truth hierarchy, and the precedence rule. Without it, the store accumulates drift: atoms compound, contradictions multiply, and confidence scores stagnate. The MCS is the editorial cycle that keeps the architecture honest — Jarvis pre-stages all the discovery work, Tripp shows up only to decide.

It is weekly at minimum. It is a ritual, not a tool. The ritual is the feature.

---

### Inputs

**All six stores are snapshotted, but the session surface is diff-first — not a full export.**

| Store | Snapshot method | What's surfaced |
|-------|----------------|-----------------|
| Workspace MEMORY.md | Hash + line-count delta | Changed/deleted sections since last MCS |
| Claude Code auto-memory atoms | File listing + metadata | New, modified, deleted atom files |
| conversation-history.jsonl | Turn count + last-ts delta | Number of new turns; any turns that contradict settled atoms |
| OpenClaw vector store | Chunk count + last-index-ts | Re-indexing needed? (not full content review) |
| Hippocampus project_state | Atom listing | New project atoms, any in conflict with auto-memory atoms |
| Session context files (SOUL.md, etc.) | Hash check | Any drift from last-MCS snapshot |

**Pre-session generation (Prime's pre-work, not session time):**
- Delta report: what changed in each store since the prior MCS timestamp
- Conflict table: atoms across stores that assert different values for the same fact
- Staleness list: atoms older than 30 days with no recent confirmation
- PHI scan log: any atoms flagged by the write-gate (should be zero; flag if not)

---

### Output Artifact

**Location:** `.planning/mcs/MCS-YYYY-MM-DD.md`

**Sections:**
1. **Snapshot summary** — atom count per store, delta since last MCS, health signal (green/amber/red per store)
2. **Conflict table** — atom-vs-atom pairs with source, ts, body; no resolution yet
3. **Staleness list** — atoms Prime flags as candidates for archival or reconfirmation
4. **Decision log** — Tripp's per-conflict resolution: `KEEP-A`, `KEEP-B`, `MERGE`, `ARCHIVE`, `NEEDS-MORE-INFO`
5. **Promoted atoms** — new or revised atoms confirmed during session; written back to the canonical store post-session with `source: mcs-confirmed`
6. **Deferred list** — items Tripp flagged as `NEEDS-MORE-INFO`; surfaced again at next MCS

**Post-session write-back:** Prime commits the promoted atoms to the auto-memory store with:
```yaml
source: mcs-confirmed
confidence: high
mcs_date: YYYY-MM-DD
```

The MCS file itself is archived, not ingested into the atom store (it is a record of process, not a knowledge atom).

---

### Pre-Staging vs Live Discussion Split

| Phase | Who | What | Time |
|-------|-----|------|------|
| **Pre-stage** | Prime (automated, night before or morning of) | Snapshot all stores, generate conflict table, build MCS-YYYY-MM-DD.md skeleton | ~10 min automated |
| **Prime narrows** | Prime (first 2 min of session) | Reads Tripp in: "X conflicts, Y stale atoms, Z stores green" | < 2 min |
| **Live decision** | Tripp + Prime | Walk conflict table row by row; Tripp decides; Prime writes decision log live | 15–30 min |
| **Write-back** | Prime (automated post-session) | Promotes confirmed atoms; archives resolved conflicts; updates store | < 5 min automated |

**The rule:** If Tripp is searching or reading during the live session, Prime failed at pre-staging. The session is decision-time, not discovery-time.

---

### Interaction with Truth / Index / View Layering

The three-layer model in the SPEC (conversation-history = truth, atom store = index, MEMORY.md = generated view) describes how memory is read. The MCS describes how memory is validated and corrected.

```
truth (conversation-history.jsonl)
        ↕  [MCS reads conflicts, writes new confirmed turns]
index (atom store — mcs-confirmed atoms rank highest)
        ↕  [post-MCS regeneration]
view (MEMORY.md — regenerated after each MCS)
```

The MCS does not alter the truth layer — it reads it. The conversations that happen *during the MCS* go into conversation-history.jsonl as new entries (highest authority). Post-session, those entries are the source for promoted atoms — closing the loop.

---

### Relation to "Most Recent Confirmed Conversation Wins"

The precedence rule (`conversation-history.jsonl outranks summarized stores`) remains in force within sessions. MCS supplements it by making "confirmed" operational rather than implicit.

**Before MCS:** "most recent" is the only confirmation signal. An atom from a 6-week-old conversation outranks a MEMORY.md entry from 2026-04-21 — but only because it's newer, not because it's been reviewed.

**After MCS:** A confirmed atom (`source: mcs-confirmed`) has been explicitly reviewed and accepted by Tripp. It outranks any `source: session-summary` atom of any date, because human editorial review is a stronger signal than timestamp alone.

**Revised precedence hierarchy (post-MCS primitive):**

| Rank | Source | Rationale |
|------|--------|-----------|
| 1 | Live conversation turn (current session) | Direct input, in-context |
| 2 | `mcs-confirmed` atom | Human-reviewed, editorially settled |
| 3 | `auto-memory` atom (recent, < 7 days) | Fresh, but not reviewed |
| 4 | `session-summary` atom (> 7 days) | Older, unreviewed |
| 5 | `hippocampus` atom | Derived from project state, coarser |
| 6 | `static-doc` entry (SOUL.md, USER.md, etc.) | Manual updates, unknown freshness |
| 7 | `historical` atom (MEMORY.md import) | Migrated, possibly stale |

A conflict between any rank and a higher rank resolves in favor of the higher rank. Conflicts within the same rank are surfaced to the next MCS.

---

### Acceptance Criteria (MCS primitive adds to Track B)

| # | Criterion |
|---|-----------|
| B8 | Prime generates MCS-YYYY-MM-DD.md automatically (via scheduled job or manual `/mcs prep`) with all five sections populated before any live session |
| B9 | Conflict table covers all six stores; no store silently omitted |
| B10 | Post-session write-back commits promoted atoms with `mcs-confirmed` source and `mcs_date` field |
| B11 | MCS archive (`.planning/mcs/`) is not indexed into the atom store; preserved as audit trail only |
| B12 | MEMORY.md view is regenerated from the atom store after every MCS write-back (not by hand) |

---

### Open Phase-0 Questions (MCS Primitive)

**Q4 — Trigger:** Should the MCS be calendar-fixed (every Monday, or every Sunday night so it's ready for Monday morning), or event-triggered (Prime runs it automatically when N unresolved conflicts accumulate)? A calendar-fixed ritual is easier to honor as a habit; event-triggered is more efficient but easy to skip when life is busy.

**Q5 — Session scope:** Should each MCS cover all six stores (full-mesh, potentially noisy for quiet weeks) or should Prime triage and only surface stores where the delta exceeds a threshold (focused, but risks missing a slow drift)? Related: is there a maximum number of items Prime should surface per session so it doesn't become a 2-hour slog?

**Q6 — Deferred item fate:** When Tripp marks something `NEEDS-MORE-INFO`, what should Prime do between sessions — actively research and pre-answer it for next MCS, or simply hold it and re-surface it? Active research could resolve conflicts before they consume session time; passive holding keeps Prime from acting on ambiguous authority.

---

**Phase 0 complete. Awaiting Tripp's "approved" gate before Phase 1 planning begins for either track.**
