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

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ConscienceItem {
  slug?: string
  type?: string
  description?: string
  body?: string
}

interface ReflectiveItem {
  title?: string
  severity?: string
  category?: string
  recurring?: boolean
  date?: string
  recommendation?: string
  persistence?: 'new' | 'persisting'
  runsSeen?: number
}

interface ResolvedItem {
  title?: string
  resolvedAt?: string
  runsSeen?: number
}

interface ConscienceSnapshot {
  schemaVersion?: number
  snapshotHash?: string
  generatedAt?: string
  sourceScoredAt?: string
  /** v2 chambers; `items` is retained as the v1-compatible normative list. */
  normative?: ConscienceItem[]
  reflective?: ReflectiveItem[]
  resolved?: ResolvedItem[]
  items?: ConscienceItem[]
}

const BODY_MAX_CHARS = 450
const TOTAL_MAX_CHARS = 6_000
const CACHE_MS = 60_000
const STALE_AFTER_MS = 36 * 60 * 60 * 1000

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
    if (!verifyConscienceSnapshot(snapshot)) {
      cache = { block: '', readAt: Date.now() }
      return ''
    }
    const normative = Array.isArray(snapshot.normative)
      ? snapshot.normative
      : Array.isArray(snapshot.items) ? snapshot.items : []
    const reflective = Array.isArray(snapshot.reflective) ? snapshot.reflective : []
    const resolved = Array.isArray(snapshot.resolved) ? snapshot.resolved : []
    if (snapshot.snapshotHash && (normative.length > 0 || reflective.length > 0 || resolved.length > 0)) {
      const lines: string[] = [
        '## Conscience — hash-verified, chain-attested working memory',
        `Selected nightly by Φ consolidation; integrity verified before prompt injection`,
        `(snapshot ${snapshot.snapshotHash.slice(0, 16)}…). Two chambers, different weight.`,
        '',
      ]
      const generatedMs = Date.parse(snapshot.generatedAt ?? '')
      if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > STALE_AFTER_MS) {
        lines.push(
          '⚠️ REFLECTIVE STATE IS STALE: durable principles still apply, but recent-failure',
          'and resolution claims may be out of date. Rebuild the conscience before relying',
          'on it as a picture of current system health.',
          '',
        )
      }
      let budget = TOTAL_MAX_CHARS

      if (normative.length > 0) {
        lines.push(
          '### I. Standing principles — durable, pinned',
          'These are how Tripp has told you to work. Weigh every answer and every action',
          'against them. If a request or a draft reply conflicts with one, say so explicitly',
          'rather than proceeding silently.',
          '',
        )
        for (const item of normative) {
          if (!item.slug || budget <= 0) continue
          const description = String(item.description ?? '').replace(/\s+/g, ' ').trim()
          const body = String(item.body ?? '').replace(/\s+/g, ' ').trim().slice(0, BODY_MAX_CHARS)
          const entry = `**${item.slug}** — ${description}${body ? `\n${body}` : ''}`
          if (entry.length > budget) break
          lines.push(entry, '')
          budget -= entry.length
        }
      }

      if (reflective.length > 0) {
        lines.push(
          '### II. Recent failures and open concerns — what went wrong lately',
          'Known problems the network found in itself. Do not repeat them; if the current',
          'task touches one, mention it rather than walking into it again.',
          '',
        )
        for (const item of reflective) {
          if (!item.title || budget <= 0) continue
          const continuity = item.persistence === 'persisting'
            ? `PERSISTING ${item.runsSeen ?? 1} runs`
            : item.persistence === 'new' ? 'NEW' : ''
          const flags = [item.severity, item.category, item.recurring ? 'RECURRING' : '', continuity]
            .filter(Boolean)
            .join(' · ')
          const rec = String(item.recommendation ?? '').replace(/\s+/g, ' ').trim()
          const entry = `- [${flags}] ${String(item.title).replace(/\s+/g, ' ').trim()}${rec ? `\n  → ${rec}` : ''}`
          if (entry.length > budget) break
          lines.push(entry)
          budget -= entry.length
        }
      }
      if (resolved.length > 0 && budget > 0) {
        lines.push(
          '',
          '### III. Recently resolved — evidence that corrective action worked',
          'Retain the lesson without continuing to treat the old problem as active.',
          '',
        )
        for (const item of resolved) {
          if (!item.title || budget <= 0) continue
          const entry = `- ${String(item.title).replace(/\s+/g, ' ').trim()} — resolved ${item.resolvedAt ?? 'recently'} after ${item.runsSeen ?? 1} observed run(s)`
          if (entry.length > budget) break
          lines.push(entry)
          budget -= entry.length
        }
      }
      block = lines.join('\n').trim()
    }
  } catch {
    /* no conscience → no block; never throws into prompt assembly */
  }
  cache = { block, readAt: Date.now() }
  return block
}

/** Verify the exact producer hash before any conscience content enters a prompt. */
export function verifyConscienceSnapshot(snapshot: ConscienceSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false
  if (typeof snapshot.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.snapshotHash)) {
    return false
  }
  let payload: object
  if (snapshot.schemaVersion === 2) {
    if (!Array.isArray(snapshot.normative) || !Array.isArray(snapshot.reflective) || !Array.isArray(snapshot.resolved)) {
      return false
    }
    payload = {
      schemaVersion: 2,
      generatedAt: snapshot.generatedAt,
      sourceScoredAt: snapshot.sourceScoredAt,
      normative: snapshot.normative,
      reflective: snapshot.reflective,
      resolved: snapshot.resolved,
    }
  } else if (snapshot.schemaVersion === 1) {
    if (!Array.isArray(snapshot.items)) return false
    payload = {
      schemaVersion: 1,
      generatedAt: snapshot.generatedAt,
      sourceScoredAt: snapshot.sourceScoredAt,
      items: snapshot.items,
    }
  } else {
    return false
  }
  const actual = createHash('sha256').update(JSON.stringify(payload)).digest()
  const expected = Buffer.from(snapshot.snapshotHash, 'hex')
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

/** Test hook. */
export function resetConscienceCacheForTests(): void {
  cache = { block: '', readAt: 0 }
}
