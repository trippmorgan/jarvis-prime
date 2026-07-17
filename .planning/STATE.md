---
type: project_state
project: jarvis-prime
status: "in-progress"
priority: 1
summary: "Prime is active after legacy-orchestrator disablement, corpus hardening, and Telegram media intake repair."
next_action: "Refresh architecture around the Prime/Argus single-brain direction and stabilize the Athena write ledger."
source: human-note
source_path: jarvis-prime/.planning/STATE.md
owner: prime
updated_at: "2026-07-14T01:37:41Z"
visibility: mesh
phi: false
---

# Jarvis Prime State

## Current

v1.0.0 was tagged on 2026-04-21 (Waves 1-8 — router + tools-on default
live; W7 PHI sandbox preserved). Since then a steady stream of in-flight
patches has landed against `master`:

- **AVSO v1** (Athena Voice Scribe Overlay, 2026-05-16) — Telegram →
  Prime → Athena navigation shipped (jarvis-prime `6869935`); read-only,
  no-write-by-construction; classify + plan + tier routing.
- **Athena v2** — write-ledger groundwork, PHI gate tests, tier-policy
  coverage, kernel-janitor spec.
- **Dual-brain reliability** — mode-to-disk persistence + bumped
  timeouts to prevent silent fallback.
- **MCP plumbing** — local registration of `athena-shadow`,
  `browser-bridge`, `chrome-cdp` MCP servers.
- **Telegram resilience** — markdown-parse fallback in
  `sendMessageAndGetId`; slash command unicode-dash normalization.
- **Portfolio surface integration** — `/projects` skill renders the
  canonical envelope; `/note` skill enables T1 WRITE upserts from
  Telegram tagged `source=human-note`.

## Next Action

Wave 9 design decisions are locked (mandatory voice-pass on every worker
output; anonymized peer-review for Tier-2 deep review; skill-scope
ceiling = 10; control plane on day one — W10 folds into W9). Execution
is gated on **corpus-callosum W8.9 A/B baseline measurement** (1 week of
production traffic with `LANGFUSE_ENABLED` on).

Meanwhile, stabilize Athena v2 write-ledger and finish the kernel-janitor
spec → implementation handoff.

## Blockers

- corpus-callosum W8.9 baseline (cross-project dependency).

## Notes

This atom is updated by `/note jarvis-prime` (T3.3 path). For automation,
add `coordination` to SuperServer's `NODE_CAPABILITIES` to arm the T3.2
state-md-poller, which will refresh this row every 5 minutes.
