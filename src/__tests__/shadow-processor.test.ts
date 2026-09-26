import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageProcessor } from '../bridge/processor.js'
import { RaceGate, attestRound } from '../bridge/harness-race.js'
import { collectShadow } from '../bridge/shadow-review.js'
const review = JSON.stringify({ verdict: 'equal', agree: true, conscience: 'ok' })
vi.mock('../bridge/shadow-review.js', () => ({ collectShadow: vi.fn() }))
vi.mock('../bridge/harness-race.js', async (original) => ({
  ...await original<object>(),
  askHarness: vi.fn(async () => ({ text: JSON.stringify({ verdict: 'equal', agree: true, conscience: 'ok' }), ms: 1 })),
  attestRound: vi.fn(async () => 202),
}))
vi.mock('../brain/right-hemisphere.js', () => ({ RightHemisphereClient: class { async call() { return { content: review, durationMs: 1 } } } }))
vi.mock('../bridge/conscience.js', () => ({ fetchConscience: vi.fn(async () => null), formatConscienceDigest: vi.fn(), citeConscience: vi.fn(() => null) }))
vi.mock('../bridge/labels.js', async original => ({ ...await original<object>(), appendLabel: vi.fn(() => true) }))

describe('processor shadow integration', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('FRANK_CROSS_REVIEW', '1'); vi.stubEnv('FRANK_CROSS_REVIEW_DELIVERY', 'flagged') })
  it.each([false, true])('never changes delivery or ledger; clinical override=%s', async clinicalOverride => {
    const gate = new RaceGate('test', 'test-chat', 'synthetic task')
    gate.jarvisText = 'answer j'; gate.harnessText = 'answer h'
    const ctx = { config: { clinicalOverride, harnessRace: { url: 'http://test', model: 'test', timeoutMs: 1, jevUrl: 'http://127.0.0.1:30110' } }, leftEvidence: new Map(), log: { info: vi.fn() }, deliver: vi.fn() }
    // Exercise the real cross-review method without spawning a production processor.
    await (MessageProcessor.prototype as unknown as { maybeCrossReview: (this: typeof ctx, gate: RaceGate) => Promise<void> }).maybeCrossReview.call(ctx, gate)
    expect(collectShadow).toHaveBeenCalledTimes(clinicalOverride ? 0 : 1)
    expect(ctx.deliver).not.toHaveBeenCalled()
    expect(vi.mocked(attestRound).mock.calls.map(c => c[1])).toEqual(['frank-cross-review', 'frank-conscience-check'])
    for (const c of vi.mocked(attestRound).mock.calls) expect(JSON.parse(c[4]!)).not.toHaveProperty('jev')
  })
})
