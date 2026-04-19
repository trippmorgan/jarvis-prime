import { describe, it, expect } from 'vitest'
import { integrationPrompt, type HistoryEntry } from '../brain/integration.js'

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
