import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor, splitMessage } from '../bridge/processor.js'
import {
  LeftHemisphereError,
  RightHemisphereError,
  IntegrationError,
  type BrainResult,
  type CallosumTrace,
} from '../brain/types.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))

import { spawnClaude } from '../claude/spawner.js'

const MOCK_TRACE: CallosumTrace = {
  p1Left: { hemisphere: 'left', pass: 1, content: 'P1-LEFT-SECRET-A', durationMs: 10 },
  p1Right: { hemisphere: 'right', pass: 1, content: 'P1-RIGHT-SECRET-B', durationMs: 10 },
  p2Left: { hemisphere: 'left', pass: 2, content: 'P2-LEFT-SECRET-C', durationMs: 10 },
  p2Right: { hemisphere: 'right', pass: 2, content: 'P2-RIGHT-SECRET-D', durationMs: 10 },
  integrationMs: 10,
  totalMs: 50,
}

function makeProcessor(opts: {
  historyPath?: string
  corpusCallosumEnabled?: boolean
  clinicalOverride?: boolean
  orchestrator?: (input: {
    userMsg: string
    history: unknown
    basePrompt: string
  }) => Promise<BrainResult>
  deliverMock?: ReturnType<typeof vi.fn>
  logger?: unknown
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
  const historyPath = opts.historyPath ?? join(tmpDir, 'history.jsonl')
  const deliverMock = opts.deliverMock ?? vi.fn().mockResolvedValue(undefined)
  const log = (opts.logger ?? Fastify({ logger: false }).log) as any
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
      corpusCallosumTimeoutMs: 90_000,
      clinicalOverride: opts.clinicalOverride,
      orchestrator: opts.orchestrator,
    },
    deliverMock,
    log,
  )
  return { processor, deliverMock, historyPath }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('MessageProcessor', () => {
  let deliverMock: ReturnType<typeof vi.fn>
  let processor: MessageProcessor

  beforeEach(() => {
    vi.clearAllMocks()
    deliverMock = vi.fn().mockResolvedValue(undefined)
    const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
    processor = new MessageProcessor(
      {
        claudePath: '/usr/bin/claude',
        claudeModel: 'sonnet',
        claudeTimeoutMs: 120_000,
        historyPath: join(tmpDir, 'history.jsonl'),
        corpusCallosumEnabled: false, // default existing tests to single-brain
        gatewayUrl: 'http://127.0.0.1:18789',
        gatewayToken: 'test-token',
        rightModel: 'gpt-5.4 codex',
        corpusCallosumTimeoutMs: 90_000,
      },
      deliverMock,
      Fastify({ logger: false }).log,
    )
  })

  it('submits message and processes via Claude', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'Hello!', stderr: '', exitCode: 0, durationMs: 500, timedOut: false,
    })

    const result = processor.submit('123', 'Hi', 'user1')
    expect(result.blocked).toBe(false)
    expect(result.position).toBe(1)

    await new Promise((r) => setTimeout(r, 100))
    expect(deliverMock).toHaveBeenCalledWith('123', 'Hello!')
  })

  it('blocks PHI without calling Claude', async () => {
    const result = processor.submit('123', 'patient John Smith was admitted', 'user1')
    expect(result.blocked).toBe(true)
    expect(result.reasons).toContain('patient_name_detected')
    expect(spawnClaude).not.toHaveBeenCalled()
  })

  it('reports queue position correctly', () => {
    // The processor uses submit() which is sync — test the return values
    vi.mocked(spawnClaude).mockImplementation(() =>
      new Promise((r) => setTimeout(() => r({
        output: 'done', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      }), 5000)) // Long enough that the first never finishes during test
    )

    const r1 = processor.submit('123', 'first', 'user1')
    expect(r1.blocked).toBe(false)
    expect(r1.position).toBe(1)

    // Queue length check
    expect(processor.isProcessing()).toBe(true)
  })
})

describe('MessageProcessor — dual-brain integration (Wave 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes natural-language messages through the orchestrator, not spawnClaude', async () => {
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'integrated',
      trace: MOCK_TRACE,
    } satisfies BrainResult)

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
    })

    processor.submit('123', 'Tell me about the network status', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).toHaveBeenCalledTimes(1)
    const callArg = orchestrator.mock.calls[0][0] as {
      userMsg: string
      history: unknown[]
      basePrompt: string
    }
    expect(callArg.userMsg).toBe('Tell me about the network status')
    expect(Array.isArray(callArg.history)).toBe(true)
    expect(typeof callArg.basePrompt).toBe('string')
    expect(callArg.basePrompt.length).toBeGreaterThan(0)

    expect(spawnClaude).not.toHaveBeenCalled()
    expect(deliverMock).toHaveBeenCalledWith('123', 'integrated')
  })

  it('slash commands bypass the orchestrator and call spawnClaude', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'toggle result', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
    })
    const orchestrator = vi.fn()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
    })

    processor.submit('123', '/toggle status', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).not.toHaveBeenCalled()
    expect(spawnClaude).toHaveBeenCalledTimes(1)
    expect(deliverMock).toHaveBeenCalledWith('123', 'toggle result')
  })

  it('clinical override bypasses the orchestrator', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'clinical result', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
    })
    const orchestrator = vi.fn()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      clinicalOverride: true,
      orchestrator,
    })

    processor.submit('123', 'Natural language message', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).not.toHaveBeenCalled()
    expect(spawnClaude).toHaveBeenCalledTimes(1)
  })

  it('CORPUS_CALLOSUM_ENABLED=false bypasses the orchestrator for natural messages', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'single brain', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
    })
    const orchestrator = vi.fn()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      orchestrator,
    })

    processor.submit('123', 'Hello there', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).not.toHaveBeenCalled()
    expect(spawnClaude).toHaveBeenCalledTimes(1)
  })

  it('unknown slash commands (not known skills) go through dual-brain', async () => {
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'dual-brain answer',
      trace: MOCK_TRACE,
    } satisfies BrainResult)

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
    })

    processor.submit('123', '/unknown-command foo', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).toHaveBeenCalledTimes(1)
    expect(spawnClaude).not.toHaveBeenCalled()
    expect(deliverMock).toHaveBeenCalledWith('123', 'dual-brain answer')
  })

  it('surfaces LeftHemisphereError to Telegram', async () => {
    const orchestrator = vi.fn().mockRejectedValue(new LeftHemisphereError('spawn failed'))
    const errorSpy = vi.fn()
    const fakeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: errorSpy,
      fatal: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: () => fakeLogger,
      level: 'info',
      silent: vi.fn(),
    }

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: fakeLogger,
    })

    processor.submit('123', 'natural', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const callText = deliverMock.mock.calls[0][1] as string
    expect(callText).toContain('Left hemisphere failed')
    expect(callText).toContain('spawn failed')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('surfaces RightHemisphereError to Telegram', async () => {
    const orchestrator = vi.fn().mockRejectedValue(new RightHemisphereError('gateway down'))
    const errorSpy = vi.fn()
    const fakeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: errorSpy,
      fatal: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: () => fakeLogger,
      level: 'info',
      silent: vi.fn(),
    }

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: fakeLogger,
    })

    processor.submit('123', 'natural', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const callText = deliverMock.mock.calls[0][1] as string
    expect(callText).toContain('Right hemisphere failed')
    expect(callText).toContain('gateway down')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('surfaces IntegrationError to Telegram', async () => {
    const orchestrator = vi.fn().mockRejectedValue(new IntegrationError('integration busted'))
    const errorSpy = vi.fn()
    const fakeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: errorSpy,
      fatal: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: () => fakeLogger,
      level: 'info',
      silent: vi.fn(),
    }

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: fakeLogger,
    })

    processor.submit('123', 'natural', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const callText = deliverMock.mock.calls[0][1] as string
    expect(callText).toContain('Integration failed after retry')
    expect(callText).toContain('integration busted')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('history contains only final response after dual-brain — no pass-1/pass-2 draft content', async () => {
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'FINAL-INTEGRATED-RESPONSE',
      trace: MOCK_TRACE,
    } satisfies BrainResult)

    const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
    const historyPath = join(tmpDir, 'history.jsonl')
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      historyPath,
    })

    processor.submit('123', 'USER-MESSAGE-XYZ', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)
    // Give history writer a moment
    await new Promise((r) => setTimeout(r, 50))

    expect(existsSync(historyPath)).toBe(true)
    const raw = readFileSync(historyPath, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)

    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0].role).toBe('user')
    expect(entries[0].content).toBe('USER-MESSAGE-XYZ')
    expect(entries[1].role).toBe('assistant')
    expect(entries[1].content).toBe('FINAL-INTEGRATED-RESPONSE')

    // No draft content leaked into the file
    expect(raw).not.toContain('P1-LEFT-SECRET-A')
    expect(raw).not.toContain('P1-RIGHT-SECRET-B')
    expect(raw).not.toContain('P2-LEFT-SECRET-C')
    expect(raw).not.toContain('P2-RIGHT-SECRET-D')
  })

  it('chunks long dual-brain output via splitMessage', async () => {
    const bigOutput = 'a'.repeat(10_000)
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: bigOutput,
      trace: MOCK_TRACE,
    } satisfies BrainResult)

    const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
    const historyPath = join(tmpDir, 'history.jsonl')
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      historyPath,
    })

    processor.submit('123', 'give me a long one', 'user1')
    // 10_000 / 4096 = 3 chunks
    await waitFor(() => deliverMock.mock.calls.length >= 3)
    await new Promise((r) => setTimeout(r, 20))

    expect(deliverMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    const combined = deliverMock.mock.calls.map((c) => c[1] as string).join('')
    expect(combined).toBe(bigOutput)

    // History writes the assistant message (capped at 2000 chars internally — existing behavior)
    const raw = readFileSync(historyPath, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    const assistantEntry = JSON.parse(lines[1])
    expect(assistantEntry.role).toBe('assistant')
    expect(assistantEntry.content.length).toBeLessThanOrEqual(2000)
  })

  it('PHI block path still works after Wave 4 (never reaches orchestrator)', async () => {
    const orchestrator = vi.fn()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
    })

    const result = processor.submit('123', 'patient Jane Doe was admitted', 'user1')
    expect(result.blocked).toBe(true)
    expect(orchestrator).not.toHaveBeenCalled()
    expect(spawnClaude).not.toHaveBeenCalled()
    // Delivery happens async via .catch(() => {}) — give it a tick
    await new Promise((r) => setTimeout(r, 20))
    const phiMsg = deliverMock.mock.calls.find((c) =>
      (c[1] as string).startsWith('PHI detected'),
    )
    expect(phiMsg).toBeTruthy()
  })

  it('logger never emits user message text during dual-brain flow', async () => {
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'integrated',
      trace: MOCK_TRACE,
    } satisfies BrainResult)

    const USER_SECRET = 'SUPER-SECRET-USER-PROBE-12345'
    const capturedLogs: unknown[] = []
    const fakeLogger = {
      info: (o: unknown) => capturedLogs.push(o),
      warn: (o: unknown) => capturedLogs.push(o),
      error: (o: unknown) => capturedLogs.push(o),
      fatal: (o: unknown) => capturedLogs.push(o),
      debug: (o: unknown) => capturedLogs.push(o),
      trace: (o: unknown) => capturedLogs.push(o),
      child: () => fakeLogger,
      level: 'info',
      silent: () => {},
    }

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: fakeLogger,
    })

    processor.submit('123', USER_SECRET, 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 20))

    const serialized = JSON.stringify(capturedLogs)
    expect(serialized).not.toContain(USER_SECRET)
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits at newline boundaries', () => {
    const text = 'line1\nline2\nline3'
    const chunks = splitMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('hard splits when no newlines', () => {
    const text = 'a'.repeat(200)
    const chunks = splitMessage(text, 100)
    expect(chunks).toEqual(['a'.repeat(100), 'a'.repeat(100)])
  })
})
