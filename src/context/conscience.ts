/**
 * Conscience context — the Φ-selected, chain-attested working memory bundle
 * built nightly by jarvis-os consolidation (jarvis-ledger Phase D).
 *
 * This is the "always available" half of the conscience contract: Prime's
 * main brain carries the network's most integrated memories — Tripp's
 * standing corrections and active-project truths — in every prompt, and is
 * asked to weigh answers and decisions against them. The other half lives
 * on-chain: every DECISION event is stamped with the snapshot hash in force.
 *
 * Fail-soft by contract: missing/unreadable snapshot → empty string, the
 * prompt is byte-identical to the pre-conscience era. Cached 60s.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ConscienceItem {
  slug?: string
  type?: string
  description?: string
  body?: string
}

interface ConscienceSnapshot {
  schemaVersion?: number
  snapshotHash?: string
  generatedAt?: string
  items?: ConscienceItem[]
}

const BODY_MAX_CHARS = 450
const TOTAL_MAX_CHARS = 6_000
const CACHE_MS = 60_000

let cache: { block: string; readAt: number } = { block: '', readAt: 0 }

export function conscienceBlock(): string {
  // Environmental input (a real file under ~/.config): stay out of unit tests
  // unless one opts in via PHI_LEDGER_DIR, so prompt-size assertions are
  // deterministic. Same posture as other machine-state loaders.
  if (process.env.VITEST && !process.env.PHI_LEDGER_DIR) return ''
  if (Date.now() - cache.readAt < CACHE_MS) return cache.block
  let block = ''
  try {
    const cfgDir = process.env.PHI_LEDGER_DIR ?? join(homedir(), '.config', 'phi-ledger')
    const snapshot = JSON.parse(
      readFileSync(join(cfgDir, 'conscience', 'current.json'), 'utf8'),
    ) as ConscienceSnapshot
    const items = Array.isArray(snapshot.items) ? snapshot.items : []
    if (snapshot.schemaVersion === 1 && items.length > 0 && snapshot.snapshotHash) {
      const lines: string[] = [
        '## Conscience — chain-attested standing principles',
        `The network's most integrated memories, selected nightly by Φ consolidation and`,
        `attested on the jarvis ledger (snapshot ${snapshot.snapshotHash.slice(0, 16)}…).`,
        'Weigh every answer and every decision against these. When a requested action or a',
        'draft reply conflicts with one, say so explicitly rather than proceeding silently.',
        '',
      ]
      let budget = TOTAL_MAX_CHARS
      for (const item of items) {
        if (!item.slug || budget <= 0) continue
        const description = String(item.description ?? '').replace(/\s+/g, ' ').trim()
        const body = String(item.body ?? '').replace(/\s+/g, ' ').trim().slice(0, BODY_MAX_CHARS)
        const entry = `### ${item.slug}\n${description}${body ? `\n${body}` : ''}`
        if (entry.length > budget) break
        lines.push(entry, '')
        budget -= entry.length
      }
      block = lines.join('\n').trim()
    }
  } catch {
    /* no conscience → no block; never throws into prompt assembly */
  }
  cache = { block, readAt: Date.now() }
  return block
}

/** Test hook. */
export function resetConscienceCacheForTests(): void {
  cache = { block: '', readAt: 0 }
}
