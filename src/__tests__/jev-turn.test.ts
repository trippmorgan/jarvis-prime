import { describe, it, expect, vi } from 'vitest'
import { executionPlan, JevTurnCoordinator, type TurnDependencies, type TurnCandidate, type ExecutionPlan } from '../bridge/jev-turn.js'
import type { JevVerdict } from '../bridge/harness-race.js'

const primary: TurnCandidate = { text: 'original answer', source: 'primary', evidence: [] }
const alternate: TurnCandidate = { text: 'alternative answer', source: 'harness', evidence: [] }
const reviewed: TurnCandidate = { text: 'corrected answer', source: 'reviewer', evidence: [{ tool: 'Bash', input: 'check', result: 'observed result' }] }
const verdict = (p = .8, bias = 0): JevVerdict => ({ pHarness: p, pJarvis: 1 - p, positionBias: bias, verdict: p > .5 ? 'harness' : 'jarvis', strong: true, head: 'shipped', order1: 'first', order2: 'second', ms: 1 })
const acceptance = { action: 'deliver' as const, pDeliver: .9, positionBias: 0, order1: 'a', order2: 'b', ms: 1 }
const plan = (kind: ExecutionPlan['kind']): ExecutionPlan => ({ kind, route: kind, primary: kind === 'competing' ? 'configured' : 'single', competingCandidate: kind === 'competing' })
function setup(kind: ExecutionPlan['kind'], limits?: { candidateMs: number; judgeMs: number; reviewMs: number; totalMs: number; margin: number }) {
  const deps = { judge: vi.fn(async () => verdict()), assess: vi.fn(async () => acceptance), review: vi.fn(async () => reviewed), event: vi.fn() }
  return { deps, turn: new JevTurnCoordinator(plan(kind), deps as TurnDependencies, limits) }
}

describe('execution plan coordinator', () => {
  it.each(['quick', 'tools', 'web', 'deep'] as const)('route %s controls execution topology', route => {
    const p = executionPlan({ mode: 'all', device: 'gpu', jev: route, confidence: .9, applied: true, lane: 'test', ms: 1, hash: 'test' })
    // 2026-10-29: `web` is one executor with the search tool; only `deep` earns a competitor.
    expect(p.competingCandidate).toBe(route === 'deep')
    expect(p.primary).toBe(route === 'deep' ? 'configured' : 'single')
    expect(p.kind).toBe(route === 'deep' ? 'competing' : route === 'quick' ? 'quick' : 'tools')
  })
  it('uncertain input routing conservatively uses one executor and a critic', () => {
    expect(executionPlan()).toMatchObject({ kind: 'tools', route: 'unknown', competingCandidate: false })
  })
  it('quick acceptance delivers one candidate without waiting for a competitor', async () => {
    const { deps, turn } = setup('quick')
    const result = await turn.select(primary, new Promise(() => {}))
    expect(result.candidate).toBe(primary); expect(result.reason).toBe('jev-deliver')
    expect(deps.review).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled()
    expect(deps.assess).toHaveBeenCalledTimes(1)
  })
  it('quick rejection escalates once and JEV chooses the reviewed answer', async () => {
    const { deps, turn } = setup('quick')
    deps.assess.mockResolvedValue({ ...acceptance, action: 'review' as any })
    const result = await turn.select(primary)
    expect(result.candidate.source).toBe('reviewer')
    expect(deps.review).toHaveBeenCalledTimes(1); expect(deps.judge).toHaveBeenCalledTimes(1)
  })
  it('tools: an accepted executor report is delivered without a reviewer (2026-10-29 gate-first)', async () => {
    const { deps, turn } = setup('tools')
    const executor = { ...primary, evidence: reviewed.evidence }
    const result = await turn.select(executor, new Promise(() => {}))
    expect(deps.assess).toHaveBeenCalledExactlyOnceWith(executor, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(deps.review).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled()
    expect(result.candidate).toBe(executor); expect(result.reason).toBe('jev-deliver'); expect(result.acceptances).toHaveLength(1)
  })
  it('tools review receives executor evidence and cannot start a competitor', async () => {
    const { deps, turn } = setup('tools')
    deps.assess.mockResolvedValueOnce({ ...acceptance, action: 'review' as any })
    const executor = { ...primary, evidence: reviewed.evidence }
    const result = await turn.select(executor, new Promise(() => {}))
    expect(deps.review).toHaveBeenCalledWith(executor, null, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(result.candidate).toBe(reviewed); expect(result.reviews).toBe(1); expect(result.reason).toBe('reviewed:jev-harness')
    expect(result.results).toHaveLength(1); expect(result.acceptances).toHaveLength(1)
  })
  it('tools: an unavailable gate falls back to the reviewer', async () => {
    const { deps, turn } = setup('tools')
    deps.assess.mockResolvedValueOnce({ error: 'acceptance-unavailable-or-timeout', ms: 0 } as any)
    const result = await turn.select(primary)
    expect(deps.review).toHaveBeenCalledTimes(1); expect(result.candidate).toBe(reviewed); expect(result.reason).toBe('reviewed:jev-harness')
  })
  it('failed executor does not ask a critic to impersonate execution', async () => {
    const { deps, turn } = setup('tools')
    const result = await turn.select({ ...primary, failed: true })
    expect(result.reason).toBe('executor-failed'); expect(deps.review).not.toHaveBeenCalled()
  })
  it('web/deep selects directly when both orders agree', async () => {
    const { deps, turn } = setup('competing')
    expect((await turn.select(primary, Promise.resolve(alternate))).candidate).toBe(alternate)
    expect(deps.review).not.toHaveBeenCalled()
  })
  it.each([verdict(.51), verdict(.7, .3)])('uncertainty triggers one review and one new judgment: %s', async initial => {
    const { deps, turn } = setup('competing')
    deps.judge.mockResolvedValueOnce(initial).mockResolvedValueOnce(verdict())
    const result = await turn.select(primary, Promise.resolve(alternate))
    expect(result.candidate).toBe(reviewed); expect(result.reviews).toBe(1); expect(result.judgments).toBe(2)
    expect(deps.review).toHaveBeenCalledExactlyOnceWith(primary, alternate, expect.anything())
  })
  it('a second uncertain judgment cannot create an unbounded review loop', async () => {
    const { deps, turn } = setup('competing')
    deps.judge.mockResolvedValue(verdict(.51))
    const result = await turn.select(primary, Promise.resolve(alternate))
    expect(result.candidate).toBe(primary); expect(deps.review).toHaveBeenCalledTimes(1); expect(deps.judge).toHaveBeenCalledTimes(2)
  })
  it('unchanged reviewed answer still passes through JEV acceptance', async () => {
    const { deps, turn } = setup('tools')
    deps.assess.mockResolvedValueOnce({ ...acceptance, action: 'review' as any })
    deps.review.mockResolvedValue(primary as any)
    const result = await turn.select(primary)
    expect(result.reason).toBe('evidence-review:jev-deliver-after-review')
    expect(deps.assess).toHaveBeenCalledTimes(2)
    // Both gates are kept (audit bug 7): the first said review, the second deliver.
    expect(result.acceptances.map(a => 'action' in a ? a.action : a.error)).toEqual(['review', 'deliver'])
    expect(result.phaseMs.assessing).toBeGreaterThanOrEqual(0); expect(result.phaseMs.reviewing).toBeGreaterThanOrEqual(0)
  })
  it('review timeout is bounded and late content cannot change the selection', async () => {
    const limits = { candidateMs: 20, judgeMs: 20, reviewMs: 10, totalMs: 40, margin: .05 }
    const { deps, turn } = setup('tools', limits)
    deps.assess.mockResolvedValueOnce({ ...acceptance, action: 'review' as any })
    let late!: (candidate: TurnCandidate) => void
    deps.review.mockImplementation(() => new Promise(resolve => { late = resolve }))
    const result = await turn.select(primary)
    expect(result.candidate).toBe(primary)
    late(reviewed); await Promise.resolve()
    expect(await turn.select(primary)).toBe(result); expect(deps.judge).not.toHaveBeenCalled()
  })
  it('competing: the first uncertain verdict is kept beside the second (audit bug 8) and the case id travels', async () => {
    const { deps, turn } = setup('competing')
    deps.judge.mockResolvedValueOnce({ ...verdict(.51), caseId: 'case-1' } as any).mockResolvedValueOnce({ ...verdict(), caseId: 'case-2' } as any)
    const result = await turn.select(primary, Promise.resolve(alternate))
    expect(result.results).toHaveLength(2); expect(result.caseId).toBe('case-2'); expect(result.result).toMatchObject({ pHarness: .8 })
  })
  it('single-flight selection cannot generate or deliver twice', async () => {
    const { deps, turn } = setup('tools')
    deps.assess.mockResolvedValue({ ...acceptance, action: 'review' as any })
    const a = turn.select(primary), b = turn.select(alternate)
    expect(a).toBe(b)
    await a
    expect(deps.review).toHaveBeenCalledTimes(1)
    expect(deps.event.mock.calls.filter(c => c[0] === 'selected')).toHaveLength(1)
  })
})
