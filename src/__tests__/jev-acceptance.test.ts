import { describe, it, expect, vi } from 'vitest'
import { askJevAcceptance, DELIVER_OPTION, REVIEW_OPTION } from '../bridge/jev-acceptance.js'
vi.mock('../bridge/shadow-lock.js', () => ({ withShadowLock: vi.fn(async (_dir, work) => work()) }))
const cfg = { url: 'unused', model: 'unused', timeoutMs: 1000, jevUrl: 'http://127.0.0.1:30110' }
const candidate = { text: 'answer', source: 'primary' as const, evidence: [{ tool: 'Bash', input: 'check', result: 'observed proof' }] }
const budget = () => ({ timeoutMs: 1000, signal: new AbortController().signal })
const response = (p: number, extra: object = {}) => new Response(JSON.stringify({ head: 'shipped', hash: 'synthetic', probabilities: { [DELIVER_OPTION]: p, [REVIEW_OPTION]: 1 - p }, ...extra }))

describe('single-candidate JEV acceptance', () => {
  it('counterbalances options, includes evidence, and requests an in-pipeline GPU judgment', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(response(.9)).mockResolvedValueOnce(response(.8))
    const result = await askJevAcceptance(cfg, 'synthetic task', candidate, budget(), f)
    expect(result).toHaveProperty('action', 'deliver')
    if ('pDeliver' in result) expect(result.pDeliver).toBeCloseTo(.85)
    const bodies = f.mock.calls.map(c => JSON.parse(c[1]!.body as string))
    expect(bodies[0].options).toEqual([DELIVER_OPTION, REVIEW_OPTION]); expect(bodies[1].options).toEqual([REVIEW_OPTION, DELIVER_OPTION])
    expect(bodies.every(b => b.delivery_gate && b.head === 'shipped' && b.state.includes('observed proof'))).toBe(true)
    expect(f.mock.calls.every(c => c[1]!.redirect === 'error')).toBe(true)
  })
  it('2026-10-29 rule: both orders above the minimum deliver even when the average is modest', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(response(.6)).mockResolvedValueOnce(response(.55))
    const result = await askJevAcceptance(cfg, 'task', candidate, budget(), f)
    expect(result).toHaveProperty('action', 'deliver')
    if ('pDeliverOrders' in result) expect(result.pDeliverOrders).toEqual([.6, .55])
  })
  it('FRANK_JEV_ACCEPT_MIN raises the per-order bar', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(response(.6)).mockResolvedValueOnce(response(.55))
    expect(await askJevAcceptance({ ...cfg, jevAcceptMin: .65 }, 'task', candidate, budget(), f)).toHaveProperty('action', 'review')
  })
  it('one-order disagreement requests review despite a favorable average', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(response(.99)).mockResolvedValueOnce(response(.49))
    expect(await askJevAcceptance(cfg, 'task', candidate, budget(), f)).toHaveProperty('action', 'review')
  })
  it.each([{ head: 'candidate' }, { hash: '' }, { probabilities: { [DELIVER_OPTION]: .8, [REVIEW_OPTION]: .8 } }])('rejects invalid judgments %s', async extra => {
    expect(await askJevAcceptance(cfg, 'task', candidate, budget(), vi.fn(async () => response(.8, extra)))).toHaveProperty('error')
  })
  it('does not send private inputs to remote services', async () => {
    const f = vi.fn()
    expect(await askJevAcceptance({ ...cfg, jevUrl: 'https://remote.invalid' }, 'task', candidate, budget(), f)).toHaveProperty('error')
    expect(f).not.toHaveBeenCalled()
  })
})
