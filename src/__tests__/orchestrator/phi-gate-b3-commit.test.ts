// Φ-PHI-Flow — Phase 2 / Wave 2 / T8: the WRITE-COMMIT audit hook (B3).
//
// This is the SAFETY CONTRACT for the commit-side signed access block:
//
//   • At the AVSO confirm/commit resolution in `handleAthenaConfirmReply`
//     — where a free-text Athena write is actually COMMITTED vs
//     CANCELLED — the hook emits exactly ONE signed access block via the
//     FROZEN T5 emitter contract:
//         emitAccessBlock(
//           {decision, resourceHash, corrId, cmdKind, tier, deviceId, ts},
//           deps): void
//   • committed  → decision = 'allow:committed'
//   • cancel / timeout / ledger-mismatch / non-affirmative
//                → decision = 'deny:cancelled'
//   • The block is keyed off the REDACTED correlation id only. It is
//     PHI-BLIND BY CONSTRUCTION: it never reads the write-ledger text,
//     and the emitted payload contains ZERO of the synthetic write-text
//     token. resourceHash/cmdKind/corrId are derived from the NON-PHI
//     command descriptor, never the write text (G2/AC2; SPEC R5).
//   • Idempotent: one block per resolution (a single confirm/cancel
//     never double-emits).
//   • Sibling T5 owns the real emitter (`phi-gate.ts`). It is NOT
//     imported here — the hook takes the emitter as an injected dep
//     (same idiom as `dispatchCommit`). Here it is a mock; the
//     PHI-blindness proof is: assert the synthetic write-text token is
//     absent from EVERY captured emit argument.
//
// PHI rule: SYNTHETIC field/text only. The write-text token below is
// obviously fake; we assert it is ABSENT from every emitted block.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  composeAthenaConfirm,
  handleAthenaConfirmReply,
  __resetAthenaConfirms,
} from '../../orchestrator/telegram-hook.js'
import { AthenaWriteLedger } from '../../orchestrator/athena-write-ledger.js'

// Synthetic, obviously-fake. NEVER realistic patient data. The whole
// point of T8: this token must NEVER reach an emitted audit block.
const SYNTH_FIELD = 'assessment'
const SYNTH_TEXT = 'ZZSYNTH_WRITETEXT_no_acute_distress_42'
const CORR = 'avso-ic-zzz9-abc123'
const CHAT = 'chatB3'
const DEVICE = 'device-zz-synthetic'

interface EmitArgs {
  decision: string
  resourceHash: string
  corrId: string
  cmdKind: string
  tier: number
  deviceId: string
  ts: string
}

function makeCtx() {
  const delivered: string[] = []
  const dispatched: Array<{ command_type: string; args: Record<string, unknown> }> = []
  const emits: EmitArgs[] = []
  const deliver = vi.fn(async (_chatId: string, text: string) => {
    delivered.push(text)
  })
  const dispatchCommit = vi.fn(
    async (step: { command_type: string; args: Record<string, unknown> }) => {
      dispatched.push(step)
      return { ok: true }
    },
  )
  // The injected B3 audit emitter — stands in for T5's
  // phi-gate.ts:emitAccessBlock. We capture every call's first arg.
  const emitAccessBlock = vi.fn((args: EmitArgs) => {
    emits.push(args)
  })
  return { delivered, dispatched, emits, deliver, dispatchCommit, emitAccessBlock }
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetAthenaConfirms()
})

describe('T8 B3 — commit path → one allow:committed block, PHI-blind', () => {
  it('exact affirmative commits → exactly ONE emitAccessBlock(allow:committed) keyed on corrId', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
    )

    expect(out.committed).toBe(true)
    // Exactly one signed block for this resolution.
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
    expect(emits).toHaveLength(1)
    const b = emits[0]
    expect(b.decision).toBe('allow:committed')
    // Keyed off the REDACTED correlation id only.
    expect(b.corrId).toBe(CORR)
    expect(b.deviceId).toBe(DEVICE)
    expect(b.cmdKind).toBe('athena-input-commit')
    expect(typeof b.ts).toBe('string')
    expect(b.ts.length).toBeGreaterThan(0)
    expect(typeof b.resourceHash).toBe('string')
    expect(b.resourceHash.length).toBeGreaterThan(0)
    expect(typeof b.tier).toBe('number')
  })

  it('PHI-blindness: the synthetic write-text token is absent from EVERY emit argument', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'yes',
      ledger,
    )

    // The whole serialized emit payload must contain ZERO of the
    // synthetic write-text token — the audit hook is PHI-blind by
    // construction (corrId / descriptor only, never the write text).
    const blob = JSON.stringify(emits)
    expect(blob).not.toContain(SYNTH_TEXT)
    // resourceHash is derived from the NON-PHI descriptor, so it must not
    // be the raw text either.
    for (const b of emits) {
      expect(b.resourceHash).not.toContain(SYNTH_TEXT)
      expect(b.corrId).not.toContain(SYNTH_TEXT)
      expect(b.cmdKind).not.toContain(SYNTH_TEXT)
    }
  })

  it('idempotent: a committed entry is single-use → a second reply emits no extra block', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
    )
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)

    // Gate is consumed; a second 'ok' is not claimed (no pending) → no
    // new block (one block per resolution).
    const again = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
    )
    expect(again.handled).toBe(false)
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
  })
})

describe('T8 B3 — cancel / timeout / mismatch → one deny:cancelled block', () => {
  it('explicit cancel → exactly ONE emitAccessBlock(deny:cancelled), no write text', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'cancel',
      ledger,
    )

    expect(out.committed).toBe(false)
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
    expect(emits[0].decision).toBe('deny:cancelled')
    expect(emits[0].corrId).toBe(CORR)
    expect(JSON.stringify(emits)).not.toContain(SYNTH_TEXT)
  })

  it('expired / stale pending on confirm → one deny:cancelled block', async () => {
    let nowMs = 1_000_000
    const ledger = new AthenaWriteLedger({ now: () => nowMs, ttlMs: 10 * 60 * 1000 })
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    nowMs += 11 * 60 * 1000 // past TTL

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
    )

    expect(out.committed).toBe(false)
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
    expect(emits[0].decision).toBe('deny:cancelled')
    expect(emits[0].corrId).toBe(CORR)
    expect(JSON.stringify(emits)).not.toContain(SYNTH_TEXT)
  })

  it('ledger text mismatch (tamper) on exact affirmative → one deny:cancelled block', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
      { correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT + '_TAMPERED' },
    )

    expect(out.committed).toBe(false)
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
    expect(emits[0].decision).toBe('deny:cancelled')
    expect(emits[0].corrId).toBe(CORR)
    // Neither the staged token nor the tampered token may leak.
    const blob = JSON.stringify(emits)
    expect(blob).not.toContain(SYNTH_TEXT)
    expect(blob).not.toContain('_TAMPERED')
  })

  it('non-affirmative typo (gate stays armed) → one deny:cancelled block, no commit', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emits, emitAccessBlock } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'oky', // typo — not an exact affirmative
      ledger,
    )

    expect(out.committed).toBe(false)
    expect(dispatchCommit).not.toHaveBeenCalled()
    // The resolution did NOT commit → it is a deny:cancelled audit event.
    expect(emitAccessBlock).toHaveBeenCalledTimes(1)
    expect(emits[0].decision).toBe('deny:cancelled')
  })

  it('no pending at all → reply not claimed → NO block emitted (nothing to audit)', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit, emitAccessBlock } = makeCtx()

    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit, emitAccessBlock, deviceId: DEVICE },
      CHAT,
      'ok',
      ledger,
    )
    expect(out.handled).toBe(false)
    expect(emitAccessBlock).not.toHaveBeenCalled()
  })
})

describe('T8 B3 — backward compatible (emitter optional)', () => {
  it('omitting the emitter does not break the existing confirm path', async () => {
    const ledger = new AthenaWriteLedger()
    const { deliver, dispatchCommit } = makeCtx()

    await composeAthenaConfirm(
      { deliver },
      { chatId: CHAT, correlationId: CORR, field: SYNTH_FIELD, text: SYNTH_TEXT },
      ledger,
    )
    const out = await handleAthenaConfirmReply(
      { deliver, dispatchCommit },
      CHAT,
      'ok',
      ledger,
    )
    expect(out.committed).toBe(true)
    expect(dispatchCommit).toHaveBeenCalledTimes(1)
  })
})
