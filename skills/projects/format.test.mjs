/**
 * Gap 1 — Telegram formatter coverage.
 *
 * Each assertion guards one way the renderer could quietly launder doubt.
 * Mirrors the SPEC invariants the service emits; this is the surface gate.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatPortfolioForTelegram, formatWarningsForTelegram } from './format.mjs';

const baseRow = {
  project: 'portfolio-surface',
  status: 'in-progress',
  priority: 1,
  summary: 'Phase 2 EXECUTE — W5 closing',
  next_action: 'Close W5 gate',
  source: 'dev-phase-hook',
  source_path: 'jarvis-os/.planning/portfolio-surface/STATE.md',
  owner: 'prime',
  updated_at: '2026-05-28T18:15:00Z',
  freshness: 'fresh',
};

describe('formatPortfolioForTelegram — honest-doubt invariants', () => {
  it('renders "Needs state review" verbatim — summary is never re-derived', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, summary: 'Needs state review' }],
      degraded: false,
    });
    assert.ok(out.includes('Needs state review'));
  });

  it('marks stale rows with the ⚠ glyph — staleness is never hidden', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, freshness: 'stale' }],
      degraded: false,
    });
    assert.match(out, /stale ⚠/);
  });

  it('omits the ⚠ glyph on fresh rows — the marker is signal, not decoration', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, freshness: 'fresh' }],
      degraded: false,
    });
    assert.ok(!out.includes('⚠'));
  });

  it('omits the ⚠ glyph on aging rows — only stale carries the warning', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, freshness: 'aging' }],
      degraded: false,
    });
    assert.ok(!out.includes('⚠'));
    assert.ok(out.includes('aging'));
  });

  it('emits the provenance line verbatim — every row cites its source_path', () => {
    const sourcePath = 'PretoriaFields/.planning/wave-7/STATE.md';
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, source_path: sourcePath }],
      degraded: false,
    });
    assert.ok(out.includes(`src: ${sourcePath}`));
  });

  it('renders the degraded message byte-identical to service emit', () => {
    const message = 'Portfolio service unreachable — last good read 12m ago.';
    const out = formatPortfolioForTelegram({
      rows: [],
      degraded: true,
      message,
    });
    assert.ok(out.includes(`⚠ ${message}`));
  });

  it('degraded + empty rows still surfaces the degraded warning, not a cheerful empty state', () => {
    const out = formatPortfolioForTelegram({
      rows: [],
      degraded: true,
      message: 'store down',
    });
    assert.ok(out.includes('DEGRADED'));
    assert.ok(out.includes('⚠ store down'));
    assert.doesNotMatch(out, /0 active project/);
  });

  it('non-degraded + empty rows reports zero, not a fabricated row', () => {
    const out = formatPortfolioForTelegram({
      rows: [],
      degraded: false,
    });
    assert.ok(out.includes('0 active projects'));
    assert.ok(!out.includes('⚠'));
    assert.ok(!out.includes('DEGRADED'));
  });

  it('preserves service row order — no re-sort, no re-derive', () => {
    const rows = [
      { ...baseRow, project: 'b-project', priority: 2 },
      { ...baseRow, project: 'a-project', priority: 1 },
      { ...baseRow, project: 'c-project', priority: 3 },
    ];
    const out = formatPortfolioForTelegram({ rows, degraded: false });
    const idxB = out.indexOf('b-project');
    const idxA = out.indexOf('a-project');
    const idxC = out.indexOf('c-project');
    assert.ok(idxB > -1);
    assert.ok(idxA > idxB);
    assert.ok(idxC > idxA);
  });

  it('skips the next_action line when empty — no bare arrow', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow, next_action: '' }],
      degraded: false,
    });
    assert.doesNotMatch(out, /^\s*→\s*$/m);
    assert.ok(!out.includes('→ \n'));
  });

  // ─── Phase 4-B — warnings footer drill-down ────────────────────────────

  it('appends a warnings footer with count when warnings ride along the envelope', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow }],
      degraded: false,
      warnings: [
        { source: 'poller', kind: 'ssh_cat_failure', detail: 'x', at: '2026-05-28T18:00:00Z' },
        { source: 'poller', kind: 'missing_frontmatter', detail: 'y', at: '2026-05-28T18:00:00Z' },
        { source: 'poller', kind: 'missing_frontmatter', detail: 'z', at: '2026-05-28T18:00:00Z' },
      ],
    });
    assert.match(out, /⚠ 3 warnings \(see \/projects warnings\)/);
  });

  it('warnings footer uses singular noun for exactly one warning', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow }],
      degraded: false,
      warnings: [
        { source: 'poller', kind: 'ssh_cat_failure', detail: 'x', at: '2026-05-28T18:00:00Z' },
      ],
    });
    assert.match(out, /⚠ 1 warning \(see \/projects warnings\)/);
  });

  it('empty warnings array does not emit a footer — silence is signal', () => {
    const out = formatPortfolioForTelegram({
      rows: [{ ...baseRow }],
      degraded: false,
      warnings: [],
    });
    assert.doesNotMatch(out, /see \/projects warnings/);
  });
});

describe('formatWarningsForTelegram — drill-down subcommand', () => {
  it('groups by source then kind so 19 identical warnings do not scroll off screen', () => {
    const out = formatWarningsForTelegram({
      warnings: [
        { source: 'poller', kind: 'missing_frontmatter', slug: 'a', detail: 'a: missing YAML frontmatter', at: '2026-05-28T18:00:00Z' },
        { source: 'poller', kind: 'missing_frontmatter', slug: 'b', detail: 'b: missing YAML frontmatter', at: '2026-05-28T18:00:00Z' },
        { source: 'poller', kind: 'ssh_cat_failure', slug: 'c', detail: 'pretoria:/tmp/x (Connection refused)', at: '2026-05-28T18:00:00Z' },
      ],
    });
    assert.match(out, /^\[T0 READ\] \/projects warnings — 3 total$/m);
    assert.match(out, /^\[poller\]$/m);
    assert.match(out, /missing_frontmatter × 2/);
    assert.match(out, /ssh_cat_failure × 1/);
  });

  it('empty envelope prints 0 total, not a fabricated warning', () => {
    const out = formatWarningsForTelegram({ warnings: [] });
    assert.ok(out.includes('0 warnings'));
  });
});
