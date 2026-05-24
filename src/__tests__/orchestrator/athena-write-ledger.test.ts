// AVSO v2 — Wave 1 T2: pending-write ledger (Boundary Contract C3).
//
// The ledger is the safety primitive that makes "no EMR write without a
// correlated Telegram affirmative" structurally enforced. These tests are
// written FIRST (TDD RED) and pin the entire contract:
//
//   (a) happy-path confirm           (e) mismatched text → abort
//   (b) cancel                       (f) mismatched field → abort
//   (c) timeout via injected clock   (g) concurrent / second-pending reject
//   (d) stale / unknown correlation id → abort
//
// PHI is sacred: every test uses SYNTHETIC field/text only. No realistic
// patient data ever appears here, and the ledger must never log the text.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AthenaWriteLedger,
  type LedgerResolution,
} from '../../orchestrator/athena-write-ledger.js'

// ── Synthetic fixtures — NEVER realistic PHI ───────────────────────────
const SESSION = 'chatZZ'
const CORR = 'corr-ZZ-0001'
const FIELD = 'ZZFIELD_NOTE'
const TEXT = 'ZZSYNTH_WRITETEXT'
const TTL = 60_000

// Deterministic injectable clock.
function makeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

function ok(r: LedgerResolution): r is Extract<LedgerResolution, { committed: true }> {
  return r.committed === true
}

describe('AthenaWriteLedger', () => {
  let clock: ReturnType<typeof makeClock>
  let ledger: AthenaWriteLedger

  beforeEach(() => {
    clock = makeClock()
    ledger = new AthenaWriteLedger({ now: clock.now, ttlMs: TTL })
  })

  // ── (a) happy-path confirm ──────────────────────────────────────────
  describe('happy-path confirm', () => {
    it('opens a pending write and commits on an exact correlated affirmative', () => {
      const open = ledger.open({
        sessionKey: SESSION,
        correlationId: CORR,
        field: FIELD,
        text: TEXT,
      })
      expect(open.accepted).toBe(true)
      expect(ledger.hasPending(SESSION)).toBe(true)

      const res = ledger.confirm({
        sessionKey: SESSION,
        correlationId: CORR,
        field: FIELD,
        text: TEXT,
      })
      expect(ok(res)).toBe(true)
      if (ok(res)) {
        expect(res.field).toBe(FIELD)
        expect(res.text).toBe(TEXT)
        expect(res.correlationId).toBe(CORR)
      }
      // Single-use: the entry is consumed once committed.
      expect(ledger.hasPending(SESSION)).toBe(false)
    })

    it('a second confirm after a commit does not re-commit', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(ok(ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT }))).toBe(true)

      const again = ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(again.committed).toBe(false)
      if (!again.committed) expect(again.reason).toBe('no_pending')
    })
  })

  // ── (b) cancel ──────────────────────────────────────────────────────
  describe('cancel', () => {
    it('cancel removes the pending entry and a later confirm cannot commit', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const cancelled = ledger.cancel(SESSION)
      expect(cancelled).toBe(true)
      expect(ledger.hasPending(SESSION)).toBe(false)

      const res = ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('no_pending')
    })

    it('cancel on a session with no pending write is a harmless no-op', () => {
      expect(ledger.cancel('nobody')).toBe(false)
    })
  })

  // ── (c) timeout via injected clock ──────────────────────────────────
  describe('timeout (TTL) via injected clock', () => {
    it('a confirm after the TTL elapses aborts and does not commit', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })

      clock.advance(TTL + 1)

      const res = ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('expired')
      expect(ledger.hasPending(SESSION)).toBe(false)
    })

    it('a confirm exactly at the TTL boundary (not yet past) still commits', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      clock.advance(TTL) // == ttl, not strictly expired
      const res = ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(ok(res)).toBe(true)
    })

    it('hasPending() reports false once the TTL has elapsed', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(ledger.hasPending(SESSION)).toBe(true)
      clock.advance(TTL + 1)
      expect(ledger.hasPending(SESSION)).toBe(false)
    })

    it('expiring one session does not free another session unrelated to it', () => {
      ledger.open({ sessionKey: 'sessA', correlationId: 'cA', field: FIELD, text: TEXT })
      clock.advance(10)
      ledger.open({ sessionKey: 'sessB', correlationId: 'cB', field: FIELD, text: TEXT })
      clock.advance(TTL) // sessA now strictly expired (age TTL+10), sessB age TTL

      expect(ledger.hasPending('sessA')).toBe(false)
      expect(ledger.hasPending('sessB')).toBe(true)
    })
  })

  // ── (d) stale / unknown correlation id ──────────────────────────────
  describe('stale / unknown correlation id', () => {
    it('confirm with an unknown correlation id aborts and keeps nothing', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const res = ledger.confirm({
        sessionKey: SESSION,
        correlationId: 'corr-ZZ-WRONG',
        field: FIELD,
        text: TEXT,
      })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('correlation_mismatch')
      // A non-matching attempt does NOT commit, but also does not silently
      // drop the still-valid pending entry (only cancel/commit/expiry do).
      expect(ledger.hasPending(SESSION)).toBe(true)
    })

    it('confirm for a session that never opened a write aborts with no_pending', () => {
      const res = ledger.confirm({
        sessionKey: 'never-opened',
        correlationId: CORR,
        field: FIELD,
        text: TEXT,
      })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('no_pending')
    })
  })

  // ── (e) mismatched text ─────────────────────────────────────────────
  describe('mismatched text', () => {
    it('confirm with text differing by even one char aborts (exact fingerprint)', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const res = ledger.confirm({
        sessionKey: SESSION,
        correlationId: CORR,
        field: FIELD,
        text: TEXT + 'x',
      })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('text_mismatch')
      expect(ledger.hasPending(SESSION)).toBe(true)
    })

    it('whitespace-only difference still aborts (no normalization)', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const res = ledger.confirm({
        sessionKey: SESSION,
        correlationId: CORR,
        field: FIELD,
        text: ` ${TEXT} `,
      })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('text_mismatch')
    })
  })

  // ── (f) mismatched field ────────────────────────────────────────────
  describe('mismatched field', () => {
    it('confirm with a different resolved field aborts', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const res = ledger.confirm({
        sessionKey: SESSION,
        correlationId: CORR,
        field: 'ZZFIELD_OTHER',
        text: TEXT,
      })
      expect(res.committed).toBe(false)
      if (!res.committed) expect(res.reason).toBe('field_mismatch')
      expect(ledger.hasPending(SESSION)).toBe(true)
    })
  })

  // ── (g) concurrent / second-pending rejection ───────────────────────
  describe('single-in-flight (concurrent / second-pending rejection)', () => {
    it('a second open() while one is pending is rejected and does not clobber the first', () => {
      const first = ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(first.accepted).toBe(true)

      const second = ledger.open({
        sessionKey: SESSION,
        correlationId: 'corr-ZZ-0002',
        field: 'ZZFIELD_OTHER',
        text: 'ZZSYNTH_OTHER',
      })
      expect(second.accepted).toBe(false)
      if (!second.accepted) expect(second.reason).toBe('already_pending')

      // The ORIGINAL entry survived — confirming it (not the rejected one)
      // is what commits.
      const res = ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      expect(ok(res)).toBe(true)
    })

    it('after the first resolves, a new open() for the same session is accepted', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })

      const reopen = ledger.open({
        sessionKey: SESSION,
        correlationId: 'corr-ZZ-0003',
        field: FIELD,
        text: 'ZZSYNTH_AGAIN',
      })
      expect(reopen.accepted).toBe(true)
    })

    it('a second open() is accepted once the first has expired by TTL', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      clock.advance(TTL + 1)
      const reopen = ledger.open({
        sessionKey: SESSION,
        correlationId: 'corr-ZZ-0004',
        field: FIELD,
        text: 'ZZSYNTH_AFTER_TTL',
      })
      expect(reopen.accepted).toBe(true)
    })

    it('different sessions each get their own independent in-flight slot', () => {
      expect(ledger.open({ sessionKey: 'sA', correlationId: 'cA', field: FIELD, text: TEXT }).accepted).toBe(true)
      expect(ledger.open({ sessionKey: 'sB', correlationId: 'cB', field: FIELD, text: TEXT }).accepted).toBe(true)
      expect(ledger.hasPending('sA')).toBe(true)
      expect(ledger.hasPending('sB')).toBe(true)
    })
  })

  // ── PHI hygiene: the ledger must never print/log the stored text ────
  describe('PHI hygiene', () => {
    it('does not write the pending text to console on open/confirm/cancel', () => {
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
        vi.spyOn(console, 'debug').mockImplementation(() => {}),
      ]
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      ledger.confirm({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: 'ZZSYNTH_WRONG' })
      ledger.cancel(SESSION)

      for (const s of spies) {
        for (const call of s.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(TEXT)
        }
        s.mockRestore()
      }
    })

    it('peekPending() exposes metadata but never the raw text', () => {
      ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })
      const meta = ledger.peekPending(SESSION)
      expect(meta).not.toBeNull()
      expect(meta?.field).toBe(FIELD)
      expect(meta?.correlationId).toBe(CORR)
      expect(JSON.stringify(meta)).not.toContain(TEXT)
    })
  })
})

// ── Thin telegram-hook integration function (additive) ──────────────────
describe('telegram-hook: resolveAthenaPendingWrite (additive integration)', () => {
  it('commits when the affirmative matches the ledger entry exactly', async () => {
    const { resolveAthenaPendingWrite } = await import('../../orchestrator/telegram-hook.js')
    const clock = makeClock()
    const ledger = new AthenaWriteLedger({ now: clock.now, ttlMs: TTL })
    ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })

    const r = resolveAthenaPendingWrite(ledger, {
      sessionKey: SESSION,
      correlationId: CORR,
      field: FIELD,
      text: TEXT,
    })
    expect(r.committed).toBe(true)
  })

  it('aborts (does not commit) on a stale correlation id', async () => {
    const { resolveAthenaPendingWrite } = await import('../../orchestrator/telegram-hook.js')
    const clock = makeClock()
    const ledger = new AthenaWriteLedger({ now: clock.now, ttlMs: TTL })
    ledger.open({ sessionKey: SESSION, correlationId: CORR, field: FIELD, text: TEXT })

    const r = resolveAthenaPendingWrite(ledger, {
      sessionKey: SESSION,
      correlationId: 'WRONG',
      field: FIELD,
      text: TEXT,
    })
    expect(r.committed).toBe(false)
  })
})
