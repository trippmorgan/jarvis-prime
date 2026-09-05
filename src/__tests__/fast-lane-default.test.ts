import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

vi.mock('../claude/spawner.js', () => ({ spawnClaude: vi.fn() }))
vi.mock('../claude/spawner-stream.js', async () => {
  const { spawnClaude } = await import('../claude/spawner.js')
  return { spawnClaudeStream: spawnClaude }
})
vi.mock('../ledger/egress.js', () => ({
  attestEgress: vi.fn().mockResolvedValue(null),
  attestProcessRun: vi.fn().mockResolvedValue(null),
  egressLedgerStatus: () => ({ enabled: false, reason: 'test' }),
}))

import { spawnClaude } from '../claude/spawner.js'
import { zonedDateString } from '../claude/daily-session.js'
import { MessageProcessor } from '../bridge/processor.js'

const ok = (output: string) => ({ output, stderr: '', exitCode: 0, durationMs: 5, timedOut: false })

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function make() {
  const tmp = mkdtempSync(join(tmpdir(), 'jp-fast-'))
  const deliver = vi.fn().mockResolvedValue(undefined)
  const sent: string[] = []
  const edits: string[] = []
  const surface = {
    sendMessageAndGetId: vi.fn(async (_c: string, text: string) => { sent.push(text); return 100 + sent.length }),
    editMessageText: vi.fn(async (_c: string, _id: number, text: string) => { edits.push(text); return true }),
    sendChatAction: vi.fn(async () => true),
  }
  const processor = new MessageProcessor(
    {
      claudePath: '/usr/bin/claude', claudeModel: 'fable', claudeTimeoutMs: 120_000, workingDir: tmp,
      nodeName: 'Jarvis Prime', botUsername: 'trippassistant_bot', historyPath: join(tmp, 'history.jsonl'),
      corpusCallosumEnabled: false, gatewayUrl: 'http://127.0.0.1:1', gatewayToken: 't', rightModel: 'gpt-5.6',
      corpusCallosumTimeoutMs: 1000, evolvingMessageEnabled: true, telegramSurface: surface,
      fastLaneDefaultEnabled: true, jobTickMs: 1_000_000,
    } as never,
    deliver,
    Fastify({ logger: false }).log as never,
  )
  return { processor, deliver, sent, edits, surface, tmp }
}

describe('fast lane by default (2026-09-04)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('status/stop are answered without spawning anything', async () => {
    const { processor, deliver } = make()
    processor.submit('c', 'status', 'u')
    await waitFor(() => deliver.mock.calls.length > 0)
    expect(deliver).toHaveBeenCalledWith('c', 'No jobs running.')
    processor.submit('c', 'stop', 'u')
    await waitFor(() => deliver.mock.calls.length > 1)
    expect(deliver).toHaveBeenLastCalledWith('c', 'Nothing is running.')
    expect(spawnClaude).not.toHaveBeenCalled()
  })

  it('chit-chat goes tools-off through the evolving bubble', async () => {
    const { processor, sent, edits } = make()
    vi.mocked(spawnClaude).mockResolvedValue(ok('Morning, Tripp.'))
    processor.submit('c', 'good morning', 'u')
    await waitFor(() => edits.some((e) => e.includes('Morning, Tripp.')))
    expect(sent[0]).toBe('Thinking…')
    const opts = vi.mocked(spawnClaude).mock.calls[0][1] as { enableTools?: boolean; timeoutMs?: number }
    expect(opts.enableTools).toBe(false)
    expect(opts.timeoutMs).toBe(120_000)
  })

  it('an imperative becomes a monitored job: monitor bubble now, result later, queue free', async () => {
    const { processor, deliver, sent, edits } = make()
    let finish!: (v: ReturnType<typeof ok>) => void
    vi.mocked(spawnClaude).mockImplementationOnce(() => new Promise((res) => { finish = res }))
    processor.submit('c', 'check whether the station is on air', 'u')
    await waitFor(() => sent.length > 0)
    expect(sent[0]).toMatch(/🛠 Task #1 · check whether the station is on air/)
    expect(sent[0]).toMatch(/Agent: Prime worker · fable · tools on/)
    const opts = vi.mocked(spawnClaude).mock.calls[0][1] as { enableTools?: boolean; signal?: AbortSignal; timeoutMs?: number }
    expect(opts.enableTools).toBeUndefined()
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.timeoutMs).toBe(30 * 60_000)
    // The queue is free: a control word answers while the job runs.
    processor.submit('c', 'status', 'u')
    await waitFor(() => deliver.mock.calls.some((c) => String(c[1]).startsWith('1 running:')))
    finish(ok('Station is on air, PlayoutONE healthy.'))
    await waitFor(() => deliver.mock.calls.some((c) => String(c[1]).includes('📬 Task #1 result')))
    expect(edits.at(-1)).toMatch(/✅ Task #1 done/)
  })

  it('a task never mints the daily session; a ghost daily session is rotated and the task retried fresh', async () => {
    const { processor, deliver, tmp } = make()
    const statePath = join(tmp, '.data', 'daily-session.json')
    vi.mocked(spawnClaude).mockResolvedValue(ok('on air'))
    processor.submit('c', 'check the station', 'u')
    await waitFor(() => deliver.mock.calls.some((c) => String(c[1]).includes('📬 Task #1 result')))
    expect(existsSync(statePath)).toBe(false)
    expect(vi.mocked(spawnClaude).mock.calls[0][1]).toMatchObject({ resumeSession: false })

    // Recorded on disk but gone from the CLI (2026-09-05 incident): the fork
    // is refused with exit 0 + is_error, so the task rotates and runs fresh.
    const ghost = '11111111-2222-4333-8444-555555555555'
    mkdirSync(join(tmp, '.data'), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ date: zonedDateString(), sessionId: ghost }))
    vi.mocked(spawnClaude)
      .mockResolvedValueOnce({ ...ok(''), isError: true, errors: [`No conversation found with session ID: ${ghost}`] })
      .mockResolvedValueOnce(ok('fresh run'))
    processor.submit('c', 'check the station again', 'u')
    await waitFor(() => deliver.mock.calls.some((c) => String(c[1]).includes('📬 Task #2 result')))
    const calls = vi.mocked(spawnClaude).mock.calls
    expect(calls.at(-2)?.[1]).toMatchObject({ sessionId: ghost, resumeSession: true, forkSession: true })
    const rotated = JSON.parse(readFileSync(statePath, 'utf-8')) as { sessionId: string }
    expect(rotated.sessionId).not.toBe(ghost)
    expect(calls.at(-1)?.[1]).toMatchObject({ sessionId: rotated.sessionId, resumeSession: false })
    expect(String(deliver.mock.calls.at(-1)?.[1])).toContain('fresh run')
  })

  it('a deliberation gets a fast answer with the dual-brain offer; "yes" then runs it as a job', async () => {
    const { processor, edits, sent } = make()
    vi.mocked(spawnClaude).mockResolvedValue(ok('Short take: keep the walker.'))
    processor.submit('c', 'Should we move the whole clinical archive into an encrypted vault long-term or keep the walker approach?', 'u')
    await waitFor(() => edits.some((e) => e.includes('Short take')))
    expect(edits.at(-1)).toMatch(/Say "dual brain"/)
    processor.submit('c', 'yes', 'u')
    await waitFor(() => sent.some((s) => s.includes('🛠 Task #1')))
    // orchestrator is off in this harness → falls back to a task job on the ORIGINAL question
    const prompt = vi.mocked(spawnClaude).mock.calls.at(-1)?.[0] as string
    expect(prompt).toMatch(/clinical archive into an encrypted vault/)
  })
})
