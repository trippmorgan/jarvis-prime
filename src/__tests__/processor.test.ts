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
  rightBrainAgentEnabled?: boolean
  rightBrainAgentFallback?: boolean
  orchestrator?: (input: {
    userMsg: string
    history: unknown
    basePrompt: string
    onEvent?: (eventName: string) => void
  }) => Promise<BrainResult>
  deliverMock?: ReturnType<typeof vi.fn>
  logger?: unknown
  evolvingMessageEnabled?: boolean
  telegramSurface?: {
    sendMessageAndGetId: (chatId: string, text: string) => Promise<number | null>
    editMessageText: (chatId: string, messageId: number, text: string) => Promise<boolean>
    sendChatAction: (chatId: string, action: string) => Promise<boolean>
  }
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
      rightBrainAgentEnabled: opts.rightBrainAgentEnabled,
      rightBrainAgentFallback: opts.rightBrainAgentFallback,
      orchestrator: opts.orchestrator,
      evolvingMessageEnabled: opts.evolvingMessageEnabled,
      telegramSurface: opts.telegramSurface,
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

  it('W7-T9: clinical override bypasses orchestrator even when rightBrainAgentEnabled=true', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'clinical result', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
    })
    const orchestrator = vi.fn()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      clinicalOverride: true,
      rightBrainAgentEnabled: true,
      orchestrator,
    })

    processor.submit('123', 'Natural language message', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(orchestrator).not.toHaveBeenCalled()
    expect(spawnClaude).toHaveBeenCalledTimes(1)
  })

  it('W7-T9: CORPUS_CALLOSUM_ENABLED=false bypasses orchestrator even when rightBrainAgentEnabled=true', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'single brain', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
    })
    const orchestrator = vi.fn()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      rightBrainAgentEnabled: true,
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

describe('MessageProcessor — data-flow logging', () => {
  type LogEntry = { level: 'info' | 'warn' | 'error', payload: unknown, msg?: string }

  function makeCapturingLogger() {
    const logged: LogEntry[] = []
    const spy = {
      info: (payload: unknown, msg?: string) => { logged.push({ level: 'info', payload, msg }) },
      warn: (payload: unknown, msg?: string) => { logged.push({ level: 'warn', payload, msg }) },
      error: (payload: unknown, msg?: string) => { logged.push({ level: 'error', payload, msg }) },
      fatal: () => {},
      debug: () => {},
      trace: () => {},
      child: () => spy,
      level: 'info',
      silent: () => {},
    }
    const events = (name: string) =>
      logged.filter((l) => (l.payload as Record<string, unknown> | null | undefined)?.event === name)
    return { logged, spy, events }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits message_inbound on submit with textLength and chatId (no raw text)', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'x', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hello-world-42', 'userA')

    const inbound = events('message_inbound')
    expect(inbound.length).toBe(1)
    const payload = inbound[0].payload as Record<string, unknown>
    expect(payload.chatId).toBe('chatA')
    expect(payload.userId).toBe('userA')
    expect(payload.textLength).toBe('hello-world-42'.length)
    expect(typeof payload.timestamp).toBe('number')
    expect(payload).not.toHaveProperty('text')
  })

  it('phi_scan fires on blocked submit with reasonsCount>=1 and blocked=true', () => {
    const { spy, events } = makeCapturingLogger()
    const { processor } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })

    processor.submit('chatA', 'patient John Smith was admitted', 'userA')

    const scans = events('phi_scan')
    expect(scans.length).toBe(1)
    const payload = scans[0].payload as Record<string, unknown>
    expect(payload.blocked).toBe(true)
    expect(payload.reasonsCount).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(payload.reasons)).toBe(true)
  })

  it('phi_scan fires on allowed submit with blocked=false and reasonsCount=0', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hello there', 'userA')

    const scans = events('phi_scan')
    expect(scans.length).toBe(1)
    const payload = scans[0].payload as Record<string, unknown>
    expect(payload.blocked).toBe(false)
    expect(payload.reasonsCount).toBe(0)
  })

  it('message_enqueued fires only when not blocked', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'patient John Smith was admitted', 'userA')
    expect(events('message_enqueued').length).toBe(0)

    processor.submit('chatA', 'hello', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const enq = events('message_enqueued')
    expect(enq.length).toBe(1)
    const payload = enq[0].payload as Record<string, unknown>
    expect(typeof payload.messageId).toBe('string')
    expect(typeof payload.position).toBe('number')
    expect(payload.chatId).toBe('chatA')
  })

  it('process_start fires at processing start with messageId and queueLength', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hello', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const starts = events('process_start')
    expect(starts.length).toBe(1)
    const payload = starts[0].payload as Record<string, unknown>
    expect(typeof payload.messageId).toBe('string')
    expect(typeof payload.queueLength).toBe('number')
  })

  it('history_user_appended fires with userContentLength === msg.text.length', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    const text = 'hello-queue-probe'
    processor.submit('chatA', text, 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const appends = events('history_user_appended')
    expect(appends.length).toBe(1)
    const payload = appends[0].payload as Record<string, unknown>
    expect(payload.userContentLength).toBe(text.length)
    expect(typeof payload.messageId).toBe('string')
  })

  it('classification event fires with kind matching the router decision', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', '/toggle something', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const cls = events('classification')
    expect(cls.length).toBe(1)
    const payload = cls[0].payload as Record<string, unknown>
    expect(payload.kind).toBe('slash')
  })

  it('prompt_built fires on single-brain path with promptLength > 0', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hello', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const built = events('prompt_built')
    expect(built.length).toBe(1)
    const payload = built[0].payload as Record<string, unknown>
    expect((payload.promptLength as number)).toBeGreaterThan(0)
    expect(typeof payload.messageId).toBe('string')
  })

  it('prompt_built fires on dual-brain path with promptLength > 0', async () => {
    const { spy, events } = makeCapturingLogger()
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'integrated',
      trace: MOCK_TRACE,
    } satisfies BrainResult)
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    processor.submit('chatA', 'tell me about things', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const built = events('prompt_built')
    expect(built.length).toBe(1)
    const payload = built[0].payload as Record<string, unknown>
    expect((payload.promptLength as number)).toBeGreaterThan(0)
  })

  it('single_brain_call_start and single_brain_call_end fire around spawnClaude', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'xyz', stderr: '', exitCode: 0, durationMs: 42, timedOut: false,
    })

    processor.submit('chatA', 'hi', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const starts = events('single_brain_call_start')
    const ends = events('single_brain_call_end')
    expect(starts.length).toBe(1)
    expect(ends.length).toBe(1)
    const endPayload = ends[0].payload as Record<string, unknown>
    expect(endPayload.durationMs).toBe(42)
    expect(endPayload.exitCode).toBe(0)
    expect(endPayload.timedOut).toBe(false)
    expect(endPayload.outputLength).toBe(3)
    expect(endPayload.stderrLength).toBe(0)
  })

  it('dual_brain_call_start fires before orchestrator call; dual_brain_done still fires', async () => {
    const { spy, events } = makeCapturingLogger()
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'integrated',
      trace: MOCK_TRACE,
    } satisfies BrainResult)
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    processor.submit('chatA', 'natural', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const startEvents = events('dual_brain_call_start')
    expect(startEvents.length).toBe(1)
    const startPayload = startEvents[0].payload as Record<string, unknown>
    expect(typeof startPayload.messageId).toBe('string')
    expect(typeof startPayload.timeoutMs).toBe('number')
    expect(events('dual_brain_done').length).toBe(1)
  })

  it('delivery_start and delivery_end fire on happy path with chunks, totalLength, deliveryMs', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'the-response', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hi', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const ds = events('delivery_start')
    const de = events('delivery_end')
    expect(ds.length).toBe(1)
    expect(de.length).toBe(1)
    const dePayload = de[0].payload as Record<string, unknown>
    expect((dePayload.chunks as number)).toBeGreaterThanOrEqual(1)
    expect(dePayload.totalLength).toBe('the-response'.length)
    expect((dePayload.deliveryMs as number)).toBeGreaterThanOrEqual(0)
    expect(dePayload.outcome).toBe('success')
    expect(dePayload.chatId).toBe('chatA')
  })

  it('history_assistant_appended fires on single-brain path with correct length', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'result-abc', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hi', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const events_ = events('history_assistant_appended')
    expect(events_.length).toBe(1)
    const payload = events_[0].payload as Record<string, unknown>
    expect(payload.assistantContentLength).toBe('result-abc'.length)
  })

  it('history_assistant_appended fires on dual-brain path with correct length', async () => {
    const { spy, events } = makeCapturingLogger()
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'dual-final',
      trace: MOCK_TRACE,
    } satisfies BrainResult)
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    processor.submit('chatA', 'natural', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const events_ = events('history_assistant_appended')
    expect(events_.length).toBe(1)
    const payload = events_[0].payload as Record<string, unknown>
    expect(payload.assistantContentLength).toBe('dual-final'.length)
  })

  it('process_end fires with path=single_brain and outcome=success', async () => {
    const { spy, events } = makeCapturingLogger()
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      logger: spy,
    })
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'ok', stderr: '', exitCode: 0, durationMs: 1, timedOut: false,
    })

    processor.submit('chatA', 'hi', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const ends = events('process_end')
    expect(ends.length).toBe(1)
    const payload = ends[0].payload as Record<string, unknown>
    expect(payload.path).toBe('single_brain')
    expect(payload.outcome).toBe('success')
    expect((payload.totalPipelineMs as number)).toBeGreaterThanOrEqual(0)
  })

  it('process_end fires with path=dual_brain and outcome=success on happy dual-brain path', async () => {
    const { spy, events } = makeCapturingLogger()
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'integrated',
      trace: MOCK_TRACE,
    } satisfies BrainResult)
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    processor.submit('chatA', 'natural', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const ends = events('process_end')
    expect(ends.length).toBe(1)
    const payload = ends[0].payload as Record<string, unknown>
    expect(payload.path).toBe('dual_brain')
    expect(payload.outcome).toBe('success')
  })

  it('process_end fires with outcome=error when orchestrator throws LeftHemisphereError', async () => {
    const { spy, events } = makeCapturingLogger()
    const orchestrator = vi.fn().mockRejectedValue(new LeftHemisphereError('boom'))
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    processor.submit('chatA', 'natural', 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    const ends = events('process_end')
    expect(ends.length).toBe(1)
    const payload = ends[0].payload as Record<string, unknown>
    expect(payload.path).toBe('dual_brain')
    expect(payload.outcome).toBe('error')
  })

  it('PHI-safety: no log payload contains raw user message, finalText, or pass-1/pass-2 draft content', async () => {
    const { spy, logged } = makeCapturingLogger()
    const orchestrator = vi.fn().mockResolvedValue({
      finalText: 'FINAL-UNIQUE-OUTPUT-ZZZ-987',
      trace: MOCK_TRACE,
    } satisfies BrainResult)
    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      logger: spy,
    })

    const USER_PROBE = 'USER-UNIQUE-PROBE-AAA-123'
    processor.submit('chatA', USER_PROBE, 'userA')
    await waitFor(() => deliverMock.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 20))

    const serialized = JSON.stringify(logged)
    expect(serialized).not.toContain(USER_PROBE)
    expect(serialized).not.toContain('FINAL-UNIQUE-OUTPUT-ZZZ-987')
    expect(serialized).not.toContain('P1-LEFT-SECRET-A')
    expect(serialized).not.toContain('P1-RIGHT-SECRET-B')
    expect(serialized).not.toContain('P2-LEFT-SECRET-C')
    expect(serialized).not.toContain('P2-RIGHT-SECRET-D')
  })
})

describe('MessageProcessor — evolving-message UX (Wave 6)', () => {
  function makeFakeSurface() {
    const sendMessageAndGetId = vi.fn().mockResolvedValue(42)
    const editMessageText = vi.fn().mockResolvedValue(true)
    const sendChatAction = vi.fn().mockResolvedValue(true)
    return {
      sendMessageAndGetId,
      editMessageText,
      sendChatAction,
      surface: { sendMessageAndGetId, editMessageText, sendChatAction },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dual-brain natural path emits 4 edits: Drafting → Revising → Integrating → final', async () => {
    const { surface, sendMessageAndGetId, editMessageText } = makeFakeSurface()

    // Orchestrator that *synchronously* fires the three phase events, then
    // resolves on the next microtask. Using Promise.resolve().then() keeps the
    // test deterministic without leaning on fake-timer microtask quirks.
    const orchestrator = vi.fn(async (input: {
      onEvent?: (e: string) => void
    }): Promise<BrainResult> => {
      input.onEvent?.('callosum_pass1_start')
      // Small real-delay hops so the responder debounce window has time to
      // flush between each phase edit.
      await new Promise((r) => setTimeout(r, 1100))
      input.onEvent?.('callosum_pass2_start')
      await new Promise((r) => setTimeout(r, 1100))
      input.onEvent?.('callosum_integration_start')
      await new Promise((r) => setTimeout(r, 1100))
      return { finalText: 'final-answer', trace: MOCK_TRACE }
    })

    const { processor } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-A', 'tell me something interesting', 'user1')

    // Wait for the finalize to happen — editMessageText is called at least 4
    // times (Drafting, Revising, Integrating, final).
    await waitFor(() => editMessageText.mock.calls.length >= 4, 5000)

    expect(sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(sendMessageAndGetId).toHaveBeenCalledWith('chat-A', 'Thinking…')

    const labels = editMessageText.mock.calls.map((c) => c[2] as string)
    expect(labels).toContain('Drafting…')
    expect(labels).toContain('Revising…')
    expect(labels).toContain('Integrating…')
    expect(labels[labels.length - 1]).toBe('final-answer')
    expect(editMessageText.mock.calls.length).toBeGreaterThanOrEqual(4)
  }, 10_000)

  it('slash-command bypass: single edit with final text, no phase labels', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'slash-final', stderr: '', exitCode: 0, durationMs: 10, timedOut: false,
    })
    const { surface, sendMessageAndGetId, editMessageText } = makeFakeSurface()

    const { processor } = makeProcessor({
      corpusCallosumEnabled: true,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-B', '/toggle foo', 'user1')

    await waitFor(() => editMessageText.mock.calls.length >= 1, 3000)
    // Give any stray edits a moment (there shouldn't be any beyond the final)
    await new Promise((r) => setTimeout(r, 50))

    expect(sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(sendMessageAndGetId).toHaveBeenCalledWith('chat-B', 'Thinking…')

    const labels = editMessageText.mock.calls.map((c) => c[2] as string)
    // The only "Thinking…" marker is the initial ack (sendMessageAndGetId);
    // phaseLabelForEvent('single_brain_call_start', 'slash') returns 'Thinking…'
    // too — but because the initial ack already says 'Thinking…', the responder
    // may still re-emit one same-text edit. Either way, no dual-brain labels.
    expect(labels).not.toContain('Drafting…')
    expect(labels).not.toContain('Revising…')
    expect(labels).not.toContain('Integrating…')
    // Final edit lands with the spawnClaude output.
    expect(labels[labels.length - 1]).toBe('slash-final')
  })

  it('legacy path: evolvingMessageEnabled=false falls back to 8s ack + deliver', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'legacy-final', stderr: '', exitCode: 0, durationMs: 10, timedOut: false,
    })
    const { surface, sendMessageAndGetId, editMessageText } = makeFakeSurface()

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      evolvingMessageEnabled: false,
      telegramSurface: surface, // present but flag disabled → ignored
    })

    processor.submit('chat-C', 'hello', 'user1')

    await waitFor(() => deliverMock.mock.calls.length > 0, 2000)

    // Legacy path routes through deliver callback, not the evolving surface.
    expect(deliverMock).toHaveBeenCalledWith('chat-C', 'legacy-final')
    expect(sendMessageAndGetId).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
  })

  it('legacy path: telegramSurface absent falls back to deliver', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'no-surface', stderr: '', exitCode: 0, durationMs: 10, timedOut: false,
    })

    const { processor, deliverMock } = makeProcessor({
      corpusCallosumEnabled: false,
      evolvingMessageEnabled: true, // flag on but surface missing → legacy
      telegramSurface: undefined,
    })

    processor.submit('chat-D', 'hello', 'user1')
    await waitFor(() => deliverMock.mock.calls.length > 0, 2000)

    expect(deliverMock).toHaveBeenCalledWith('chat-D', 'no-surface')
  })

  it('typing heartbeat fires repeatedly during a long-running orchestrator', async () => {
    const { surface, sendChatAction } = makeFakeSurface()

    // Long-running orchestrator — never fires phase events, just delays.
    const orchestrator = vi.fn(async (): Promise<BrainResult> => {
      await new Promise((r) => setTimeout(r, 9000))
      return { finalText: 'eventually', trace: MOCK_TRACE }
    })

    const { processor } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-E', 'long task', 'user1')

    // Wait ~8s of real time; the responder fires typing every ~4s.
    await new Promise((r) => setTimeout(r, 8200))

    // Initial + at least one interval tick = >= 2 calls.
    expect(sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of sendChatAction.mock.calls) {
      expect(call[0]).toBe('chat-E')
      expect(call[1]).toBe('typing')
    }
  }, 15_000)

  it('error path finalizes with error text and stops typing heartbeat', async () => {
    const { surface, editMessageText, sendChatAction } = makeFakeSurface()

    const orchestrator = vi.fn().mockRejectedValue(new LeftHemisphereError('boom'))

    const { processor } = makeProcessor({
      corpusCallosumEnabled: true,
      orchestrator,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-F', 'trigger error', 'user1')

    // Wait for finalize edit to appear.
    await waitFor(() => editMessageText.mock.calls.length >= 1, 3000)

    const lastEditText = editMessageText.mock.calls.at(-1)?.[2] as string
    expect(lastEditText).toContain('Left hemisphere failed')
    expect(lastEditText).toContain('boom')

    // Snapshot typing call count right after resolution, then wait 5s real —
    // the heartbeat should NOT continue ticking once stopTyping fired.
    const afterErrorCount = sendChatAction.mock.calls.length
    await new Promise((r) => setTimeout(r, 5000))
    expect(sendChatAction.mock.calls.length).toBe(afterErrorCount)
  }, 10_000)

  it('clinical bypass routes to single-brain with only one final edit', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'clinical-final', stderr: '', exitCode: 0, durationMs: 10, timedOut: false,
    })
    const { surface, sendMessageAndGetId, editMessageText } = makeFakeSurface()
    const orchestrator = vi.fn() // should never be called

    const { processor } = makeProcessor({
      corpusCallosumEnabled: true,
      clinicalOverride: true,
      orchestrator,
      evolvingMessageEnabled: true,
      telegramSurface: surface,
    })

    processor.submit('chat-G', 'something clinical', 'user1')

    await waitFor(() => editMessageText.mock.calls.length >= 1, 3000)
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator).not.toHaveBeenCalled()
    expect(sendMessageAndGetId).toHaveBeenCalledWith('chat-G', 'Thinking…')

    const labels = editMessageText.mock.calls.map((c) => c[2] as string)
    expect(labels).not.toContain('Drafting…')
    expect(labels).not.toContain('Revising…')
    expect(labels).not.toContain('Integrating…')
    expect(labels[labels.length - 1]).toBe('clinical-final')
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
