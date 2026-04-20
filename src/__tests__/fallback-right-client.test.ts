import { describe, it, expect } from 'vitest'
import { FallbackRightClient } from '../brain/fallback-right-client.js'
import {
  RightBrainTransportError,
  RightBrainModelError,
} from '../brain/right-brain-agent.js'
import type { HemisphereClient } from '../brain/types.js'

/**
 * W7-T8 — fallback client tests. Core contract:
 *   1. Success path — backup never called.
 *   2. TransportError — backup called exactly once, result returned.
 *   3. ModelError — backup NEVER called, error propagates.
 *   4. Other errors — backup NEVER called, error propagates.
 */

interface CallCounter {
  client: HemisphereClient
  calls: Array<{ system: string; user: string }>
}

function countingClient(
  impl: (input: { system: string; user: string; timeoutMs: number }) =>
    Promise<{ content: string; durationMs: number }>,
): CallCounter {
  const calls: Array<{ system: string; user: string }> = []
  const client: HemisphereClient = {
    async call(input) {
      calls.push({ system: input.system, user: input.user })
      return impl(input)
    },
  }
  return { client, calls }
}

describe('FallbackRightClient (W7-T8)', () => {
  it('returns primary result when primary succeeds — backup never called', async () => {
    const primary = countingClient(async () => ({ content: 'primary-ok', durationMs: 100 }))
    const backup = countingClient(async () => ({ content: 'backup-ok', durationMs: 200 }))
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
    })
    const result = await client.call({ system: 's', user: 'u', timeoutMs: 30_000 })
    expect(result.content).toBe('primary-ok')
    expect(primary.calls.length).toBe(1)
    expect(backup.calls.length).toBe(0)
  })

  it('falls back to backup on TransportError — backup called exactly once', async () => {
    const primary = countingClient(async () => {
      throw new RightBrainTransportError('agent exec failed')
    })
    const backup = countingClient(async () => ({ content: 'backup-recovered', durationMs: 150 }))
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
    })
    const result = await client.call({ system: 's', user: 'u', timeoutMs: 30_000 })
    expect(result.content).toBe('backup-recovered')
    expect(primary.calls.length).toBe(1)
    expect(backup.calls.length).toBe(1)
  })

  it('does NOT fall back on ModelError — backup never called, error propagates', async () => {
    const primary = countingClient(async () => {
      throw new RightBrainModelError('agent returned status=error')
    })
    const backup = countingClient(async () => ({ content: 'backup-unused', durationMs: 150 }))
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainModelError)
    expect(primary.calls.length).toBe(1)
    expect(backup.calls.length).toBe(0)
  })

  it('does NOT fall back on generic Error — propagates as-is', async () => {
    const primary = countingClient(async () => {
      throw new Error('something else')
    })
    const backup = countingClient(async () => ({ content: 'backup-unused', durationMs: 150 }))
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toThrow('something else')
    expect(primary.calls.length).toBe(1)
    expect(backup.calls.length).toBe(0)
  })

  it('emits right_brain_agent_fallback event on TransportError', async () => {
    const events: Array<{ obj: unknown; level: string }> = []
    const logger = {
      info: () => undefined,
      warn: (obj: unknown) => events.push({ obj, level: 'warn' }),
      error: () => undefined,
    }
    const primary = countingClient(async () => {
      throw new RightBrainTransportError('broken')
    })
    const backup = countingClient(async () => ({ content: 'ok', durationMs: 100 }))
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
      logger,
    })
    await client.call({ system: 's', user: 'u', timeoutMs: 30_000 })
    const fallbackEvents = events.filter(
      (e) => (e.obj as { event?: string }).event === 'right_brain_agent_fallback',
    )
    expect(fallbackEvents.length).toBe(1)
  })

  it('bubbles backup failures — no further retry beyond the single fallback attempt', async () => {
    const primary = countingClient(async () => {
      throw new RightBrainTransportError('primary bad')
    })
    const backup = countingClient(async () => {
      throw new Error('backup also bad')
    })
    const client = new FallbackRightClient({
      primary: primary.client,
      backup: backup.client,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toThrow('backup also bad')
    expect(primary.calls.length).toBe(1)
    expect(backup.calls.length).toBe(1)
  })
})
