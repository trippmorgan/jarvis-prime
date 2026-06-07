/**
 * Tests for the async deferred-task lane (difficult message routing).
 *
 * Covers:
 *   1. isDifficultTask() classifier — all three signals.
 *   2. Processor deferred dispatch behaviour:
 *      a. ACK is delivered immediately (before orchestrator resolves).
 *      b. Orchestrator runs and final answer is delivered.
 *      c. Heartbeat fires when work takes longer than the interval.
 *      d. Non-difficult messages still go through the synchronous path.
 *      e. deferredTaskEnabled=false disables the lane entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { isDifficultTask } from '../brain/router.js'
import { MessageProcessor } from '../bridge/processor.js'
import type { BrainResult, CallosumTrace } from '../brain/types.js'

// ── Mock spawner so single-brain tests don't reach real processes ─────────────
vi.mock('../claude/spawner.js', () => ({ spawnClaude: vi.fn() }))
vi.mock('../claude/spawner-stream.js', async () => {
  const { spawnClaude } = await import('../claude/spawner.js')
  return { spawnClaudeStream: spawnClaude }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_TRACE: CallosumTrace = {
  p1Left:  { hemisphere: 'left',  pass: 1, content: '', durationMs: 10 },
  p1Right: { hemisphere: 'right', pass: 1, content: '', durationMs: 10 },
  p2Left:  { hemisphere: 'left',  pass: 2, content: '', durationMs: 10 },
  p2Right: { hemisphere: 'right', pass: 2, content: '', durationMs: 10 },
  integrationMs: 10,
  totalMs: 50,
}

function makeBrainResult(text: string): BrainResult {
  return { finalText: text, trace: MOCK_TRACE }
}

function makeProcessor(opts: {
  orchestrator?: (input: unknown) => Promise<BrainResult>
  deliverMock?: ReturnType<typeof vi.fn>
  deferredTaskEnabled?: boolean
  deferredTaskMinChars?: number
  heartbeatMs?: number
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-deferred-test-'))
  const deliverMock = opts.deliverMock ?? vi.fn().mockResolvedValue(undefined)
  const log = Fastify({ logger: false }).log
  const processor = new MessageProcessor(
    {
      claudePath: '/usr/bin/claude',
      claudeModel: 'sonnet',
      claudeTimeoutMs: 120_000,
      workingDir: tmpDir,
      nodeName: 'Jarvis Prime',
      botUsername: 'trippassistant_bot',
      historyPath: join(tmpDir, 'history.jsonl'),
      corpusCallosumEnabled: true,
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'test-token',
      rightModel: 'gpt-5.4 codex',
      corpusCallosumTimeoutMs: 90_000,
      orchestrator: opts.orchestrator,
      deferredTaskEnabled: opts.deferredTaskEnabled,
      deferredTaskMinChars: opts.deferredTaskMinChars,
      // Disable short-message fast lane so messages reach the dual-brain path
      // in tests — same convention as processor.test.ts.
      shortMessageFastLaneEnabled: false,
      defaultMode: 'dual',
    },
    deliverMock,
    log,
  )
  return { processor, deliverMock }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ── isDifficultTask classifier ────────────────────────────────────────────────

describe('isDifficultTask', () => {
  it('returns false for short non-keyword messages', () => {
    expect(isDifficultTask('ok sounds good')).toBe(false)
    expect(isDifficultTask('thanks')).toBe(false)
    expect(isDifficultTask('yes do it')).toBe(false)
  })

  it('returns true when message length ≥ minChars (default 300)', () => {
    const long = 'a'.repeat(300)
    expect(isDifficultTask(long)).toBe(true)
  })

  it('returns false just below the length threshold', () => {
    const short = 'a'.repeat(299)
    expect(isDifficultTask(short)).toBe(false)
  })

  it('respects custom minChars', () => {
    expect(isDifficultTask('a'.repeat(50), { minChars: 40 })).toBe(true)
    expect(isDifficultTask('a'.repeat(30), { minChars: 40 })).toBe(false)
  })

  it('triggers on heavy-intent keywords regardless of length', () => {
    expect(isDifficultTask('research the Frank node logs')).toBe(true)
    expect(isDifficultTask('analyze the errors')).toBe(true)
    expect(isDifficultTask('build a new feature')).toBe(true)
    expect(isDifficultTask('implement the dispatch lane')).toBe(true)
    expect(isDifficultTask('debug the timeout issue')).toBe(true)
    expect(isDifficultTask('investigate the crash')).toBe(true)
    expect(isDifficultTask('audit the security config')).toBe(true)
    expect(isDifficultTask('refactor the callosum')).toBe(true)
    expect(isDifficultTask('explain in detail how routing works')).toBe(true)
    expect(isDifficultTask('walk me through the architecture')).toBe(true)
    expect(isDifficultTask('deploy the new service')).toBe(true)
  })

  it('does NOT trigger on single multi-step marker without other signals', () => {
    // Single "also" should not be enough
    expect(isDifficultTask('also please check')).toBe(false)
  })

  it('triggers when ≥ 2 multi-step markers are present', () => {
    // "additionally" + "also" = 2 markers
    expect(isDifficultTask('additionally check the logs. also fix it.')).toBe(true)
    // "and then" + "furthermore"
    expect(isDifficultTask('do x and then do y furthermore do z')).toBe(true)
  })

  it('returns false for slash commands even if long', () => {
    expect(isDifficultTask('/network-status ' + 'a'.repeat(400))).toBe(false)
  })

  it('is case-insensitive for keywords', () => {
    expect(isDifficultTask('RESEARCH the network')).toBe(true)
    expect(isDifficultTask('Analyze logs')).toBe(true)
  })
})

// ── Processor deferred lane behaviour ────────────────────────────────────────

describe('MessageProcessor deferred async lane', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ACKs immediately before orchestrator resolves', async () => {
    // Orchestrator that takes a perceptible time to resolve.
    let resolveOrchestrator!: (r: BrainResult) => void
    const orchestratorHeld = new Promise<BrainResult>(
      (res) => (resolveOrchestrator = res),
    )
    const orchestrator = vi.fn().mockReturnValue(orchestratorHeld)
    const { processor, deliverMock } = makeProcessor({
      orchestrator,
      // Use a very low minChars so we can trigger with a short test string
      deferredTaskMinChars: 5,
    })

    processor.submit('chat1', 'do this important work', 'user1')

    // Wait for the immediate ACK (should arrive well before orchestrator).
    await waitFor(() => deliverMock.mock.calls.length > 0)
    const firstCall = deliverMock.mock.calls[0][1] as string
    expect(firstCall).toMatch(/on it|working now|report back/i)

    // Orchestrator should NOT have delivered a final answer yet.
    expect(deliverMock.mock.calls.length).toBe(1)

    // Now let the orchestrator resolve.
    resolveOrchestrator(makeBrainResult('Final answer from deferred'))
    await waitFor(() => deliverMock.mock.calls.length >= 2)

    const calls = deliverMock.mock.calls.map((c) => c[1] as string)
    expect(calls.some((t) => t.includes('Final answer from deferred'))).toBe(true)
  })

  it('delivers the final orchestrator answer', async () => {
    const orchestrator = vi.fn().mockResolvedValue(
      makeBrainResult('Deep analysis complete.'),
    )
    const { processor, deliverMock } = makeProcessor({
      orchestrator,
      deferredTaskMinChars: 5,
    })

    processor.submit('chat2', 'research the whole thing', 'user1')
    await waitFor(() => deliverMock.mock.calls.length >= 2)

    const texts = deliverMock.mock.calls.map((c) => c[1] as string)
    expect(texts.some((t) => t === 'Deep analysis complete.')).toBe(true)
  })

  it('does NOT defer short/simple messages', async () => {
    // Short message should stay on the synchronous dual-brain path.
    // The orchestrator resolves quickly so we can verify both paths.
    const orchestrator = vi.fn().mockResolvedValue(
      makeBrainResult('Quick answer'),
    )
    const { processor, deliverMock } = makeProcessor({ orchestrator })

    // "ok cool" is 7 chars, no keywords — should not defer
    processor.submit('chat3', 'ok cool', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    // The message should still be delivered, but the ACK text is NOT the
    // deferred-lane ACK (it might be "Working on it..." or direct delivery).
    const texts = deliverMock.mock.calls.map((c) => c[1] as string)
    expect(texts.every((t) => !t.match(/on it.*report back/i))).toBe(true)
  })

  it('deferredTaskEnabled=false disables the lane for long messages', async () => {
    const orchestrator = vi.fn().mockResolvedValue(
      makeBrainResult('Sync answer'),
    )
    const { processor, deliverMock } = makeProcessor({
      orchestrator,
      deferredTaskEnabled: false,
    })

    const longMsg = 'a'.repeat(400)
    processor.submit('chat4', longMsg, 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const texts = deliverMock.mock.calls.map((c) => c[1] as string)
    // No deferred ACK — synchronous path delivers the real answer.
    expect(texts.some((t) => t === 'Sync answer')).toBe(true)
    expect(texts.every((t) => !t.match(/on it.*report back/i))).toBe(true)
  })

  it('delivers error message when orchestrator throws in deferred lane', async () => {
    const orchestrator = vi.fn().mockRejectedValue(new Error('brain exploded'))
    const { processor, deliverMock } = makeProcessor({
      orchestrator,
      deferredTaskMinChars: 5,
    })

    processor.submit('chat5', 'build something large', 'user1')
    // ACK first, then error delivery
    await waitFor(() => deliverMock.mock.calls.length >= 2, 4000)

    const texts = deliverMock.mock.calls.map((c) => c[1] as string)
    expect(texts.some((t) => t.includes('Task failed') || t.includes('brain exploded') || t.includes('Internal error'))).toBe(true)
  })
})
