---
name: mcs
description: Memory Consolidation Session (MCS) — drive the every-2-day governance ritual that produces the MCS-YYYY-MM-DD.md skeleton, records decisions, and writes promoted atoms back with source=mcs-confirmed.
command: /mcs
tier: T0-T2
mutates: prep=false, writeback=true
---

# /mcs — Memory Consolidation Session  `[T0/T1/T2]`

Wrapper skill for the MCS primitive (Wave B8). The MCS is the governance
ritual that keeps the memory atom store honest: every 2 days a skeleton
is staged, Tripp marks decisions inline, and the write-back commits
those decisions back to `project_state` (and v1.x: vault) atoms with
`source: mcs-confirmed` + `mcs_date`.

Source of truth:
- `jarvis-prime/.planning/memory-and-graphify/SPEC.md §Track B Primitive (MCS)`
- `jarvis-prime/.planning/memory-and-graphify/PLAN.md §Wave B8`

The wrapper itself is **T0** — it only routes. Each subcommand carries
its own tier and gate:

| Subcommand | Tier | Gate |
|------------|------|------|
| `/mcs status` | T0 READ | none |
| `/mcs prep [--date YYYY-MM-DD] [--force-dry-run]` | T1 GENERATE | dry-run for first 7 days |
| `/mcs writeback --date YYYY-MM-DD [--dry-run]` | T2 STAGE | parses + commits atoms |
| `/mcs regen [--out PATH]` | T1 GENERATE | preview only — never touches live MEMORY.md |

---

## Underlying pipeline

The wrapper sits on top of the canonical runner:

```
/home/tripp/.openclaw/workspace/jarvis-os/scripts/run-mcs-prep.mjs
```

That runner re-execs into `src/services/memory-consolidation/cli.ts`
under `tsconfig.daemon.json`. The skill never re-implements pipeline
logic; subcommand bodies shell out so the runner stays the single
source of truth.

---

## `/mcs status`  `[T0 READ]`

Prints the current MCS state file as pretty-printed JSON. Shows:

- `config` — resolved paths + thresholds (Q3 + Q4 knobs).
- `state` — `first_run_at`, `last_prep_at`, `last_writeback_at`,
  `deferred[]`. `null` until first prep runs.
- `inDryRunWindow` — are we still in the Q4 7-day grace?
- `daysSinceLastPrep` / `daysSinceLastWriteback`.

```bash
node /home/tripp/.openclaw/workspace/jarvis-os/scripts/run-mcs-prep.mjs status
```

---

## `/mcs prep [--date YYYY-MM-DD] [--force-dry-run]`  `[T1 GENERATE]`

Renders today's (or `--date`'s) MCS skeleton. Snapshot + conflicts +
drift signals get composed into `.planning/mcs/MCS-YYYY-MM-DD.md` and
the cross-session state file gets updated.

- `--date YYYY-MM-DD` — backfill / re-run a specific NY day.
- `--force-dry-run` — keeps write-back disabled regardless of the Q4
  grace check. Useful for rehearsing after grace has lapsed.

```bash
node /home/tripp/.openclaw/workspace/jarvis-os/scripts/run-mcs-prep.mjs prep --date 2026-06-16
```

The handler is hard-isolated — a failure never crashes the runner,
never crashes the pg-boss job, and never affects DIL or the morning
briefing.

---

## `/mcs writeback --date YYYY-MM-DD [--dry-run]`  `[T2 STAGE]`

Parses the `## 5. Promoted atoms` YAML block in `MCS-<date>.md` and
commits each entry back to its store with `source: mcs-confirmed` and
`mcs_date: <date>` set. Per-entry failures are isolated — one bad
entry never aborts the batch.

- `--dry-run` — parse + report only; never calls store.upsert.
- v1 scope writes `project_state` atoms; vault keys are parsed and
  reported but DEFERRED to v1.x (the vault update path needs the
  baseHash round-trip and a wider write-gate review).

```bash
node /home/tripp/.openclaw/workspace/jarvis-os/scripts/run-mcs-prep.mjs writeback --date 2026-06-16
```

Also persists the `## 6. Deferred list` items into `.state.json` so
the next prep run carries them forward.

---

## `/mcs regen [--out PATH]`  `[T1 GENERATE]`

Regenerates a structured MEMORY.md narrative view from the
hippocampus stores (project_state + vault). Default output is
`/home/tripp/.openclaw/workspace/MEMORY.md.preview` — the
hand-maintained MEMORY.md is NOT overwritten by this wave.

```bash
node /home/tripp/.openclaw/workspace/jarvis-os/scripts/run-mcs-prep.mjs regen
```

---

## How to invoke

From Telegram:

```
/mcs                                  # → help text
/mcs status
/mcs prep
/mcs prep --date 2026-06-16
/mcs prep --force-dry-run
/mcs writeback --date 2026-06-16
/mcs writeback --date 2026-06-16 --dry-run
/mcs regen
```

Under the hood the skill shells out to `mcs.sh` (same dir). Paste the
script's stdout into Telegram unmodified — the runner already prints
Telegram-friendly summary lines.

---

## Tunables (Q3 / Q4 — locked 2026-06-16)

| Var | Default | Meaning |
|-----|---------|---------|
| `MCS_DRIFT_THRESHOLD` | `10` | N atoms changed since last MCS that forces a session |
| `MCS_HEARTBEAT_SOFT_DAYS` | `2` | Days since last MCS that triggers a soft "still alive?" prep |
| `MCS_HEARTBEAT_HARD_DAYS` | `14` | Days since last MCS that FORCES a prep regardless of drift |
| `MCS_DRY_RUN_GRACE_DAYS` | `7` | Days from `first_run_at` before write-back goes live |
| `HIPPOCAMPUS_ROOT` | `jarvis-prime/.data/hippocampus` | FileVaultStore root |
| `PROJECT_STATE_STORE_ROOT` | `jarvis-os/.data/project-state` | ProjectStateStore root |
| `MCS_ARCHIVE_ROOT` | `jarvis-prime/.planning/mcs` | Where `MCS-*.md` + `.state.json` live |

All env-overridable per-process — the daemon, runner, and skill all
share the same resolution path (`loadMCSConfig()`).
