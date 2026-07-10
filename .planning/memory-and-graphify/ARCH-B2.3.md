# B2.3 — Does `ProjectStateStore.upsert` generalize? (architecture note)

**Date:** 2026-06-07
**Verdict:** **No — fork a sibling store.** project_state atoms stay in `ProjectStateStore`; the other eight atom types route to the slug-keyed vault `notes` store.

## Why ProjectStateStore does not generalize

`src/services/hippocampus/project-state-store.ts` is structurally bound to `project_state`:

| Coupling | Where | Generalizes? |
|----------|-------|--------------|
| Identity = `project` slug → `{project}.md` | `pathFor()` :145 | ❌ body atoms have no `project`; they key by `name`/`slug` |
| `assertUpsertable` is project_state-specific (`project`, `source_path`, `phi:false`) | `upsert()` :54 | ❌ body atoms have no `project` field |
| `serializeAtom` hardcodes the project_state field list | :167 | ❌ wrong field set for `feedback`/`reference`/… |
| `parseStoredAtom` rejects `type !== 'project_state'` | :206 | ❌ explicitly refuses other types |
| Last-writer-wins by `updated_at` + atomic tmp-rename write | :70, :152 | ✅ **this discipline is reusable** |
| `listActive` freshness sort | :119 | ⚠️ project_state-shaped rows only |

So the *write discipline* (last-writer-wins, atomic write) is worth factoring out, but the *identity scheme and serializer* are project_state-only.

## Recommended shape

```
                 ┌─────────────────────────────┐
   project_state │ ProjectStateStore (existing) │  file-per-project, structured
   atoms ───────▶│  .data/project-state/*.md    │  (unchanged)
                 └─────────────────────────────┘
                 ┌─────────────────────────────┐
   8 body-atom   │ vault notes store (existing) │  slug-keyed, FTS + embeddings
   types ───────▶│  sqlite-index.ts + *.md      │  + backlinks (currently EMPTY)
                 └─────────────────────────────┘
        both share ▶ last-writer-wins-by-updated_at + atomic write (factor to a mixin/util)
```

- **project_state** → no change. It already works and is the canonical live store.
- **user / feedback / project / reference / session-summary / mcs-confirmed / static-doc / historical** → the vault `notes` store. It is already slug-keyed (`NoteRecord.slug`), already has FTS5 + embeddings + a `backlinks` table, and is **empty** — it is the natural home and needs only population.

## This resolves D1

The eight body-atom types landing in the vault is exactly why **D1 should be "widen the CHECK enum"** (SCHEMA.md §7): four of the eight (`user/feedback/project/reference`) already fit; the other four (`session-summary/mcs-confirmed/static-doc/historical`) need the CHECK widened or they can't be written. `fitsVaultEnum()` in `atom-types.ts` is the gate that tells the migration which atoms need D1 first.

**If Tripp picks D1=(b) keep-narrow:** then `session-summary/mcs-confirmed/static-doc/historical` cannot live in the vault; they'd need a third file-store (a generic `AtomStore` sibling). That's strictly more code and a second index to query — hence the lean toward (a).

## What B2.2 delivered (done)
- `src/services/hippocampus/atom-types.ts` — discriminated union `Atom = ProjectStateAtomExt | BodyAtom`, the nine-type/`source`/`confidence` enums, `fitsVaultEnum()`, `deriveConfidence()`. Reuses existing `ProjectStateAtom` (no edits to it).
- `atom-types.test.ts` — 9 tests (guards, vault-enum gate, confidence derivation). Full project `tsc --noEmit` exit 0.

## What B3 will do with this
1. Read each store → build `Atom`s.
2. `deriveConfidence()` per atom.
3. project_state → `ProjectStateStore.upsert` (idempotent, already correct).
4. body atoms → vault notes store; `fitsVaultEnum()` decides whether D1 is a prerequisite.
5. Conflict report **before** commit-mode (B3.3) for Tripp's review.
