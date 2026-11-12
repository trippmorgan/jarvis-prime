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
  onMessage: (chatId: string, text: string, userId: string, extraContext?: string) => Promise<void>
  logger: FastifyBaseLogger
  /** Voldemort-prime vision lane. When set, inbound Telegram photos are
   *  base64-fetched and POSTed to this OpenAI-compatible chat-completions
   *  endpoint with model=visionModel and an image_url content block. The
   *  returned description is injected into the text Claude sees, replacing
   *  the legacy "[Photo received - no caption]" stub. Voldemort-only.
   *  Leave undefined on other nodes for the legacy passthrough behavior. */
  visionApiUrl?: string
  visionModel?: string
}

export class TelegramPoller {
  private readonly apiBase: string
  private readonly botToken: string
  private readonly allowedChatIds: Set<string>
  private readonly pollTimeout: number
  private readonly onMessage: TelegramPollerConfig['onMessage']
  private readonly log: FastifyBaseLogger
  private readonly visionApiUrl?: string
  private readonly visionModel?: string
  private offset = 0
  private running = false
  private abortController: AbortController | null = null

  constructor(config: TelegramPollerConfig) {
    this.apiBase = `https://api.telegram.org/bot${config.botToken}`
    this.botToken = config.botToken
    this.allowedChatIds = new Set(config.allowedChatIds)
    this.pollTimeout = config.pollTimeoutSecs
    this.onMessage = config.onMessage
    this.log = config.logger
    if (config.visionApiUrl) this.visionApiUrl = config.visionApiUrl
    if (config.visionModel) this.visionModel = config.visionModel
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

      // Markdown parse failure — retry without formatting, same as sendMessage().
      // The evolving-message path needs a message id, so a plain-text retry is
      // much better than returning null and silently dropping the final answer.
      if (parseMode && res.status === 400 && errText.includes("can't parse entities")) {
        this.log.warn({ chatId }, 'sendMessageAndGetId Markdown parse failed — retrying as plain text')
        return this.sendMessageAndGetId(chatId, text)
      }

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
    let extraContext: string | undefined
    if (hasPhoto) {
      const caption = msg.caption?.trim()
      this.log.info({ chatId, userId, hasCaption: !!caption }, 'Telegram photo received')
      // Voldemort vision dispatch — fetch the photo, send to voldemort-prime's
      // vision lane (qwen3-vl:235b on Ollama Cloud), inject the description
      // into THIS TURN'S prompt only via extraContext. The persisted user
      // text stays minimal so future turns don't re-encounter old descriptions
      // and confuse Claude into thinking the user re-sent the same image.
      // Falls back to legacy passthrough behavior on any vision error.
      text = caption ? `[Photo received] ${caption}` : '[Photo received]'
      if (this.visionApiUrl && this.visionModel) {
        const largest = pickLargestPhoto(msg.photo!)
        const description = await this.describePhotoViaVision(largest.file_id, caption)
        if (description) {
          extraContext = `[vision-evidence — qwen3-vl:235b describes the attached image as]\n${description}`
        } else {
          extraContext = '[vision lane failed for this image — proceed without a description]'
        }
      } else if (!caption) {
        // No vision lane configured AND no caption — leave the legacy stub
        // so the user knows we received the photo but can't process it.
        text = '[Photo received — no caption. I can see you sent an image but cannot process it without a caption describing what you need.]'
      }
    } else {
      text = msg.text!
      this.log.info({ chatId, userId, text: text.slice(0, 80) }, 'Telegram message received')
    }

    try {
      await this.onMessage(chatId, text, userId, extraContext)
    } catch (err) {
      this.log.error({ chatId, error: err instanceof Error ? err.message : String(err) }, 'Message handler error')
    }
  }

  /**
   * Two-step Telegram file fetch: getFile → download bytes.
   * Returns the image as a data URL the OpenAI image_url block accepts.
   */
  private async fetchTelegramPhotoAsDataUrl(fileId: string): Promise<string | null> {
    try {
      const fileRes = await fetch(`${this.apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`)
      if (!fileRes.ok) {
        this.log.warn({ fileId, status: fileRes.status }, 'getFile failed')
        return null
      }
      const fileEnv = await fileRes.json() as { ok: boolean; result?: { file_path?: string } }
      const filePath = fileEnv.result?.file_path
      if (!filePath) return null
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`
      const dlRes = await fetch(downloadUrl)
      if (!dlRes.ok) {
        this.log.warn({ fileId, status: dlRes.status }, 'photo download failed')
        return null
      }
      const buf = Buffer.from(await dlRes.arrayBuffer())
      const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (err) {
      this.log.warn({ fileId, err: err instanceof Error ? err.message : String(err) }, 'photo fetch threw')
      return null
    }
  }

  /**
   * Send the photo to voldemort-prime's vision lane and return the description
   * text. Returns null on any failure (caller falls back to legacy stub).
   */
  private async describePhotoViaVision(fileId: string, caption?: string): Promise<string | null> {
    if (!this.visionApiUrl || !this.visionModel) return null
    const dataUrl = await this.fetchTelegramPhotoAsDataUrl(fileId)
    if (!dataUrl) return null
    try {
      const res = await fetch(this.visionApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.visionModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    caption
                      ? `Describe this image. The user added this caption: "${caption}". Address it in your description.`
                      : 'Describe this image in 2-4 sentences. Note dominant colors, foreground subjects, and any text visible.',
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      })
      if (!res.ok) {
        this.log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'vision API non-OK')
        return null
      }
      const env = await res.json() as { choices: Array<{ message: { content: string } }> }
      const content = env.choices?.[0]?.message?.content
      if (!content) return null
      this.log.info({ length: content.length }, 'vision lane returned description')
      return content
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'vision API call threw')
      return null
    }
  }
}

function pickLargestPhoto(
  photos: Array<{ file_id: string; width: number; height: number; file_size?: number }>,
): { file_id: string; width: number; height: number; file_size?: number } {
  // Telegram returns the same image at multiple sizes — pick the largest by
  // pixel area (file_size is optional and unreliable for our purposes).
  let best = photos[0]!
  let bestArea = best.width * best.height
  for (let i = 1; i < photos.length; i++) {
    const p = photos[i]!
    const area = p.width * p.height
    if (area > bestArea) {
      best = p
      bestArea = area
    }
  }
  return best
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
