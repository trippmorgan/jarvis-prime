import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const MAX_ENTRIES = 20
const MAX_CONTEXT_CHARS = 6000

export class ConversationHistory {
  private readonly path: string

  constructor(path: string) {
    this.path = path
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  append(role: 'user' | 'assistant', content: string): void {
    const entry: HistoryEntry = { role, content: content.slice(0, 2000), timestamp: Date.now() }
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf-8')
    this.trim()
  }

  getRecent(maxEntries: number = 10): HistoryEntry[] {
    if (!existsSync(this.path)) return []

    const lines = readFileSync(this.path, 'utf-8').trim().split('\n').filter(Boolean)
    const entries: HistoryEntry[] = []

    for (const line of lines.slice(-maxEntries)) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }

    return entries
  }

  formatForPrompt(maxEntries: number = 10): string {
    const entries = this.getRecent(maxEntries)
    if (entries.length === 0) return ''

    let result = '## Recent conversation\n'
    let chars = result.length

    // Build from most recent backward, then reverse to get chronological order
    const selected: HistoryEntry[] = []
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const line = `${entry.role === 'user' ? 'Tripp' : 'Jarvis'}: ${entry.content}\n`
      if (chars + line.length > MAX_CONTEXT_CHARS) break
      selected.unshift(entry)
      chars += line.length
    }

    for (const entry of selected) {
      const label = entry.role === 'user' ? 'Tripp' : 'Jarvis'
      result += `${label}: ${entry.content}\n\n`
    }

    return result
  }

  private trim(): void {
    if (!existsSync(this.path)) return
    const lines = readFileSync(this.path, 'utf-8').trim().split('\n').filter(Boolean)
    if (lines.length > MAX_ENTRIES * 2) {
      writeFileSync(this.path, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf-8')
    }
  }
}
