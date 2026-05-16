// W21.7 — intent-oversight: conservative re-read of auto-replies.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  reviewOrchestratorReply,
  _resetOversightBreakerForTests,
} from '../../orchestrator/intent-oversight.js'

function fakeFetch(content: string, opts: { onCall?: () => void; status?: number } = {}): typeof fetch {
  return (async () => {
    opts.onCall?.()
    return new Response(JSON.stringify({ message: { content } }), {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const base = {
  userText: 'Update',
  autoReply: 'Proceed with the update from 1.12.0 → 1.42.3?',
  klass: 'workflow',
  recentTurns: [{ role: 'user' as const, content: 'how is the deploy going' }],
}

describe('W21.7 intent-oversight — conservative verdicts', () => {
  beforeEach(() => _resetOversightBreakerForTests())

  it('OK → no correction', async () => {
    const v = await reviewOrchestratorReply(base, { fetchFn: fakeFetch('OK') })
    expect(v.ok).toBe(true)
    expect(v.correction).toBeUndefined()
  })

  it('FIX: <text> → correction surfaced', async () => {
    const v = await reviewOrchestratorReply(base, {
      fetchFn: fakeFetch('FIX: You meant a status update, not the software updater — want the status?'),
    })
    expect(v.ok).toBe(false)
    expect(v.correction).toContain('status update')
  })

  it('non-FIX prose defaults to OK (never nitpick-spam)', async () => {
    const v = await reviewOrchestratorReply(base, { fetchFn: fakeFetch('It looks mostly fine to me honestly') })
    expect(v.ok).toBe(true)
  })

  it('empty / too-short FIX defaults to OK', async () => {
    expect((await reviewOrchestratorReply(base, { fetchFn: fakeFetch('FIX:') })).ok).toBe(true)
    expect((await reviewOrchestratorReply(base, { fetchFn: fakeFetch('FIX: x') })).ok).toBe(true)
  })

  it('HTTP error / network throw / empty body → OK (never block or spam)', async () => {
    expect((await reviewOrchestratorReply(base, { fetchFn: fakeFetch('FIX: should not be used', { status: 500 }) })).ok).toBe(true)
    _resetOversightBreakerForTests()
    const throwing = (async () => { throw new Error('frank down') }) as unknown as typeof fetch
    expect((await reviewOrchestratorReply(base, { fetchFn: throwing })).ok).toBe(true)
    _resetOversightBreakerForTests()
    expect((await reviewOrchestratorReply(base, { fetchFn: fakeFetch('   ') })).ok).toBe(true)
  })

  it('disabled → OK, no network call', async () => {
    let calls = 0
    const v = await reviewOrchestratorReply(base, { enabled: false, fetchFn: fakeFetch('FIX: nope', { onCall: () => calls++ }) })
    expect(v.ok).toBe(true)
    expect(calls).toBe(0)
  })

  it('empty input short-circuits to OK without a call', async () => {
    let calls = 0
    const v = await reviewOrchestratorReply(
      { ...base, autoReply: '' },
      { fetchFn: fakeFetch('FIX: x', { onCall: () => calls++ }) },
    )
    expect(v.ok).toBe(true)
    expect(calls).toBe(0)
  })

  it('breaker opens after 2 failures, then skips the judge entirely', async () => {
    let calls = 0
    const throwing = (async () => { calls++; throw new Error('down') }) as unknown as typeof fetch
    await reviewOrchestratorReply(base, { fetchFn: throwing })
    await reviewOrchestratorReply(base, { fetchFn: throwing })
    expect(calls).toBe(2)
    const v = await reviewOrchestratorReply(base, { fetchFn: throwing })
    expect(v.ok).toBe(true)
    expect(calls).toBe(2) // breaker open — no further network
  })
})
