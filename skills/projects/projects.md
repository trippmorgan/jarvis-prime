---
name: projects
description: List Tripp's active projects from the canonical jarvis-os portfolio-surface service. Render-only adapter — same rows as the Jarvis OS UI.
command: /projects
tier: T0
mutates: false
---

# /projects — Active portfolio [T0 READ]

Returns Tripp's currently-tracked projects from the canonical
`PortfolioSurfaceService` (jarvis-os). Render-only: this skill does **no
SQL**, **no parsing**, and **no re-derivation**. The service is the contract;
the skill only styles. Same rows as the Jarvis OS `/projects` UI by design
(SPEC Trust Contract invariant #5).

Per the SPEC Trust Contract:
- **#2** Stale rows are rendered with a ⚠ marker, never hidden.
- **#4** Every row cites `source_path` (provenance — Tripp can verify).
- **#5** Telegram and OS UI MUST agree; divergence is a bug.

## How Claude should invoke this

Run the bash entry and post stdout verbatim to Telegram. Do not edit the
`[T0 READ]` tag, the row order, or the `⚠` markers.

```bash
bash /home/tripp/.openclaw/workspace/jarvis-prime/skills/projects/projects.sh
```

## Safety

- **Tier:** T0 (read-only). No SQL, no mutations, no confirmation gate.
- **PHI:** the service strips `project: scalpel` upstream — this skill
  cannot leak clinical project state.
- **Degraded handling:** if the service is unreachable or the query
  throws, the skill prints a `[T0 READ] /projects — DEGRADED` warning
  and exits non-zero. It does **not** fall back to assistant recall
  (Trust Contract invariant #3).

## Env vars

- `JARVIS_OS_ROOT` — jarvis-os repo path (default `/home/tripp/.openclaw/workspace/jarvis-os`).
- `HIPPOCAMPUS_ROOT` — project_state store root (default `<JARVIS_OS_ROOT>/.data/project-state`).
