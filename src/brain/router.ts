/**
 * Router bypass detection for the dual-brain corpus callosum.
 *
 * Classifies an incoming Telegram message into one of three kinds:
 *   - "slash"    — a known slash command; bypass dual-brain, route to single-brain Claude
 *   - "clinical" — clinical-path override flagged by caller; bypass dual-brain
 *   - "natural"  — normal natural-language message; dual-brain path
 *
 * Pure function. No I/O, no side effects.
 */

export type MessageKind = 'slash' | 'clinical' | 'natural'

export interface ClassifyInput {
  /** The raw message text as received from Telegram. */
  text: string
  /** Telegram user id. Reserved for future per-user routing rules. */
  userId?: string
  /**
   * When true, the caller has already decided this message takes the clinical
   * bypass path (usually derived from the CORPUS_CLINICAL_OVERRIDE env flag or
   * a per-chat explicit tag). No string-content inspection is performed in v1.
   */
  clinicalOverride?: boolean
}

/** Known slash-command skill names. Keep in sync with Jarvis network skills. */
const KNOWN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'toggle',
  'network-status',
  'frank-status',
  'station-check',
  'deploy',
  'dispatch',
  'dev',
])

export function classifyMessage(input: ClassifyInput): { kind: MessageKind } {
  if (input.clinicalOverride === true) {
    return { kind: 'clinical' }
  }

  const trimmed = input.text.trimStart()

  if (trimmed.startsWith('/')) {
    // Slice from the character after '/' up to the first whitespace.
    const afterSlash = trimmed.slice(1)
    const whitespaceMatch = afterSlash.match(/\s/)
    const firstToken =
      whitespaceMatch && whitespaceMatch.index !== undefined
        ? afterSlash.slice(0, whitespaceMatch.index)
        : afterSlash

    if (firstToken.length > 0 && KNOWN_SLASH_COMMANDS.has(firstToken)) {
      return { kind: 'slash' }
    }
  }

  return { kind: 'natural' }
}
