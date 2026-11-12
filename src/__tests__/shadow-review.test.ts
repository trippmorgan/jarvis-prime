import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectCase, collectShadow, nextBlind, labelIndependent, exportIndependent, shadowStatus, evaluateShadow, localService, scoreShadow, calibrateShadow, writeCalibration, loadCalibration } from '../bridge/shadow-review.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { askJevJudge } from '../bridge/harness-race.js'
const dir = () => mkdtempSync(join(tmpdir(), 'frank-shadow-test-'))
const input = { messageId: 'synthetic-test', chatId: 'test', task: 'Synthetic: add 1 and 1', harness: '2', jarvis: '3', evidence: { harness: [], jarvis: [] } }
const cfg = { url: '', model: '', timeoutMs: 1, jevUrl: 'http://127.0.0.1:30110' }
const good = { p_a: .8, p_b: .2, position_bias: .1, head: 'shipped', order1: 'hash1', order2: 'hash2' }
const response = (x: unknown) => new Response(JSON.stringify(x), { status: 200 })

describe('advisory shadow collection', () => {
  it.each(['cpu', 'cuda'])('routing explicitly accepts GPU-swap %s and persists an active decision', async device => {
    const d = dir(), c = collectCase(input, d)
    const f = vi.fn().mockResolvedValueOnce(response({ loaded: true, device, mode: 'gpu-swap', status: device === 'cpu' ? 'parked' : 'gpu', restore_pending: device === 'cuda' })).mockResolvedValueOnce(response(good))
    const onResult = vi.fn()
    await evaluateShadow(cfg, c, d, f, onResult, true)
    expect(JSON.parse(f.mock.calls[1][1].body).delivery_gate).toBe(true)
    expect(JSON.parse(readFileSync(join(d, 'predictions', c.id + '.json'), 'utf8')).advisory).toBe(false)
    await evaluateShadow(cfg, c, d, f, onResult, true)
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('persists duplicate-safe private cases and counts no weak judgments as independent', () => {
    const d = dir(), c = collectCase(input, d)
    expect(collectCase(input, d)).toEqual(c)
    expect(shadowStatus(d)).toEqual({ cases: 1, predictions: 0, independentDeclarations: 0, exportableCases: 0 })
    expect(statSync(join(d, 'cases', c.id + '.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(d, 'cases')).mode & 0o777).toBe(0o700)
  })
  it('assigns stable blind A/B, exports only explicit reviewed labels with scenario families', () => {
    const d = dir(), c = collectCase(input, d), blind = nextBlind('human-test', d)!
    expect(nextBlind('human-test', d)).toEqual(blind)
    expect(blind).not.toHaveProperty('pHarness'); expect(blind).not.toHaveProperty('reviewer_harness')
    expect(blind).not.toHaveProperty('head'); expect(blind).not.toHaveProperty('a')
    expect(() => labelIndependent('human-test', c.id, 'A', 'correct arithmetic', 'arithmetic', false, d)).toThrow(/declaration/)
    expect(() => labelIndependent('unassigned', c.id, 'A', 'reason', 'arithmetic', true, d)).toThrow()
    labelIndependent('human-test', c.id, 'A', 'Correct arithmetic', 'arithmetic', true, d)
    expect(exportIndependent(d)[0].label).toBe(blind.A === '2' ? 'harness' : 'jarvis')
    expect(exportIndependent(d)[0].scenarioId).toBe('arithmetic')
    expect(nextBlind('human-test', d)).toBeNull()
    expect(() => labelIndependent('human-test', c.id, 'B', 'change', 'arithmetic', true, d)).toThrow(/already exists/)
  })
  it('excludes disputed labels and abstentions rather than inventing consensus', () => {
    const d = dir(), c = collectCase(input, d)
    const a = nextBlind('first-human', d)!, b = nextBlind('second-human', d)!
    labelIndependent('first-human', c.id, a.A === '2' ? 'A' : 'B', 'correct', 'arithmetic', true, d)
    labelIndependent('second-human', c.id, b.A === '3' ? 'A' : 'B', 'disagree', 'arithmetic', true, d)
    expect(exportIndependent(d)).toEqual([])
    const d2 = dir(), c2 = collectCase(input, d2); nextBlind('human', d2)
    labelIndependent('human', c2.id, 'abstain', 'insufficient context', 'arithmetic', true, d2)
    expect(exportIndependent(d2)).toEqual([])
  })
  it('records shipped results only and never calls load/unload or follows redirects', async () => {
    const d = dir(), c = collectCase(input, d)
    const f = vi.fn().mockResolvedValueOnce(response({ loaded: true, device: 'cpu' })).mockResolvedValueOnce(response(good))
    await expect(evaluateShadow(cfg, c, d, f)).resolves.toBe('recorded')
    expect(f.mock.calls.map(x => x[0])).toEqual([cfg.jevUrl + '/health', cfg.jevUrl + '/judge'])
    expect(JSON.parse(f.mock.calls[1][1].body).head).toBe('shipped')
    expect(f.mock.calls.every(x => x[1].redirect === 'error')).toBe(true)
    expect(shadowStatus(d).predictions).toBe(1)
    expect(JSON.parse(readFileSync(join(d, 'predictions', c.id + '.json'), 'utf8')).advisory).toBe(true)
  })
  it.each([{ loaded: false, device: null }, { loaded: true, device: 'cuda' }])('keeps case pending if CPU not ready: %s', async health => {
    const d = dir(), c = collectCase(input, d), f = vi.fn().mockResolvedValue(response(health))
    await expect(evaluateShadow(cfg, c, d, f)).rejects.toThrow(/CPU/)
    expect(f).toHaveBeenCalledTimes(1); expect(shadowStatus(d).predictions).toBe(0)
  })
  it.each([{ head: 'candidate' }, { head: undefined }, { p_a: 1.1 }, { p_b: .8 }, { position_bias: .9 }, { order1: undefined }])('rejects malformed or unprovenanced results: %s', async override => {
    const f = vi.fn().mockResolvedValue(response({ ...good, ...override }))
    expect(await askJevJudge(cfg, 'q', 'a', 'b', f)).toHaveProperty('error')
  })
  it('retains ties and rejects remote services', async () => {
    const f = vi.fn().mockResolvedValue(response({ ...good, p_a: .5, p_b: .5 }))
    expect(await askJevJudge(cfg, 'q', 'a', 'b', f)).toHaveProperty('verdict', 'tie')
    for (const u of ['https://remote.invalid', 'http://127.0.0.1.evil:30110', 'http://user@localhost:30110', 'http://localhost:30110/path']) expect(localService(u)).toBe(false)
    const d = dir(), c = collectCase(input, d)
    await expect(evaluateShadow({ ...cfg, jevUrl: 'https://remote.invalid' }, c, d, f)).rejects.toThrow(/loopback/)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('returns immediately, bounds concurrent requests, and preserves pending cases on timeout', async () => {
    const d = dir(); let reject!: (e: Error) => void
    const f = vi.fn(() => new Promise<Response>((_, r) => { reject = r }))
    vi.stubGlobal('fetch', f)
    try {
      expect(collectShadow(cfg, input, () => {}, d)).toBeUndefined()
      collectShadow(cfg, { ...input, messageId: 'second' }, () => {}, d)
      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
      expect(shadowStatus(d).cases).toBe(2)
      reject(new Error('timeout')); await new Promise(r => setTimeout(r, 0))
      expect(shadowStatus(d).predictions).toBe(0)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('model labels and calibration (2026-10-30)', () => {
  const pred = (d: string, id: string, pHarness: number) => { mkdirSync(join(d, 'predictions'), { recursive: true }); writeFileSync(join(d, 'predictions', id + '.json'), JSON.stringify({ schema: 1, caseId: id, createdAt: 'x', advisory: true,
    result: { pHarness, pJarvis: 1 - pHarness, verdict: pHarness > .5 ? 'harness' : 'jarvis', strong: Math.abs(pHarness - .5) > .35, positionBias: 0, head: 'shipped', order1: 'h1', order2: 'h2', ms: 1 } })) }
  it('keeps model labels out of human ground truth but scores them separately', () => {
    const d = dir(), c = collectCase(input, d), blind = nextBlind('claude-cli', d)!
    labelIndependent('claude-cli', c.id, blind.A === '2' ? 'A' : 'B', 'correct arithmetic', 'arithmetic', true, d, 'claude-sonnet')
    expect(exportIndependent(d)).toEqual([])
    expect(shadowStatus(d).independentDeclarations).toBe(1)
    expect(() => labelIndependent('x', c.id, 'A', 'r', 's', true, d, 'bad name!')).toThrow(/identifier/)
    pred(d, c.id, .9)
    const sc = scoreShadow(d)
    expect(sc.humanAgreement.labeled).toBe(0)
    expect(sc.modelAgreement).toMatchObject({ labeled: 1, scored: 1, agree: 1, rate: 1, reviewers: { 'model:claude-sonnet': 1 } })
    expect(sc.modelAgreement.byBand.ge25).toEqual({ n: 1, agree: 1, rate: 1 })
  })
  it('calibrates the route margin from labels and loads only a usable file', () => {
    const d = dir(); const cases = Array.from({ length: 12 }, (_, i) => collectCase({ ...input, messageId: 'm' + i, task: 'task ' + i }, d))
    // judge is right whenever it is decisive (|p-.5| >= .15) and wrong when it is a coin flip
    const truthOf = new Map(cases.map((c, i) => { pred(d, c.id, i < 4 ? .55 : .9); return [c.id, i < 4 ? 'jarvis' : 'harness'] as const }))
    for (let i = 0; i < 12; i++) {
      const blind = nextBlind('claude-cli', d)!, truth = truthOf.get(blind.caseId)!
      labelIndependent('claude-cli', blind.caseId, (blind.A === input.harness) === (truth === 'harness') ? 'A' : 'B', 'r', 'f', true, d, 'claude-sonnet')
    }
    const cal = calibrateShadow(d, 8, .7)
    expect(cal.source).toBe('model'); expect(cal.labeled).toBe(12)
    expect(cal.byMargin[0]).toMatchObject({ margin: .05, decisive: 12, agree: 8 })
    expect(cal.routeMargin).toBe(.1)
    expect(loadCalibration(d)).toBeNull()
    writeCalibration(cal, d); expect(loadCalibration(d)?.routeMargin).toBe(.1)
    writeFileSync(join(d, 'calibration.json'), JSON.stringify({ schema: 1, routeMargin: .01 })); expect(loadCalibration(d)).toBeNull()
    writeFileSync(join(d, 'calibration.json'), 'not json'); expect(loadCalibration(d)).toBeNull()
    expect(calibrateShadow(dir()).routeMargin).toBeNull()
  })
})
