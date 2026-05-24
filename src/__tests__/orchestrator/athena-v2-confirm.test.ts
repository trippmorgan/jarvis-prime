// AVSO v2 — Wave 3 / T9: Telegram confirm integration (the L3 human
// audit gate for the free-text write).
//
// These tests are the SAFETY CONTRACT for the confirm path:
//
//   • The confirm message echoes the EXACT to-be-written text + the
//     resolved field via the accepted Telegram path — NOT reconstructed
//     from an LLM transcript / the redacted orchestrate result (C5).
//   • An exact affirmative (`ok`/`yes`) → ledger commit → exactly one
//     `athena-input-commit` dispatch carrying the prepare correlation id.
//   • Wrong/typo reply → NO commit, gate stays armed (retry until TTL).
//   • Stale id / cancel / timeout / second concurrent pending → abort,
//     NO commit, honest "write cancelled — not confirmed".
//   • A patient-search (athena-patient-nav) reply is NON-PHI only.
//   • The staged write text NEVER appears in any logged / transcript /
//     kernel-envelope fixture (only the Telegram confirm echo carries it
//     — the one SPEC-sanctioned outbound exception).
//
// PHI rule: SYNTHETIC field/text only. The tokens below are obviously
// fake; we assert they are ABSENT everywhere except the Telegram echo.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { orchestrate, classifyIntent } = vi.hoisted(() => ({
  orchestrate: vi.fn(),
  classifyIntent: vi.fn(() => 'chat'),
}))
vi.mock('../../orchestrator/index.js', () => ({
  orchestrate,
  classifyIntent: (t: string) => classifyIntent(t),
  renderResult: (c: Record<string, unknown>) => JSON.stringify(c),
  actionLabel: (cmd?: string) => cmd ?? 'do it',
}))

import {
  composeAthenaConfirm,
  handleAthenaConfirmReply,
  composeAthenaPatientSearchReply,
  __resetAthenaConfirms,
} from '../../orchestrator/telegram-hook.js'
import { AthenaWriteLedger } from '../../orchestrator/athena-write-ledger.js'

// Synthetic, obviously-fake. NEVER realistic patient data.
const SYNTH_FIELD = 'assessment'
const SYNTH_TEXT = 'ZZSYNTH_WRITETEXT_no_acute_distress_42'
const SYNTH_QUERY = 'ZZSYNTH_PATIENT_Qx'
const CORR = 'avso-ic-zzz9-abc123'
const CHAT = 'chatAVSO'

function makeCtx() {
  const delivered: string[] = []
  const dispatched: Array<{ command_type: string; args: Record<string, unknown> }> = []
  const deliver = vi.fn(async (_chatId: string, text: string) => {
    delivered.push(text)
  })
  // The commit dispatch sink — stands in for the kernel envelope path.
  const dispatchCommit = vi.fn(
    async (step: { command_type: string; args: Record<string, unknown> }) => {
      dispatched.push(step)
      return { ok: true }
    },
  )
  return { delivered, dispatched, deliver, dispatchCommit }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetAthenaConfirms()
})

describe('AVSO v2 T9 — confirm compose (C5: exact text via Telegram path)', () => {
  it('opens a ledger entry and echoes the EXACT synthetic text + field', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, delivered } = makeCtx()

    const res = await composeAthenaConfirm(
      { deliver },
      {
        chatId: CHAT,
        correlationId: CORR,
        field: SYNTH_FIELD,
        // Exact text comes from the trusted Telegram-side context — NOT
        // from the redacted orchestrate result.
        text: SYNTH_TEXT,
      },
      ledger,
    )

    expect(res.armed).toBe(true)
    // Ledger now holds a live pending entry for this chat.
    expect(ledger.hasPending(CHAT)).toBe(true)
    expect(ledger.peekPending(CHAT)?.correlationId).toBe(CORR)
    expect(ledger.peekPending(CHAT)?.field).toBe(SYNTH_FIELD)

    // The confirm message shows the exact text + the resolved field.
    const msg = delivered.join('\n')
    expect(msg).toContain(SYNTH_TEXT)
    expect(msg).toContain(SYNTH_FIELD)
    // It must read as a confirm gate consistent with the W21 tier-3 UX.
    expect(msg.toLowerCase()).toMatch(/\bok\b|\byes\b/)
    expect(msg.toLowerCase()).toContain('cancel')
  })

  it('a second concurrent pending write for the same chat is rejected (no clobber)', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, delivered } = makeCtx()

    const first = await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    expect(first.armed).toBe(true)

    const second = await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: 'avso-ic-other', field: 'plan', text: 'ZZSYNTH_OTHER' },
      ledger,
    )
    expect(second.armed).toBe(false)
    expect(second.reason).toBe('already_pending')
    // The first entry was NOT clobbered.
    expect(ledger.peekPending(CHAT)?.correlationId).toBe(CORR)
    // The user was told, without leaking the second text.
    expect(delivered.join('\n')).not.toContain('ZZSYNTH_OTHER')
  })
})

describe('AVSO v2 T9 — affirmative grammar → ledger commit → dispatch', () => {
  for (const word of ['ok', 'OK', 'yes', ' Yes ', 'okay']) {
    it(`affirmative "${word}" commits the matching write and dispatches input-commit once`, async () => {
      const ledger = new AthenaWriteLedger()
      const { deliver, dispatchCommit, dispatched } = makeCtx()

      await composeAthenaConfirm(
        { deliver },
        { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
        ledger,
      )

      const out = await handleAthenaConfirmReply(
        { deliver, dispatchCommit },
        CHAT,
        word,
        ledger,
      )

      expect(out.handled).toBe(true)
      expect(out.committed).toBe(true)
      // Exactly one commit dispatch, carrying the prepare correlation id.
      expect(dispatchCommit).toHaveBeenCalledTimes(1)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].command_type).toBe('athena-input-commit')
      expect(dispatched[0].args.correlation_id).toBe(CORR)
      // The dispatched envelope is REDACTED — the synthetic text is absent.
      expect(JSON.stringify(dispatched[0])).not.toContain(SYNTH_TEXT)
      expect(dispatched[0].args.write_text).toBe('<WRITE_TEXT>')
      // Ledger entry consumed (single-use).
      expect(ledger.hasPending(CHAT)).toBe(false)
    })
  }

  it('the commit carries a corr-id reusing the prepare id (avso-ic-<…>)', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, dispatched } = makeCtx()
    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    await handleAthenaConfirmReply({ deliver, dispatchCommit }, CHAT, 'yes', ledger)
    expect(dispatched[0].args.correlation_id).toBe(CORR)
    expect(String(dispatched[0].args.correlation_id)).toMatch(/^avso-ic-/)
  })
})

describe('AVSO v2 T9 — abort semantics (NO commit, honest message)', () => {
  it('a typo / non-affirmative does NOT commit; the gate stays armed for retry', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, delivered } = makeCtx()
    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'oky', // typo — NOT an exact affirmative
      ledger,
    )

    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
    // Gate stays armed — Tripp can still confirm.
    expect(ledger.hasPending(CHAT)).toBe(true)
    expect(delivered.join('\n').toLowerCase()).toContain('not confirmed')

    // …and a subsequent exact affirmative still works.
    const ok = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'ok',
      ledger,
    )
    expect(ok.committed).toBe(true)
    expect(dispatchCommit).toHaveBeenCalledTimes(1)
  })

  it('an explicit cancel aborts: NO commit, ledger cleared, honest message', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, delivered } = makeCtx()
    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'cancel',
      ledger,
    )

    expect(out.handled).toBe(true)
    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
    expect(ledger.hasPending(CHAT)).toBe(false)
    const msg = delivered.join('\n').toLowerCase()
    expect(msg).toContain('cancel')
    expect(msg).toContain('not confirmed')
  })

  it('a stale / expired pending aborts on confirm: NO commit, honest message', async () => {
    let nowMs = 1_000_000
    const ledger = new AthenaWriteLedger({ now: () => nowMs, ttlMs: 10 * 60 * 1000 })
    const { deliver, dispatchCommit, delivered } = makeCtx()
    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )

    // Advance the injected clock past the TTL.
    nowMs += 11 * 60 * 1000

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'ok',
      ledger,
    )

    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
    expect(ledger.hasPending(CHAT)).toBe(false)
    expect(delivered.join('\n').toLowerCase()).toContain('not confirmed')
  })

  it('no pending at all → reply is not claimed by the AVSO confirm path', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit } = makeCtx()
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'ok',
      ledger,
    )
    expect(out.handled).toBe(false)
    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
  })

  it('a correlation/field/text mismatch between staged + reply context aborts (no commit)', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, delivered } = makeCtx()
    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    // The affirmative is exact, but the trusted reply context the hook
    // resolved disagrees on the text — the ledger must refuse to commit.
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'ok',
      ledger,
      { correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT + '_TAMPERED' },
    )
    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
    expect(delivered.join('\n').toLowerCase()).toContain('not confirmed')
    // A non-matching attempt does not burn a still-valid entry.
    expect(ledger.hasPending(CHAT)).toBe(true)
  })
})

describe('AVSO v2 T9 — patient-search reply is NON-PHI only', () => {
  it('never echoes the query or any result — only a screen-pick instruction', () => {
    const reply = composeAthenaPatientSearchReply({ query: SYNTH_QUERY })
    expect(reply).not.toContain(SYNTH_QUERY)
    expect(reply.toLowerCase()).toContain('search submitted')
    expect(reply.toLowerCase()).toContain('screen')
    // No record/result echo language.
    expect(reply.toLowerCase()).not.toContain('result')
    expect(reply.toLowerCase()).not.toContain('found')
  })

  it('is non-PHI even with no query supplied', () => {
    const reply = composeAthenaPatientSearchReply({})
    expect(reply.toLowerCase()).toContain('search submitted')
    expect(reply.toLowerCase()).toContain('screen')
  })
})

describe('AVSO v2 T9 — the staged text never leaks beyond the Telegram echo', () => {
  it('not in the dispatched envelope, not in any non-deliver sink', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, dispatched, delivered } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    await handleAthenaConfirmReply({ deliver, dispatchCommit }, CHAT, 'ok', ledger)

    // The Telegram echo (deliver) IS allowed to carry the text — that is
    // the one SPEC-sanctioned outbound exception (Tripp must verify it).
    expect(delivered.join('\n')).toContain(SYNTH_TEXT)

    // EVERYTHING ELSE must be clean. The kernel-bound dispatch envelope:
    const dispatchBlob = JSON.stringify(dispatched)
    expect(dispatchBlob).not.toContain(SYNTH_TEXT)
    // peekPending (observability) never returns the text.
    expect(JSON.stringify(ledger.peekPending(CHAT))).not.toContain(SYNTH_TEXT)
  })
})
