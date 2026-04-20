import { describe, it, expect } from 'vitest'
import { makeRightClient } from '../brain/right-client-factory.js'
import { RightHemisphereClient } from '../brain/right-hemisphere.js'
import { RightBrainAgentClient } from '../brain/right-brain-agent.js'
import { FallbackRightClient } from '../brain/fallback-right-client.js'
import { deriveRightBrainSessionId } from '../brain/sessionId.js'

/**
 * W7-T7 — factory tests. Asserts the config flag picks the correct
 * HemisphereClient implementation and that the agent path derives its
 * session id from the chatId (AC7.1, AC7.2, AC7.6).
 */

const DUMMY_GATEWAY = {
  gatewayUrl: 'http://127.0.0.1:18789',
  gatewayToken: 'dummy-token',
  rightModel: 'gpt-5.4 codex',
}

describe('makeRightClient (W7-T7)', () => {
  it('returns RightHemisphereClient when rightBrainAgentEnabled=false', () => {
    const client = makeRightClient({
      rightBrainAgentEnabled: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    })
    expect(client).toBeInstanceOf(RightHemisphereClient)
    expect(client).not.toBeInstanceOf(RightBrainAgentClient)
  })

  it('returns RightBrainAgentClient directly when fallback=false', () => {
    const client = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    })
    expect(client).toBeInstanceOf(RightBrainAgentClient)
    expect(client).not.toBeInstanceOf(FallbackRightClient)
  })

  it('wraps agent in FallbackRightClient when fallback=true (default)', () => {
    const client = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: true,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    })
    expect(client).toBeInstanceOf(FallbackRightClient)
  })

  it('wraps agent in FallbackRightClient when fallback unset (default true)', () => {
    const client = makeRightClient({
      rightBrainAgentEnabled: true,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    })
    expect(client).toBeInstanceOf(FallbackRightClient)
  })

  it('agent client gets sessionId derived from chatId', () => {
    const expectedSessionId = deriveRightBrainSessionId('8048875001')
    const client = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    }) as RightBrainAgentClient
    expect((client as unknown as { sessionId: string }).sessionId).toBe(
      expectedSessionId,
    )
  })

  it('two calls with the same chatId produce agent clients with the same sessionId', () => {
    const a = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    }) as RightBrainAgentClient
    const b = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    }) as RightBrainAgentClient
    expect(
      (a as unknown as { sessionId: string }).sessionId,
    ).toBe((b as unknown as { sessionId: string }).sessionId)
  })

  it('different chatIds produce agent clients with different sessionIds', () => {
    const a = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875001',
      ...DUMMY_GATEWAY,
    }) as RightBrainAgentClient
    const b = makeRightClient({
      rightBrainAgentEnabled: true,
      rightBrainAgentFallback: false,
      chatId: '8048875002',
      ...DUMMY_GATEWAY,
    }) as RightBrainAgentClient
    expect(
      (a as unknown as { sessionId: string }).sessionId,
    ).not.toBe((b as unknown as { sessionId: string }).sessionId)
  })
})
