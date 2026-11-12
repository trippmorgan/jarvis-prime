import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import {
  registerChatCompletionsRoute,
  lastUserText,
  isVirtualChat,
  guardDelivery,
  guardSurface,
  MODEL_ID,
} from '../routes/chat-completions.js'
import { MessageProcessor } from '../bridge/processor.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))
vi.mock('../claude/spawner-stream.js', () => ({
  spawnClaudeStream: vi.fn(),
}))
// Same shim as message-route.test.ts: the openclaw left runtime is the
// default, so both openclaw spawners drive off the spawnClaudeStream mock.
vi.mock('../openclaw/spawner.js', async () => {
  const { spawnClaudeStream } = await import('../claude/spawner-stream.js')
  return { spawnOpenclawAgent: spawnClaudeStream }
})
vi.mock('../openclaw/spawner-stream.js', async () => {
  const { spawnClaudeStream } = await import('../claude/spawner-stream.js')
  return { spawnOpenclawAgentStream: spawnClaudeStream }
})

import { spawnClaudeStream } from '../claude/spawner-stream.js'

const deliverMock = vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined)

function makeProcessor(): MessageProcessor {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-cc-test-'))
  return new MessageProcessor(
    {
      claudePath: '/usr/bin/claude',
      claudeModel: 'sonnet',
      claudeTimeoutMs: 120_000,
      workingDir: '/tmp',
      nodeName: 'Frank',
      botUsername: 'Frank_Voldemort_Bot',
      historyPath: join(tmpDir, 'history.jsonl'),
    },
    deliverMock,
    Fastify({ logger: false }).log,
  )
}

/** Parse an SSE body into its JSON data events (skipping comments/[DONE]). */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map((block) => JSON.parse(block.slice('data: '.length)))
}

describe('helpers', () => {
  it('lastUserText picks the last non-empty user turn and flattens parts', () => {
    expect(
      lastUserText([
        { role: 'system', content: 'You are Frank' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url' }] },
        { role: 'user', content: '   ' },
      ]),
    ).toBe('second')
    expect(lastUserText([{ role: 'system', content: 'only system' }])).toBeNull()
  })

  it('lastUserText skips the openclaw runtime-context envelope that trails the real prompt', () => {
    const envelope = [
      'OpenClaw runtime context for the immediately preceding user message.',
      'This context is runtime-generated, not user-authored. Keep internal details private.',
      '',
      'Sender (untrusted metadata):',
      '```json',
      '{ "label": "openclaw-tui", "id": "openclaw-tui" }',
      '```',
      '',
      'The previous attempt did not produce a user-visible answer. Continue from the current state.',
    ].join('\n')
    expect(
      lastUserText([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '[Tue 2026-09-01 23:00 EDT] what are your hemispheres?' },
        { role: 'user', content: envelope },
      ]),
    ).toBe('[Tue 2026-09-01 23:00 EDT] what are your hemispheres?')
    // an envelope with no real prompt behind it is not answerable
    expect(lastUserText([{ role: 'user', content: envelope }])).toBeNull()
  })

  it('isVirtualChat recognises the tui: prefix only', () => {
    expect(isVirtualChat('tui:openclaw')).toBe(true)
    expect(isVirtualChat('8048875001')).toBe(false)
  })
})

describe('POST /v1/chat/completions', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(() => {
    vi.clearAllMocks()
    server = Fastify()
    registerChatCompletionsRoute(server, makeProcessor())
  })

  afterEach(async () => {
    await server.close()
  })

  it('returns a non-streaming completion carrying the processed reply', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: 'Hello from Frank',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
    })

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: MODEL_ID,
        messages: [
          { role: 'system', content: 'openclaw system prompt' },
          { role: 'user', content: 'Hello' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe(MODEL_ID)
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Hello from Frank' })
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBeGreaterThan(0)
    // The processor still "delivers" — to a virtual chat id that server.ts's
    // guardDelivery() drops (covered below), never to a Telegram chat.
    expect(deliverMock).toHaveBeenCalledWith('tui:openclaw', 'Hello from Frank')
  })

  it('streams the reply as OpenAI-style SSE chunks ending in [DONE] (real socket)', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: 'Streamed answer',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
    })

    // A real HTTP round-trip, not inject(): the hijacked SSE path depends on
    // Node's request/response 'close' semantics, which light-my-request does
    // not model (a listener on the wrong stream once made every write a no-op).
    const address = await server.listen({ port: 0, host: '127.0.0.1' })
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        stream: true,
        messages: [{ role: 'user', content: 'Stream please' }],
      }),
    })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(body.trim().endsWith('data: [DONE]')).toBe(true)

    const events = parseSse(body)
    expect(events.every((e) => e.object === 'chat.completion.chunk')).toBe(true)
    const content = events
      .map((e) => (e.choices as Array<{ delta: { content?: string } }>)[0].delta.content ?? '')
      .join('')
    expect(content).toBe('Streamed answer')
    const last = events[events.length - 1] as { choices: Array<{ finish_reason: string | null }> }
    expect(last.choices[0].finish_reason).toBe('stop')
  })

  it('routes the turn to a virtual tui: chat, honouring x-frank-chat-id', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
    })

    await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-frank-chat-id': 'term-1' },
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    })

    expect(spawnClaudeStream).toHaveBeenCalledWith(
      expect.stringContaining('Hi'),
      expect.objectContaining({ workingDir: expect.any(String) }),
    )
    const chatIds = deliverMock.mock.calls.map((c) => c[0])
    expect(chatIds.length).toBeGreaterThan(0)
    expect(chatIds.every((id) => id === 'tui:term-1')).toBe(true)
  })

  it('surfaces a pipeline error as the reply text (like Telegram would)', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({
      output: '',
      stderr: 'boom',
      exitCode: 1,
      durationMs: 10,
      timedOut: false,
    })

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'break' }] },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.choices[0].message.content.toLowerCase()).toContain('error')
  })

  it('rejects payloads without a user message', async () => {
    const noUser = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'system', content: 'sys only' }] },
    })
    expect(noUser.statusCode).toBe(400)

    const malformed = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: MODEL_ID },
    })
    expect(malformed.statusCode).toBe(400)
  })
})

describe('Telegram guards (as wired in server.ts)', () => {
  it('guardDelivery drops virtual chats and passes real ones through', async () => {
    const inner = vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined)
    const deliver = guardDelivery(inner)
    await deliver('tui:openclaw', 'Working on it...')
    await deliver('tui:term-1', 'final answer')
    expect(inner).not.toHaveBeenCalled()
    await deliver('8048875001', 'hello tripp')
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledWith('8048875001', 'hello tripp')
  })

  it('guardSurface rejects virtual chats (postAck → null → legacy path) and forwards real ones', async () => {
    const sendMessageAndGetId = vi.fn().mockResolvedValue(42)
    const editMessageText = vi.fn().mockResolvedValue(undefined)
    const sendChatAction = vi.fn().mockResolvedValue(undefined)
    const surface = guardSurface({ sendMessageAndGetId, editMessageText, sendChatAction })

    await expect(surface.sendMessageAndGetId('tui:openclaw', 'ack')).rejects.toThrow(/virtual chat/)
    await expect(surface.editMessageText('tui:openclaw', 1, 'x')).rejects.toThrow(/virtual chat/)
    await expect(surface.sendChatAction('tui:openclaw', 'typing')).rejects.toThrow(/virtual chat/)
    expect(sendMessageAndGetId).not.toHaveBeenCalled()
    expect(editMessageText).not.toHaveBeenCalled()
    expect(sendChatAction).not.toHaveBeenCalled()

    await expect(surface.sendMessageAndGetId('8048875001', 'ack')).resolves.toBe(42)
    expect(sendMessageAndGetId).toHaveBeenCalledWith('8048875001', 'ack')
    await surface.sendChatAction('8048875001', 'typing')
    expect(sendChatAction).toHaveBeenCalledWith('8048875001', 'typing')
  })
})

describe('GET /v1/models', () => {
  it('advertises the frank-prime model', async () => {
    const server = Fastify()
    registerChatCompletionsRoute(server, makeProcessor())
    const response = await server.inject({ method: 'GET', url: '/v1/models' })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).data[0].id).toBe(MODEL_ID)
    await server.close()
  })
})
