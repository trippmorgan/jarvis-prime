import { describe, it, expect } from 'vitest'
import {
  integrationPrompt,
  integrationPromptWithSelfCheck,
  integrationRetryPrompt,
  parseSelfCheck,
  stripSelfCheck,
  SELF_CORRECTION_CAVEAT,
  type HistoryEntry,
} from '../brain/integration.js'

const SUFFIX =
  "You have both pass-2 drafts from the corpus callosum. Produce the final response to Tripp. Integrate the right hemisphere's perspective silently into your natural voice. No meta-commentary, no dissent flags — one coherent answer. You are the 51% dominant hemisphere; your voice wins when they diverge."

describe('integrationPrompt', () => {
  const basePrompt = '## Context\nYou are Jarvis Prime.'
  const history: HistoryEntry[] = [
    { role: 'user', content: 'hello there', timestamp: 1 },
    { role: 'assistant', content: 'good evening', timestamp: 2 },
  ]
  const userMsg = 'What do you think about Phi?'
  const p2Left = 'Left hemisphere draft content about integrated information.'
  const p2Right = 'Right hemisphere draft content about holistic patterns.'

  it('returns a { system, user } pair', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result).toHaveProperty('system')
    expect(result).toHaveProperty('user')
    expect(typeof result.system).toBe('string')
    expect(typeof result.user).toBe('string')
  })

  it('system appends integration suffix to basePrompt with two newlines separator', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.system).toBe(`${basePrompt}\n\n${SUFFIX}`)
  })

  it('system contains the exact integration suffix paragraph', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.system).toContain(SUFFIX)
  })

  it('user message contains both draft blocks', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.user).toContain('<left-hemisphere-draft>')
    expect(result.user).toContain('</left-hemisphere-draft>')
    expect(result.user).toContain('<right-hemisphere-draft>')
    expect(result.user).toContain('</right-hemisphere-draft>')
  })

  it('user message contains both p2 draft contents', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.user).toContain(p2Left)
    expect(result.user).toContain(p2Right)
  })

  it("user message contains Tripp's current message", () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.user).toContain(`Tripp: ${userMsg}`)
  })

  it('user message formats history with Tripp/Jarvis role labels', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    expect(result.user).toContain('Tripp: hello there')
    expect(result.user).toContain('Jarvis: good evening')
  })

  it('handles empty history gracefully', () => {
    const result = integrationPrompt(basePrompt, [], userMsg, p2Left, p2Right)
    expect(result.user).toContain(`Tripp: ${userMsg}`)
    expect(result.user).toContain(p2Left)
    expect(result.user).toContain(p2Right)
  })

  it('places draft blocks after the user message', () => {
    const result = integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
    const userIdx = result.user.indexOf(`Tripp: ${userMsg}`)
    const leftIdx = result.user.indexOf('<left-hemisphere-draft>')
    const rightIdx = result.user.indexOf('<right-hemisphere-draft>')
    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(leftIdx).toBeGreaterThan(userIdx)
    expect(rightIdx).toBeGreaterThan(leftIdx)
  })
})

// -----------------------------------------------------------------------------
// Wave 8 T12 — self-check + retry
// -----------------------------------------------------------------------------

describe('integrationPromptWithSelfCheck (W8-T12)', () => {
  const basePrompt = '## Context\nYou are Jarvis Prime.'
  const history: HistoryEntry[] = []
  const userMsg = 'Check Argus uptime'
  const p2Left = 'Left draft'
  const p2Right = 'Right draft'

  it('returns a { system, user } pair', () => {
    const r = integrationPromptWithSelfCheck(basePrompt, history, userMsg, p2Left, p2Right)
    expect(typeof r.system).toBe('string')
    expect(typeof r.user).toBe('string')
  })

  it('instructs Claude to emit a <self-check> block', () => {
    const r = integrationPromptWithSelfCheck(basePrompt, history, userMsg, p2Left, p2Right)
    expect(r.system).toContain('<self-check>')
    expect(r.system.toLowerCase()).toContain('adequate')
    expect(r.system.toLowerCase()).toContain('gaps')
  })

  it('preserves the base integration suffix (dominance framing)', () => {
    const r = integrationPromptWithSelfCheck(basePrompt, history, userMsg, p2Left, p2Right)
    expect(r.system).toContain('51% dominant')
  })

  it('user content still carries both pass-2 drafts', () => {
    const r = integrationPromptWithSelfCheck(basePrompt, history, userMsg, p2Left, p2Right)
    expect(r.user).toContain(p2Left)
    expect(r.user).toContain(p2Right)
  })
})

describe('integrationRetryPrompt (W8-T12)', () => {
  const basePrompt = 'base'
  const history: HistoryEntry[] = []
  const userMsg = 'u'

  it('includes the previous draft and the gap list', () => {
    const r = integrationRetryPrompt(basePrompt, history, userMsg, 'PREV_CONTENT', [
      'no Argus latency number',
      'missed Frank GPU context',
    ])
    expect(r.user).toContain('PREV_CONTENT')
    expect(r.user).toContain('no Argus latency number')
    expect(r.user).toContain('missed Frank GPU context')
  })

  it('re-asks for a <self-check> block', () => {
    const r = integrationRetryPrompt(basePrompt, history, userMsg, 'prev', ['gap'])
    expect(r.system).toContain('<self-check>')
  })
})

describe('parseSelfCheck (W8-T12)', () => {
  it('returns null when no <self-check> block present', () => {
    expect(parseSelfCheck('just a reply')).toBeNull()
  })

  it('returns null when body is malformed JSON', () => {
    expect(parseSelfCheck('<self-check>not json</self-check>')).toBeNull()
  })

  it('returns null when adequate is missing', () => {
    expect(
      parseSelfCheck('<self-check>{"gaps":[]}</self-check>'),
    ).toBeNull()
  })

  it('returns null when gaps is not an array of strings', () => {
    expect(
      parseSelfCheck('<self-check>{"adequate":false,"gaps":[1,2]}</self-check>'),
    ).toBeNull()
  })

  it('parses adequate=true with empty gaps', () => {
    const r = parseSelfCheck(
      '<self-check>{"adequate":true,"gaps":[]}</self-check>',
    )
    expect(r).toEqual({ adequate: true, gaps: [] })
  })

  it('parses adequate=false with populated gaps', () => {
    const r = parseSelfCheck(
      '<self-check>{"adequate":false,"gaps":["missing latency","no GPU"]}</self-check>',
    )
    expect(r).toEqual({
      adequate: false,
      gaps: ['missing latency', 'no GPU'],
    })
  })

  it('tolerates whitespace around block content', () => {
    const r = parseSelfCheck(
      '<self-check>\n  {"adequate":true,"gaps":[]}\n</self-check>',
    )
    expect(r).toEqual({ adequate: true, gaps: [] })
  })
})

describe('stripSelfCheck (W8-T12)', () => {
  it('removes the block from the content', () => {
    const out = stripSelfCheck(
      'The answer is 42.\n\n<self-check>{"adequate":true,"gaps":[]}</self-check>',
    )
    expect(out).not.toContain('<self-check>')
    expect(out).toContain('The answer is 42.')
  })

  it('leaves content unchanged when no block present', () => {
    expect(stripSelfCheck('plain reply')).toBe('plain reply')
  })

  it('trims trailing whitespace left behind by the stripped block', () => {
    const out = stripSelfCheck(
      'answer\n\n<self-check>{"adequate":true,"gaps":[]}</self-check>',
    )
    expect(out.endsWith('answer')).toBe(true)
  })
})

describe('SELF_CORRECTION_CAVEAT (W8-T12)', () => {
  it('starts with the ⚠️ warning glyph', () => {
    expect(SELF_CORRECTION_CAVEAT.startsWith('⚠️')).toBe(true)
  })

  it('mentions "Best-effort" and "verification"', () => {
    expect(SELF_CORRECTION_CAVEAT).toContain('Best-effort')
    expect(SELF_CORRECTION_CAVEAT.toLowerCase()).toContain('verification')
  })

  it('ends with a double newline so content follows cleanly', () => {
    expect(SELF_CORRECTION_CAVEAT.endsWith('\n\n')).toBe(true)
  })
})
