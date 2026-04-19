import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelegramResponder, type TelegramSendSurface } from '../telegram/responder.js'

function makeSurface(): {
  surface: TelegramSendSurface
  sendMessageAndGetId: ReturnType<typeof vi.fn>
  editMessageText: ReturnType<typeof vi.fn>
  sendChatAction: ReturnType<typeof vi.fn>
} {
  const sendMessageAndGetId = vi.fn().mockResolvedValue(42)
  const editMessageText = vi.fn().mockResolvedValue(true)
  const sendChatAction = vi.fn().mockResolvedValue(true)
  const surface: TelegramSendSurface = {
    sendMessageAndGetId,
    editMessageText,
    sendChatAction,
  }
  return { surface, sendMessageAndGetId, editMessageText, sendChatAction }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe('TelegramResponder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('postAck', () => {
    it('calls sendMessageAndGetId once and returns the messageId', async () => {
      const { surface, sendMessageAndGetId } = makeSurface()
      const responder = new TelegramResponder({ surface, logger: makeLogger() })

      const id = await responder.postAck('chat-1', 'working on it')

      expect(id).toBe(42)
      expect(sendMessageAndGetId).toHaveBeenCalledTimes(1)
      expect(sendMessageAndGetId).toHaveBeenCalledWith('chat-1', 'working on it')
    })

    it('returns null when surface returns null', async () => {
      const { surface, sendMessageAndGetId } = makeSurface()
      sendMessageAndGetId.mockResolvedValueOnce(null)
      const responder = new TelegramResponder({ surface, logger: makeLogger() })

      const id = await responder.postAck('chat-1', 'working on it')

      expect(id).toBeNull()
    })
  })

  describe('updatePhase (debounce)', () => {
    it('fires edit immediately on first call in quiet window', async () => {
      const { surface, editMessageText } = makeSurface()
      const responder = new TelegramResponder({ surface, logger: makeLogger() })

      responder.updatePhase('chat-1', 42, 'phase-a')

      // Allow microtasks to flush (edit is fired but promise-based)
      await vi.advanceTimersByTimeAsync(0)

      expect(editMessageText).toHaveBeenCalledTimes(1)
      expect(editMessageText).toHaveBeenCalledWith('chat-1', 42, 'phase-a')
    })

    it('burst of 5 calls within debounce window fires 2 edits total with latest label', async () => {
      const { surface, editMessageText } = makeSurface()
      const responder = new TelegramResponder({
        surface,
        editDebounceMs: 1000,
        logger: makeLogger(),
      })

      // t=0 — first call fires immediately
      responder.updatePhase('chat-1', 42, 'A')
      await vi.advanceTimersByTimeAsync(0)
      expect(editMessageText).toHaveBeenCalledTimes(1)

      // t=100 .. t=400 — four more calls within window
      await vi.advanceTimersByTimeAsync(100)
      responder.updatePhase('chat-1', 42, 'B')
      await vi.advanceTimersByTimeAsync(100)
      responder.updatePhase('chat-1', 42, 'C')
      await vi.advanceTimersByTimeAsync(100)
      responder.updatePhase('chat-1', 42, 'D')
      await vi.advanceTimersByTimeAsync(100)
      responder.updatePhase('chat-1', 42, 'E')

      // Still only 1 edit during the window
      expect(editMessageText).toHaveBeenCalledTimes(1)

      // Advance to t=1000 — debounced edit should fire with latest ('E')
      await vi.advanceTimersByTimeAsync(1000)

      expect(editMessageText).toHaveBeenCalledTimes(2)
      expect(editMessageText).toHaveBeenLastCalledWith('chat-1', 42, 'E')
    })

    it('two different chatIds have independent debounce windows', async () => {
      const { surface, editMessageText } = makeSurface()
      const responder = new TelegramResponder({ surface, logger: makeLogger() })

      responder.updatePhase('chat-1', 11, 'a-1')
      responder.updatePhase('chat-2', 22, 'b-1')

      await vi.advanceTimersByTimeAsync(0)

      expect(editMessageText).toHaveBeenCalledTimes(2)
      expect(editMessageText).toHaveBeenCalledWith('chat-1', 11, 'a-1')
      expect(editMessageText).toHaveBeenCalledWith('chat-2', 22, 'b-1')
    })
  })

  describe('finalize', () => {
    it('flushes pending debounce without sending intermediate label', async () => {
      const { surface, editMessageText } = makeSurface()
      const responder = new TelegramResponder({
        surface,
        editDebounceMs: 1000,
        logger: makeLogger(),
      })

      responder.updatePhase('chat-1', 42, 'A') // immediate
      await vi.advanceTimersByTimeAsync(0)
      expect(editMessageText).toHaveBeenCalledTimes(1)
      expect(editMessageText).toHaveBeenLastCalledWith('chat-1', 42, 'A')

      responder.updatePhase('chat-1', 42, 'stale') // pending

      await responder.finalize('chat-1', 42, 'final')

      // Two edits total: immediate "A" and "final" — never "stale"
      expect(editMessageText).toHaveBeenCalledTimes(2)
      expect(editMessageText).toHaveBeenLastCalledWith('chat-1', 42, 'final')

      // Advance past debounce window — no additional edit
      await vi.advanceTimersByTimeAsync(2000)
      expect(editMessageText).toHaveBeenCalledTimes(2)
    })

    it('finalize with nothing pending fires a single edit with final text', async () => {
      const { surface, editMessageText } = makeSurface()
      const responder = new TelegramResponder({ surface, logger: makeLogger() })

      await responder.finalize('chat-1', 42, 'done')

      expect(editMessageText).toHaveBeenCalledTimes(1)
      expect(editMessageText).toHaveBeenCalledWith('chat-1', 42, 'done')
    })
  })

  describe('startTyping', () => {
    it('fires sendChatAction immediately then every typingIntervalMs', async () => {
      const { surface, sendChatAction } = makeSurface()
      const responder = new TelegramResponder({
        surface,
        typingIntervalMs: 4000,
        logger: makeLogger(),
      })

      const stop = responder.startTyping('chat-1')

      // Immediate call
      await vi.advanceTimersByTimeAsync(0)
      expect(sendChatAction).toHaveBeenCalledTimes(1)
      expect(sendChatAction).toHaveBeenCalledWith('chat-1', 'typing')

      // t=4000
      await vi.advanceTimersByTimeAsync(4000)
      expect(sendChatAction).toHaveBeenCalledTimes(2)

      // t=8000
      await vi.advanceTimersByTimeAsync(4000)
      expect(sendChatAction).toHaveBeenCalledTimes(3)

      stop()
    })

    it('stopper prevents further sendChatAction calls', async () => {
      const { surface, sendChatAction } = makeSurface()
      const responder = new TelegramResponder({
        surface,
        typingIntervalMs: 4000,
        logger: makeLogger(),
      })

      const stop = responder.startTyping('chat-1')
      await vi.advanceTimersByTimeAsync(0)
      expect(sendChatAction).toHaveBeenCalledTimes(1)

      stop()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(sendChatAction).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('editMessageText throwing during debounced edit does not crash timers; next updatePhase still works', async () => {
      const { surface, editMessageText } = makeSurface()
      const logger = makeLogger()
      // First call throws
      editMessageText.mockRejectedValueOnce(new Error('boom'))

      const responder = new TelegramResponder({
        surface,
        editDebounceMs: 1000,
        logger,
      })

      responder.updatePhase('chat-1', 42, 'A') // immediate — throws
      await vi.advanceTimersByTimeAsync(10)

      // Error was swallowed and logged
      expect(logger.error).toHaveBeenCalled()

      // Next call: should still work (treated as quiet window since last fire resolved)
      responder.updatePhase('chat-1', 42, 'B')
      await vi.advanceTimersByTimeAsync(1100)

      // Subsequent edits should succeed
      expect(editMessageText.mock.calls.length).toBeGreaterThanOrEqual(2)
      // Last observed call should be the latest label sent
      const lastCall = editMessageText.mock.calls[editMessageText.mock.calls.length - 1]
      expect(lastCall[2]).toBe('B')
    })
  })
})
