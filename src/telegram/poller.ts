import type { FastifyBaseLogger } from 'fastify'

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; first_name: string; username?: string }
    chat: { id: number; type: string }
    date: number
    text?: string
    caption?: string
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>
  }
}

export interface TelegramPollerConfig {
  botToken: string
  allowedChatIds: string[]
  pollTimeoutSecs: number
  onMessage: (chatId: string, text: string, userId: string) => Promise<void>
  logger: FastifyBaseLogger
}

export class TelegramPoller {
  private readonly apiBase: string
  private readonly allowedChatIds: Set<string>
  private readonly pollTimeout: number
  private readonly onMessage: TelegramPollerConfig['onMessage']
  private readonly log: FastifyBaseLogger
  private offset = 0
  private running = false
  private abortController: AbortController | null = null

  constructor(config: TelegramPollerConfig) {
    this.apiBase = `https://api.telegram.org/bot${config.botToken}`
    this.allowedChatIds = new Set(config.allowedChatIds)
    this.pollTimeout = config.pollTimeoutSecs
    this.onMessage = config.onMessage
    this.log = config.logger
  }

  async start(): Promise<void> {
    this.running = true
    this.log.info('Telegram poller starting')

    while (this.running) {
      try {
        await this.poll()
      } catch (err) {
        if (!this.running) break
        const msg = err instanceof Error ? err.message : String(err)
        const is409 = msg.includes('409')
        if (is409) {
          this.log.warn('Telegram poll conflict (409) — another process is polling this token. Yielding 90s.')
          await sleep(90_000)
        } else {
          this.log.error({ error: msg }, 'Telegram poll error — retrying in 5s')
          await sleep(5_000)
        }
      }
    }

    this.log.info('Telegram poller stopped')
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
  }

  /**
   * Wraps fetch with one retry on transient network failures (DNS hiccups,
   * TLS handshake aborts — observed as `fetch failed` against
   * api.telegram.org). HTTP error responses (4xx/5xx) are NOT retried — those
   * are returned to the caller so existing per-method handling can apply
   * (markdown reparse, benign 400s, etc.). Returns null only when both
   * attempts threw.
   */
  private async fetchTelegram(path: string, body: object, ctx: object): Promise<Response | null> {
    const url = `${this.apiBase}/${path}`
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetch(url, init)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (attempt === 0) {
          this.log.warn({ ...ctx, path, error: errMsg }, 'Telegram fetch failed — retrying once after 200ms')
          await sleep(200)
          continue
        }
        this.log.error({ ...ctx, path, error: errMsg }, 'Telegram fetch failed after retry')
        return null
      }
    }
    return null
  }

  async sendMessage(chatId: string, text: string, parseMode?: string): Promise<boolean> {
    const body: Record<string, unknown> = { chat_id: chatId, text }
    if (parseMode) body.parse_mode = parseMode

    const res = await this.fetchTelegram('sendMessage', body, { chatId })
    if (!res) return false

    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`)

      // Markdown parse failure — retry without formatting
      if (parseMode && res.status === 400 && errText.includes("can't parse entities")) {
        this.log.warn({ chatId }, 'Markdown parse failed — retrying as plain text')
        return this.sendMessage(chatId, text)
      }

      this.log.error({ chatId, status: res.status, error: errText }, 'sendMessage failed')
      return false
    }

    return true
  }

  async sendMessageAndGetId(chatId: string, text: string, parseMode?: string): Promise<number | null> {
    const body: Record<string, unknown> = { chat_id: chatId, text }
    if (parseMode) body.parse_mode = parseMode

    const res = await this.fetchTelegram('sendMessage', body, { chatId })
    if (!res) return null

    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`)
      this.log.error({ chatId, status: res.status, error: errText }, 'sendMessageAndGetId failed')
      return null
    }

    try {
      const data = (await res.json()) as { ok: boolean; result?: { message_id: number } }
      if (!data.ok || !data.result || typeof data.result.message_id !== 'number') {
        this.log.error({ chatId }, 'sendMessageAndGetId: unexpected response shape')
        return null
      }
      return data.result.message_id
    } catch (err) {
      this.log.error(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'sendMessageAndGetId parse error',
      )
      return null
    }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<boolean> {
    const body = { chat_id: chatId, message_id: messageId, text }

    const res = await this.fetchTelegram('editMessageText', body, { chatId, messageId })
    if (!res) return false

    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`)

      if (
        res.status === 400 &&
        (errText.includes('message is not modified') || errText.includes('chat not found'))
      ) {
        this.log.warn({ chatId, messageId, status: res.status }, 'editMessageText swallowed benign 400')
        return false
      }

      this.log.error({ chatId, messageId, status: res.status, error: errText }, 'editMessageText failed')
      return false
    }

    return true
  }

  async sendChatAction(chatId: string, action: string): Promise<boolean> {
    const body = { chat_id: chatId, action }

    const res = await this.fetchTelegram('sendChatAction', body, { chatId, action })
    if (!res) return false

    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`)

      if (res.status === 400) {
        this.log.warn({ chatId, action, error: errText }, 'sendChatAction swallowed 400')
        return false
      }

      this.log.error({ chatId, action, status: res.status, error: errText }, 'sendChatAction failed')
      return false
    }

    return true
  }

  private async poll(): Promise<void> {
    this.abortController = new AbortController()
    const timeout = setTimeout(() => this.abortController?.abort(), (this.pollTimeout + 5) * 1000)

    try {
      const url = `${this.apiBase}/getUpdates?offset=${this.offset}&timeout=${this.pollTimeout}&allowed_updates=["message"]`
      const res = await fetch(url, { signal: this.abortController.signal })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }

      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }
      if (!data.ok || !data.result) return

      for (const update of data.result) {
        this.offset = update.update_id + 1
        await this.handleUpdate(update)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message
    if (!msg?.from) return

    const hasText = !!msg.text
    const hasPhoto = !!(msg.photo?.length)
    if (!hasText && !hasPhoto) return

    const chatId = String(msg.chat.id)
    const userId = String(msg.from.id)

    if (!this.allowedChatIds.has(chatId)) {
      this.log.warn({ chatId, userId }, 'Message from unauthorized chat — ignoring')
      return
    }

    let text: string
    if (hasPhoto) {
      const caption = msg.caption?.trim()
      text = caption
        ? `[Photo received] ${caption}`
        : '[Photo received — no caption. I can see you sent an image but cannot process it without a caption describing what you need.]'
      this.log.info({ chatId, userId, hasCaption: !!caption }, 'Telegram photo received')
    } else {
      text = msg.text!
      this.log.info({ chatId, userId, text: text.slice(0, 80) }, 'Telegram message received')
    }

    try {
      await this.onMessage(chatId, text, userId)
    } catch (err) {
      this.log.error({ chatId, error: err instanceof Error ? err.message : String(err) }, 'Message handler error')
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
