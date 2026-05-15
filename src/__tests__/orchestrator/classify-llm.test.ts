// W18 — LLM-fallback classifier tests.
//
// The 6 documented gaps from the W17.2 verify run that fell to 'chat'
// because no regex rule fired. With the LLM fallback wired, they should
// all classify correctly via the Frank-brain stage.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyIntentWithLLM,
  _resetClassifyLLMCacheForTests,
} from '../../orchestrator/classify-llm.js'
import type { IntentClass } from '../../orchestrator/types.js'

/** Build a fake fetch that always replies with the given classification.
 *  Tracks call count so tests can assert cache behavior. */
function fakeFetch(reply: IntentClass, opts: { onCall?: () => void } = {}): typeof fetch {
  return (async (_url: string, _init?: RequestInit): Promise<Response> => {
    opts.onCall?.()
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

describe('classifyIntentWithLLM — regex still wins for matched inputs', () => {
  beforeEach(() => _resetClassifyLLMCacheForTests())

  it('regex match short-circuits — LLM never called', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    // "frank restart ollama" matches the existing regex workflow rule.
    const k = await classifyIntentWithLLM('frank restart ollama', { fetchFn: ff })
    expect(k).toBe('workflow')
    expect(calls).toBe(0)
  })

  it('"all nodes status" stays status via regex', async () => {
    let calls = 0
    const ff = fakeFetch('chat', { onCall: () => { calls++ } })
    expect(await classifyIntentWithLLM('all nodes status', { fetchFn: ff })).toBe('status')
    expect(calls).toBe(0)
  })

  it('"morning report" stays query via regex', async () => {
    let calls = 0
    const ff = fakeFetch('chat', { onCall: () => { calls++ } })
    expect(await classifyIntentWithLLM('morning report', { fetchFn: ff })).toBe('query')
    expect(calls).toBe(0)
  })
})

describe('classifyIntentWithLLM — fills the 6 W17.2 verify gaps', () => {
  beforeEach(() => _resetClassifyLLMCacheForTests())

  it('"restart all nodes" → workflow (was mis-classified as status)', async () => {
    const ff = fakeFetch('workflow')
    expect(await classifyIntentWithLLM('restart all nodes', { fetchFn: ff })).toBe('workflow')
  })

  it('"debug chrome cdp" verb-first → workflow (was falling to chat)', async () => {
    const ff = fakeFetch('workflow')
    // This one actually matches an existing regex; verify both paths agree.
    const k = await classifyIntentWithLLM('debug chrome cdp', { fetchFn: ff })
    expect(['workflow']).toContain(k)
  })

  it('"debug the chrome-cdp tool" (intervening word) → workflow', async () => {
    const ff = fakeFetch('workflow')
    expect(await classifyIntentWithLLM('debug the chrome-cdp tool', { fetchFn: ff })).toBe('workflow')
  })

  it('"let us work on X" (expanded contraction) → workflow', async () => {
    const ff = fakeFetch('workflow')
    expect(await classifyIntentWithLLM('let us work on the morning briefing', { fetchFn: ff })).toBe('workflow')
  })

  it('"todays cases" → query (no apostrophe variant)', async () => {
    const ff = fakeFetch('query')
    expect(await classifyIntentWithLLM('todays cases', { fetchFn: ff })).toBe('query')
  })

  it("\"tomorrow's cases\" → query", async () => {
    const ff = fakeFetch('query')
    expect(await classifyIntentWithLLM("tomorrow's cases", { fetchFn: ff })).toBe('query')
  })
})

describe('classifyIntentWithLLM — safety + cache', () => {
  beforeEach(() => _resetClassifyLLMCacheForTests())

  it('LLM returns garbage → falls back to chat', async () => {
    const ff = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'banana muffin' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    expect(await classifyIntentWithLLM('something nondescript', { fetchFn: ff })).toBe('chat')
  })

  it('network error → falls back to chat (regex was already chat)', async () => {
    const ff = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    expect(await classifyIntentWithLLM('weird input that needs LLM help', { fetchFn: ff })).toBe('chat')
  })

  it('cache: second call for same text does not hit LLM', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    await classifyIntentWithLLM('let us work on the morning briefing', { fetchFn: ff })
    await classifyIntentWithLLM('let us work on the morning briefing', { fetchFn: ff })
    expect(calls).toBe(1)
  })

  it('cache normalizes whitespace + case', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    await classifyIntentWithLLM('let us work on the morning briefing', { fetchFn: ff })
    await classifyIntentWithLLM('  LET US  WORK ON  THE MORNING BRIEFING  ', { fetchFn: ff })
    expect(calls).toBe(1)
  })

  it('disabled=false → LLM never called, returns chat', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    expect(await classifyIntentWithLLM('totally novel input', { fetchFn: ff, enabled: false })).toBe('chat')
    expect(calls).toBe(0)
  })

  it('slash-command bypasses LLM entirely', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    expect(await classifyIntentWithLLM('/deep', { fetchFn: ff })).toBe('chat')
    expect(calls).toBe(0)
  })

  it('tiny input (<4 chars) bypasses LLM', async () => {
    let calls = 0
    const ff = fakeFetch('workflow', { onCall: () => { calls++ } })
    expect(await classifyIntentWithLLM('hi', { fetchFn: ff })).toBe('chat')
    expect(calls).toBe(0)
  })

  it('onLLMCall observability hook fires for real calls + cached', async () => {
    const events: Array<{ fromCache: boolean; parsed: IntentClass }> = []
    const ff = fakeFetch('query', { onCall: () => undefined })
    await classifyIntentWithLLM("tomorrow's strategy meeting", {
      fetchFn: ff,
      onLLMCall: (info) => events.push({ fromCache: info.fromCache, parsed: info.parsed }),
    })
    await classifyIntentWithLLM("tomorrow's strategy meeting", {
      fetchFn: ff,
      onLLMCall: (info) => events.push({ fromCache: info.fromCache, parsed: info.parsed }),
    })
    expect(events).toHaveLength(2)
    expect(events[0].fromCache).toBe(false)
    expect(events[1].fromCache).toBe(true)
    expect(events[0].parsed).toBe('query')
  })
})
