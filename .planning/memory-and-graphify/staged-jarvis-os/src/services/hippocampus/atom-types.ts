// Canonical atom type model for the memory-and-graphify Index layer.
//
// Ratifies the live `project_state` shape (see ./project-state.ts) and extends
// the `type` enum to the nine atom types defined in
// jarvis-prime/.planning/memory-and-graphify/SCHEMA.md (B2.1).
//
// Scope: this is the in-memory MODEL only. It is independent of D1 (whether the
// vault `notes` SQL CHECK is widened to accept all nine types) — the union here
// describes atoms regardless of which physical store backs them. project_state
// atoms live in ProjectStateStore (file-per-project); the other eight types are
// slug-keyed and belong in the vault `notes` store (see ARCH-B2.3 note).

import type { ProjectStateAtom } from './project-state';

/** SCHEMA.md §3 — the nine canonical atom types. */
export type AtomType =
  | 'project_state'
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'session-summary'
  | 'mcs-confirmed'
  | 'static-doc'
  | 'historical';

/** SCHEMA.md §4 — observed provenance sources (project_state's narrower
 *  ProjectStateSource is a subset of this; kept loose for the other types). */
export type AtomSource =
  | 'human-direct'
  | 'human-note'
  | 'state-md-poller'
  | 'dev-phase-hook'
  | 'daily-improvement-loop'
  | 'auto-memory'
  | 'session-summary'
  | 'mcs-confirmed'
  | 'hippocampus'
  | 'static-doc'
  | 'prose-narrative';

/** SCHEMA.md §5 — confidence drives precedence tie-breaks (B7 resolver). */
export type AtomConfidence = 'high' | 'medium' | 'low' | 'historical';

export type AtomVisibility = 'mesh' | 'local' | 'private';

/**
 * Provenance + governance fields carried by EVERY atom. Mirrors the live
 * project_state frontmatter, plus the three SPEC-required additions
 * (`name`, `description`, `confidence`) and the MCS write-back field.
 */
export interface AtomProvenance {
  name: string;
  description: string;
  source: AtomSource | string;
  source_path: string;
  owner: string;
  updated_at: string; // ISO-8601 UTC — last-writer-wins key
  confidence: AtomConfidence;
  visibility: AtomVisibility;
  phi: boolean;
  /** Set only when source === 'mcs-confirmed'; null otherwise. */
  mcs_date?: string | null;
}

/**
 * A free-form (non-project_state) atom: identity + provenance + markdown body.
 * Identity is the `slug` (kebab-case), matching the vault `notes` PK.
 */
export interface BodyAtom extends AtomProvenance {
  type: Exclude<AtomType, 'project_state'>;
  slug: string;
  body: string;
  tags?: string[];
  links?: string[];
}

/**
 * project_state atoms keep their existing structured shape (./project-state.ts).
 * They are intersected with the three new identity/confidence fields so the
 * union is uniform at the read site (the precedence resolver reads `confidence`
 * and `name` on any atom). These three are OPTIONAL here so existing
 * ProjectStateAtom producers (parseStateMd, parseStoredAtom) stay valid without
 * modification; B3 migration backfills them.
 */
export type ProjectStateAtomExt = ProjectStateAtom & {
  name?: string;
  description?: string;
  confidence?: AtomConfidence;
};

/** The canonical discriminated union, keyed on `type`. */
export type Atom = ProjectStateAtomExt | BodyAtom;

// ---- Type guards ------------------------------------------------------------

export function isProjectStateAtom(a: Atom): a is ProjectStateAtomExt {
  return a.type === 'project_state';
}

export function isBodyAtom(a: Atom): a is BodyAtom {
  return a.type !== 'project_state';
}

/** The four types the vault `notes` CHECK accepts today (D1 = widen this). */
const VAULT_NATIVE_TYPES = new Set<AtomType>(['user', 'feedback', 'project', 'reference']);

/**
 * True if `type` already fits the vault's current CHECK constraint. Used by the
 * migration/write path to decide whether a vault write needs D1 (widened enum)
 * or can proceed against the unmodified schema.
 */
export function fitsVaultEnum(type: AtomType): boolean {
  return VAULT_NATIVE_TYPES.has(type);
}

// ---- Confidence derivation (SCHEMA.md §5; applied by B3 migration) ----------

const SEVEN_DAYS_MS = 7 * 86_400_000;

/**
 * Derive confidence from source + age. `now` is injected for testability
 * (no Date.now() in the pure path).
 */
export function deriveConfidence(
  source: AtomSource | string,
  updatedAt: string,
  now: Date,
): AtomConfidence {
  if (source === 'mcs-confirmed') return 'high';
  if (source === 'prose-narrative') return 'historical';

  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 'low'; // SPEC §135 — missing/unparseable ts ⇒ low
  const ageMs = now.getTime() - t;
  const fresh = ageMs <= SEVEN_DAYS_MS;

  if ((source === 'human-direct' || source === 'human-note') && fresh) return 'high';
  if (fresh) return 'medium';
  return 'low';
}
