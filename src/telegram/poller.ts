import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { attestEgress } from '../ledger/egress.js'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
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

type TransportErrorContext = {
  error: string
  causeCode?: string
  causeName?: string
}

function transportErrorContext(err: unknown): TransportErrorContext {
  const error = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
  const causeRecord = cause && typeof cause === 'object' ? cause as Record<string, unknown> : undefined
  const rawCode = causeRecord?.code
  const rawName = causeRecord?.name
  const causeCode = typeof rawCode === 'string' && /^[A-Z0-9_]{2,64}$/.test(rawCode) ? rawCode : undefined
  const causeName = typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9]{1,63}$/.test(rawName) ? rawName : undefined
  return { error, ...(causeCode ? { causeCode } : {}), ...(causeName ? { causeName } : {}) }
}

export interface TelegramPollerConfig {
  botToken: string
  allowedChatIds: string[]
  pollTimeoutSecs: number
  onMessage: (chatId: string, text: string, userId: string) => Promise<void>
  logger: FastifyBaseLogger
  /**
   * Where to persist the getUpdates offset. When set, the offset survives
   * restarts so a message that wedges (or crashes) mid-process is NOT
   * re-fetched on the next boot — prevents the "works once then crashes"
   * poison-message loop. Absent → in-memory only (legacy behaviour).
   */
  offsetPersistPath?: string
}

export class TelegramPoller {
  private readonly apiBase: string
  private readonly botToken: string
  private readonly allowedChatIds: Set<string>
  private readonly pollTimeout: number
  private readonly onMessage: TelegramPollerConfig['onMessage']
  private readonly log: FastifyBaseLogger
  private readonly offsetPath: string | null
  private offset = 0
  private running = false
  private abortController: AbortController | null = null

  // Circuit breaker: collapse repeated transport failures into one event
  private consecutiveTransportFailures = 0
  private circuitOpen = false
  private static readonly BREAKER_TRIP_THRESHOLD = 3
  private static readonly BREAKER_MAX_BACKOFF_MS = 60_000

  constructor(config: TelegramPollerConfig) {
    this.apiBase = `https://api.telegram.org/bot${config.botToken}`
    this.botToken = config.botToken
    this.allowedChatIds = new Set(config.allowedChatIds)
    this.pollTimeout = config.pollTimeoutSecs
    this.onMessage = config.onMessage
    this.log = config.logger
    this.offsetPath = config.offsetPersistPath ?? null
    this.loadOffset()
  }

  /** Restore the persisted getUpdates offset so a poison message isn't re-fetched after a restart. */
  private loadOffset(): void {
    if (!this.offsetPath) return
    try {
      const raw = readFileSync(this.offsetPath, 'utf-8')
      const parsed = JSON.parse(raw) as { offset?: number }
      if (typeof parsed.offset === 'number' && parsed.offset > 0) {
        this.offset = parsed.offset
        this.log.info({ offset: this.offset }, 'Telegram offset restored from disk')
      }
    } catch {
      // missing or corrupt — start from 0 (process whatever backlog exists)
    }
  }

  /** Persist the advanced offset atomically. Fail-soft: a write error must never break polling. */
  private persistOffset(): void {
    if (!this.offsetPath) return
    try {
      mkdirSync(dirname(this.offsetPath), { recursive: true })
      const tmp = this.offsetPath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ offset: this.offset }) + '\n')
      renameSync(tmp, this.offsetPath)
    } catch (err) {
      this.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Telegram offset persist failed')
    }
  }

  async start(): Promise<void> {
    this.running = true
    this.log.info('Telegram poller starting')

    while (this.running) {
      try {
        await this.poll()
      } catch (err) {
        if (!this.running) break
        const details = transportErrorContext(err)
        const is409 = details.error.includes('409')
        if (is409) {
          this.log.warn('Telegram poll conflict (409) — another process is polling this token. Yielding 90s.')
          await sleep(90_000)
        } else {
          const backoff = this.pollBackoffMs
          if (!this.circuitOpen) {
            this.log.error(details, `Telegram poll error — retrying in ${backoff / 1000}s`)
          }
          await sleep(backoff)
        }
      }
    }

    this.log.info('Telegram poller stopped')
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
  }

  private noteTransportSuccess(): void {
    if (this.circuitOpen) {
      this.log.info('Telegram transport recovered — circuit breaker closed')
    }
    this.circuitOpen = false
    this.consecutiveTransportFailures = 0
  }

  private noteTransportFailure(err: unknown): TransportErrorContext {
    const details = transportErrorContext(err)
    this.consecutiveTransportFailures++
    if (!this.circuitOpen && this.consecutiveTransportFailures >= TelegramPoller.BREAKER_TRIP_THRESHOLD) {
      this.circuitOpen = true
      this.log.error(
        { ...details, consecutiveFailures: this.consecutiveTransportFailures },
        'Telegram transport DOWN — circuit breaker open. Suppressing per-request errors until recovery.',
      )
    }
    return details
  }

  /**
   * Wraps fetch with one retry on transient network failures (DNS hiccups,
   * TLS handshake aborts — observed as `fetch failed` against
   * api.telegram.org). HTTP error responses (4xx/5xx) are NOT retried — those
   * are returned to the caller so existing per-method handling can apply
   * (markdown reparse, benign 400s, etc.). Returns null only when both
   * attempts threw.
   *
   * Circuit breaker: after BREAKER_TRIP_THRESHOLD consecutive transport
   * failures, enters open state — suppresses per-request error logs and
   * emits a single "transport down" event. On recovery, emits "transport
   * recovered" and resets.
   */
  private async fetchTelegram(path: string, body: object, ctx: object): Promise<Response | null> {
    const res = await this.fetchTelegramRaw(path, body, ctx)
    // Ledger: every message-bearing call is an EGRESS entry on the jarvis
    // chain (2026-09-04). Fire-and-forget — never delays or fails the send.
    if (path === 'sendMessage' || path === 'editMessageText') {
      const b = body as { chat_id?: unknown; text?: unknown }
      if (typeof b.text === 'string' && b.chat_id !== undefined) {
        const outcome = res === null ? 'failed' : res.ok ? 'sent' : path === 'editMessageText' && res.status === 400 ? 'skipped' : 'failed'
        void attestEgress({
          chatId: String(b.chat_id),
          text: b.text,
          outcome,
          purpose: path === 'sendMessage' ? 'reply' : 'reply-edit',
        }).catch(() => undefined)
      }
    }
    return res
  }

  private async fetchTelegramRaw(path: string, body: object, ctx: object): Promise<Response | null> {
    const url = `${this.apiBase}/${path}`
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, init)
        // Success (HTTP-level) — reset circuit breaker.
        this.noteTransportSuccess()
        return res
      } catch (err) {
        const details = transportErrorContext(err)
        if (attempt === 0) {
          if (!this.circuitOpen) {
            this.log.warn({ ...ctx, path, ...details }, 'Telegram fetch failed — retrying once after 200ms')
          }
          await sleep(200)
          continue
        }
        // Both attempts failed — increment circuit breaker.
        this.noteTransportFailure(err)
        if (!this.circuitOpen) {
          this.log.error({ ...ctx, path, ...details }, 'Telegram fetch failed after retry')
        }
        // When circuit is open, suppress individual error logs (already reported the state change)
        return null
      }
    }
    return null
  }

  /** Backoff duration for the poll loop when circuit breaker is open. */
  private get pollBackoffMs(): number {
    if (!this.circuitOpen) return 5_000
    // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
    return Math.min(5_000 * Math.pow(2, this.consecutiveTransportFailures - TelegramPoller.BREAKER_TRIP_THRESHOLD), TelegramPoller.BREAKER_MAX_BACKOFF_MS)
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

      if (parseMode && res.status === 400 && errText.includes("can't parse entities")) {
        this.log.warn({ chatId }, 'Markdown parse failed — retrying sendMessageAndGetId as plain text')
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
      this.noteTransportSuccess()

      for (const update of data.result) {
        this.offset = update.update_id + 1
        // Persist BEFORE handling: if handleUpdate wedges or the process dies
        // mid-process, the restart resumes PAST this update instead of
        // re-fetching it forever (the "works once then crashes" loop).
        this.persistOffset()
        await this.handleUpdate(update)
      }
    } catch (err) {
      this.noteTransportFailure(err)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Downloads the highest-resolution variant of an incoming photo to local
   * disk. The `claude --print` CLI has no image/attachment flag, but it runs
   * as a full agent with an unrestricted (--dangerously-skip-permissions)
   * Read tool, which is multimodal — so the fix is to get the file onto disk
   * and reference its path in the prompt text, not to pass image bytes
   * through this pipeline directly.
   */
  private async downloadPhoto(fileId: string, chatId: string): Promise<string | null> {
    try {
      const infoRes = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`)
      if (!infoRes.ok) {
        this.log.warn({ chatId, status: infoRes.status }, 'Telegram getFile failed')
        return null
      }
      const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } }
      const remotePath = info.result?.file_path
      if (!info.ok || !remotePath) {
        this.log.warn({ chatId }, 'Telegram getFile returned no file_path')
        return null
      }

      const fileRes = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${remotePath}`)
      if (!fileRes.ok) {
        this.log.warn({ chatId, status: fileRes.status }, 'Telegram photo download failed')
        return null
      }

      const ext = remotePath.includes('.') ? remotePath.slice(remotePath.lastIndexOf('.')) : '.jpg'
      const dir = join(tmpdir(), 'jarvis-prime-telegram-photos')
      mkdirSync(dir, { recursive: true })
      const localPath = join(dir, `${chatId}-${Date.now()}${ext}`)
      writeFileSync(localPath, Buffer.from(await fileRes.arrayBuffer()))
      return localPath
    } catch (err) {
      this.log.warn(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'Telegram photo download threw',
      )
      return null
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
      const photos = msg.photo!
      const best = photos[photos.length - 1] // Telegram orders variants ascending by size
      const localPath = await this.downloadPhoto(best.file_id, chatId)
      if (localPath) {
        text = `[Photo received, saved to ${localPath}. Use the Read tool to view it before responding.]${caption ? ' ' + caption : ' Read any text or names visible in the image and report what you find.'}`
        this.log.info({ chatId, userId, hasCaption: !!caption, localPath }, 'Telegram photo downloaded')
      } else {
        text = caption
          ? `[Photo received but download failed] ${caption}`
          : '[Photo received but download failed — I cannot process it without a caption describing what you need.]'
        this.log.warn({ chatId, userId }, 'Telegram photo download failed — falling back to placeholder')
      }
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
