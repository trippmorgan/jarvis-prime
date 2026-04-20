/**
 * Wave 6 Sub-wave 6.4 — top-of-pipeline end-to-end smoke tests.
 *
 * Vertical slice: MessageProcessor -> (real) TelegramResponder -> mocked
 * TelegramSendSurface   ...and in parallel...   MessageProcessor -> (real)
 * corpusCallosum orchestrator -> mocked HemisphereClients.
 *
 * What's real: the processor's evolving-vs-legacy routing, the responder's
 * debounce + typing loop, phase-label mapping, and the dual-brain
 * orchestrator's event emissions.
 *
 * What's mocked: the Telegram Bot API boundary (sendMessageAndGetId /
 * editMessageText / sendChatAction) and the LLM leaves
 * (HemisphereClient.call). This is the same mock discipline as
 * corpus-callosum.e2e.test.ts, extended up through the Telegram surface.
 *
 * Satisfies Wave-6 ACs:
 *   T7: natural dual-brain fires ack + ≥2 phase edits + final edit (no legacy
 *       "Working on it..." ack ever sent), 5 hemisphere calls happen, typing
 *       indicator fires at least once.
 *   T8: slash command takes the evolving single-brain path — ack "Thinking…"
 *       + single final edit, 0 hemisphere calls, 0 dual-brain phase labels.
 *   T9: legacy fallback — when telegramSurface is absent (or ack returns
 *       null), surface methods are never called and deliver() carries the
 *       output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor } from '../bridge/processor.js'
import { corpusCallosum } from '../brain/corpus-callosum.js'
import type { HemisphereClient } from '../brain/types.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))

import { spawnClaude } from '../claude/spawner.js'

type CallArg = { system: string; user: string; timeoutMs: number }

function makeFakeHemisphere(responses: Array<{ content: string; durationMs?: number }>): HemisphereClient & {
  calls: CallArg[]
} {
  const calls: CallArg[] = []
  const queue = [...responses]
  return {
    calls,
    async call(input) {
      calls.push({ system: input.system, user: input.user, timeoutMs: input.timeoutMs })
      const next = queue.shift()
      if (!next) throw new Error(`FakeHemisphere: no response queued for call #${calls.length}`)
      return { content: next.content, durationMs: next.durationMs ?? 1 }
    },
  }
}

function makeFakeSurface(opts?: { ackReturn?: number | null }) {
  const ackReturn = opts?.ackReturn === undefined ? 4242 : opts.ackReturn
  const sendMessageAndGetId = vi.fn().mockResolvedValue(ackReturn)
  const editMessageText = vi.fn().mockResolvedValue(true)
  const sendChatAction = vi.fn().mockResolvedValue(true)
  return { sendMessageAndGetId, editMessageText, sendChatAction }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function makeE2EProcessor(opts: {
  left?: HemisphereClient
  right?: HemisphereClient
  corpusCallosumEnabled?: boolean
  clinicalOverride?: boolean
  evolvingMessageEnabled?: boolean
  telegramSurface?: ReturnType<typeof makeFakeSurface>
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-w6-e2e-'))
  const historyPath = join(tmpDir, 'history.jsonl')
  const deliverMock = vi.fn().mockResolvedValue(undefined)
  const log = Fastify({ logger: false }).log

  // Only wrap a real orchestrator if hemispheres are provided.
  const orchestrator =
    opts.left && opts.right
      ? async (input: { userMsg: string; history: any; basePrompt: string; onEvent?: (e: string) => void }) =>
          corpusCallosum(
            {
              left: opts.left!,
              right: opts.right!,
              basePrompt: input.basePrompt,
              timeoutMs: 5000,
              logger: log as any,
              onEvent: input.onEvent,
            },
            { userMsg: input.userMsg, history: input.history },
          )
      : undefined

  const processor = new MessageProcessor(
    {
      claudePath: '/usr/bin/claude',
      claudeModel: 'sonnet',
      claudeTimeoutMs: 120_000,
      historyPath,
      corpusCallosumEnabled: opts.corpusCallosumEnabled ?? true,
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'test-token',
      rightModel: 'gpt-5.4 codex',
      corpusCallosumTimeoutMs: 5000,
      clinicalOverride: opts.clinicalOverride,
      orchestrator,
      evolvingMessageEnabled: opts.evolvingMessageEnabled,
      telegramSurface: opts.telegramSurface,
    },
    deliverMock,
    log,
  )

  return { processor, deliverMock, historyPath }
}

describe('Wave 6 evolving-UX E2E (Sub-wave 6.4 — W6-T7/T8/T9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T7: natural dual-brain — initial ack + phase edits + integrated finalize, 5 hemisphere calls, typing fires', async () => {
    const left = makeFakeHemisphere([
      { content: 'L1-DRAFT' },
      { content: 'L2-REVISED' },
      { content: 'INTEGRATED-FINAL' },
    ])
    const right = makeFakeHemisphere([
      { content: 'R1-DRAFT' },
      { content: 'R2-REVISED' },
    ])
    const surface = makeFakeSurface({ ackReturn: 4242 })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right,
      corpusCallosumEnabled: true,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-A', 'What is Gibson\'s theory of affordances?', 'user-A')

    // Wait for finalize to land (last editMessageText carries the integrated text).
    await waitFor(() =>
      surface.editMessageText.mock.calls.some(([, , text]) => text === 'INTEGRATED-FINAL'),
      5000,
    )

    // Let the debounce window drain so any trailing flush has fired.
    await new Promise((r) => setTimeout(r, 1100))

    // Initial ack fired exactly once with the opaque "Thinking…" label.
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(surface.sendMessageAndGetId).toHaveBeenCalledWith('chat-A', 'Thinking…')

    // 5 hemisphere calls — dual-brain orchestrator really ran.
    expect(left.calls.length).toBe(3)
    expect(right.calls.length).toBe(2)

    // Typing indicator fired at least once (heartbeat starts immediately).
    expect(surface.sendChatAction).toHaveBeenCalled()
    expect(surface.sendChatAction.mock.calls[0]).toEqual(['chat-A', 'typing'])

    // Edit sequence: must end with the integrated final text…
    const editedTexts = surface.editMessageText.mock.calls.map(([, , text]) => text as string)
    expect(editedTexts[editedTexts.length - 1]).toBe('INTEGRATED-FINAL')

    // …and must include at least one of the transparent dual-brain labels.
    const labeledEdit = editedTexts.find((t) =>
      t === 'Drafting…' || t === 'Revising…' || t === 'Integrating…',
    )
    expect(labeledEdit).toBeDefined()

    // Every edit targets the ack message id the surface returned.
    for (const [chatId, msgId] of surface.editMessageText.mock.calls) {
      expect(chatId).toBe('chat-A')
      expect(msgId).toBe(4242)
    }

    // Legacy fallback did NOT run — deliver() was never invoked.
    expect(deliverMock).not.toHaveBeenCalled()

    // spawnClaude NOT invoked — dual-brain path only.
    expect(spawnClaude).not.toHaveBeenCalled()
  })

  it('T8: slash command — ack + single finalize, no dual-brain, no phase reveal', async () => {
    const left = makeFakeHemisphere([])
    const right = makeFakeHemisphere([])
    const surface = makeFakeSurface({ ackReturn: 9999 })

    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'network ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right,
      corpusCallosumEnabled: true,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-B', '/network-status', 'user-B')

    await waitFor(() =>
      surface.editMessageText.mock.calls.some(([, , text]) => text === 'network ok'),
      3000,
    )

    // Let any pending debounce flush.
    await new Promise((r) => setTimeout(r, 1100))

    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(surface.sendMessageAndGetId).toHaveBeenCalledWith('chat-B', 'Thinking…')

    // Dual-brain NOT invoked — slash bypasses orchestrator.
    expect(left.calls.length).toBe(0)
    expect(right.calls.length).toBe(0)
    expect(spawnClaude).toHaveBeenCalledTimes(1)

    // No dual-brain phase labels on the single-brain path.
    const editedTexts = surface.editMessageText.mock.calls.map(([, , text]) => text as string)
    expect(editedTexts).not.toContain('Drafting…')
    expect(editedTexts).not.toContain('Revising…')
    expect(editedTexts).not.toContain('Integrating…')

    // Final edit carries the Claude output.
    expect(editedTexts[editedTexts.length - 1]).toBe('network ok')

    // Typing indicator fired.
    expect(surface.sendChatAction).toHaveBeenCalled()

    // Legacy fallback did NOT run.
    expect(deliverMock).not.toHaveBeenCalled()
  })

  it('T9a: legacy fallback — no telegramSurface means surface methods never called, deliver carries output', async () => {
    const left = makeFakeHemisphere([
      { content: 'L1' },
      { content: 'L2' },
      { content: 'FINAL-LEGACY' },
    ])
    const right = makeFakeHemisphere([
      { content: 'R1' },
      { content: 'R2' },
    ])

    const { processor, deliverMock } = makeE2EProcessor({
      left, right,
      corpusCallosumEnabled: true,
      evolvingMessageEnabled: true, // flag ON but surface absent → still legacy
      telegramSurface: undefined,
    })

    processor.submit('chat-C', 'Any natural-language message', 'user-C')
    await waitFor(() =>
      deliverMock.mock.calls.some(([, text]) => text === 'FINAL-LEGACY'),
      5000,
    )

    // Legacy deliver() carried the output.
    const deliveredTexts = deliverMock.mock.calls.map(([, text]) => text as string)
    expect(deliveredTexts).toContain('FINAL-LEGACY')

    // Orchestrator really ran — 5 hemisphere calls.
    expect(left.calls.length).toBe(3)
    expect(right.calls.length).toBe(2)
  })

  it('T9b: legacy fallback — surface present but sendMessageAndGetId returns null', async () => {
    const left = makeFakeHemisphere([
      { content: 'L1' },
      { content: 'L2' },
      { content: 'FINAL-NULL-ACK' },
    ])
    const right = makeFakeHemisphere([
      { content: 'R1' },
      { content: 'R2' },
    ])
    const surface = makeFakeSurface({ ackReturn: null })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right,
      corpusCallosumEnabled: true,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-D', 'Another natural-language message', 'user-D')
    await waitFor(() =>
      deliverMock.mock.calls.some(([, text]) => text === 'FINAL-NULL-ACK'),
      5000,
    )

    // Ack was attempted, returned null — editMessageText and typing NEVER fire
    // (we bail to legacy before startTyping/updatePhase).
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(surface.editMessageText).not.toHaveBeenCalled()
    expect(surface.sendChatAction).not.toHaveBeenCalled()

    // Legacy deliver() carried the output.
    const deliveredTexts = deliverMock.mock.calls.map(([, text]) => text as string)
    expect(deliveredTexts).toContain('FINAL-NULL-ACK')
  })
})
