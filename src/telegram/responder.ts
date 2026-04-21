/**
 * TelegramResponder — single-message evolving UX for Telegram chats.
 *
 * Wraps a narrow send-surface to provide:
 *   - Debounced editMessageText updates (Telegram bot-edit rate limit is 1/sec/chat)
 *   - Typing-indicator heartbeat (chat_action TTL is ~5s)
 *
 * Keyed by chatId so multiple concurrent conversations don't interfere.
 */

export interface TelegramSendSurface {
  sendMessageAndGetId(chatId: string, text: string): Promise<number | null>
  editMessageText(chatId: string, messageId: number, text: string): Promise<boolean>
  sendChatAction(chatId: string, action: string): Promise<boolean>
}

export interface TelegramResponderLogger {
  info: (o: object, m?: string) => void
  warn: (o: object, m?: string) => void
  error: (o: object, m?: string) => void
}

export interface TelegramResponderOptions {
  surface: TelegramSendSurface
  editDebounceMs?: number
  typingIntervalMs?: number
  logger?: TelegramResponderLogger
}

interface DebounceState {
  messageId: number
  timer: ReturnType<typeof setTimeout> | null
  pendingText: string | null
  pendingMessageId: number | null
}

const noopLogger: TelegramResponderLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export class TelegramResponder {
  private readonly surface: TelegramSendSurface
  private readonly editDebounceMs: number
  private readonly typingIntervalMs: number
  private readonly log: TelegramResponderLogger

  private readonly debounceByChat = new Map<string, DebounceState>()
  private readonly typingByChat = new Map<string, ReturnType<typeof setInterval>>()

  constructor(opts: TelegramResponderOptions) {
    this.surface = opts.surface
    this.editDebounceMs = opts.editDebounceMs ?? 1000
    this.typingIntervalMs = opts.typingIntervalMs ?? 4000
    this.log = opts.logger ?? noopLogger
  }

  async postAck(chatId: string, initialText: string): Promise<number | null> {
    try {
      return await this.surface.sendMessageAndGetId(chatId, initialText)
    } catch (err) {
      this.log.error(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'TelegramResponder.postAck error',
      )
      return null
    }
  }

  /**
   * Post a fresh standalone bubble. Used after a deliberation card has been
   * pinned to the original ack bubble — subsequent content (the integrated
   * answer, follow-up chunks, error text) lands as new messages below.
   */
  async postBubble(chatId: string, text: string): Promise<number | null> {
    try {
      return await this.surface.sendMessageAndGetId(chatId, text)
    } catch (err) {
      this.log.error(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'TelegramResponder.postBubble error',
      )
      return null
    }
  }

  updatePhase(chatId: string, messageId: number, label: string): void {
    const state = this.debounceByChat.get(chatId)

    if (!state) {
      // Quiet window — fire immediately and start debounce window
      const newState: DebounceState = {
        messageId,
        timer: null,
        pendingText: null,
        pendingMessageId: null,
      }
      this.debounceByChat.set(chatId, newState)
      this.fireEdit(chatId, messageId, label)
      this.armDebounceWindow(chatId, newState)
      return
    }

    // Already in a debounce window — stash latest text for flush
    state.pendingText = label
    state.pendingMessageId = messageId
  }

  async finalize(chatId: string, messageId: number, text: string): Promise<void> {
    const state = this.debounceByChat.get(chatId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    // Clear state: pending intermediate is discarded
    this.debounceByChat.delete(chatId)

    try {
      await this.surface.editMessageText(chatId, messageId, text)
    } catch (err) {
      this.log.error(
        { chatId, messageId, error: err instanceof Error ? err.message : String(err) },
        'TelegramResponder.finalize error',
      )
    }
  }

  startTyping(chatId: string): () => void {
    // Replace any existing typing loop for this chat
    const existing = this.typingByChat.get(chatId)
    if (existing) {
      clearInterval(existing)
      this.typingByChat.delete(chatId)
    }

    // Fire immediately (swallowed on error)
    void this.fireChatAction(chatId)

    const interval = setInterval(() => {
      void this.fireChatAction(chatId)
    }, this.typingIntervalMs)
    this.typingByChat.set(chatId, interval)

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      // Only remove from map if still the same handle (startTyping may have replaced it)
      if (this.typingByChat.get(chatId) === interval) {
        this.typingByChat.delete(chatId)
      }
    }
  }

  private armDebounceWindow(chatId: string, state: DebounceState): void {
    state.timer = setTimeout(() => {
      // Window closed — if a pending edit exists, fire it and re-arm; otherwise clear state
      const pendingText = state.pendingText
      const pendingMessageId = state.pendingMessageId
      state.pendingText = null
      state.pendingMessageId = null
      state.timer = null

      if (pendingText !== null && pendingMessageId !== null) {
        this.fireEdit(chatId, pendingMessageId, pendingText)
        this.armDebounceWindow(chatId, state)
      } else {
        // No pending — debounce window is done
        this.debounceByChat.delete(chatId)
      }
    }, this.editDebounceMs)
  }

  private fireEdit(chatId: string, messageId: number, text: string): void {
    // Fire-and-forget — errors swallowed via .catch
    Promise.resolve()
      .then(() => this.surface.editMessageText(chatId, messageId, text))
      .then((ok) => {
        if (!ok) {
          this.log.warn({ chatId, messageId }, 'editMessageText returned false')
        }
      })
      .catch((err: unknown) => {
        this.log.error(
          { chatId, messageId, error: err instanceof Error ? err.message : String(err) },
          'editMessageText threw',
        )
      })
  }

  private async fireChatAction(chatId: string): Promise<void> {
    try {
      await this.surface.sendChatAction(chatId, 'typing')
    } catch (err) {
      this.log.error(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'sendChatAction threw',
      )
    }
  }
}
