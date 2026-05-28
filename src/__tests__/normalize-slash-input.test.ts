import { describe, it, expect } from 'vitest'
import { normalizeSlashInput } from '../bridge/normalize-slash-input.js'

describe('normalizeSlashInput — slash commands', () => {
  it('rewrites em dash (U+2014) to --', () => {
    expect(normalizeSlashInput('/improvement —run')).toBe(
      '/improvement --run',
    )
  })

  it('rewrites en dash (U+2013) to --', () => {
    expect(normalizeSlashInput('/improvement –run')).toBe(
      '/improvement --run',
    )
  })

  it('rewrites minus sign (U+2212) to --', () => {
    expect(normalizeSlashInput('/improvement −run')).toBe(
      '/improvement --run',
    )
  })

  it('rewrites horizontal bar (U+2015) to --', () => {
    expect(normalizeSlashInput('/improvement ―run')).toBe(
      '/improvement --run',
    )
  })

  it('rewrites multiple dash variants in one message', () => {
    expect(
      normalizeSlashInput('/improvement —date 2026-05-27 —run'),
    ).toBe('/improvement --date 2026-05-27 --run')
  })

  it('leaves ASCII -- unchanged', () => {
    expect(normalizeSlashInput('/improvement --run')).toBe('/improvement --run')
  })

  it('handles leading whitespace before the slash', () => {
    expect(normalizeSlashInput('   /improvement —run')).toBe(
      '   /improvement --run',
    )
  })

  it('preserves the slash command name', () => {
    expect(normalizeSlashInput('/wp:publish —dry-run abc')).toBe(
      '/wp:publish --dry-run abc',
    )
  })
})

describe('normalizeSlashInput — narrative messages', () => {
  it('leaves em dash untouched in narrative text', () => {
    expect(normalizeSlashInput('I went to the store — bought milk')).toBe(
      'I went to the store — bought milk',
    )
  })

  it('leaves en dash untouched in date ranges', () => {
    expect(normalizeSlashInput('open 9–5pm')).toBe('open 9–5pm')
  })

  it('handles empty string', () => {
    expect(normalizeSlashInput('')).toBe('')
  })

  it('leaves messages that mention a slash mid-sentence', () => {
    const text = 'the doc says use /improvement —run later'
    expect(normalizeSlashInput(text)).toBe(text)
  })
})
