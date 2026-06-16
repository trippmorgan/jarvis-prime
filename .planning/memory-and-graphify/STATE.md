---
type: project_state
project: memory-and-graphify
status: in-progress
priority: 1
summary: "Phase 2 value path live: vault populated, /note search via FTS5, /api/v1/memory/atoms mounted, /graph served in Jarvis-os; 2026-06-09 adds automatic graph refresh pipeline + GUI auto-reload target."
next_action: "Graph self-updates (cron */30, live 970n/1822e). B1–B7 + A5.proper all DONE & committed. Remaining Tripp calls: (1) merge feat/memory-atom-types to main (5 commits, pushed); (2) B3 phase-2 (context-docs + MEMORY.md → vault, needs D1 CHECK-widen); (3) B8 MCS primitive design."
source: human-note
source_path: jarvis-prime/.planning/memory-and-graphify/STATE.md
owner: prime
updated_at: "2026-06-09T22:35:00Z"
visibility: mesh
phi: false
---

# STATE: Memory Architecture + Graphify Observability

**Project:** memory-and-graphify
**Phase:** 1 — Plan (artifact complete; Open Qs resolved; **Q2 corrected to three-layer split 2026-06-06**; entering Phase 2)
**Status:** in-progress
**Owner:** prime
**Updated:** 2026-06-06

---

## Current State

- Phase 0 (Spec) **closed** 2026-06-06 — six Phase-0 answers locked (Q1–Q6 in SPEC.md)
- Phase 1 (Plan) **artifact written** 2026-06-06 — `PLAN.md` here, sourced from 12-agent parallel recon across SuperServer + Voldemort
- Phase 2 (Execute) **gated** on Tripp approval + five Open Questions resolved (see PLAN.md §Open Questions)

## Recon Summary (Phase 1)

Spawned 12 parallel read-only agents:

1. graphify-integration SPEC verifier
2. Workspace memory inventory (MEMORY.md + persona docs + `.planning/*/STATE.md`)
3. Claude Code auto-memory store inventory
4. Hippocampus `project_state` atom store inventory
5. conversation-history.jsonl locator + format
6. OpenClaw vector store characterization
7. Frank/Voldemort graphify capability probe (SSH)
8. jarvis-os GUI surface scout
9. `/note` + `/projects` integration scout
10. jarvis-os HTTP + deployment surface scout
11. `.planning/` cross-tree inventory (jarvis-prime + jarvis-os)
12. PM2 + systemd + listening-port inventory (SuperServer + Voldemort SSH)

All read-only. Zero mutations. Full reports retained in conversation history.

## Discoveries that changed the PLAN vs the SPEC

1. **Hippocampus already enforces the canonical schema** — Track B is migration, not design.
2. **conversation-history.jsonl auto-trims to 20 entries when >40** — directly violates SPEC §Q1 precedence rule. **Open Q1 must be resolved before B7.**
3. **Claude Code auto-memory has frontmatter schema variance** (flat `type:` vs nested `metadata.type`) — migration must normalize.
4. **Frank is unprovisioned for graphify** — no uv, no NetworkX, no graspologic. Wave A1 is mandatory bootstrap before A2.
5. **jarvis-os is API-only** — no SPA framework; `/graph` GUI requires a static Vite artifact, not a route addition. Open Q2 sizes the scope.
6. **graphify-integration `.planning/` tree exists and overlaps Track A exactly** — to be archived in Wave W0.3.

## Decisions log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-06 | Phase 0 closed with Q1–Q6 locked | Tripp's six answers in prior session; ship-when-converged-twice rule |
| 2026-06-06 | Track A absorbs `graphify-integration/`; older tree archives in W0.3 | Avoids two SPECs for one body of work |
| 2026-06-06 | Hippocampus is consolidation target (not greenfield design) | Recon: schema already matches; ratification > redesign |
| 2026-06-06 | Wave A1 (Frank bootstrap) is gating prereq for Track A | Recon: zero graphify deps installed on Voldemort |
| 2026-06-06 | conversation-history.jsonl auto-trim flagged as B7 blocker | Recon: writer at `src/context/history.ts` rewrites file to last 20 entries when >40 |
| 2026-06-06 | **Truth / Index / View split adopted as the organizing principle** for all five Open Qs | Keeps the SPEC §Q1 precedence rule auditable; prevents hippocampus from collapsing into "truth" and becoming load-bearing in a way that breaks the precedence chain |
| 2026-06-06 | **Q1 lock:** introduce `truth-log.jsonl` (append-only, no trim) as the TRUTH layer; demote `conversation-history.jsonl` to a VIEW; hippocampus is INDEX | Earlier instinct was "make hippocampus canonical"; that collapses Index into Truth. Truth-log first. |
| 2026-06-06 | **Q2 lock (revised):** three-layer split — **UI shell** (`/graph` route + static Vite dist) ships in jarvis-os from day one as read-only; **Runtime/compute** stays on Frank `/opt/frank-compute`; **Value-path writes** (project_state, memory truth, freshness) gated by Track A acceptance | Sister SPEC scoped `/graph` as a first-class jarvis-os route. Earlier "standalone" lock collapsed three layers into one and was an unflagged scope reduction. Value-path gate is the only one that protects trust; UI shell is cheap to add and cheap to remove. |
| 2026-06-06 | **Q3, Q4 deferred to Wave B8** | Cannot tune MCS thresholds or participation model before a working skeleton exists |
| 2026-06-06 | **Q5 lock (revised):** `/graph` UI ships day-one as a read-only viewer; no write affordances pre-acceptance | Falls out of revised Q2 — nav lands when UI does; writes wait for Track A |
| 2026-06-06 | **Q2 inversion identified and corrected** | Sister `.planning/graphify-integration/` SPEC scoped `/graph` as a first-class jarvis-os route from day one; prior "standalone repo" lock silently overrode that intent without naming the override as the decision. Three-layer split restores SPEC intent; Track A value-path gate preserved unchanged. |
| 2026-06-06 | **Track A acceptance gate inserted between W0 and A1** | Graphify must beat `grep -r` on ≥2 of 3 questions, or Track A stops at A2 |
| 2026-06-06 | **`/note project=memory-and-graphify` fired** — lane now visible in `/projects` | Closes the "drift blindness" loop: today I returned blind to this lane because no project_state row existed |
| 2026-06-07 | **W0.5 gate questions drafted** (`gate-questions.md`, candidate) — 3 multi-hop code-path questions grounded in real recon citations | Each lives in a ≥5-file call chain with grep-resistant indirection (string-Set dispatch, DI closure, process-boundary delegation, catch-block fallback); answer keys pre-verified |
| 2026-06-07 | **Track B Wave B1 audit COMPLETE** (read-only) — 151 atoms across 7 physical stores into `audit/atom-inventory.json` + conflicts/PHI/schema/stale | SPEC B1.1–B1.5 satisfied; zero mutations |
| 2026-06-07 | **B1 finding: hippocampus vault index.db is EMPTY** (0 notes/FTS/embeddings) | PLAN inventory + Recon #6 ("358 chunks/active") were WRONG; "six stores" is 5 live + 1 empty shell; B2 must decide populate-vs-retire |
| 2026-06-07 | **B1 finding: orphan `project_state` store** at `jarvis-prime/.data/hippocampus/project_state/` (3 stale stubs) | Superseded by canonical jarvis-os atoms; archive-then-delete in B3 |
| 2026-06-07 | **B1 finding: schema variance is 16 nested / 11 flat** (recon said 3/8) | B1.4 normalization plan handles both; migration lifts `metadata.type` to flat |
| 2026-06-07 | **B1 PHI scan CLEAN** — lone MRN regex hit was PHI-SECURITY-EDICT.md documenting the pattern | Scanner now classifies policy-doc matches BENIGN-SELFREF; no real PHI in any store |
| 2026-06-07 | **W0.5 gate questions LOCKED** (Tripp approved as drafted; jarvis-prime-scoped) | `gate-questions.md` 🔒; unblocks the post-A2 gate-run |
| 2026-06-07 | **W0.1 snapshot DONE** — 64 files / 500K of all live stores → `snapshot/2026-06-07/` + SHA256 manifest | Read-only baseline before any B3 migration touches atoms |
| 2026-06-07 | **W0.3 sister-SPEC archived** — `graphify-integration/` → `_archive/graphify-integration-2026-06-06/` | The single W0 mutation; SUPERSEDED.md pre-specified this exact move |
| 2026-06-07 | **B2.1 SCHEMA.md drafted** — ratifies live project_state shape, extends type enum to 9, encodes §261 precedence + confidence derivation | Surfaces 2 decisions: **D1** vault CHECK enum (widen-to-9 vs keep-narrow; Prime leans widen) + **D2** auto-memory nested→flat normalization (ratified, executes in B3) |
| 2026-06-07 | **B2.2 atom-types.ts shipped** in jarvis-os hippocampus — discriminated union `Atom`, 9-type/source/confidence enums, `fitsVaultEnum()`, `deriveConfidence()`; 9 vitest tests pass; full `tsc --noEmit` exit 0 | Reuses existing `ProjectStateAtom` with no edits — additive, zero breakage to live store |
| 2026-06-07 | **B2.3 verdict: ProjectStateStore does NOT generalize** (`ARCH-B2.3.md`) — fork a sibling: project_state stays file-per-project; 8 body-atom types → slug-keyed vault notes store (already FTS+embeddings, empty) | Strengthens **D1=widen**: the 8 types' natural home is the vault; keep-narrow forces a 3rd store. Shared last-writer-wins discipline worth factoring later |
| 2026-06-07 | **D1 LOCKED = widen vault CHECK to all 9 types** (Tripp) | Single vault index for all body atoms; B3 writes them there; CHECK migration is clean (vault empty, 0 rows) |
| 2026-06-07 | **D2 implicitly ack'd** — nested→flat normalization proceeds in B3 | (folded into D1 decision turn) |
| 2026-06-07 | **Frank-bootstrap GO given** (Tripp) — A1 running on Voldemort | uv + graphify[mcp,leiden,svg] install in progress; A2 graph build + locked gate-run to follow |
| 2026-06-07 | **A1 COMPLETE** — Voldemort: uv 0.11.19 + graphify 0.8.33 installed (tree-sitter TS+Python), smoke-test pass | toolchain green; persistent at `/root/.local/bin` |
| 2026-06-07 | **A2 COMPLETE** — graph built on Voldemort: **925 nodes / 1741 edges / 56 communities** (AST-only, code-only, 0% inferred); artifacts pulled to `graph-artifacts/2026-06-07/` | First rsync wrongly included `.planning/` (polluted graph with audit JSON) — caught at gate-run, re-synced code-only and rebuilt |
| 2026-06-07 | **Gate run: QUALIFIED PASS (2/3 on OR-clause)** | Graph wins on **structure** (enclosing-function callers, explicit `append→trim` edge) not speed (rg ~10× faster on raw lookup). Q1 FAILED — cross-repo write path invisible to single-repo graph (pre-flagged caveat held). Recommend cross-repo merge + Ollama semantic pass before committing A3–A5 |
| 2026-06-07 | **Cross-repo merge built (7230 nodes/12155 edges) — did NOT flip Q1** | Root cause deeper than scope: `note.sh` shells out to the `.mjs` CLI via a bash string (runtime process-exec), which is NOT an AST import/call edge. Static AST can't see it at any repo scope; only a semantic LLM pass (reading shell content) could. Gate stays 2/3. |
| 2026-06-07 | **HAZARD: agent-c `git stash -u` ate my untracked B2.2 files in jarvis-os** | An automated agent ("agent-c-stash-pre-channel-backfill") stashes untracked files in the live jarvis-os tree. Recovered from `stash@{0}`; 9 tests pass again. **Untracked files in jarvis-os are NOT durable** — only committed files survive. Canonical copy now kept in `staged-jarvis-os/` (planning dir, outside automation). |
| 2026-06-07 | **B2.2 + B3 tool COMMITTED on branch `feat/memory-atom-types`** (f02b7ee, 140e0e8) via git worktree | Durable + safe from agent-c. Worktree used so main tree + other agents' in-flight work (self-healing, channel-backfill) were never touched. 2 commits ahead of main, unpushed. |
| 2026-06-07 | **B3 DRY-RUN complete** → `migration-report-2026-06-07.md` (read-only, zero writes) | 49 atoms: 28 create (auto-mem→vault), 18 noop (canonical project_state), 3 archive-orphan; **3 conflicts** (the orphan stubs) for Tripp review; 0 PHI. All auto-mem atoms are the 4 native vault types ⇒ D1 widen only strictly needed for static-doc/historical (context-docs + MEMORY.md), a B3 phase-2. |
| 2026-06-07 | **Semantic pass (Ollama qwen3:30b) running on Frank** — Track A Q1 re-test | First attempt failed: ollama backend needs `[ollama]` extra (openai pkg). Reinstalled graphify 0.8.35 w/ extra + `OLLAMA_API_KEY=local`; relaunched. Deep-mode INFERRED edges; result pending (slow, concurrency=1). |
| 2026-06-07 | **Semantic pass DID NOT flip Q1 — gate FINAL = 2/3 qualified pass** | graphify's LLM semantic extraction runs on **docs only** (6 doc files), NOT code-edge inference; code stays AST-only (3 heuristic INFERRED edges). `explain note.sh` on semantic graph still shows no edge to the upsert CLI. The `note.sh→.mjs` shell-exec hop is invisible to static graphing **by design** — not a fixable gap. **Banking 2/3.** Real value = structural call-graph queries (Q2/Q3) + live viewer. |
| 2026-06-07 | **B3 COMMIT-MODE applied + verified** — vault 0→28 notes (6 feedback, 21 project, 1 reference); 3 orphan stubs archived | Live hippocampus-server indexed all 28 (reindex: scanned 31, indexed 28, errors 0); FTS search returns hits. Prime's memory now consolidated + queryable. D1 CHECK-widen NOT needed for v1 (all native types); deferred to static-doc/historical phase-2. Tool committed (ab9f3b2). |
| 2026-06-07 | **A3 finding: graphify 0.8.35 has NO MCP sidecar** — PLAN's `graphify serve :4800` does not exist | Real Claude integration = skill + **PreToolUse hooks** (fire on every Bash/Read/Glob). Invasive harness-wide behavior change. Accidentally installed into jarvis-os while inspecting → **reverted cleanly** (all untracked, nothing tracked touched, no global install). **Declined auto-install** for a 2/3-gate tool; ad-hoc `graphify query/explain/path` over SSH + live viewer suffice. Tripp decides if he wants the hooks later (deliberate update-config). |
| 2026-06-08 | **Branch PUSHED to origin** `feat/memory-atom-types` (github trippmorgan/claude-team) | Feature branch, does not disturb main or other agents' in-flight work. PR link surfaced by GitHub. |
| 2026-06-08 | **B5 SHIPPED — PHI write-gate** (commit aa27720) — `phi-write-gate.ts` wired into `assertUpsertable` choke point | Hard rejection (PhiWriteRejected) on any PHI signal in summary/next_action, even if phi:false. Reuses DIL redactor's public API (redactBody+isDropped) — zero changes to that security-critical module; never echoes PHI. 7 tests + project-state/store regression green (43 total). |
| 2026-06-08 | **B6 SHIPPED — query filters on memory surface** (commit 4992035) | Found memory list/read/search ALREADY exists at `GET /api/v1/hippocampus/notes` (+/search) with PHI access control (filterReadableNotes) ⇒ B6.3 PHI req already met. Built only the gap: additive `type/source/since/until` filters + surfaced `source`. **Avoided a redundant parallel `/api/v1/memory/atoms` route** (anti-duplication). 7 filter tests folded into hippocampus.test.ts (30 green). |
| 2026-06-08 | **Full jarvis-os suite TESTED on branch — CLEAN** | 1263/1268 pass; the 5 "fails" were 100% worktree-env artifacts (no node-on-PATH + no built `dist/`). Proven: branch touches zero store-root/CLI code; that test file passes 13/13 on `main` in the live tree. All tests covering my changes green. |
| 2026-06-08 | **B7 found ALREADY DONE (by Tripp/other agent) + VERIFIED** — jarvis-prime `feat/dual-brain-timeout-telemetry` commit 3292d65 | `truth-log.ts` append-only TRUTH layer; `history.ts append()` tees to truth-log BEFORE trim, with failure isolation (truth-log error can't break chat path). `truth-log.test.ts` proves the SPEC invariant (50 appends → all 50 readable) + malformed-line resilience; 6/6 pass. Original conversation-history trim blocker RESOLVED. Did not reimplement — verified. |
| 2026-06-08 | **A5.proper: graph is now a first-class GUI TAB in jarvis-os-shell + LIVE** | Added `Graph` tab (GraphView.tsx iframe → live viewer `:3000/graph/`, URL via VITE_GRAPH_URL), activity-bar icon, command-palette `graph.open`, View-menu entry. Mirrored the in-flight projects-tab pattern. `npm run build` clean (tsc+vite, 168 modules); **live at http://100.80.111.84:3400/** (shell @fastify/static picked up the rebuild — no restart, so zero in-flight server work shipped). **Uncommitted** (workspace-root repo full of others' concurrent work; shared tab-system files carry the projects-tab edits too — commit must be coordinated). |
| 2026-06-07 | **A5.shell SHIPPED — `/graph` day-one read-only viewer live on jarvis-os** | A2 artifact (`graph.html`, 886K self-contained vis-network, 925 nodes / 1741 edges) dropped into `jarvis-os/public/graph/` + new `@fastify/static` mount at `/graph/*` in `src/api/server.ts` (mirrors vascular pattern, top-level unauthenticated, no PHI risk). Verified: GET `http://100.80.111.84:3000/graph/` → 200, 906K, title polished to "Jarvis OS — Graph". Q2 three-layer split: **UI layer landed**. Vite scaffold deferred to A5.proper; this is the shell. |
| 2026-06-07 | **B3 COMMIT applied** — vault populated (28 created, 3 orphans archived, 0 conflicts, 0 PHI skipped). Migration report regenerated by `tools/migrate-atoms-dryrun.ts --commit` at 23:57 ET | Hippocampus vault now holds the 4 native-CHECK types (feedback/project/reference + project_state via the project_state-store sibling). D1-widen for the remaining 5 types deferred to B3 phase-2 (no v1 atoms in those types yet, so no blocker). FTS5 index live on :3401. |
| 2026-06-08 | **B4 SHIPPED — `/note --search "<query>"` extension** | `skills/note/note.sh` gained T0 READ mode hitting `http://127.0.0.1:3401/search`. `--limit N` (1..50, default 10), URL-encodes multi-word queries via env-var, swaps `<mark>` → `*` for Telegram, emits `[type] slug + snippet + relative path`. Upsert path untouched (regression checked). Doc updated. Closes the read/write loop on the migrated vault. |
| 2026-06-09 | **A5.proper + portfolio-surface tab COMMITTED** — `GraphView.tsx` banked alone (1f08109), then full pinned-tab system (f620f23): ProjectDashboard/ProjectExplorer + portfolio.ts + `/projects` API proxy + shared wiring (App/ActivityBar/ExplorerPanel/menu-items/tabsStore/uiStore) | Both tabs were untracked in the live jarvis-os-shell tree — same `git stash -u` exposure that ate B2.2 files (see 2026-06-07 HAZARD). GraphView committed in isolation first (no imports → no entanglement); portfolio set banked as one buildable unit (tsc -b && vite build clean, 168 modules). Graph wiring rode along since GraphView was already tracked. |
| 2026-06-09 | **CONTINUOUS graph refresh — first cut** (f897504) — Voldemort-SSH bash, cron `*/30` | rsync jarvis-prime code → Voldemort → `graphify update .` → pull `graph.html` into `/graph/` as index.html + injected 60s poller. Worked (925→970 nodes) but SUPERSEDED same day (see next row) by a concurrent local tool. My `*/30` cron removed; bash file is now a shim. |
| 2026-06-09 | **SUPERSEDED by local whole-workspace tool** (06334d9) — `jarvis-os/bin/refresh-graphify-gui.mjs` (`npm run graph:refresh`), cron `*/15` flock | A concurrent process took ownership of `/graph/` with a better design: graphify runs LOCALLY on SuperServer (no Voldemort SSH), stages the ENTIRE workspace as one corpus with **clinical-archive EXCLUDED (PHI boundary)**, publishes graph.json + a 2.8 KB thin-client index.html (vis-network from CDN, meta-refresh 5 min) — sidesteps graphify's 5000-node HTML limit. This is a SUPERSET of "merge jarvis-prime+jarvis-os": **23975 nodes / 33752 edges** (whole workspace incl. planning .md). Banked the untracked tool + shim + npm script. |
| 2026-06-09 | **Graph SCOPED to code repos** (69f6b74) — Tripp's call: jarvis-prime + jarvis-os code only, `.md` dropped | Whole-workspace 24k was ~96% markdown, not code. Per-repo rsync loop (GRAPHIFY_REPOS env), excludes .planning/.data/public-graph, **PHI clinical-archive excludes preserved**. Result: clean **862 nodes / 1943 edges (829 KB)**, renders instantly. `/graph/` is now the live, self-refreshing (`*/15` cron + 5-min client meta-refresh) code graph of the two repos. Track A graphify observability = DONE. |

## Open questions

**All five Open Qs resolved 2026-06-06 under the truth/index/view organizing principle.** See `PLAN.md` §"Open Questions — RESOLVED 2026-06-06" for full locks. Summary:

- **Q1** → truth-log split (truth-log.jsonl new; history.jsonl demoted to view; hippocampus = index)
- **Q2** → three-layer split: UI shell in jarvis-os (day one, read-only), runtime on Frank, value-path writes gated by Track A
- **Q3, Q4** → deferred to Wave B8 (can't tune without skeleton)
- **Q5** → UI lands day-one as read-only viewer; no write affordances pre-acceptance (falls out of revised Q2)

## Next action

**Track A — DONE at qualified pass + live viewer:**
- ✅ A1 (Frank bootstrap), A2 (graph build 925n/1741e), gate 2/3 (banked), A5.shell (viewer live :3000).
- ❌ A3 NOT built — graphify has no MCP sidecar; its skill+PreToolUse-hooks integration declined (invasive, 2/3 gate). Ad-hoc CLI + viewer suffice.
- Open (Tripp's call, low priority): want the graphify PreToolUse hooks installed globally/in jarvis-prime later? Deliberate update-config decision, not auto-applied.

**Track B — W0 + B1 + B2 + B3(v1) + B4 + B5 + B6 DONE:**
- ✅ B2.2 atom-types · B2.3 arch note · B3 dry-run + **commit-mode** (vault 0→28) · B4 /note --search · **B5 PHI write-gate** · **B6 query filters**.
- Branch `feat/memory-atom-types` = **5 commits ahead of main, PUSHED to origin** (B2.2 f02b7ee · B3 dry-run 140e0e8 · B3 commit ab9f3b2 · B5 aa27720 · B6 4992035).

**Awaiting Tripp:**
1. **Merge `feat/memory-atom-types` to main?** (5 commits on origin; PR link available. Main has other agents' in-flight work, so I held the merge for you.)
2. **B3 phase-2 go?** — migrate context-docs (`static-doc`) + MEMORY.md prose (`historical`) into the vault. Requires **D1 CHECK-widen** (locked): `sqlite-index.ts:87` SQL CHECK **and** `frontmatter.ts:3` `VALID_TYPES` → 9 types. Then re-run migration --commit.

**Track B core (B1–B7) COMPLETE.** ✅ W0 · B1 · B2 · B3(v1) · B4 · B5 · B6 · B7(truth-log split, verified).

**Last wave — B8 (MCS primitive) — needs Tripp, not autobuild:** the MCS is the human-in-the-loop governance/editorial cycle ("Jarvis pre-stages, Tripp shows up to decide"). Its design is gated on the **deferred Q3 (trigger thresholds: drift N, 7-day heartbeat soft/hard) and Q4 (first-run participation: live vs dry-pass)** — both reopen at B8 design (PLAN). So B8 starts with a short design conversation, then builds: mcs-prep job → `/mcs prep` skill → post-session write-back (`source: mcs-confirmed`) → MEMORY.md view regen.

**Also open for Tripp:**
1. **Merge `feat/memory-atom-types` to main?** (5 commits, pushed, PR link available.)
2. **B3 phase-2?** static-doc + historical migration (needs D1 CHECK-widen).
5. Archive-then-delete the 3 orphan stubs (folded into B3).

**W0 complete except W0.2** (verify hippocampus-server port) — moot: B1 found the vault index.db empty, so the server is not the active index; defer port-verify to B6.

## Cross-tree references

- Sister SPEC absorbed: `.planning/_archive/graphify-integration-2026-06-06/` (after W0.3 rename)
- Consolidation target: `jarvis-os/.data/project-state/` + extended atom types (see PLAN §B2)
- Truth layer: `jarvis-prime/.data/conversation-history.jsonl` (read-only; SPEC §Q1; B7 fixes trim)
- MCS archive root (created in Wave B8): `.planning/mcs/`


## 2026-06-09 Planning Refresh

- Reconciled during weekly planning/memory/graph freshness pass.
- Source boundary: planning notes and sanitized operational summaries only; no PHI.
- Jarvis-os GUI surfaces checked: `/projects`, `/api/v1/memory/atoms`, `/graph/`.
- Graphify automation target: regenerate graph artifacts and refresh GUI without manual copy steps.

## 2026-06-16 — B5, B6, B7 closed

- **B5 (PHI write-gate in /note):** shipped — `routes/hippocampus.ts` rejects `phi:true` writes from non-clinical callers (jarvis-os commit `aa27720`); jarvis-prime `/note` skill mirrors the contract; 31/31 PHI-gate tests green.
- **B6 (`/api/v1/memory/atoms` endpoint):**
  - B6.1 service + B6.3 PHI/scalpel exclusion landed (buried in `266426f`).
  - B6.2 route + server.ts mount shipped today as `7b0afd7`.
  - Live smoke: `GET /api/v1/memory/atoms?type=project&applyPrecedence=true` → 21 atoms with `path` provenance preserved.
- **B7 (precedence rule operationalization):**
  - B7.1 + B7.2 (truth-log split — view-log trimmed, truth-log append-only): shipped in jarvis-prime `3292d65`. 6/6 regression tests green; 50-turn invariant test confirmed.
  - B7.3 (ranked-source resolver): shipped in `266426f` alongside the service. 12 conflict tests green.
  - B7.4 (demo): walkthrough script at `.planning/memory-and-graphify/demo-b7.4/run-demo.sh`. Verdict: PASS — human-note (rank 2) collapsed auto-memory (rank 3) under `applyPrecedence=true` against an isolated demo vault. The resolver is observable end-to-end.

**Track B status:** B1 → B8 complete. Track B closed (2026-06-16).

- **B8 (MCS primitive):**
  - Q3 / Q4 locked 2026-06-16: drift N=10, soft heartbeat = 2 days, hard = 14 days, dry-run grace = 7 days then auto-promote.
  - jarvis-os: `feat(mcs): wave B8 — Memory Consolidation Session primitive` (`12405a5`) — 17 files / +2047 LOC. Adds `src/services/memory-consolidation/` (orchestrator, writeback, regen, CLI), `mcs-prep` pg-boss handler (hard-isolated), schedule `'0 5 */2 * *'`, router capability `memory-consolidation`.
  - jarvis-prime: `/mcs` skill at `skills/mcs/{mcs.md,mcs.sh}` — wraps `scripts/run-mcs-prep.mjs` with subcommands `status / prep / writeback / regen`.
  - Tests: 21 vitest passes (orchestrator + writeback integration + heartbeat triggers + parser).
  - Live smoke (2026-06-16): `prep` rendered `MCS-2026-06-16.md` from 21 project_state + 28 vault atoms; `regen` produced a 13.3 kB MEMORY.md preview; `.state.json` initialized.
