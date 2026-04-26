import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { registerMessageRoute } from '../routes/message.js'
import { MessageProcessor } from '../bridge/processor.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))
vi.mock('../claude/spawner-stream.js', () => ({
  spawnClaudeStream: vi.fn(),
}))

import { spawnClaude } from '../claude/spawner.js'
import { spawnClaudeStream } from '../claude/spawner-stream.js'

const deliverMock = vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined)

function makeProcessor(): MessageProcessor {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
  return new MessageProcessor(
    {
      claudePath: '/usr/bin/claude',
      claudeModel: 'sonnet',
      claudeTimeoutMs: 120_000,
      historyPath: join(tmpDir, 'history.jsonl'),
    },
    deliverMock,
    Fastify({ logger: false }).log,
  )
}

describe('POST /message', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(() => {
    vi.clearAllMocks()
    server = Fastify()
    registerMessageRoute(server, makeProcessor())
  })

  afterEach(async () => {
    await server.close()
  })

  it('accepts valid message and returns 202', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: 'Hello from Claude',
      stderr: '',
      exitCode: 0,
      durationMs: 1000,
      timedOut: false,
    })

    const response = await server.inject({
      method: 'POST',
      url: '/message',
      payload: { chatId: '123', text: 'Hello', userId: 'user1' },
    })

    expect(response.statusCode).toBe(202)
    const body = JSON.parse(response.body)
    expect(body.queued).toBe(true)
    expect(body.position).toBe(1)
  })

  it('rejects invalid payload with 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/message',
      payload: { chatId: '123' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('calls spawnClaude after processing', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: 'Test response',
      stderr: '',
      exitCode: 0,
      durationMs: 500,
      timedOut: false,
    })

    await server.inject({
      method: 'POST',
      url: '/message',
      payload: { chatId: '123', text: 'Hello', userId: 'user1' },
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(spawnClaudeStream).toHaveBeenCalledWith(
      expect.stringContaining('Hello'),
      expect.objectContaining({ model: 'sonnet' }),
    )
  })

  it('delivers timeout error gracefully', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: '',
      stderr: '',
      exitCode: 1,
      durationMs: 300_000,
      timedOut: true,
    })

    await server.inject({
      method: 'POST',
      url: '/message',
      payload: { chatId: '123', text: 'complex task', userId: 'user1' },
    })

    await new Promise((r) => setTimeout(r, 100))

    const timeoutCall = deliverMock.mock.calls.find(c => c[1].includes('timed out'))
    expect(timeoutCall).toBeDefined()
  })

  it('delivers Claude error gracefully', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: '',
      stderr: 'Something went wrong',
      exitCode: 1,
      durationMs: 100,
      timedOut: false,
    })

    await server.inject({
      method: 'POST',
      url: '/message',
      payload: { chatId: '123', text: 'bad request', userId: 'user1' },
    })

    await new Promise((r) => setTimeout(r, 100))

    const errorCall = deliverMock.mock.calls.find(c => c[1].includes('error'))
    expect(errorCall).toBeDefined()
  })
})

describe('GET /queue', () => {
  it('returns queue status', async () => {
    const server = Fastify()
    registerMessageRoute(server, makeProcessor())

    const response = await server.inject({
      method: 'GET',
      url: '/queue',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body).toHaveProperty('length')
    expect(body).toHaveProperty('processing')

    await server.close()
  })
})
