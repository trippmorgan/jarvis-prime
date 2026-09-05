import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DailySession, zonedDateString } from '../claude/daily-session.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'daily-session-')), '.data', 'daily-session.json')
}

describe('zonedDateString', () => {
  it('formats YYYY-MM-DD in the given zone', () => {
    // 2026-07-18T03:00Z is still 2026-07-17 in New York (EDT, UTC-4).
    expect(zonedDateString(new Date('2026-07-18T03:00:00Z'))).toBe('2026-07-17')
    expect(zonedDateString(new Date('2026-07-18T12:00:00Z'))).toBe('2026-07-18')
  })
})

describe('DailySession', () => {
  it('first turn of the day mints a fresh session; later turns resume it', () => {
    const sessions = new DailySession(statePath())
    const noon = new Date('2026-07-18T16:00:00Z')

    const first = sessions.forTurn(noon)
    expect(first.isNew).toBe(true)
    expect(first.sessionId).toMatch(UUID_RE)

    const second = sessions.forTurn(new Date('2026-07-18T20:00:00Z'))
    expect(second.isNew).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
  })

  it('rolls over at the NY date boundary', () => {
    const sessions = new DailySession(statePath())
    const evening = sessions.forTurn(new Date('2026-07-19T03:00:00Z')) // 07-18 23:00 NY
    const morning = sessions.forTurn(new Date('2026-07-19T09:00:00Z')) // 07-19 05:00 NY
    expect(morning.isNew).toBe(true)
    expect(morning.sessionId).not.toBe(evening.sessionId)
  })

  it('peek() reads today\'s session without minting one', () => {
    const sessions = new DailySession(statePath())
    const now = new Date('2026-07-18T16:00:00Z')
    expect(sessions.peek(now)).toBeNull()
    // Still nothing minted — the next real turn is the first of the day.
    const first = sessions.forTurn(now)
    expect(first.isNew).toBe(true)
    expect(sessions.peek(now)).toEqual({ sessionId: first.sessionId, isNew: false })
    // Yesterday's session is not today's.
    expect(sessions.peek(new Date('2026-07-19T16:00:00Z'))).toBeNull()
  })

  it('rotate() replaces the stored session for the same day', () => {
    const sessions = new DailySession(statePath())
    const now = new Date('2026-07-18T16:00:00Z')
    const first = sessions.forTurn(now)
    const rotated = sessions.rotate(now)
    expect(rotated.isNew).toBe(true)
    expect(rotated.sessionId).not.toBe(first.sessionId)
    // Subsequent turns resume the rotated id, not the dead one.
    const next = sessions.forTurn(now)
    expect(next.isNew).toBe(false)
    expect(next.sessionId).toBe(rotated.sessionId)
  })

  it('treats corrupt or non-UUID state as absent', () => {
    const path = statePath()
    const sessions = new DailySession(path)
    const now = new Date('2026-07-18T16:00:00Z')
    sessions.forTurn(now)
    writeFileSync(path, JSON.stringify({ date: zonedDateString(now), sessionId: 'not-a-uuid' }))
    const recovered = sessions.forTurn(now)
    expect(recovered.isNew).toBe(true)
    expect(recovered.sessionId).toMatch(UUID_RE)
    // And the recovery is persisted.
    expect(JSON.parse(readFileSync(path, 'utf-8')).sessionId).toBe(recovered.sessionId)
  })
})
