---
name: note
description: Force a portfolio-surface refresh on a project's STATE.md, tagged source=human-note. The human-override path when automation missed something or you want the row updated NOW.
command: /note
tier: T1
mutates: false
---

# /note — Human-override portfolio upsert  `[T1 WRITE]`

Re-upserts a project's `project_state` atom from its on-disk STATE.md,
tagged `source: human-note`. This is the **direct write path** the SPEC
reserves for the rare case where automation missed a state change and
Tripp wants the `/projects` row refreshed immediately.

The skill only re-reads the existing STATE.md and re-runs the canonical
upsert — it does NOT mutate the STATE.md itself. Edit STATE.md first
if you want the content to change, then `/note <slug>` to push it.

Source of truth: `.planning/portfolio-surface/SPEC.md §Write Paths #3`
and `PLAN.md task T3.3`.

## Tier

T1 WRITE — touches the local Hippocampus store, no external services,
no PHI surface. No typed confirmation, no live-window check; the worst
outcome is a stale row gets refreshed.

## Usage

```
/note <project-slug>
/note <absolute-path-to-STATE.md>
```

Known project slugs (resolve to canonical STATE.md paths):

| Slug | Path |
|------|------|
| `jarvis-prime` | `jarvis-prime/.planning/STATE.md` |
| `jarvis-os` | `jarvis-os/.planning/STATE.md` |
| `hippocampus` | `jarvis-os/.planning/hippocampus/STATE.md` |
| `pretoria-fields` (alias: `station`, `pretoria`) | `PretoriaFields/.planning/STATE.md` |
| `frank-v3` (alias: `frank`) | `frank-v3/.planning/STATE.md` |
| `kitchen-hub` (alias: `kitchen`) | `kitchen-hub/.planning/STATE.md` |
| `portfolio-surface` | `jarvis-os/.planning/portfolio-surface/STATE.md` |

Unknown slug → skill exits 1 with the resolver's known-slugs list.

## How Claude should invoke this

Run the bash entry, pass through the slug argument, and post stdout
verbatim to Telegram.

```bash
bash /home/tripp/.openclaw/workspace/jarvis-prime/skills/note/note.sh <slug>
```

## Output (success)

```
[T1 WRITE] /note jarvis-prime
ok — upserted jarvis-prime (source=human-note)
  store: /home/tripp/.openclaw/workspace/jarvis-os/.data/project-state/jarvis-prime.md
  state: jarvis-prime/.planning/STATE.md
```

## Output (unknown slug)

```
[T1 WRITE] /note xyz
ERROR: unknown project slug 'xyz'.
Known slugs: jarvis-prime, jarvis-os, hippocampus, pretoria-fields (station/pretoria),
             frank-v3 (frank), kitchen-hub (kitchen), portfolio-surface
Or pass an absolute path to a STATE.md.
```

## Output (STATE.md missing frontmatter)

The CLI exits 2 and prints the parser warning — no row is written.
`/note` surfaces the warning unchanged so Tripp can fix the STATE.md.

```
[T1 WRITE] /note jarvis-prime
ERROR: portfolio upsert refused (exit 2)
[WARN] frontmatter missing required field: priority
```
