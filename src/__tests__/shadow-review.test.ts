import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectCase, collectShadow, nextBlind, labelIndependent, exportIndependent, shadowStatus, evaluateShadow, localService } from '../bridge/shadow-review.js'
import { askJevJudge } from '../bridge/harness-race.js'
const dir = () => mkdtempSync(join(tmpdir(), 'frank-shadow-test-'))
const input = { messageId: 'synthetic-test', chatId: 'test', task: 'Synthetic: add 1 and 1', harness: '2', jarvis: '3', evidence: { harness: [], jarvis: [] } }
const cfg = { url: '', model: '', timeoutMs: 1, jevUrl: 'http://127.0.0.1:30110' }
const good = { p_a: .8, p_b: .2, position_bias: .1, head: 'shipped', order1: 'hash1', order2: 'hash2' }
const response = (x: unknown) => new Response(JSON.stringify(x), { status: 200 })

describe('advisory shadow collection', () => {
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
