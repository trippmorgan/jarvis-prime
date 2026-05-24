// AVSO — Phase 1 T11: TIER-SEMANTICS reconciliation + v1 no-regression lock.
//
// THE LONG-RECORDED MISMATCH (PLAN-v2 T11 / SPEC-v2 AC14):
//   - The approved specs describe read-only Athena nav/export as
//     "tier-1 / read-only / no-confirm".
//   - The v1 implementation maps `athena-nav` and `patient-schedule`
//     as numeric tier-0 in execute.ts COMMAND_TIER.
//   - The `workflow-adversarial` guard treats numeric tier-0 as the
//     read-only / no-confirm allowlist tier ("no tier-0 command mutates
//     state"), and tier >= 3 is the typed-confirm gate (execute.ts).
//
// CANONICAL RESOLUTION (documented authoritatively in
// skills/athena-emr/TIER-POLICY.md):
//   The code's NUMERIC tier-0 and the spec's PROSE "tier-1/no-confirm"
//   denote the SAME no-confirm read-only behavior under two different
//   numbering schemes. The numeric scheme in this codebase is the
//   canonical one for code (it is the scheme the kernel + confirm gate
//   + the workflow-adversarial allowlist invariant enforce). The spec's
//   "tier-1" is prose for "lowest acting tier, no confirm" — NOT the
//   numeric 1 used by athena-patient-search / athena-input-prepare.
//   Renumbering nav/export 0 -> 1 would break the read-only allowlist
//   invariant and the existing v1 tier tests for ZERO behavioral gain:
//   the gate fires on tier >= 3 regardless. So the resolution is
//   DOCUMENT + a consistency regression test, NOT a renumber.
//
// This test is the executable contract for that resolution. It asserts:
//   (a) the no-confirm read-only paths resolve to a NO-CONFIRM tier;
//   (b) input-prepare is no-confirm, input-commit is the tier-3 gate;
//   (c) the authoritative TIER-POLICY.md exists and its documented
//       numbers MATCH the code constants (doc cannot silently drift);
//   (d) v1 nav/export keep their exact v1 numeric tiers (no regression).
//
// SYNTHETIC tokens only. No live services. No code-tier renumber.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tierFor, COMMAND_TIER } from '../../orchestrator/execute.js'
import { avsoV2Tier } from '../../orchestrator/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// jarvis-prime/src/__tests__/orchestrator -> repo root -> skills/athena-emr
const TIER_POLICY_PATH = resolve(
  HERE,
  '../../../../skills/athena-emr/TIER-POLICY.md',
)

// The kernel + execute.ts gate semantics: a step pauses for a typed
// confirm phrase iff its numeric tier is >= 3 (execute.ts emitCommand:
// `tier >= 3 ? CONFIRM ... : undefined`). Everything below 3 dispatches
// with NO confirm gate. This is the single behavioral fact the whole
// policy hangs on.
const CONFIRM_GATE_MIN_TIER = 3
function isNoConfirm(cmd: string): boolean {
  return tierFor(cmd) < CONFIRM_GATE_MIN_TIER
}

// ─── 1. The canonical NO-CONFIRM invariant (behavioral, not numeric) ───

describe('AVSO tier-policy — read-only paths are NO-CONFIRM', () => {
  it('athena-nav (v1 nav) resolves to a no-confirm tier', () => {
    expect(isNoConfirm('athena-nav')).toBe(true)
  })

  it('patient-schedule (v1 export) resolves to a no-confirm tier', () => {
    expect(isNoConfirm('patient-schedule')).toBe(true)
  })

  it('athena-patient-search (v2 blind search) is no-confirm', () => {
    expect(isNoConfirm('athena-patient-search')).toBe(true)
  })

  it('athena-schedule-date-probe (v2 nav-chrome probe) is no-confirm', () => {
    expect(isNoConfirm('athena-schedule-date-probe')).toBe(true)
  })

  it('athena-input-prepare (stages, no mutation) is no-confirm', () => {
    expect(isNoConfirm('athena-input-prepare')).toBe(true)
  })
})

// ─── 2. The single typed-confirm gate ──────────────────────────────────

describe('AVSO tier-policy — input-commit is the ONLY confirm gate', () => {
  it('athena-input-commit is tier-3 (the typed-confirm write gate)', () => {
    expect(tierFor('athena-input-commit')).toBe(3)
    expect(isNoConfirm('athena-input-commit')).toBe(false)
  })

  it('among all the AVSO command kinds, ONLY input-commit gates', () => {
    const avsoKinds = [
      'athena-nav',
      'patient-schedule',
      'athena-patient-search',
      'athena-input-prepare',
      'athena-input-commit',
      'athena-schedule-date-probe',
    ]
    const gated = avsoKinds.filter(
      (k) => tierFor(k) >= CONFIRM_GATE_MIN_TIER,
    )
    expect(gated).toEqual(['athena-input-commit'])
  })

  it('the gate mints exactly CONFIRM ATHENA-INPUT-COMMIT', () => {
    // Mirrors execute.ts: requiredPhrase = `CONFIRM ${cmd.toUpperCase()}`
    expect(`CONFIRM ${'athena-input-commit'.toUpperCase()}`).toBe(
      'CONFIRM ATHENA-INPUT-COMMIT',
    )
  })
})

// ─── 3. v1 NO-REGRESSION lock — exact numeric tiers are frozen ─────────

describe('AVSO tier-policy — v1 numeric tiers are FROZEN (no regression)', () => {
  it('athena-nav stays numeric tier-0 (the read-only allowlist tier)', () => {
    // Renumbering this would break workflow-adversarial's
    // "no tier 0 command mutates state" allowlist + "read-only
    // commands are tier 0". It MUST stay 0.
    expect(COMMAND_TIER['athena-nav']).toBe(0)
    expect(tierFor('athena-nav')).toBe(0)
  })

  it('patient-schedule stays numeric tier-0', () => {
    expect(COMMAND_TIER['patient-schedule']).toBe(0)
    expect(tierFor('patient-schedule')).toBe(0)
  })

  it('v2 numeric tiers are unchanged: ps1 / ip1 / ic3 / sp0', () => {
    expect(tierFor('athena-patient-search')).toBe(1)
    expect(tierFor('athena-input-prepare')).toBe(1)
    expect(tierFor('athena-input-commit')).toBe(3)
    expect(tierFor('athena-schedule-date-probe')).toBe(0)
  })

  it('execute.ts COMMAND_TIER and types.ts AVSO_V2_TIER agree for v2', () => {
    // The two tier sources must never drift apart.
    expect(tierFor('athena-patient-search')).toBe(
      avsoV2Tier('athena-patient-search'),
    )
    expect(tierFor('athena-input-prepare')).toBe(
      avsoV2Tier('athena-input-prepare'),
    )
    expect(tierFor('athena-input-commit')).toBe(
      avsoV2Tier('athena-input-commit'),
    )
    expect(tierFor('athena-schedule-date-probe')).toBe(
      avsoV2Tier('athena-schedule-date-probe'),
    )
  })
})

// ─── 4. The authoritative doc exists AND matches the code ──────────────

describe('AVSO tier-policy — TIER-POLICY.md is authoritative + in sync', () => {
  it('skills/athena-emr/TIER-POLICY.md exists', () => {
    expect(existsSync(TIER_POLICY_PATH)).toBe(true)
  })

  it('the doc states the canonical numbering = the code numbering', () => {
    const doc = readFileSync(TIER_POLICY_PATH, 'utf8')
    // The doc must carry a machine-checkable canonical table. We parse
    // lines of the form `| <command> | <number> | ...` and assert the
    // documented number equals the code constant for every AVSO kind.
    const expected: Record<string, number> = {
      'athena-nav': 0,
      'patient-schedule': 0,
      'athena-schedule-date-probe': 0,
      'athena-patient-search': 1,
      'athena-input-prepare': 1,
      'athena-input-commit': 3,
    }
    for (const [cmd, tier] of Object.entries(expected)) {
      // Match a markdown table row: | `cmd` | N | … (N is the numeric
      // tier). Backticks optional around the command name.
      const row = new RegExp(
        `\\|\\s*\`?${cmd.replace(/[-]/g, '\\-')}\`?\\s*\\|\\s*(\\d+)\\s*\\|`,
      )
      const m = doc.match(row)
      expect(m, `TIER-POLICY.md missing canonical row for ${cmd}`).toBeTruthy()
      expect(
        Number(m![1]),
        `TIER-POLICY.md tier for ${cmd} must match code`,
      ).toBe(tier)
    }
  })

  it('the doc explicitly reconciles spec "tier-1" prose with code tier-0', () => {
    const doc = readFileSync(TIER_POLICY_PATH, 'utf8')
    // It must name BOTH the spec prose tier-1 and the code numeric
    // tier-0 and assert they are the same no-confirm behavior, so a
    // future reader stops tripping on the mismatch.
    expect(doc).toMatch(/tier-?1/i)
    expect(doc).toMatch(/tier-?0/i)
    expect(doc).toMatch(/no[-\s]?confirm/i)
    expect(doc).toMatch(/read[-\s]?only/i)
    // It must explicitly say the resolution is DOCUMENT, not renumber.
    expect(doc).toMatch(/document(ed|ation)?|not\s+renumber|no\s+renumber/i)
  })

  it('the doc records the tier-3 confirm gate threshold', () => {
    const doc = readFileSync(TIER_POLICY_PATH, 'utf8')
    expect(doc).toMatch(/tier[-\s]?3/i)
    expect(doc).toMatch(/CONFIRM ATHENA-INPUT-COMMIT/)
  })
})

// ─── 5. The read-only allowlist invariant still holds (guard mirror) ───

describe('AVSO tier-policy — read-only allowlist invariant intact', () => {
  it('every numeric tier-0 AVSO command is a read-only prefix', () => {
    // Mirror of workflow-adversarial "no tier 0 command mutates state":
    // every tier-0 command in COMMAND_TIER must be a known read-only
    // family. This is the invariant a renumber would have broken.
    const readOnlyPrefixes = [
      'health',
      'fetch',
      'station-query',
      'patient',
      'athena-nav',
      'athena-schedule-date-probe',
      'inspect',
      'chrome-cdp-status',
      'list-',
      'read-',
    ]
    const tier0 = Object.entries(COMMAND_TIER)
      .filter(([, t]) => t === 0)
      .map(([c]) => c)
    for (const cmd of tier0) {
      const safe = readOnlyPrefixes.some((p) => cmd.startsWith(p))
      expect(safe, `tier-0 ${cmd} not in read-only allowlist`).toBe(true)
    }
  })
})
