/**
 * Integration prompt builder — Wave 1 / T04.
 *
 * After both hemispheres have drafted (pass 1) and revised (pass 2), Claude
 * integrates the two pass-2 drafts into one final user-facing response.
 * Dissent is merged silently — no meta-commentary, no "GPT disagreed" flags.
 * Claude is the 51% dominant hemisphere; his voice wins on divergence.
 *
 * Wave 8 / T12 adds bounded self-correction: when the router is enabled,
 * Claude is asked to emit a <self-check>{"adequate":bool,"gaps":[...]}</self-check>
 * block at the end of the integration draft. If adequate=false, the
 * orchestrator retries once with the gap list. If retry is still inadequate,
 * the final content is prefixed with SELF_CORRECTION_CAVEAT.
 */

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const INTEGRATION_SUFFIX =
  "You have both pass-2 drafts from the corpus callosum. Produce the final response to Tripp. Integrate the right hemisphere's perspective silently into your natural voice. No meta-commentary, no dissent flags — one coherent answer. You are the 51% dominant hemisphere; your voice wins when they diverge."

const SELF_CHECK_SUFFIX = `After your integrated response, append a self-check on its own line at the very end:

<self-check>{"adequate":<bool>,"gaps":[<string>,...]}</self-check>

Set "adequate" to true if your answer fully addresses Tripp's message with no material gaps. Set it to false only when you are aware of missing evidence or a concrete follow-up you should have done (e.g. "no Argus latency number", "missed Frank GPU context"). The "gaps" array lists those missing items — empty when adequate=true. The user never sees this block; it is machine-consumed.`

export const SELF_CORRECTION_CAVEAT = '⚠️ Best-effort — verification incomplete.\n\n'

function formatHistoryLines(history: HistoryEntry[]): string {
  return history
    .map(entry => `${entry.role === 'user' ? 'Tripp' : 'Jarvis'}: ${entry.content}`)
    .join('\n')
}

function buildDraftUser(
  history: HistoryEntry[],
  userMsg: string,
  p2Left: string,
  p2Right: string,
): string {
  const historyLines = formatHistoryLines(history)
  const draftBlock =
    `<left-hemisphere-draft>\n${p2Left}\n</left-hemisphere-draft>\n\n` +
    `<right-hemisphere-draft>\n${p2Right}\n</right-hemisphere-draft>`
  const parts: string[] = []
  if (historyLines) parts.push(historyLines)
  parts.push(`Tripp: ${userMsg}`)
  parts.push(draftBlock)
  return parts.join('\n\n')
}

/**
 * Build the integration prompt Claude uses to produce the final response.
 *
 * @param basePrompt - The shared system/context prompt (Jarvis Prime identity + skills).
 * @param history    - Recent conversation history (chronological order).
 * @param userMsg    - Tripp's current message.
 * @param p2Left     - Left hemisphere's pass-2 revised draft (Claude).
 * @param p2Right    - Right hemisphere's pass-2 revised draft (GPT via OpenClaw gateway).
 * @returns `{ system, user }` - the system prompt and the user-turn content.
 */
export function integrationPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  p2Left: string,
  p2Right: string,
): { system: string; user: string } {
  return {
    system: `${basePrompt}\n\n${INTEGRATION_SUFFIX}`,
    user: buildDraftUser(history, userMsg, p2Left, p2Right),
  }
}

/**
 * Wave 8 / T12 — integration prompt that also asks for a <self-check> block
 * at the end. Preserves the 51% dominance framing.
 */
export function integrationPromptWithSelfCheck(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  p2Left: string,
  p2Right: string,
): { system: string; user: string } {
  return {
    system: `${basePrompt}\n\n${INTEGRATION_SUFFIX}\n\n${SELF_CHECK_SUFFIX}`,
    user: buildDraftUser(history, userMsg, p2Left, p2Right),
  }
}

/**
 * Wave 8 / T12 — retry prompt for bounded self-correction. Feeds the
 * previous integration draft and the gap list back to Claude, re-asks for
 * a <self-check> block so the new attempt can be evaluated.
 */
export function integrationRetryPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  prevContent: string,
  gaps: readonly string[],
): { system: string; user: string } {
  const historyLines = formatHistoryLines(history)
  const gapList = gaps.map((g) => `- ${g}`).join('\n')
  const parts: string[] = []
  if (historyLines) parts.push(historyLines)
  parts.push(`Tripp: ${userMsg}`)
  parts.push(
    `Your previous integrated draft was:\n\n<previous-draft>\n${prevContent}\n</previous-draft>\n\nYou flagged the following gaps:\n\n${gapList}\n\nProduce a revised final response that closes those gaps. End again with a <self-check> block as before.`,
  )
  return {
    system: `${basePrompt}\n\n${INTEGRATION_SUFFIX}\n\n${SELF_CHECK_SUFFIX}`,
    user: parts.join('\n\n'),
  }
}

const SELF_CHECK_RE = /<self-check>([\s\S]*?)<\/self-check>/

export interface SelfCheck {
  adequate: boolean
  gaps: string[]
}

/**
 * Wave 8 / T12 — parse a <self-check> block from Claude's integration
 * output. Returns null when the block is missing, malformed, or when the
 * parsed payload doesn't match the expected shape.
 */
export function parseSelfCheck(content: string): SelfCheck | null {
  const match = content.match(SELF_CHECK_RE)
  if (!match) return null
  const body = match[1].trim()
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.adequate !== 'boolean') return null
  if (!Array.isArray(rec.gaps)) return null
  if (!rec.gaps.every((g) => typeof g === 'string')) return null
  return { adequate: rec.adequate, gaps: rec.gaps as string[] }
}

/**
 * Wave 8 / T12 — remove the <self-check> block from Claude's integration
 * output and trim any trailing whitespace left behind.
 */
export function stripSelfCheck(content: string): string {
  if (!SELF_CHECK_RE.test(content)) return content
  return content.replace(SELF_CHECK_RE, '').replace(/\s+$/, '')
}
