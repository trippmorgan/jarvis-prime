# Weekly Planning Refresh — 2026-06-09

Scope: planning notes touched since 2026-06-02 across `jarvis-prime/.planning` and `jarvis-os/.planning`.

## Updated / reconciled

- `memory-and-graphify`: Graph viewer is live in Jarvis-os; memory atoms endpoint is live; remaining gap is continuous refresh rather than static June 7 artifact.
- `argus-mini-migration`: STATE exists and is enrolled into `/projects`; Argus Mini should stay Tailscale-first and key-auth-first.
- `jarvis-os`: Root state refreshed to reflect current GUI/memory/graph observability work while keeping Athena Vision as explicit-authority-gated.
- `hippocampus`: Formal human acceptance still pending, but production read surfaces are already live.
- `portfolio-surface`: `/projects` fixed and verified with memory-and-graphify + argus-mini-migration rows.
- `improvement-loop-v2` / DIL: reports continue through 2026-06-08; Claude/OpenClaw harness path repaired; Codex/model timeout/allowlist remains a repair item.
- `DJ Jarvis / WPFQ`: repair ownership handed back to Pretoria; Prime now performs twice-daily oversight only.

## Graph/GUI freshness goal

- Regenerate graph artifacts on a schedule and on demand.
- Copy artifacts into `jarvis-os/public/graph/` atomically.
- Make `/graph/` auto-refresh so the GUI does not fossilize on old artifacts.
- Keep graph content PHI-safe: planning/source/operational notes only, never clinical archive contents.
