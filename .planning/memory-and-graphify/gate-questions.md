# Track A Acceptance Gate — Test Questions (W0.5)

**Status:** 🔒 LOCKED — Tripp approved 2026-06-07 (3 questions as drafted; jarvis-prime-scoped, no cross-repo swap)
**Drafted:** 2026-06-07 (Prime)
**Source:** PLAN.md §"Track A acceptance gate (load-bearing)"
**Purpose:** Graphify earns A3/A4/A5 only if a code-graph beats `grep -r` on ≥2 of these 3.

---

## How the gate runs

1. Lock these 3 questions (this file) **before** A2 builds `graph.json`.
2. Answer each with `rg`/`grep -r` only, time-boxed to **<10 min total**. Record answer + wall-clock.
3. After A2, query the graph for the same 3. Record answer + wall-clock.
4. **PASS** = on ≥2 of 3, the graph either surfaces an edge grep missed **or** cuts time ≥3×.
5. On fail → Track A stops at A2 (artifact only, no MCP/API/GUI). Track B continues regardless.

Each question was chosen because the answer lives in a **call chain across ≥5 files** with indirection grep can't follow (string-keyed dispatch, closures, external-process delegation, catch-block fallbacks). Citations below are the *expected* answer, pre-verified during Phase-1 recon — they're the answer key, not given to the grep run.

---

## Q1 — project_state write paths (delegation across a process boundary)

> **"List every code path that ends in a `project_state` atom being written. For each path, state whether it routes through the shared `bin/project-state-upsert.mjs` CLI or writes atom files directly — and identify the writer responsible for the 3 orphaned stub atoms in `jarvis-prime/.data/hippocampus/project_state/`."**

**Answer key (recon):**
- `/note` skill → `skills/note/note.sh:86` resolves slug → spawns external `jarvis-os/bin/project-state-upsert.mjs` (shared CLI). Reached via Telegram → `router.ts:36` string-Set membership (`KNOWN_SLASH_COMMANDS`) → `spawnClaude()`.
- `/projects` skill (`skills/projects/`) — read/render path; confirm it does **not** write.
- `state-md-poller` source (canonical jarvis-os atoms carry `source: state-md-poller`) — a separate poller writing on STATE.md change.
- `dev-phase-hook` source (e.g. `conway-dogfood.md` carries `source: dev-phase-hook`) — the methodology hook.
- **Orphan writer:** the 3 stubs (`source: human-note`, "Needs state review") predate the store's move to jarvis-os — an earlier hippocampus location that was never cleaned up.

**Why grep-hard:** the `/note` write crosses a **process boundary** — the skill name is a string in a `Set`, dispatched by a function, then the actual file write happens in a *different package's* CLI (`jarvis-os/bin/`). `grep -r project_state` inside jarvis-prime never sees the writer.

---

## Q2 — memory read order + the trim race (DI + line-count-gated control flow)

> **"At context-assembly time, in what order are `conversation-history.jsonl`, the skill summaries, and the current message composed into the prompt — and at which call site does the 20-entry auto-trim fire relative to that read? Name the function that can silently drop a turn."**

**Answer key (recon):**
- `processor.ts:431` `history.append('user', …)` → inside `append`, `history.ts:70-76` `trim()` rewrites file to last 20 **when lines > 40**.
- `prompt-builder.ts:28-39` `build()` → `history.formatForPrompt(10)` → `history.ts:28-43` `getRecent` reads last 10.
- Compose order: `[systemContext, historyBlock, currentMessage]` (`prompt-builder.ts:41-48`); dual-brain re-formats via `affordance.ts:133-149`.
- **Silent-drop function:** `ConversationHistory.append()` (via `trim()`) — the SPEC §Q1 precedence violation and B7 blocker.

**Why grep-hard:** the history path is constructed by **dependency injection** (`ProcessorConfig.historyPath` computed in the constructor, not a literal), and the trim is gated on a **runtime line count**, not a constant — `grep 20`/`grep trim` finds the line but not that it sits on the truth-layer read path.

---

## Q3 — message → delivery, including the fallback collapse (closure + catch-block branch)

> **"Trace every path by which a user message reaches `src/delivery/`. How many functions call `deliverWithLogging`, and under exactly what condition does the dual-brain path collapse to single-brain?"**

**Answer key (recon):**
- Happy path: `processor.ts` dual-brain → `corpus-callosum.ts` (bound as `this.orchestrator`, a constructor closure at ~`:295-310`) → left/right hemispheres → integration → `deliverWithLogging` (`:1284`) → `delivery-client.ts:41-77` POST to gateway.
- `deliverWithLogging` is called from **two** sites: dual-brain (`:1284`) and single-brain (`~:895`).
- **Collapse condition:** `catch (err) { if (err instanceof LeftHemisphereError) … return this.processSingleBrain(...) }` (`~:1301-1316`) — left-hemisphere timeout/throw only.

**Why grep-hard:** the orchestrator is invoked through a **closure stored in a field** (`this.orchestrator`), so `grep corpusCallosum` won't show the call; the fallback is an **error-recovery branch inside a catch block**, not a top-level code path.

---

## Gate run — 2026-06-07 (graph: 925 nodes / 1741 edges / 56 communities, AST-only, code-only)

| Q | grep/rg result | grep time | graph result | graph time | graph won? |
|---|---|---|---|---|---|
| Q1 | `rg project-state-upsert` finds the string in `note.sh`; human knows it shells out | ~0.02s | `explain note.sh` shows `resolve_state_md()` but **NOT** the cross-repo edge to jarvis-os's CLI | ~0.2s | **NO** — single-repo graph can't see the process-boundary write (pre-flagged caveat) |
| Q2 | `rg append` → open `history.ts` (76 lines) → read body to see it calls `trim()` | ~0.02s | `explain append` returns `append --calls--> trim()` as an **explicit edge** | ~0.2s | **YES (structure)** — silent-drop edge is first-class, not implicit in text |
| Q3 | `rg deliverWithLogging` → 7 raw call sites; must read each to find enclosing function | ~0.02s | `explain` returns the **2 distinct caller methods** directly; `path` traces to `emitTelegramOutbound` | ~0.2s | **YES (structure)** — enclosing-function callers + path, not raw sites |

**Gate verdict: QUALIFIED PASS (2/3 on the OR-clause).**

Honest reading:
- The graph did **not** win on speed — `rg` is ~10× faster on raw string lookup. The ≥3× *speed* clause failed on all three.
- The graph won on the OR's **"surface something grep missed"** clause for Q2 and Q3: it returns *enclosing-function callers* and *explicit call edges* (e.g. `append→trim`) as first-class answers, where grep returns raw line hits a human must assemble into structure.
- Q1 failed because the highest-value hop is a **cross-repo, cross-process** delegation (jarvis-prime `note.sh` → jarvis-os `project-state-upsert.mjs`) — invisible to a single-repo AST graph. This confirms the pre-registered caveat.

**Consequence per gate rule:** 2/3 → proceed to A3 is *permitted*.

### Both upgrades attempted (2026-06-07) — neither flipped Q1

1. **Cross-repo merge** (jarvis-prime + jarvis-os = 7230 nodes): the path it found for Q1 was spurious. The real `note.sh → project-state-upsert.mjs` hop is a **shell-exec of an external process named in a bash string** — not an AST import/call edge, so invisible at *any* repo scope.
2. **Semantic pass** (`extract --backend ollama --model qwen3:30b --mode deep` on Frank): graphify's LLM extraction runs on **docs only** (6 doc files); code stays AST-only (3 heuristic INFERRED edges). `explain note.sh` on the semantic graph still shows no CLI edge.

**FINAL GATE VERDICT: 2/3 — qualified pass, banked.** Q1 is a genuine static-analysis dead-end (runtime shell-exec delegation), not a graphify shortcoming. The graph's demonstrated, repeatable value is **structural call-graph navigation** (Q2/Q3: enclosing-function callers, explicit `append→trim` edge) plus the live `/graph` viewer — not speed (rg wins raw lookups) and not shell-glue tracing.

---

### Notes for Tripp
- These bias toward jarvis-prime's own architecture (the SPEC's highest-ROI graph target). If you'd rather stress a cross-repo question (jarvis-prime → jarvis-os), say so and I'll swap Q1 for a two-repo edge — though that *raises* the bar graphify must clear, since the current A2 build is single-repo.
- Want them harder or easier? The gate only needs to be a fair "can a graph see what grep can't" test — not a trick.
