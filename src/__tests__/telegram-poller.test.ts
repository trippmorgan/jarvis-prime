import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { TelegramPoller, type TelegramUpdate } from '../telegram/poller.js'

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

  describe('getUpdates transport circuit breaker', () => {
    it('opens after repeated poll transport failures and exponentially backs off', async () => {
      const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause })))

      for (let i = 0; i < 3; i++) {
        await expect((poller as any).poll()).rejects.toThrow('fetch failed')
      }
      expect((poller as any).circuitOpen).toBe(true)
      expect((poller as any).pollBackoffMs).toBe(5_000)

      await expect((poller as any).poll()).rejects.toThrow('fetch failed')
      expect((poller as any).pollBackoffMs).toBe(10_000)

      vi.unstubAllGlobals()
    })

    it('closes the circuit after a successful getUpdates response', async () => {
      ;(poller as any).circuitOpen = true
      ;(poller as any).consecutiveTransportFailures = 7
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      }))

      await (poller as any).poll()

      expect((poller as any).circuitOpen).toBe(false)
      expect((poller as any).consecutiveTransportFailures).toBe(0)
      vi.unstubAllGlobals()
    })
  })

  describe('photo handling', () => {
    const downloadedPaths: string[] = []

    afterEach(() => {
      for (const p of downloadedPaths.splice(0)) {
        try { rmSync(p) } catch { /* already gone */ }
      }
    })

    function photoUpdate(caption?: string): TelegramUpdate {
      return {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 99, first_name: 'Tripp' },
          chat: { id: 8048875001, type: 'private' },
          date: 0,
          caption,
          photo: [
            { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
            { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 1280 },
          ],
        },
      }
    }

    it('downloads the highest-res photo and references its local path in the prompt text', async () => {
      const fileBytes = Buffer.from('fake-jpeg-bytes')
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/getFile')) {
          expect(url).toContain('file_id=big') // picks the last (largest) variant
          return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } }) }
        }
        if (url.includes('/file/bottest-token/')) {
          return { ok: true, arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength) }
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      await (poller as any).handleUpdate(photoUpdate('who is this'))

      expect(onMessageMock).toHaveBeenCalledTimes(1)
      const [, text] = onMessageMock.mock.calls[0]
      expect(text).toContain('who is this')
      expect(text).toMatch(/saved to (\/\S+)\. Use the Read tool/)

      const match = text.match(/saved to (\/\S+)\./)
      const localPath = match![1]
      downloadedPaths.push(localPath)
      expect(existsSync(localPath)).toBe(true)
      expect(readFileSync(localPath)).toEqual(fileBytes)

      vi.unstubAllGlobals()
    })

    it('falls back to a placeholder when the download fails, without throwing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

      await (poller as any).handleUpdate(photoUpdate())

      expect(onMessageMock).toHaveBeenCalledTimes(1)
      const [, text] = onMessageMock.mock.calls[0]
      expect(text).toContain('download failed')
      expect(text).not.toContain('saved to')

      vi.unstubAllGlobals()
    })
  })

  describe('duplicate-delivery guard', () => {
    it('persists the advanced offset before downstream dispatch and restores it after restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'telegram-offset-test-'))
      const offsetPath = join(dir, 'offset.json')
      let persistedDuringDispatch = 0
      const guardedHandler = vi.fn().mockImplementation(async () => {
        persistedDuringDispatch = JSON.parse(readFileSync(offsetPath, 'utf8')).offset
      })
      const guardedPoller = new TelegramPoller({
        botToken: 'test-token',
        allowedChatIds: ['8048875001'],
        pollTimeoutSecs: 1,
        offsetPersistPath: offsetPath,
        onMessage: guardedHandler,
        logger: Fastify({ logger: false }).log,
      })

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: [{
            update_id: 41,
            message: {
              message_id: 7,
              from: { id: 99, first_name: 'Tripp' },
              chat: { id: 8048875001, type: 'private' },
              date: 0,
              text: 'once only',
            },
          }],
        }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await (guardedPoller as any).poll()
      expect(guardedHandler).toHaveBeenCalledTimes(1)
      expect(persistedDuringDispatch).toBe(42)

      const restartedPoller = new TelegramPoller({
        botToken: 'test-token',
        allowedChatIds: ['8048875001'],
        pollTimeoutSecs: 1,
        offsetPersistPath: offsetPath,
        onMessage: vi.fn(),
        logger: Fastify({ logger: false }).log,
      })
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: [] }) })
      await (restartedPoller as any).poll()
      expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('offset=42')

      guardedPoller.stop()
      restartedPoller.stop()
      vi.unstubAllGlobals()
      rmSync(dir, { recursive: true, force: true })
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
