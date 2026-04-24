import { describe, it, expect } from 'vitest'
import { ModeState } from '../bridge/mode-state.js'
import { matchDeepCommand } from '../bridge/processor.js'

describe('ModeState', () => {
  it('defaults to single', () => {
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
