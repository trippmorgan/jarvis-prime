/**
 * Daily start brief — injected once per day, on the first turn of the daily
 * Claude session. Pulls the network's self-knowledge into working context:
 *
 *   - Φ-promoted memories (consolidation's PROMOTED.md — memories that
 *     earned their place through real linkage + recall)
 *   - the latest consolidation summary (top-ranked atoms, promote/decay)
 *   - jarvis-ledger witness status (is the truth-log verified + witnessed?)
 *   - recent DIL findings (what the network caught itself doing wrong)
 *
 * Every section is fail-soft and size-capped: a missing file yields nothing,
 * never an error, and the whole block stays under ~4.5KB. PHI never appears
 * in any of these sources by construction (consolidation skips PHI atoms;
 * DIL findings are PHI-free counts/titles; witness files are hashes).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PHI_LEDGER_DIR = () => process.env.PHI_LEDGER_DIR ?? join(homedir(), '.config', 'phi-ledger')
const DIL_FINDINGS_DIR = () =>
  process.env.JARVIS_DIL_FINDINGS_DIR ?? '/home/tripp/.openclaw/workspace/jarvis-os/.data/dil-findings'

const PROMOTED_MAX_CHARS = 1_500
const DIL_MAX_FINDINGS = 6
const TOTAL_MAX_CHARS = 4_500

export function dailyBriefBlock(date: string): string {
  const sections = [promotedSection(), consolidationSection(), ledgerSection(), dilSection()]
    .filter((s): s is string => s !== null)
  if (sections.length === 0) return ''
  const block = [
    `## Daily start brief — ${date}`,
    'First turn of today\'s session. This is the network\'s self-knowledge as of last night;',
    'carry it through the day. Later turns in this session will NOT repeat it.',
    '',
    sections.join('\n\n'),
  ].join('\n')
  return block.length > TOTAL_MAX_CHARS ? block.slice(0, TOTAL_MAX_CHARS) : block
}

function promotedSection(): string | null {
  try {
    const raw = readFileSync(join(PHI_LEDGER_DIR(), 'consolidation', 'PROMOTED.md'), 'utf-8')
    const items = raw.split('\n').filter((l) => l.startsWith('- ['))
    if (items.length === 0) return null
    return `### Φ-promoted memories (earned via real use)\n${items.join('\n')}`.slice(0, PROMOTED_MAX_CHARS)
  } catch {
    return null
  }
}

function consolidationSection(): string | null {
  try {
    const dir = join(PHI_LEDGER_DIR(), 'consolidation')
    const latest = readdirSync(dir).filter((f) => f.startsWith('report-')).sort().pop()
    if (!latest) return null
    const report = JSON.parse(readFileSync(join(dir, latest), 'utf-8')) as {
      scoredAt: string
      atomCount: number
      summary: { top5: string[]; promote: string[]; decayCandidates: string[] }
    }
    return (
      `### Memory consolidation (${report.scoredAt.slice(0, 10)})\n` +
      `${report.atomCount} atoms scored. Top: ${report.summary.top5.slice(0, 5).join(', ')}. ` +
      `Promoted ${report.summary.promote.length}, decay candidates ${report.summary.decayCandidates.length}.`
    )
  } catch {
    return null
  }
}

function ledgerSection(): string | null {
  try {
    const cc = JSON.parse(
      readFileSync(join(PHI_LEDGER_DIR(), 'crosscheck-jarvis.json'), 'utf-8'),
    ) as { ok: boolean; checkedAt: string; witnessLines: number; divergences: unknown[] }
    const status = cc.ok && cc.divergences.length === 0
      ? 'verified clean against the Argus witness'
      : `⚠️ DIVERGENCES DETECTED (${cc.divergences.length}) — history may have been edited; flag this to Tripp`
    return (
      `### Truth ledger\n` +
      `jarvis-ledger ${status} (last cross-check ${cc.checkedAt.slice(0, 16)}Z, ` +
      `${cc.witnessLines} witnessed checkpoints). Memory writes, recalls, and decisions are chained.`
    )
  } catch {
    return null
  }
}

function dilSection(): string | null {
  try {
    const dir = DIL_FINDINGS_DIR()
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-2)
    const findings: string[] = []
    for (const f of files.reverse()) {
      const day = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        date: string
        findings: Array<{ title: string; severity: string; category: string }>
      }
      for (const fd of day.findings ?? []) {
        if (findings.length >= DIL_MAX_FINDINGS) break
        const title = String(fd.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
        findings.push(`- [${fd.severity ?? '?'} · ${day.date}] ${title}`)
      }
    }
    if (findings.length === 0) return null
    return (
      `### Recent self-observed failures (Daily Improvement Loop)\n` +
      `Do not walk into these again; mention them when relevant.\n${findings.join('\n')}`
    )
  } catch {
    return null
  }
}
