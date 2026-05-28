/**
 * Normalize Unicode dash variants to ASCII `--` for slash-command lines.
 *
 * iOS / macOS autocorrect substitutes consecutive hyphens with typographic
 * dashes (U+2013 EN DASH, U+2014 EM DASH, U+2015 HORIZONTAL BAR) and SI
 * keyboards emit U+2212 MINUS SIGN. None of those match ASCII `--`, so flag
 * tokens like `—run` get parsed as a single word and slash-command flags
 * silently drop.
 *
 * We only rewrite when the message is a slash command (text trimStart()s
 * with `/`). Narrative em-dashes elsewhere ("…the store — bought milk")
 * stay verbatim.
 */

const DASH_VARIANTS = /[–—―−]/g

export function normalizeSlashInput(text: string): string {
  if (!text) return text
  if (!text.trimStart().startsWith('/')) return text
  return text.replace(DASH_VARIANTS, '--')
}
