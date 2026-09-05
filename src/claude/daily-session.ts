/**
 * Daily session continuity — one Claude CLI session per calendar day
 * (America/New_York), so Telegram turns accumulate context the way a
 * terminal session does: tool results, investigations, and conclusions
 * persist across messages instead of being re-derived from a 10-turn
 * text window every spawn.
 *
 * State is a tiny JSON file: { date, sessionId }. First turn of the day
 * mints a fresh UUID (spawned with --session-id, which creates the
 * session); later turns resume it (--resume). `rotate()` replaces a
 * session the CLI refused to resume (evicted/corrupt) so one stale file
 * can never wedge the brain — the caller retries once with the fresh id.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface DailySessionState {
  date: string
  sessionId: string
}

export interface SessionForTurn {
  sessionId: string
  /** True when this turn must CREATE the session (first of the day / post-rotate). */
  isNew: boolean
}

/** Calendar date in the given IANA zone, formatted YYYY-MM-DD. */
export function zonedDateString(now: Date = new Date(), timeZone = 'America/New_York'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export class DailySession {
  constructor(
    private readonly statePath: string,
    private readonly timeZone = 'America/New_York',
  ) {}

  /** Today's session — mints a fresh one when the stored date has rolled over. */
  forTurn(now: Date = new Date()): SessionForTurn {
    const today = zonedDateString(now, this.timeZone)
    const state = this.read()
    if (state && state.date === today && isUuid(state.sessionId)) {
      return { sessionId: state.sessionId, isNew: false }
    }
    return this.mint(today)
  }

  /**
   * Today's session if one has already been minted, else null — never mints.
   * Background jobs use this: a job forks the daily session when it exists
   * but must not claim the day's id for a session it will never create.
   */
  peek(now: Date = new Date()): SessionForTurn | null {
    const today = zonedDateString(now, this.timeZone)
    const state = this.read()
    if (state && state.date === today && isUuid(state.sessionId)) {
      return { sessionId: state.sessionId, isNew: false }
    }
    return null
  }

  /**
   * Replace today's session after a failed --resume. The caller retries the
   * turn once with the returned id as a fresh session.
   */
  rotate(now: Date = new Date()): SessionForTurn {
    return this.mint(zonedDateString(now, this.timeZone))
  }

  private mint(date: string): SessionForTurn {
    const sessionId = randomUUID()
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify({ date, sessionId } satisfies DailySessionState))
    } catch {
      // Unwritable state → every turn becomes a fresh session. Degraded but
      // never broken: identical to the pre-continuity behavior.
    }
    return { sessionId, isNew: true }
  }

  private read(): DailySessionState | null {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as DailySessionState
      return typeof raw?.date === 'string' && typeof raw?.sessionId === 'string' ? raw : null
    } catch {
      return null
    }
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}
