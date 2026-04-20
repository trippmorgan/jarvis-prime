import { createHash } from 'node:crypto'

/**
 * Derives a deterministic, CLI- and filesystem-safe session id for the
 * right-brain OpenClaw agent from a Telegram chat id. sha256 prefix → 16-char
 * lowercase hex (64 bits of entropy; collision risk negligible at the number
 * of chats the bot ever sees).
 */
export function deriveRightBrainSessionId(chatId: string): string {
  return createHash('sha256').update(chatId).digest('hex').slice(0, 16)
}
