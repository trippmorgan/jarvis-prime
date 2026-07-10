# PLAN: Memory Architecture + Graphify Observability

**Phase:** 1 — Plan
**Status:** Draft — awaiting human approval
**Date:** 2026-06-06
**Source SPEC:** `./SPEC.md`
**Supersedes:** `.planning/graphify-integration/` (preserved as reference; Track A absorbs it)

---

## Recon Findings That Change Phase 0 Assumptions

Phase 1 recon (12 read-only Explore agents across SuperServer + Voldemort) surfaced six facts the SPEC didn't fully internalize. Each carries a planning consequence:

1. **Hippocampus already satisfies the canonical schema.** The 17 atoms in `/home/tripp/.openclaw/workspace/jarvis-os/.data/project-state/` already carry `source`, `source_path`, `owner`, `updated_at`, `phi`, and `visibility`. The Phase-0 schema design is not greenfield — it's a ratification of what `ProjectStateStore` enforces today, extended to non-`project_state` atom types. **Track B v1 deliverable is "migrate INTO hippocampus," not "design canonical store from scratch."**

2. **conversation-history.jsonl auto-trims to 20 entries when >40.** Writer: `src/context/history.ts → ConversationHistory.append()`. This directly contradicts SPEC §Q1 precedence ("most recent confirmed statement wins; older summaries are evidence, not ground truth") — a truth-layer that loses old turns cannot be the truth layer. **B7 is unachievable until this is fixed.**

3. **Claude Code auto-memory has frontmatter schema variance.** 5/8 files use flat `type:`; 3/8 nest under `metadata.type` + `metadata.node_type`. Migration must normalize before import.

4. **Frank is unprovisioned for graphify.** Python 3.12 present, but `uv` absent, NetworkX absent, graspologic absent, no PM2. Resources are fine (RTX 3090, 62 GiB RAM, 1TB free, Ollama healthy). Bootstrap install is mandatory before A1.

5. **jarvis-os has no SPA framework.** Fastify-only backend; existing static frontends are served from `/public/<name>/` via `@fastify/static` (model: Vascular SPA at `/public/vascular/`). **Track A Phase 2 GUI must produce a static artifact** — Vite/SvelteKit/whatever — built separately and dropped into `/public/graph/`. No "add a React route" path exists.

6. **graphify-integration .planning/ tree exists with a fully-formed SPEC.** Use Case 1 (jarvis-prime dependency map) already ranked highest ROI; install command (`uv tool install graphifyy[mcp,leiden,svg]`) already specified; MIT license already cleared; PHI allowlist gate already specified. **This PLAN absorbs it; the older tree stays as provenance.**

---

## Inventory Snapshot (truth as of 2026-06-06)

| Store | Path | Size / Count | Last Write | Schema Health |
|-------|------|--------------|------------|---------------|
| Workspace MEMORY.md | `workspace/MEMORY.md` | 26 K / 504 lines | 2026-05-11 | prose-heavy; not atomic |
| Workspace context docs | `workspace/{SOUL,IDENTITY,USER,AGENTS,HEARTBEAT,TOOLS,ARCHITECTURE,PHI-SECURITY-EDICT,PROJECT-URLS,SLASH_COMMANDS,MORNING-BRIEFING}.md` | ~84 K / 12 files | 2026-02 → 2026-05 | static persona; ok as `static-doc` |
| Claude Code auto-memory | `~/.claude/projects/<slug>/memory/` | 36 K / 8 files | rolling | schema variance (flat vs nested `type`) |
| conversation-history.jsonl | `jarvis-prime/.data/conversation-history.jsonl` | 33 K / 32 turns | 2026-06-06 | **auto-trims to 20 when >40 — blocker** |
| OpenClaw vector index | `~/.openclaw/hippocampus-vault/.hippocampus/index.db` | 68 K / 358 chunks / 768 d | 2026-06-06 | active; SQLite + FTS5; owned by `hippocampus-server` PM2 |
| Hippocampus project_state | `jarvis-os/.data/project-state/` | 17 atoms | 2026-05-31 | canonical schema already enforced |

### Running services (Phase-1 ports to avoid)

- **SuperServer:** first-officer-bridge (3000/3001), jarvis-brain (3400), jarvis-os-shell (3401, 4040), hippocampus-server (3100 or 3401 — verify in Wave 0), jarvis-os (5173 dev), wpfq-dashboard (8080).
- **Voldemort:** ollama (11434, 11435), frank-brain (8000).
- **Safe MCP sidecar slots:** SuperServer 4800-4999, Voldemort 5200-5299.

---

## Wave Plan

**Sequencing principle:** Track A and Track B share zero code surface but share the `/note` skill (Track B writer) and the jarvis-os service registry (both write new routes there). They can run in parallel **after Wave 0** if Tripp wants throughput. Sequential if Tripp wants careful.

### Wave 0 — Snapshot + reconcile (both tracks) — SHARED PREREQ

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| W0.1 | Snapshot all six stores to `.planning/memory-and-graphify/snapshot/2026-06-06/` (read-only copy) | Prime | snapshot dir; SHA256 manifest |
| W0.2 | Verify hippocampus-server actual port (recon disagreement: 3100 vs 3401) | Prime | one-line note in this PLAN |
| W0.3 | Fold `graphify-integration/SPEC.md` references into this tree's STATE.md; archive `graphify-integration/` as `.planning/_archive/graphify-integration-2026-06-06/` | Prime | renamed dir + STATE.md cross-link |
| W0.4 | ~~Decide blocker resolution for conversation-history.jsonl auto-trim~~ **RESOLVED** — see Open Q1 lock above (truth-log split). | Prime | implemented in B7 |
| W0.5 | Write the 3 Track-A gate-test questions BEFORE A2 runs (see "Track A acceptance gate" below) | Tripp + Prime | `gate-questions.md` checked into this dir |

**Gate:** all five complete before any other wave starts. Single mutation: directory rename in W0.3.

### Track A — Graphify

#### Wave A1 — Frank bootstrap (one-shot install)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| A1.1 | Install `uv` on Voldemort (`curl -LsSf https://astral.sh/uv/install.sh \| sh`) | Prime via SSH | `which uv` succeeds |
| A1.2 | Install graphify: `uv tool install 'graphifyy[mcp,leiden,svg]'` | Prime via SSH | `graphify --version` succeeds |
| A1.3 | Smoke-test on Voldemort: `graphify --help` + Python `import networkx, graspologic` | Prime via SSH | logs in `.planning/memory-and-graphify/A1-bootstrap.log` |
| A1.4 | Document install in `frank-v3/` workspace so reinstalls don't re-discover | Prime | one-line note in Frank's STATE.md |

**Gate:** all four green. No persistent service yet — just toolchain.

#### Wave A2 — First graph build (artifact only)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| A2.1 | rsync jarvis-prime → Voldemort `/root/graph-targets/jarvis-prime/` (read-only copy; **exclude** `.data/`, `.git/`, `node_modules/`, `_archive*/`, anything matching clinical-archive pattern) | Prime | rsync log |
| A2.2 | Run `graphify .` against the copy; output to `/root/graph-out/jarvis-prime/` | Frank (Prime SSH) | `graph.json` + `GRAPH_REPORT.md` |
| A2.3 | Sanity check: node count, edge count, community count. If >3 k nodes, document collapse strategy for Phase-2 viewer per SPEC risk table | Prime | sanity-check.md |
| A2.4 | Pull artifacts to SuperServer: `.planning/memory-and-graphify/graph-artifacts/2026-06-06/` | Prime | local copies |

**Gate:** A1, A2 = **SPEC A1 + A2 satisfied.**

#### Wave A3 — MCP sidecar on SuperServer

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| A3.1 | Install `graphifyy[mcp]` on SuperServer via uv | Prime | `which graphify` succeeds locally |
| A3.2 | Wrap `graphify serve graph.json` as a manageable process: systemd user unit OR PM2 entry (pick PM2 — fits existing pattern). Port: 4800. | Prime | ecosystem entry + `pm2 jlist` shows it |
| A3.3 | Register MCP server in Claude Code config (`~/.claude/settings.json` or per-project) | Prime via /update-config | tool list shows graphify-* tools |
| A3.4 | One end-to-end query from this Claude session to graphify-mcp | Prime + Tripp | sample query transcript |

**Gate:** A3 = **SPEC A3 satisfied.**

#### Wave A4 — jarvis-os HTTP surface

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| A4.1 | Create `jarvis-os/src/services/graph/graph-service.ts` following PortfolioSurfaceService pattern (envelope: `{nodes, edges, degraded, message?}`) | Prime | unit tests passing |
| A4.2 | Create `jarvis-os/src/api/routes/graph.ts` — `GET /api/v1/graph/jarvis-prime` → service → JSON envelope | Prime | route test passing |
| A4.3 | Wire route in `src/api/server.ts` inside authenticated scope (after `projectsRoutes` line) | Prime | `curl /api/v1/graph/jarvis-prime` returns valid JSON |
| A4.4 | Service reads `graph.json` from a configurable path (env `GRAPH_ARTIFACT_ROOT`, default `.data/graph/`) | Prime | env documented in `.env.example` |

**Gate:** A4 = **SPEC A4 satisfied.**

#### Wave A5 — `/graph` GUI viewer (static artifact)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| A5.1 | Decide renderer (Cytoscape.js primary, D3 fallback — SPEC default). Confirm node count from A2 fits Cytoscape ceiling (~5 k); if not, implement community-collapse | Prime | decision recorded |
| A5.2 | Scaffold Vite app at `jarvis-os/frontend/graph/` (or stand-alone repo if Tripp prefers separation) | Prime | `npm run build` produces dist |
| A5.3 | Build artifact → `jarvis-os/public/graph/`; serve via existing `@fastify/static` pattern (mirror Vascular SPA at `/public/vascular/`) | Prime | `GET /graph` returns HTML |
| A5.4 | Viewer fetches `/api/v1/graph/jarvis-prime`, renders nodes/edges, supports zoom/pan | Prime | manual browser walkthrough |
| A5.5 | Add nav link in existing jarvis-os GUI surface IF one exists (recon: API-only — so this is just a documented URL, not a nav entry) | Prime | URL in MEMORY.md |

**Gate:** A5 = **SPEC A5 satisfied.** Track A complete.

### Track B — Memory consolidation

#### Wave B1 — Audit + conflict map (read-only)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B1.1 | Parse every atom across the six stores into a uniform in-memory model `{store, id, type, body, ts, source_inferred}`. Output: `audit/atom-inventory.json` | Prime | JSON file |
| B1.2 | Conflict detection: identify atoms across stores that assert the same fact with different bodies (name/key match heuristics; surface both prose-vs-atom mismatches). Output: `audit/conflicts.md` | Prime | conflict table |
| B1.3 | PHI scan: every atom body checked against PHI patterns (SSN, MRN, name+DOB combo, insurance #). Any hit → halt + alert Tripp | Prime | `audit/phi-scan.log` (must be empty) |
| B1.4 | Schema-variance normalization plan: how flat `type` and nested `metadata.type` reconcile | Prime | one-page in audit/ |
| B1.5 | Stale-atom shortlist: atoms older than 60 days that no recent conversation has referenced | Prime | `audit/stale-candidates.md` |

**Gate:** B1.1–B1.5 complete = **SPEC B1 satisfied.** No mutations yet.

#### Wave B2 — Canonical schema ratification (not design — ratification)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B2.1 | Write `SCHEMA.md` documenting the existing hippocampus atom shape, extended for non-`project_state` types (`user`, `feedback`, `project`, `reference`, `session-summary`, `mcs-confirmed`, `static-doc`, `historical`). Includes source enum from SPEC §49. | Prime | `SCHEMA.md` |
| B2.2 | Add discriminated-union TypeScript types in `jarvis-os/src/services/hippocampus/atom-types.ts` covering the extended types | Prime | tsc 0; tests pass |
| B2.3 | Verify the existing `ProjectStateStore.upsert` is generalizable to other types OR fork a sibling `AtomStore` if the constraints conflict | Prime | architecture note |

**Gate:** B2 = **SPEC B2 satisfied.**

#### Wave B3 — Migration script (archives, does not delete)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B3.1 | Migration tool reads each store, normalizes atoms to canonical schema, writes to hippocampus with `source` = source-store, `confidence` = derived (recent + reviewed = high; old + unreviewed = historical) | Prime | `tools/migrate-atoms.mjs` |
| B3.2 | Migration is **idempotent and additive** — re-running produces no duplicates, no edits to existing atoms (last-writer-wins enforced by `updated_at`) | Prime | dry-run produces empty diff on second pass |
| B3.3 | Conflict report (`migration-report-2026-06-06.md`) lists every atom where the source disagrees with an existing hippocampus atom. Tripp reviews **before** any merge writes occur. | Prime + Tripp | review file |
| B3.4 | After Tripp signs off on the report, migration runs in commit mode. Source-stores remain on disk untouched (we archive, we do not delete). | Prime | post-migration atom count delta |
| B3.5 | conversation-history.jsonl is **not** consolidated — it remains the truth layer per SPEC §Q1. Migration extracts confirmed facts FROM it; does not move it. | Prime | extraction log |

**Gate:** B3 = **SPEC B3 satisfied.** Source-stores still readable; rollback = ignore hippocampus extensions.

#### Wave B4 — `/note` provenance + search

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B4.1 | Extend `/note` script (`jarvis-prime/skills/note/note.sh`) with `--search "<query>"` flag; shells out to hippocampus search endpoint | Prime | smoke test |
| B4.2 | Output format for search results includes `source`, `updated_at`, `confidence` per row | Prime | sample output |
| B4.3 | Existing upsert path unchanged. New flag is additive. | Prime | regression test on current usage |

**Gate:** B4 = **SPEC B4 satisfied.**

#### Wave B5 — PHI write-gate in `/note`

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B5.1 | Add a `phi-detector.mjs` library checking inputs against patterns (SSN, MRN, name+DOB combo, insurance #, phone+name combos). Used by both `/note` and the migration tool. | Prime | unit tests covering each pattern |
| B5.2 | Wire detector into the `project-state-upsert.mjs` CLI as a pre-write gate. **Hard error**, not warning (per SPEC PHI §). | Prime | rejection test passes |
| B5.3 | Detector logs rejected attempts (without echoing PHI) to `.data/phi-rejections.log` for forensic review | Prime | rejection log entry |

**Gate:** B5 = **SPEC B5 satisfied.**

#### Wave B6 — jarvis-os `/api/v1/memory/atoms` endpoint

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B6.1 | Create `jarvis-os/src/services/memory-surface/memory-surface-service.ts` — filterable list (type, source, date range, project) | Prime | unit tests |
| B6.2 | Route: `jarvis-os/src/api/routes/memory.ts` → `GET /api/v1/memory/atoms?type=&source=&since=&until=&project=` | Prime | route test |
| B6.3 | PHI filter mirrors PortfolioSurfaceService (excludes `project=scalpel`, drops `phi=true` atoms) | Prime | test confirms no leak |
| B6.4 | Register in `server.ts` authenticated scope | Prime | curl smoke test |

**Gate:** B6 = **SPEC B6 satisfied.**

#### Wave B7 — Precedence rule operationalization

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B7.1 | Resolve Open Q1 (conversation-history.jsonl trim). Options: (a) raise threshold to 10 k, (b) rotate to dated files in `.data/history/YYYY-MM-DD.jsonl`, (c) move write target to hippocampus directly | Tripp + Prime | decision in STATE.md |
| B7.2 | Implement the chosen option. Whichever option wins, the **invariant** is: no turn is ever silently lost. | Prime | regression test: append 50 turns, all 50 readable |
| B7.3 | Precedence rule lives in code at the read site, not the write site. Add `ranked-source` resolver in `memory-surface-service.ts` per SPEC §261 hierarchy | Prime | conflict test: same-fact atoms at ranks 2 and 4 → rank 2 wins |
| B7.4 | Demo: write conflicting atom to MEMORY.md import + a confirmed mcs-confirmed atom on same fact; query returns mcs-confirmed | Prime + Tripp | walkthrough recorded |

**Gate:** B7 = **SPEC B7 satisfied.** Precedence is observable.

#### Wave B8 — MCS primitive (pre-stage + write-back)

| # | Task | Owner | Deliverable |
|---|------|-------|-------------|
| B8.1 | `jarvis-os` job: `mcs-prep` — runs on the soft 7-day heartbeat OR when drift threshold trips (N=5 unresolved contradictions OR project open/close event). Produces `.planning/mcs/MCS-YYYY-MM-DD.md` skeleton per SPEC §204 | Prime | sample MCS file |
| B8.2 | `/mcs prep` skill for manual invocation | Prime | skill file + smoke test |
| B8.3 | Post-session write-back script: reads decision log, commits promoted atoms with `source: mcs-confirmed`, `mcs_date: <date>` | Prime | round-trip test |
| B8.4 | MEMORY.md view regeneration: read hippocampus atoms tagged as workspace-narrative-grade, render structured MEMORY.md | Prime | regenerated MEMORY.md sample (NOT committed in Wave 8 — verification only) |
| B8.5 | First MCS session against this PLAN's outputs (recursive acceptance test per SPEC §Q5) | Tripp + Prime | MCS-<date>.md |

**Gate:** B8 = **SPEC B8–B12 satisfied.** Track B complete.

---

## Dependency Graph (waves)

```
W0 ─┬─→ A1 ─→ A2 ─→ A3 ─→ A4 ─→ A5
    └─→ B1 ─→ B2 ─→ B3 ─→ B4 ┬─→ B6 ─→ B7 ─→ B8
                              └─→ B5 ───────┘
```

- **W0 is the only hard barrier.** Everything else can fan out.
- **A waves are strictly sequential** (each builds on prior artifact).
- **B waves split after B3.** B4 (search) and B5 (PHI gate) are independent.
- **B7 has its own gate** — Q1 must be resolved before B7.1.

Parallelization opportunity: A1+A2 (Frank install + build) runs concurrent with B1 (audit) — different machines, no shared code.

---

## Open Questions — RESOLVED 2026-06-06

The five Open Qs were resolved under one organizing principle:
**Truth / Index / View are three distinct layers and must stay separated.**

- **Truth** = append-only, lossless (e.g. `truth-log.jsonl`)
- **Index** = typed atoms, queryable (e.g. hippocampus, project_state, future graph)
- **View** = rendered for humans (e.g. MEMORY.md, auto-memory, `/projects`, future `/graph`)

| # | Question | Lock | Blocks |
|---|----------|------|--------|
| **Q1** | conversation-history.jsonl auto-trim violates SPEC §Q1 precedence | **Demote `conversation-history.jsonl` to a VIEW.** Introduce `truth-log.jsonl` (append-only, no trim) as the new TRUTH layer, written BEFORE the 20-entry trim fires. Hippocampus mirrors/indexes it but is INDEX, not TRUTH. Wave B7 implements the write-before-trim split + regression test for the trim path. | B7.1 |
| **Q2** | Track A Phase 2 viewer location | **Standalone repo, NOT jarvis-os.** Graphify must earn its place. If `/graph` is baked into jarvis-os pre-acceptance and graphify flames out (see Track A acceptance gate below), we own dead UI in the OS surface. Standalone keeps the failure mode local. | A5.2 |
| **Q3** | MCS trigger thresholds (drift N=5; 7-day heartbeat soft/hard) | **DEFERRED to Wave B8.** Cannot tune thresholds before we have a working MCS skeleton to observe. Q3 reopens at B8.1 design. | B8.1 |
| **Q4** | First MCS run participation model (live vs dry-pass) | **DEFERRED to Wave B8.** Same reason as Q3 — premature optimization without skeleton. Q4 reopens at B8.5. | B8.5 |
| **Q5** | `/graph` route nav model | **DEFERRED until Track A acceptance.** Falls out of Q2 — if the viewer is standalone, nav becomes a property of that repo, not jarvis-os. Reopens after the Track A acceptance gate passes. | A5.5 |

---

## Track A acceptance gate (load-bearing)

**Inserted 2026-06-06 between W0 and A1.** Graphify integration earns
its build/maintenance cost only if it can answer a query about
`jarvis-prime` code paths that `grep -r` cannot.

### Gate test (run BEFORE A1 fires)

| Step | What | Pass criterion |
|------|------|----------------|
| 1 | Pick 3 questions where the answer requires multi-hop reasoning across files (e.g. "which skills upsert project_state, and which of those go through `/note` vs the dev-phase hook?") | 3 questions written down |
| 2 | Time-box: try answering each with `grep -r` / `rg` only | <10 min total |
| 3 | After A2 produces graph.json, query the graph for the same 3 answers | <2 min each |
| 4 | Compare: did the graph surface anything grep missed, OR cut time by ≥3×? | YES on at least 2 of 3 |

**On gate failure:** Track A stops at A2. No A3/A4/A5. Track B continues alone.
**On gate pass:** proceed to A3 (MCP sidecar) per existing plan.

This goes into the wave plan as **W0.5** (gate-test design) so the
questions are written before A2 runs, not retrofitted after.

---

## Risk Register (additions from SPEC)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| conversation-history.jsonl auto-trim violates precedence rule | **High** | Q1 resolution before B7 starts; B7.2 regression test catches future regression |
| Schema variance in Claude Code auto-memory (flat vs nested `type`) | Low | B1.4 normalization plan + B3 migration handles both shapes |
| Frank toolchain install fails (network, uv install hiccup) | Low | A1 has a 4-step diagnostic order; failure stops Wave A, doesn't block Track B |
| Migration produces unexpected duplicates | Medium | B3.2 idempotency + B3.3 conflict review file before commit-mode |
| jarvis-os has no SPA — `/graph` viewer is greenfield frontend work | Medium | Q2 decision sizes the work; Vite Cytoscape app is ~1 day if scoped tight |
| First MCS surfaces too many conflicts for one session | Medium | Q3 trigger threshold; B8.1 skeleton caps surface size per session |

---

## Acceptance Mapping (SPEC → Waves)

| SPEC criterion | Satisfied by |
|----------------|--------------|
| A1 — graphify produces graph.json + GRAPH_REPORT.md on Frank | A2 |
| A2 — GRAPH_REPORT identifies god-nodes and community clusters | A2.3 |
| A3 — MCP sidecar serves a query from Claude Code | A3 |
| A4 — `GET /api/graph/jarvis-prime` returns valid JSON | A4 |
| A5 — `/graph` route renders, zoom/pan works | A5 |
| A6 — No PHI in any graphify run | A2.1 exclude list + A2.2 allowlist check |
| B1 — Audit lists all atoms across six stores | B1 |
| B2 — Canonical atom schema with provenance | B2 |
| B3 — Migration script runs without data loss; conflicts surfaced first | B3 |
| B4 — `/note` search returns provenance | B4 |
| B5 — `/note` write rejects PHI | B5 |
| B6 — `GET /api/memory/atoms` returns filterable list | B6 |
| B7 — Precedence rule demonstrably enforced | B7 |
| B8 — MCS skeleton generated automatically | B8.1 |
| B9 — Conflict table covers all six stores | B8 (output schema) |
| B10 — Write-back commits with mcs-confirmed source | B8.3 |
| B11 — MCS archive not indexed into atom store | B8 (deliberate omission) |
| B12 — MEMORY.md regenerated from atoms post-MCS | B8.4 |

---

## Estimated Effort

| Track | Waves | Time (focused work) |
|-------|-------|---------------------|
| Track A | A1–A5 | 2-3 sessions (A1+A2 in one; A3 + A4 in one; A5 if Q2 is "static drop-in") |
| Track B | B1–B8 | 4-6 sessions (B1+B2 in one; B3 alone; B4+B5 in one; B6+B7 in one; B8.1 + first MCS in one) |
| Parallelization | A1+B1 concurrent | -1 session |

Phase 1 PLAN does not commit to Phase 2 execution; numbers are sizing guidance.

---

**Phase 1 plan ready for approval. Tripp signs off → STATE.md flips to Phase 2 — Execute.**
