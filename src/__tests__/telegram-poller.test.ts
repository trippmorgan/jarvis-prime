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

  describe('sendMessageAndGetId', () => {
    it('returns message_id on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 42, chat: { id: 123 }, date: 1 } }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const result = await poller.sendMessageAndGetId('123', 'Hello', 'Markdown')

      expect(result).toBe(42)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ chat_id: '123', text: 'Hello', parse_mode: 'Markdown' }),
        }),
      )

      vi.unstubAllGlobals()
    })

    it('returns null on 400 response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' }),
      )

      const result = await poller.sendMessageAndGetId('123', 'Hello')
      expect(result).toBeNull()

      vi.unstubAllGlobals()
    })

    it('returns null on 500 response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal Server Error' }),
      )

      const result = await poller.sendMessageAndGetId('123', 'Hello')
      expect(result).toBeNull()

      vi.unstubAllGlobals()
    })
  })

  describe('editMessageText', () => {
    it('POSTs to editMessageText with correct body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
      vi.stubGlobal('fetch', fetchMock)

      const result = await poller.editMessageText('123', 42, 'Updated text')

      expect(result).toBe(true)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/editMessageText',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ chat_id: '123', message_id: 42, text: 'Updated text' }),
        }),
      )

      vi.unstubAllGlobals()
    })

    it('swallows "message is not modified" (returns false, no throw)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () =>
            '{"ok":false,"description":"Bad Request: message is not modified: specified new message content and reply markup are exactly the same"}',
        }),
      )

      const result = await poller.editMessageText('123', 42, 'Same text')
      expect(result).toBe(false)

      vi.unstubAllGlobals()
    })

    it('swallows "chat not found" (returns false, no throw)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => '{"ok":false,"description":"Bad Request: chat not found"}',
        }),
      )

      const result = await poller.editMessageText('999', 42, 'Hello')
      expect(result).toBe(false)

      vi.unstubAllGlobals()
    })

    it('returns false on other non-2xx responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal Server Error' }),
      )

      const result = await poller.editMessageText('123', 42, 'Hello')
      expect(result).toBe(false)

      vi.unstubAllGlobals()
    })
  })

  describe('sendChatAction', () => {
    it('POSTs to sendChatAction with action=typing', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
      vi.stubGlobal('fetch', fetchMock)

      const result = await poller.sendChatAction('123', 'typing')

      expect(result).toBe(true)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendChatAction',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ chat_id: '123', action: 'typing' }),
        }),
      )

      vi.unstubAllGlobals()
    })

    it('swallows 400 response (returns false, no throw)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' }),
      )

      const result = await poller.sendChatAction('123', 'typing')
      expect(result).toBe(false)

      vi.unstubAllGlobals()
    })
  })
})
