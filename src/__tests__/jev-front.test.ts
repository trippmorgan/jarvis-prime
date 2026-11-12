import { describe, it, expect, vi } from 'vitest'
import { routeApplies, routeThreshold, routeRecord, type JevFrontConfig } from '../bridge/jev-front.js'
import { askJevRoute, JEV_ROUTE_OPTIONS, laneForRoute, parseFrontMode } from '../bridge/jev-front.js'

const cfg = { jevUrl: 'http://127.0.0.1:30110', mode: 'all' as const, device: 'gpu' as const, timeoutMs: 1000, strong: .6 }
const response = (probabilities: number[], extra: object = {}) => new Response(JSON.stringify({ head: 'shipped', hash: 'synthetic', device: 'cuda',
  probabilities: Object.fromEntries(JEV_ROUTE_OPTIONS.map((o, i) => [o[1], probabilities[i]])), ...extra }))

describe('Jev front routing', () => {
  it.each([0, 1, 2, 3])('maps the typed winner %s to an executable harness lane', async winner => {
    const p = [.05, .05, .05, .05]; p[winner] = .85
    const fetchImpl = vi.fn<typeof fetch>(async () => response(p))
    const result = await askJevRoute(cfg, 'synthetic task', [], fetchImpl)
    expect(result).toMatchObject({ route: JEV_ROUTE_OPTIONS[winner][0], confidence: .85, hash: 'synthetic' })
    expect(laneForRoute(JEV_ROUTE_OPTIONS[winner][0])).toBe(['frank-chat', 'frank', 'frank', 'frank-deep'][winner])
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).skip_idle_wait).toBe(true)
    expect(fetchImpl.mock.calls[0][1]!.redirect).toBe('error')
  })
  it.each([[.7, .7, .1, .1], [1.1, -.1, 0, 0]])('rejects invalid distributions %s', async p => {
    expect(await askJevRoute(cfg, 'synthetic', [], vi.fn(async () => response(p)))).toHaveProperty('error')
  })
  it.each([{ hash: '' }, { device: '' }, { head: 'candidate' }])('rejects missing provenance: %s', async extra => {
    expect(await askJevRoute(cfg, 'synthetic', [], vi.fn(async () => response([.7, .1, .1, .1], extra)))).toHaveProperty('error')
  })
  it('never sends private route text to a remote service', async () => {
    const fetchImpl = vi.fn()
    expect(await askJevRoute({ ...cfg, jevUrl: 'http://remote.invalid' }, 'synthetic', [], fetchImpl)).toHaveProperty('error')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('fails soft on service timeout and honors the off switch', async () => {
    const f = vi.fn(async () => { throw new Error('timeout') })
    expect(await askJevRoute(cfg, 'synthetic', [], f)).toHaveProperty('error', 'timeout')
    expect(parseFrontMode('off')).toBe('off')
    f.mockClear()
    await askJevRoute({ ...cfg, mode: 'off' }, 'synthetic', [], f)
    expect(f).not.toHaveBeenCalled()
  })
  it('2026-10-29: per-route thresholds gate `quick` harder than the rest and the record says which bar applied', () => {
    const cfg: JevFrontConfig = { jevUrl: 'http://127.0.0.1:30110', mode: 'all', device: 'gpu', timeoutMs: 100, strong: .6, strongByRoute: { quick: .8 } }
    const r = (route: 'quick' | 'tools' | 'web' | 'deep', confidence: number) => ({ route, confidence, p: { quick: 0, tools: 0, web: 0, deep: 0, [route]: confidence }, ms: 1, hash: 'h', device: 'cpu' })
    expect(routeThreshold(cfg, 'quick')).toBe(.8); expect(routeThreshold(cfg, 'tools')).toBe(.6)
    expect(routeApplies(cfg, r('quick', .7))).toBe(false); expect(routeApplies(cfg, r('quick', .85))).toBe(true); expect(routeApplies(cfg, r('tools', .7))).toBe(true)
    expect(routeApplies({ ...cfg, mode: 'shadow' }, r('tools', .9))).toBe(false)
    expect(routeRecord(cfg, r('quick', .7), false, 'frank', true)).toMatchObject({ device: 'cpu', threshold: .8, parallel: true, applied: false, servedOn: 'cpu' })
  })
})
