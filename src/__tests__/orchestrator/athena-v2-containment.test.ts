// AVSO v2 — Wave 4 / T10: PHI / LOG CONTAINMENT HARNESS (jarvis-prime side).
//
// This is the automated PROOF that synthetic-PHI never escapes into any
// session / log / kernel-envelope / handler-return / memory-like output
// across the four v2 paths:
//
//   • patient-search      (buildAvsoV2Context / buildAvsoV2PlanStep)
//   • input-prepare       (buildAvsoV2Context / buildAvsoV2PlanStep)
//   • input-commit        (buildAvsoV2Context / buildAvsoV2PlanStep +
//                           the telegram-hook confirm → commit dispatch)
//   • schedule-date-probe (buildAvsoV2Context / buildAvsoV2PlanStep)
//
// The ONLY place the raw write text is allowed to appear is the one
// SPEC-sanctioned Telegram confirm-echo (the `deliver` sink — Tripp must
// be able to audit exactly what will be written). We assert it appears
// THERE and provably NOWHERE ELSE (not in the dispatched/kernel-bound
// envelope, not in the ledger's PHI-safe peek, not in any console /
// stdout / stderr line emitted while the path runs).
//
// TDD: we FIRST prove the containment scanner can DETECT a leak using a
// deliberately-leaky local synthetic stub (RED), then assert the REAL
// public surfaces are clean (GREEN). A scanner that has never caught a
// leak proves nothing.
//
// PHI rule: SYNTHETIC, obviously-fake tokens only. Counts-only synthetic
// scans. NO live Athena / CDP / SSH / Telegram / EMR. Deterministic +
// offline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Telegram-hook imports orchestrator/index.js transitively; stub it the
// same way athena-v2-confirm.test.ts does so this stays pure + offline.
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
  buildAvsoV2Context,
  newCorrelationId,
} from '../../orchestrator/types.js'
import { buildAvsoV2PlanStep } from '../../orchestrator/plan.js'
import { AthenaWriteLedger } from '../../orchestrator/athena-write-ledger.js'
import {
  composeAthenaConfirm,
  handleAthenaConfirmReply,
  composeAthenaPatientSearchReply,
  __resetAthenaConfirms,
} from '../../orchestrator/telegram-hook.js'

// ─── Synthetic, obviously-fake PHI-class tokens. NEVER realistic data. ───
const SYNTH_QUERY = 'ZZSYNTH_PATIENT_Q'
const SYNTH_WRITE = 'ZZSYNTH_WRITETEXT'
// A longer realistic-shaped (but still synthetic) write body — the kind
// of free-text a dictation would produce. Still obviously fake.
const SYNTH_WRITE_BODY = 'ZZSYNTH_WRITETEXT no acute distress, plan ZZSYNTH_PLAN_42'
const ALL_TOKENS = [SYNTH_QUERY, SYNTH_WRITE, SYNTH_WRITE_BODY, 'ZZSYNTH_PLAN_42']

// ─── Containment scanner (counts-only synthetic scan) ────────────────────

/** Count how many of `tokens` appear (as substrings) anywhere in `blob`. */
function countTokens(blob: string, tokens: string[]): number {
  let n = 0
  for (const t of tokens) if (blob.includes(t)) n++
  return n
}

/** Hard assertion: NONE of `tokens` appear anywhere in `blob`. Returns
 *  the count so callers can also use it as a leak-DETECTOR (count > 0). */
function expectClean(blob: string, tokens: string[], where: string): number {
  const hits = countTokens(blob, tokens)
  expect(hits, `synthetic PHI leaked into ${where}`).toBe(0)
  return hits
}

/**
 * Capture every console.{log,info,warn,error,debug} + process stdout/stderr
 * write produced while `fn` runs, returned as one joined blob. Used to
 * prove no v2 path logs the synthetic tokens.
 */
async function captureConsole(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = []
  const push = (...a: unknown[]) =>
    lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a) => push(...a)),
    vi.spyOn(console, 'info').mockImplementation((...a) => push(...a)),
    vi.spyOn(console, 'warn').mockImplementation((...a) => push(...a)),
    vi.spyOn(console, 'error').mockImplementation((...a) => push(...a)),
    vi.spyOn(console, 'debug').mockImplementation((...a) => push(...a)),
  ]
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((c: unknown) => {
      lines.push(String(c))
      return true
    }) as typeof process.stdout.write)
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((c: unknown) => {
      lines.push(String(c))
      return true
    }) as typeof process.stderr.write)
  try {
    await fn()
  } finally {
    for (const s of spies) s.mockRestore()
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
  return lines.join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetAthenaConfirms()
})
afterEach(() => {
  __resetAthenaConfirms()
})

// ─── RED proof: the scanner DOES catch a real leak ───────────────────────
//
// A scanner that has never failed proves nothing. Here we build a
// deliberately-leaky synthetic stub (the kind of mistake a future
// regression could introduce — copying the raw text straight into the
// "envelope"). We assert that running our containment check against that
// leaky output FAILS (throws). We catch the failure HERE so this harness
// file itself stays GREEN while still proving the detector works.

describe('AVSO v2 T10 — RED proof: the containment scanner detects a real leak', () => {
  // A leaky stand-in for buildAvsoV2Context: the bug is copying the raw
  // text into the envelope instead of replacing it with a placeholder.
  function leakyBuildContext(raw: string): Record<string, unknown> {
    return {
      kind: 'athena-input-commit',
      risk_tier: 3,
      correlation_id: 'avso-ic-deadbeef-000000',
      // THE LEAK: raw PHI copied straight through.
      write_text: raw,
    }
  }

  it('countTokens returns > 0 when raw text is present (detector is live)', () => {
    const leaked = JSON.stringify(leakyBuildContext(SYNTH_WRITE_BODY))
    expect(countTokens(leaked, ALL_TOKENS)).toBeGreaterThan(0)
  })

  it('expectClean THROWS against a leaky envelope (proves it would fail RED)', () => {
    const leaked = JSON.stringify(leakyBuildContext(SYNTH_WRITE_BODY))
    let threw = false
    try {
      // This is the exact assertion the real-surface tests use. Against
      // leaky output it MUST throw — otherwise the harness is blind.
      expectClean(leaked, ALL_TOKENS, 'leaky-stub-envelope')
    } catch {
      threw = true
    }
    expect(threw, 'containment assertion failed to detect an obvious leak').toBe(true)
  })

  it('a leaky console logger is also caught by captureConsole + expectClean', async () => {
    const blob = await captureConsole(() => {
      // Simulate a future regression that logs the raw write text.
      console.log(`staging write: ${SYNTH_WRITE_BODY}`)
    })
    let threw = false
    try {
      expectClean(blob, ALL_TOKENS, 'leaky-console')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

// ─── GREEN: the REAL public surfaces are provably clean ──────────────────

describe('AVSO v2 T10 — buildAvsoV2Context: no synthetic PHI in any context', () => {
  it('patient-search context + its console trace are clean', async () => {
    let ctx: unknown
    const log = await captureConsole(() => {
      ctx = buildAvsoV2Context({
        kind: 'athena-patient-search',
        rawPatientQuery: SYNTH_QUERY,
      })
    })
    expectClean(JSON.stringify(ctx), ALL_TOKENS, 'patient-search context')
    expectClean(log, ALL_TOKENS, 'patient-search build console')
  })

  it('input-prepare context + console trace are clean', async () => {
    let ctx: unknown
    const log = await captureConsole(() => {
      ctx = buildAvsoV2Context({
        kind: 'athena-input-prepare',
        rawWriteText: SYNTH_WRITE_BODY,
        fieldId: 'assessment',
      })
    })
    expectClean(JSON.stringify(ctx), ALL_TOKENS, 'input-prepare context')
    expectClean(log, ALL_TOKENS, 'input-prepare build console')
  })

  it('input-commit context (re-using a prepare corr id) is clean', async () => {
    const corr = newCorrelationId('athena-input-prepare')
    let ctx: unknown
    const log = await captureConsole(() => {
      ctx = buildAvsoV2Context({
        kind: 'athena-input-commit',
        rawWriteText: SYNTH_WRITE_BODY,
        fieldId: 'assessment',
        correlationId: corr,
      })
    })
    expectClean(JSON.stringify(ctx), ALL_TOKENS, 'input-commit context')
    expectClean(log, ALL_TOKENS, 'input-commit build console')
  })

  it('schedule-date-probe context is clean (carries no PHI text at all)', async () => {
    let ctx: unknown
    const log = await captureConsole(() => {
      ctx = buildAvsoV2Context({
        kind: 'athena-schedule-date-probe',
        date: '2026-05-19',
      })
    })
    expectClean(JSON.stringify(ctx), ALL_TOKENS, 'schedule-date-probe context')
    expectClean(log, ALL_TOKENS, 'schedule-date-probe build console')
  })
})

describe('AVSO v2 T10 — buildAvsoV2PlanStep: no synthetic PHI in any kernel-bound step', () => {
  const cases = [
    {
      name: 'patient-search',
      input: { kind: 'athena-patient-search' as const, rawPatientQuery: SYNTH_QUERY },
    },
    {
      name: 'input-prepare',
      input: {
        kind: 'athena-input-prepare' as const,
        rawWriteText: SYNTH_WRITE_BODY,
        fieldId: 'assessment',
      },
    },
    {
      name: 'input-commit',
      input: {
        kind: 'athena-input-commit' as const,
        rawWriteText: SYNTH_WRITE_BODY,
        fieldId: 'plan',
      },
    },
    {
      name: 'schedule-date-probe',
      input: { kind: 'athena-schedule-date-probe' as const, date: '2026-05-19' },
    },
  ]

  for (const c of cases) {
    it(`${c.name} PlanStep (the kernel envelope) carries no synthetic PHI`, async () => {
      let step: unknown
      const log = await captureConsole(() => {
        step = buildAvsoV2PlanStep(c.input)
      })
      // The step IS the kernel-bound payload (target/command_type/args).
      expectClean(JSON.stringify(step), ALL_TOKENS, `${c.name} PlanStep`)
      expectClean(log, ALL_TOKENS, `${c.name} PlanStep build console`)
    })
  }

  it('deep redaction: a sneaky raw body containing placeholder-looking text still does not leak', () => {
    const sneaky = `${SYNTH_WRITE_BODY} <WRITE_TEXT> <PATIENT_QUERY>`
    const step = buildAvsoV2PlanStep({
      kind: 'athena-input-prepare',
      rawWriteText: sneaky,
      fieldId: 'hpi',
    })
    expectClean(JSON.stringify(step), ALL_TOKENS, 'sneaky input-prepare PlanStep')
  })
})

describe('AVSO v2 T10 — ledger: peekPending is PHI-safe (no staged text)', () => {
  it('an armed pending write never exposes the synthetic text via peekPending', () => {
    const ledger = new AthenaWriteLedger()
    const corr = 'avso-ic-zzz9-abc123'
    const opened = ledger.open({
      sessionKey: 'chatT10',
      correlationId: corr,
      field: 'assessment',
      text: SYNTH_WRITE_BODY,
    })
    expect(opened.accepted).toBe(true)
    // peekPending is the observability surface — it MUST be clean.
    expectClean(
      JSON.stringify(ledger.peekPending('chatT10')),
      ALL_TOKENS,
      'ledger.peekPending',
    )
    // hasPending is a boolean — trivially clean, but assert the contract.
    expect(ledger.hasPending('chatT10')).toBe(true)
  })
})

describe('AVSO v2 T10 — telegram-hook confirm path: text appears ONLY in the sanctioned echo', () => {
  const CHAT = 'chatT10'
  const FIELD = 'assessment'
  const CORR = 'avso-ic-zzz9-abc123'

  function makeSinks() {
    const delivered: string[] = []
    const dispatched: Array<{ command_type: string; args: Record<string, unknown> }> = []
    const deliver = vi.fn(async (_chatId: string, text: string) => {
      delivered.push(text)
    })
    // Stands in for the kernel envelope path (the commit dispatch sink).
    const dispatchCommit = vi.fn(
      async (step: { command_type: string; args: Record<string, unknown> }) => {
        dispatched.push(step)
        return { ok: true }
      },
    )
    return { delivered, dispatched, deliver, dispatchCommit }
  }

  it('compose → affirmative commit: text is in deliver ONLY, absent everywhere else', async () => {
    const ledger = new AthenaWriteLedger()
    const { delivered, dispatched, deliver, dispatchCommit } = makeSinks()

    const consoleBlob = await captureConsole(async () => {
      const armed = await composeAthenaConfirm(
        { deliver },
        { chatId: CHAT, correlationId: CORR, field: FIELD, text: SYNTH_WRITE_BODY },
        ledger,
      )
      expect(armed.armed).toBe(true)
      const out = await handleAthenaConfirmReply(
        { deliver, dispatchCommit },
        CHAT,
        'ok',
        ledger,
      )
      expect(out.committed).toBe(true)
    })

    // (1) The ONE SPEC-sanctioned appearance: the Telegram confirm echo.
    const echo = delivered.join('\n')
    expect(
      countTokens(echo, [SYNTH_WRITE_BODY]),
      'sanctioned Telegram confirm echo must carry the exact write text',
    ).toBeGreaterThan(0)

    // (2) The kernel-bound dispatch envelope MUST be clean.
    expectClean(JSON.stringify(dispatched), ALL_TOKENS, 'commit dispatch envelope')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].command_type).toBe('athena-input-commit')
    expect(dispatched[0].args.write_text).toBe('<WRITE_TEXT>')
    expect(dispatched[0].args.correlation_id).toBe(CORR)

    // (3) The ledger's observability surface MUST be clean (entry consumed
    // on commit, but assert the peek is clean regardless).
    expectClean(
      JSON.stringify(ledger.peekPending(CHAT)),
      ALL_TOKENS,
      'ledger.peekPending post-commit',
    )

    // (4) NO console / stdout / stderr line carried any synthetic token.
    expectClean(consoleBlob, ALL_TOKENS, 'confirm-path console')

    // (5) The handler RETURN dict (a memory-like / session output) is
    //     clean — re-run capturing the return explicitly.
    __resetAthenaConfirms()
    const l2 = new AthenaWriteLedger()
    const s2 = makeSinks()
    await composeAthenaConfirm(
      { deliver: s2.deliver },
      { chatId: CHAT, correlationId: CORR, field: FIELD, text: SYNTH_WRITE_BODY },
      l2,
    )
    const ret = await handleAthenaConfirmReply(
      { deliver: s2.deliver, dispatchCommit: s2.dispatchCommit },
      CHAT,
      'ok',
      l2,
    )
    expectClean(JSON.stringify(ret), ALL_TOKENS, 'handleAthenaConfirmReply return')
  })

  it('rejected second concurrent write: the second text never leaks anywhere', async () => {
    const ledger = new AthenaWriteLedger()
    const { delivered, deliver } = makeSinks()
    const SECOND = 'ZZSYNTH_WRITETEXT_SECOND_should_never_appear'

    const consoleBlob = await captureConsole(async () => {
      await composeAthenaConfirm(
        { deliver },
        { chatId: CHAT, correlationId: CORR, field: FIELD, text: SYNTH_WRITE_BODY },
        ledger,
      )
      // A second, DIFFERENT staged text — must be refused and NEVER echoed.
      const second = await composeAthenaConfirm(
        { deliver },
        { chatId: CHAT, correlationId: 'avso-ic-other', field: 'plan', text: SECOND },
        ledger,
      )
      expect(second.armed).toBe(false)
    })

    // Only the FIRST text is in the (sanctioned) echo; the second never is.
    const echo = delivered.join('\n')
    expect(echo).toContain(SYNTH_WRITE_BODY) // first echo allowed
    expect(echo).not.toContain(SECOND) // second text NEVER echoed
    expectClean(consoleBlob, [SECOND], 'second-write console')
    expectClean(JSON.stringify(ledger.peekPending(CHAT)), [SECOND], 'ledger after reject')
  })

  it('cancel path: NO commit, NO synthetic text in dispatch / console / return', async () => {
    const ledger = new AthenaWriteLedger()
    const { dispatched, deliver, dispatchCommit } = makeSinks()
    let ret: unknown
    const consoleBlob = await captureConsole(async () => {
      await composeAthenaConfirm(
        { deliver },
        { chatId: CHAT, correlationId: CORR, field: FIELD, text: SYNTH_WRITE_BODY },
        ledger,
      )
      ret = await handleAthenaConfirmReply(
        { deliver, dispatchCommit },
        CHAT,
        'cancel',
        ledger,
      )
    })
    expect((ret as { committed: boolean }).committed).toBe(false)
    expect(dispatched).toHaveLength(0)
    expectClean(JSON.stringify(dispatched), ALL_TOKENS, 'cancel: dispatch')
    expectClean(JSON.stringify(ret), ALL_TOKENS, 'cancel: handler return')
    expectClean(consoleBlob, ALL_TOKENS, 'cancel: console')
  })

  it('patient-search Telegram reply is NON-PHI (never echoes the query)', async () => {
    let reply = ''
    const consoleBlob = await captureConsole(() => {
      reply = composeAthenaPatientSearchReply({ query: SYNTH_QUERY })
    })
    expectClean(reply, ALL_TOKENS, 'patient-search Telegram reply')
    expectClean(consoleBlob, ALL_TOKENS, 'patient-search reply console')
  })
})

describe('AVSO v2 T10 — full-path sweep across all four v2 kinds', () => {
  it('end-to-end synthetic sweep: write text confined to the Telegram echo, nowhere else', async () => {
    const sinks = {
      delivered: [] as string[],
      dispatched: [] as unknown[],
    }
    const deliver = vi.fn(async (_c: string, t: string) => {
      sinks.delivered.push(t)
    })
    const dispatchCommit = vi.fn(async (step: unknown) => {
      sinks.dispatched.push(step)
      return { ok: true }
    })
    const ledger = new AthenaWriteLedger()

    const consoleBlob = await captureConsole(async () => {
      // patient-search path
      buildAvsoV2PlanStep({
        kind: 'athena-patient-search',
        rawPatientQuery: SYNTH_QUERY,
      })
      composeAthenaPatientSearchReply({ query: SYNTH_QUERY })
      // schedule-date-probe path
      buildAvsoV2PlanStep({
        kind: 'athena-schedule-date-probe',
        date: '2026-05-19',
      })
      // input-prepare path
      buildAvsoV2PlanStep({
        kind: 'athena-input-prepare',
        rawWriteText: SYNTH_WRITE_BODY,
        fieldId: 'assessment',
      })
      // input-commit path (via the confirm gate)
      await composeAthenaConfirm(
        { deliver },
        {
          chatId: 'sweep',
          correlationId: 'avso-ic-sweep-000001',
          field: 'assessment',
          text: SYNTH_WRITE_BODY,
        },
        ledger,
      )
      await handleAthenaConfirmReply(
        { deliver, dispatchCommit },
        'sweep',
        'yes',
        ledger,
      )
    })

    // The sanctioned echo carries the text (exactly once-ish; presence is
    // what matters for the contract).
    expect(sinks.delivered.join('\n')).toContain(SYNTH_WRITE_BODY)

    // EVERYTHING else — kernel-bound dispatch, console/stdout/stderr,
    // ledger observability — must be clean.
    expectClean(JSON.stringify(sinks.dispatched), ALL_TOKENS, 'sweep: all dispatched envelopes')
    expectClean(consoleBlob, ALL_TOKENS, 'sweep: all console output')
    expectClean(JSON.stringify(ledger.peekPending('sweep')), ALL_TOKENS, 'sweep: ledger peek')
  })
})
