import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationHistory } from '../context/history.js'
import { PromptBuilder } from '../context/prompt-builder.js'

describe('durable research memory', () => {
  it('imports legacy history once and preserves full messages after restart and cache trimming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frank-memory-'))
    const path = join(dir, 'history.jsonl')
    writeFileSync(path, JSON.stringify({ role: 'user', content: 'Legacy decision', timestamp: 1 }) + '\ninvalid\n')
    let history = new ConversationHistory(path)
    const long = 'padding '.repeat(400) + ' Zephyr calibration target is 1739.'
    history.append('user', long)
    for (let i = 0; i < 65; i++) history.append('assistant', `Unrelated filler ${i}`)
    history.close()
    history = new ConversationHistory(path)
    expect(history.memory.recent(100)).toHaveLength(67)
    expect(history.memory.recent(100)[1].content).toBe(long)
    expect(history.memory.retrieve('Zephyr calibration')).toContain('1739')
    expect(new PromptBuilder(history).build('Zephyr calibration')).toContain('1739')
    expect(history.memory.retrieve('nonexistentpterodactyl')).toBe('')
    expect(history.memory.retrieve('Zephyr calibration').length).toBeLessThanOrEqual(4500)
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).length).toBeLessThanOrEqual(40)
    history.close()
  })

  it('refreshes explicitly registered research sources and replaces superseded text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frank-research-'))
    const history = new ConversationHistory(join(dir, 'history.jsonl'))
    const doc = join(dir, 'DESIGN.md')
    writeFileSync(doc, 'Nebula replication has 18 pairs; state RUNNING.')
    history.memory.registerDocument(doc)
    expect(history.memory.retrieve('Nebula replication')).toContain('RUNNING')
    writeFileSync(doc, 'Nebula replication has 18 pairs; state COMPLETED.')
    utimesSync(doc, new Date(), new Date(Date.now() + 1000))
    const evidence = history.memory.retrieve('Nebula replication')
    expect(evidence).toContain('COMPLETED')
    expect(evidence).not.toContain('RUNNING')
    expect(evidence).toContain(doc)
    history.close()
  })
})
