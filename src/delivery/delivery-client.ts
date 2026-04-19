import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DeliveryClientConfig {
  gatewayUrl: string
  gatewayToken: string
  deliveryQueueDir: string
}

// ─── Spool entry shape ───────────────────────────────────────────────────────

export interface SpoolEntry {
  chatId: string
  text: string
  parseMode?: string
  spooledAt: string
  error: string
}

// ─── DeliveryClient ──────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096

export class DeliveryClient {
  private readonly gatewayUrl: string
  private readonly gatewayToken: string
  private readonly deliveryQueueDir: string

  constructor(config: DeliveryClientConfig) {
    this.gatewayUrl = config.gatewayUrl
    this.gatewayToken = config.gatewayToken
    this.deliveryQueueDir = config.deliveryQueueDir
  }

  /**
   * Deliver a message via the OpenClaw gateway.
   * On failure, spools the message to the delivery queue directory.
   * Returns true on success, false on spool.
   */
  async deliver(
    chatId: string,
    text: string,
    opts?: { parseMode?: string },
  ): Promise<boolean> {
    const url = `${this.gatewayUrl}/api/jarvis/deliver`
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: opts?.parseMode,
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewayToken}`,
        },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        return true
      }

      // HTTP error — spool it
      const errorText = await response.text().catch(() => `HTTP ${response.status}`)
      this.spool(chatId, text, opts?.parseMode, `HTTP ${response.status}: ${errorText}`)
      return false
    } catch (err) {
      // Network error — spool it
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.spool(chatId, text, opts?.parseMode, errorMsg)
      return false
    }
  }

  /**
   * Split a message into chunks that respect Telegram's 4096-char limit.
   * Prefers splitting at newline boundaries.
   */
  splitMessage(text: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
    if (text.length <= maxLen) {
      return [text]
    }

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }

      // Find the last newline within the max length window
      const slice = remaining.slice(0, maxLen)
      const lastNewline = slice.lastIndexOf('\n')

      let splitAt: number
      if (lastNewline > 0) {
        // Split at the newline — include the newline in the current chunk
        splitAt = lastNewline + 1
      } else {
        // No newline found — hard split at maxLen
        splitAt = maxLen
      }

      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }

    return chunks
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private spool(chatId: string, text: string, parseMode: string | undefined, error: string): void {
    if (!existsSync(this.deliveryQueueDir)) {
      mkdirSync(this.deliveryQueueDir, { recursive: true })
    }

    const entry: SpoolEntry = {
      chatId,
      text,
      parseMode,
      spooledAt: new Date().toISOString(),
      error,
    }

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const filepath = `${this.deliveryQueueDir}/${filename}`
    writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf-8')
  }
}
