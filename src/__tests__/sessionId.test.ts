import { describe, it, expect } from 'vitest'
import { deriveRightBrainSessionId } from '../brain/sessionId.js'

describe('deriveRightBrainSessionId (W7-T6)', () => {
  it('is deterministic — same input produces same output', () => {
    const a = deriveRightBrainSessionId('8048875001')
    const b = deriveRightBrainSessionId('8048875001')
    expect(a).toBe(b)
  })

  it('produces different outputs for different chat ids', () => {
    const a = deriveRightBrainSessionId('8048875001')
    const b = deriveRightBrainSessionId('8048875002')
    expect(a).not.toBe(b)
  })

  it('output matches /^[a-z0-9]{16}$/ (CLI- and filesystem-safe)', () => {
    const id = deriveRightBrainSessionId('8048875001')
    expect(id).toMatch(/^[a-z0-9]{16}$/)
  })

  it('handles numeric string chat ids', () => {
    const id = deriveRightBrainSessionId('123456789')
    expect(id).toMatch(/^[a-z0-9]{16}$/)
  })

  it('handles string chat ids with non-alphanumeric characters', () => {
    const id = deriveRightBrainSessionId('user:alice@host')
    expect(id).toMatch(/^[a-z0-9]{16}$/)
  })

  it('handles empty string without throwing', () => {
    const id = deriveRightBrainSessionId('')
    expect(id).toMatch(/^[a-z0-9]{16}$/)
  })

  it('collision-resistant across a batch of similar inputs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(deriveRightBrainSessionId(`chat-${i}`))
    }
    expect(ids.size).toBe(1000)
  })
})
