import { describe, expect, it } from 'vitest';
import {
  deriveConfidence,
  fitsVaultEnum,
  isBodyAtom,
  isProjectStateAtom,
  type Atom,
  type BodyAtom,
} from './atom-types';
import type { ProjectStateAtom } from './project-state';

const NOW = new Date('2026-06-07T00:00:00Z');

const psAtom: ProjectStateAtom = {
  type: 'project_state',
  project: 'jarvis-prime',
  status: 'in-progress',
  priority: 1,
  summary: 's',
  next_action: null,
  source: 'state-md-poller',
  source_path: 'jarvis-prime/.planning/STATE.md',
  owner: 'prime',
  updated_at: '2026-06-06T00:00:00Z',
  visibility: 'mesh',
  phi: false,
};

const bodyAtom: BodyAtom = {
  type: 'feedback',
  slug: 'dev-then-harden',
  body: 'full toolset in dev, harden after',
  name: 'Dev-then-harden',
  description: 'risky integrations sequencing',
  source: 'auto-memory',
  source_path: '~/.claude/.../feedback_dev_then_harden.md',
  owner: 'prime',
  updated_at: '2026-06-05T00:00:00Z',
  confidence: 'medium',
  visibility: 'mesh',
  phi: false,
};

describe('atom-types guards', () => {
  it('discriminates project_state from body atoms', () => {
    const atoms: Atom[] = [psAtom, bodyAtom];
    expect(atoms.filter(isProjectStateAtom)).toHaveLength(1);
    expect(atoms.filter(isBodyAtom)).toHaveLength(1);
    expect(isProjectStateAtom(psAtom)).toBe(true);
    expect(isBodyAtom(bodyAtom)).toBe(true);
  });
});

describe('fitsVaultEnum (D1 gate)', () => {
  it('accepts the four native vault types', () => {
    for (const t of ['user', 'feedback', 'project', 'reference'] as const) {
      expect(fitsVaultEnum(t)).toBe(true);
    }
  });
  it('rejects the five extended types until D1 widens the CHECK', () => {
    for (const t of ['project_state', 'session-summary', 'mcs-confirmed', 'static-doc', 'historical'] as const) {
      expect(fitsVaultEnum(t)).toBe(false);
    }
  });
});

describe('deriveConfidence (SCHEMA.md §5)', () => {
  it('mcs-confirmed is always high regardless of age', () => {
    expect(deriveConfidence('mcs-confirmed', '2020-01-01T00:00:00Z', NOW)).toBe('high');
  });
  it('prose-narrative (MEMORY.md import) is historical', () => {
    expect(deriveConfidence('prose-narrative', '2026-06-06T00:00:00Z', NOW)).toBe('historical');
  });
  it('fresh human input is high', () => {
    expect(deriveConfidence('human-note', '2026-06-05T00:00:00Z', NOW)).toBe('high');
  });
  it('fresh non-human input is medium', () => {
    expect(deriveConfidence('state-md-poller', '2026-06-05T00:00:00Z', NOW)).toBe('medium');
  });
  it('stale input is low', () => {
    expect(deriveConfidence('human-note', '2026-05-01T00:00:00Z', NOW)).toBe('low');
  });
  it('missing/unparseable updated_at is low (SPEC §135)', () => {
    expect(deriveConfidence('auto-memory', 'not-a-date', NOW)).toBe('low');
  });
});
