import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TruthLog } from '../context/truth-log.js'
import { ConversationHistory } from '../context/history.js'

/**
 * B7 — SPEC §Q1 invariant: no turn is ever silently lost.
 *
 * The legacy `conversation-history.jsonl` writer trims itself to 20
 * entries when it crosses 40 — which means the truth of "what was said"
 * silently disappears as soon as a conversation is moderately long. The
 * memory architecture's precedence rule ("most recent confirmed
 * statement wins") needs an audit-quality record to be true about.
 *
 * Truth-log is that record. These tests are the canary.
 */

describe('TruthLog — append-only, never trimmed (SPEC §Q1)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'truthlog-'))
    path = join(dir, 'truth-log.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a single appended turn', () => {
    const log = new TruthLog(path)
    log.append('user', 'hello')
    expect(log.count()).toBe(1)
    const all = log.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].role).toBe('user')
    expect(all[0].content).toBe('hello')
    expect(typeof all[0].timestamp).toBe('number')
  })

  it('keeps all 50 turns readable after append-50 — the SPEC invariant', () => {
    const log = new TruthLog(path)
    for (let i = 0; i < 50; i++) {
      log.append(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`)
    }
    expect(log.count()).toBe(50)
    const all = log.getAll()
    expect(all).toHaveLength(50)
    // First and last turn both survive — proves head AND tail intact.
    expect(all[0].content).toBe('turn-0')
    expect(all[49].content).toBe('turn-49')
    // Roles alternate as written — proves nothing reordered.
    expect(all[0].role).toBe('user')
    expect(all[1].role).toBe('assistant')
  })

  it('survives a single malformed line without losing surrounding turns', () => {
    const log = new TruthLog(path)
    log.append('user', 'before')
    // Hand-inject a corrupt line — truth-log MUST keep advancing past it.
    appendCorrupt(path, '{not-valid-json')
    log.append('assistant', 'after')
    const all = log.getAll()
    expect(all.map((e) => e.content)).toEqual(['before', 'after'])
  })

  it('returns empty without throwing when the file is absent', () => {
    const log = new TruthLog(path)
    expect(log.count()).toBe(0)
    expect(log.getAll()).toEqual([])
  })
})

describe('ConversationHistory — teed to TruthLog (B7 wiring)', () => {
  let dir: string
  let historyPath: string
  let truthPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-'))
    historyPath = join(dir, 'conversation-history.jsonl')
    truthPath = join(dir, 'truth-log.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes every turn to truth-log even when the view is trimmed', () => {
    const truth = new TruthLog(truthPath)
    const history = new ConversationHistory(historyPath, truth)

    // 50 turns — well past the view's MAX_ENTRIES=20 / trim-trigger=40.
    for (let i = 0; i < 50; i++) {
      history.append(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`)
    }

    // View is bounded — trim fires at >MAX_ENTRIES*2 (40), cutting back to
    // the last MAX_ENTRIES (20). After 50 sequential appends the view ends
    // up between 20 and 40. The point is it does NOT keep growing.
    const view = readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(view.length).toBeGreaterThanOrEqual(20)
    expect(view.length).toBeLessThanOrEqual(40)
    expect(view.length).toBeLessThan(50)

    // Truth survives all 50 turns — INVARIANT.
    expect(truth.count()).toBe(50)
    const all = truth.getAll()
    expect(all[0].content).toBe('turn-0')
    expect(all[49].content).toBe('turn-49')
  })

  it('still writes the view when TruthLog is omitted (backwards compat)', () => {
    const history = new ConversationHistory(historyPath)
    history.append('user', 'hi')
    const view = readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(view).toHaveLength(1)
  })
})

function appendCorrupt(path: string, garbage: string): void {
  // Inline use to avoid pulling fs into the test top — keeps the assertion
  // block readable.
  const fs = require('node:fs') as typeof import('node:fs')
  fs.appendFileSync(path, garbage + '\n', 'utf-8')
}
