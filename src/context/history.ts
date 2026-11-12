import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DurableMemory } from './durable-memory.js'

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const MAX_ENTRIES = 20
const MAX_CONTEXT_CHARS = 6000

export class ConversationHistory {
  private readonly path: string
  readonly memory: DurableMemory

  constructor(path: string) {
    this.path = path
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.memory = new DurableMemory(`${path}.sqlite`, path)
  }

  append(role: 'user' | 'assistant', content: string): void {
    const entry: HistoryEntry = { role, content, timestamp: Date.now() }
    this.memory.append(entry)
    // Compatibility cache only. The SQLite archive retains the complete message.
    appendFileSync(this.path, JSON.stringify({ ...entry, content: content.slice(0, 2000) }) + '\n', 'utf-8')
    this.trim()
  }

  getRecent(maxEntries: number = 10): HistoryEntry[] {
    return this.memory.recent(maxEntries).map(entry => ({ ...entry, content: entry.content.slice(0, 2000) }))
  }

  close(): void { this.memory.close() }

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
