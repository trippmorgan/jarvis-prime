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
  'projects',
  'note',
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

/**
 * W8.7.1 — Short-message fast lane.
 *
 * Heuristic shortcut for trivially-short statements that would otherwise burn
 * the full 190-second dual-brain pipeline. Returns true when the message is:
 *   - short enough to be conversational (≤ `maxChars`, default 80),
 *   - not a question (no '?' anywhere),
 *   - not a slash command.
 *
 * This sits ALONGSIDE the tier-0 embedding classifier as belt-and-suspenders:
 * tier-0 catches semantically-quick utterances by similarity; this catches the
 * length-and-shape signature that no embedding can describe ("ok cool sounds
 * good then we'll do that"). Either path resolving short-circuits to single-
 * brain Claude (fast path, ~5–10s).
 *
 * Pure function — safe to call before tier-0 to avoid an embedding round-trip
 * on the obvious cases.
 */
export function isShortMessageFastLane(
  text: string,
  opts: { maxChars?: number } = {},
): boolean {
  const maxChars = opts.maxChars ?? 80
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > maxChars) return false
  if (trimmed.includes('?')) return false
  if (trimmed.startsWith('/')) return false
  return true
}

/**
 * Async-lane difficult-task classifier.
 *
 * Returns true when a natural-language message looks like a heavy,
 * multi-step, or long-running task that will tie up the event loop for
 * several minutes if run synchronously.  Conservative by design — only
 * fires on strong signals so that conversational turns never land here
 * by mistake.
 *
 * Signals (ANY of the following):
 *   1. Length ≥ minChars (default 300) — long messages imply detailed scope.
 *   2. Presence of "heavy-intent" keywords — research, analyse/analyze,
 *      build, implement, investigate, audit, refactor, debug, deploy,
 *      generate, write a plan, diagnose, explain in detail, walk me through.
 *   3. Multi-step markers — numbered lists (1. / 2.), "step 1", "first …
 *      then", "and then", "also", "additionally" (≥ 2 of these).
 *
 * Pure function — no I/O, no side effects.
 */
export interface DifficultTaskOpts {
  /** Minimum character count to trigger on length alone. Default 300. */
  minChars?: number
}

// Patterns indicating research / build / deep-analysis intent.
// Note: partial-root alternatives (investigat, diagnos) intentionally omit
// the trailing \b so they match "investigate", "investigating", "diagnosis" etc.
// Full-word alternatives (research, audit, etc.) retain \b on both sides.
const HEAVY_INTENT_RE =
  /\b(research|analys[ei]s|analyz[ei]\w*|build|implement\w*|investigat\w+|audit|refactor|debug\w*|deploy\w*|diagnos\w+|generate|write\s+a\s+plan|explain\s+in\s+detail|walk\s+me\s+through|set\s+up|create\s+a|design\s+a|architect\w*)\b/i

// Markers of multi-step composition inside the message.
const STEP_MARKERS: readonly RegExp[] = [
  /^\s*\d+[.)]\s/m,           // "1. " or "1) " at line start
  /\bstep\s+\d+\b/i,
  /\bfirst\b.{1,60}\bthen\b/is,
  /\band\s+then\b/i,
  /\badditionally\b/i,
  /\balso[,:]?\s/i,
  /\bmoreover\b/i,
  /\bfurthermore\b/i,
]

export function isDifficultTask(
  text: string,
  opts: DifficultTaskOpts = {},
): boolean {
  const minChars = opts.minChars ?? 300
  const trimmed = text.trim()

  // Slash commands are never classified as difficult — they route to the
  // skill shim which is already fast.
  if (trimmed.startsWith('/')) return false

  // Signal 1: raw length.
  if (trimmed.length >= minChars) return true

  // Signal 2: heavy-intent keyword.
  if (HEAVY_INTENT_RE.test(trimmed)) return true

  // Signal 3: ≥ 2 multi-step markers.
  let stepCount = 0
  for (const re of STEP_MARKERS) {
    if (re.test(trimmed)) {
      stepCount++
      if (stepCount >= 2) return true
    }
  }

  return false
}
