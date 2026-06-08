import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TruthLogEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

/**
 * Append-only conversation record. SPEC §Q1 lock 2026-06-06: this is the
 * TRUTH layer. Never trimmed, never rewritten. ConversationHistory is the
 * bounded VIEW that feeds the prompt window; the truth log is the audit
 * record that survives every turn so the precedence rule
 * ("most recent confirmed statement wins") has something to be true about.
 *
 * Read paths (getAll, count) load the whole file. Acceptable: truth-log
 * grows linearly with turns, and reads are off the hot prompt-build path.
 */
export class TruthLog {
  private readonly path: string

  constructor(path: string) {
    this.path = path
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  append(role: 'user' | 'assistant', content: string): void {
    const entry: TruthLogEntry = { role, content, timestamp: Date.now() }
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf-8')
  }

  getAll(): TruthLogEntry[] {
    if (!existsSync(this.path)) return []
    const lines = readFileSync(this.path, 'utf-8').trim().split('\n').filter(Boolean)
    const out: TruthLogEntry[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip malformed line; truth-log MUST keep advancing past corruption
      }
    }
    return out
  }

  count(): number {
    if (!existsSync(this.path)) return 0
    return readFileSync(this.path, 'utf-8').trim().split('\n').filter(Boolean).length
  }
}
