import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { TelegramPoller } from '../telegram/poller.js'

describe('TelegramPoller', () => {
  let onMessageMock: ReturnType<typeof vi.fn>
  let poller: TelegramPoller

  beforeEach(() => {
    onMessageMock = vi.fn().mockResolvedValue(undefined)
    poller = new TelegramPoller({
      botToken: 'test-token',
      allowedChatIds: ['8048875001'],
      pollTimeoutSecs: 1,
      onMessage: onMessageMock,
      logger: Fastify({ logger: false }).log,
    })
  })

  afterEach(() => {
    poller.stop()
  })

  it('sends message via Bot API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await poller.sendMessage('123', 'Hello', 'Markdown')

    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '123', text: 'Hello', parse_mode: 'Markdown' }),
      }),
    )

    vi.unstubAllGlobals()
  })

  it('returns false on sendMessage failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' }))

    const result = await poller.sendMessage('123', 'Hello')
    expect(result).toBe(false)

    vi.unstubAllGlobals()
  })

  it('retries as plain text when Markdown parse fails', async () => {
    let callCount = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: false, status: 400, text: async () => '{"ok":false,"description":"Bad Request: can\'t parse entities: Can\'t find end of the entity starting at byte offset 42"}' }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await poller.sendMessage('123', 'Hello *broken', 'Markdown')

    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondCall = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondCall.parse_mode).toBeUndefined()

    vi.unstubAllGlobals()
  })
})
