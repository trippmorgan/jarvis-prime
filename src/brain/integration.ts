/**
 * Integration prompt builder — Wave 1 / T04.
 *
 * After both hemispheres have drafted (pass 1) and revised (pass 2), Claude
 * integrates the two pass-2 drafts into one final user-facing response.
 * Dissent is merged silently — no meta-commentary, no "GPT disagreed" flags.
 * Claude is the 51% dominant hemisphere; his voice wins on divergence.
 */

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const INTEGRATION_SUFFIX =
  "You have both pass-2 drafts from the corpus callosum. Produce the final response to Tripp. Integrate the right hemisphere's perspective silently into your natural voice. No meta-commentary, no dissent flags — one coherent answer. You are the 51% dominant hemisphere; your voice wins when they diverge."

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
  const system = `${basePrompt}\n\n${INTEGRATION_SUFFIX}`

  const historyLines = history
    .map(entry => `${entry.role === 'user' ? 'Tripp' : 'Jarvis'}: ${entry.content}`)
    .join('\n')

  const draftBlock =
    `<left-hemisphere-draft>\n${p2Left}\n</left-hemisphere-draft>\n\n` +
    `<right-hemisphere-draft>\n${p2Right}\n</right-hemisphere-draft>`

  const parts: string[] = []
  if (historyLines) parts.push(historyLines)
  parts.push(`Tripp: ${userMsg}`)
  parts.push(draftBlock)

  const user = parts.join('\n\n')

  return { system, user }
}
