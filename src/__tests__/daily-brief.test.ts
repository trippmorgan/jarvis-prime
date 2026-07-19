import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dailyBriefBlock } from '../context/daily-brief.js'

let dir: string
let savedLedgerDir: string | undefined
let savedDilDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daily-brief-'))
  savedLedgerDir = process.env.PHI_LEDGER_DIR
  savedDilDir = process.env.JARVIS_DIL_FINDINGS_DIR
  process.env.PHI_LEDGER_DIR = join(dir, 'ledger')
  process.env.JARVIS_DIL_FINDINGS_DIR = join(dir, 'dil')
})

afterEach(() => {
  if (savedLedgerDir === undefined) delete process.env.PHI_LEDGER_DIR
  else process.env.PHI_LEDGER_DIR = savedLedgerDir
  if (savedDilDir === undefined) delete process.env.JARVIS_DIL_FINDINGS_DIR
  else process.env.JARVIS_DIL_FINDINGS_DIR = savedDilDir
})

describe('dailyBriefBlock', () => {
  it('returns empty string when no sources exist (fail-soft)', () => {
    expect(dailyBriefBlock('2026-07-18')).toBe('')
  })

  it('composes available sections and skips missing ones', () => {
    const consolidation = join(dir, 'ledger', 'consolidation')
    mkdirSync(consolidation, { recursive: true })
    writeFileSync(
      join(consolidation, 'PROMOTED.md'),
      '# PROMOTED\n\n- [feedback_dev_then_harden](feedback/x.md) — Φ 0.94 (links 10, recalls 3)\n',
    )
    writeFileSync(
      join(consolidation, 'report-2026-07-18.json'),
      JSON.stringify({
        scoredAt: '2026-07-18T08:10:00.000Z',
        atomCount: 49,
        summary: { top5: ['a', 'b'], promote: ['a'], decayCandidates: [] },
      }),
    )
    writeFileSync(
      join(dir, 'ledger', 'crosscheck-jarvis.json'),
      JSON.stringify({ ok: true, checkedAt: '2026-07-18T07:55:00.000Z', witnessLines: 217, divergences: [] }),
    )
    mkdirSync(join(dir, 'dil'), { recursive: true })
    writeFileSync(
      join(dir, 'dil', '2026-07-17.json'),
      JSON.stringify({
        date: '2026-07-17',
        findings: [{ title: 'SHS cannot localize incidents', severity: 'error', category: 'operational' }],
      }),
    )

    const brief = dailyBriefBlock('2026-07-18')
    expect(brief).toContain('## Daily start brief — 2026-07-18')
    expect(brief).toContain('feedback_dev_then_harden')
    expect(brief).toContain('49 atoms scored')
    expect(brief).toContain('verified clean against the Argus witness')
    expect(brief).toContain('SHS cannot localize incidents')
    expect(brief.length).toBeLessThanOrEqual(4_500)
  })

  it('flags witness divergences loudly', () => {
    mkdirSync(join(dir, 'ledger'), { recursive: true })
    writeFileSync(
      join(dir, 'ledger', 'crosscheck-jarvis.json'),
      JSON.stringify({ ok: false, checkedAt: '2026-07-18T07:55:00.000Z', witnessLines: 10, divergences: [{}] }),
    )
    expect(dailyBriefBlock('2026-07-18')).toContain('DIVERGENCES DETECTED')
  })
})
