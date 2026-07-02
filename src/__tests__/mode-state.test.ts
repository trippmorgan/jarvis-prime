import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModeState, type LeftRuntime } from '../bridge/mode-state.js'
import { matchDeepCommand } from '../bridge/processor.js'

describe('ModeState', () => {
  it('defaults to single (no persist path)', () => {
    expect(new ModeState().current).toBe('single')
  })

  it('toggles single → dual → single', () => {
    const s = new ModeState()
    expect(s.toggle()).toBe('dual')
    expect(s.current).toBe('dual')
    expect(s.toggle()).toBe('single')
    expect(s.current).toBe('single')
  })
})

describe('ModeState persistence', () => {
  let tmp: string
  let statePath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mode-state-'))
    statePath = join(tmp, '.data', 'mode-state.json')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('persists mode to disk on toggle', () => {
    const s = new ModeState('single', statePath)
    s.toggle()
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(raw.mode).toBe('dual')
    expect(raw.updatedAt).toBeTruthy()
  })

  it('restores persisted mode on construction', () => {
    const s1 = new ModeState('single', statePath)
    s1.toggle() // → dual, persisted

    const s2 = new ModeState('single', statePath)
    expect(s2.current).toBe('dual')
  })

  it('survives missing file — falls back to initial', () => {
    const s = new ModeState('single', statePath)
    expect(s.current).toBe('single')
  })

  it('survives corrupt file — falls back to initial', () => {
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(join(tmp, '.data'), { recursive: true })
    writeFileSync(statePath, 'not json')
    const s = new ModeState('single', statePath)
    expect(s.current).toBe('single')
  })
})

describe('ModeState left runtime', () => {
  let tmp: string
  let statePath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mode-state-'))
    statePath = join(tmp, '.data', 'mode-state.json')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('defaults to openclaw', () => {
    expect(new ModeState().currentLeftRuntime).toBe('openclaw')
  })

  it('constructor accepts claude as left runtime', () => {
    const s = new ModeState('single', undefined, 'claude')
    expect(s.currentLeftRuntime).toBe('claude')
  })

  it('setLeftRuntime returns and sets the new runtime', () => {
    const s = new ModeState()
    const result: LeftRuntime = s.setLeftRuntime('claude')
    expect(result).toBe('claude')
    expect(s.currentLeftRuntime).toBe('claude')
  })

  it('leftRuntime is NOT persisted — mode restores, runtime resets to default', () => {
    const s1 = new ModeState('single', statePath)
    s1.toggle() // → dual, persisted
    s1.setLeftRuntime('claude')
    expect(s1.currentLeftRuntime).toBe('claude')

    const s2 = new ModeState('single', statePath)
    expect(s2.current).toBe('dual') // mode restored from disk
    expect(s2.currentLeftRuntime).toBe('openclaw') // runtime deliberately in-memory only
  })
})

describe('matchDeepCommand', () => {
  it('matches /deep as toggle', () => {
    expect(matchDeepCommand('/deep')).toBe('toggle')
    expect(matchDeepCommand('  /deep  ')).toBe('toggle')
    expect(matchDeepCommand('/DEEP')).toBe('toggle')
  })

  it('matches /deep status', () => {
    expect(matchDeepCommand('/deep status')).toBe('status')
    expect(matchDeepCommand('/Deep Status')).toBe('status')
  })

  it('returns null for non-matches', () => {
    expect(matchDeepCommand('/deep please think hard')).toBe(null)
    expect(matchDeepCommand('/dispatch something')).toBe(null)
    expect(matchDeepCommand('hey jarvis')).toBe(null)
    expect(matchDeepCommand('')).toBe(null)
  })
})
