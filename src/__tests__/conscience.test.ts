import { describe, it, expect, beforeEach } from 'vitest'
import { fetchConscience, formatConscienceDigest, citeConscience, resetConscienceCache } from '../bridge/conscience.js'

const snapshot = {
  attested: true,
  snapshot: {
    snapshotHash: 'd23ae3ffeba09cc6' + 'a'.repeat(48), generatedAt: '2026-09-17T08:10:01.686Z', itemCount: 13,
    normative: [{ slug: 'feedback_dev_then_harden', description: 'Get it working in dev mode first, harden security/PHI after', body: 'long…' }, { slug: 'phi-vs-deidentified', description: 'PHI never leaves the boundary; de-identified data may' }],
    reflective: [{ id: 'dil-1', title: 'Claude does not distinguish reporting periods', severity: 'warning' }],
    resolved: [],
  },
}
const fake = (status: number, body: unknown, calls: { n: number }) => (async () => { calls.n++; return { ok: status === 200, status, json: async () => body } as Response }) as unknown as typeof fetch

describe('conscience client', () => {
  beforeEach(() => resetConscienceCache())

  it('parses the kernel snapshot into a compact digest and a citation', async () => {
    const calls = { n: 0 }
    const c = await fetchConscience({ kernelUrl: 'http://k', token: 't', fetchImpl: fake(200, snapshot, calls) })
    expect(c?.attested).toBe(true); expect(c?.normative).toHaveLength(2); expect(c?.reflective).toHaveLength(1)
    const d = formatConscienceDigest(c!)
    expect(d).toMatch(/^STANDING PRINCIPLES — the network's chain-attested conscience \(snapshot d23ae3ff, attested on the jarvis-ledger, 2026-09-17\)/)
    expect(d).toContain('- feedback_dev_then_harden: Get it working in dev mode first')
    expect(d).toContain('RECENT FINDINGS the network is asked not to repeat:\n- [warning] Claude does not distinguish reporting periods')
    expect(d).not.toContain('long…')   // bodies never ride along
    expect(citeConscience(c)).toEqual({ snapshotHash: snapshot.snapshot.snapshotHash, attested: true, generatedAt: '2026-09-17T08:10:01.686Z' })
  })

  it('caches for the ttl and is null without a token, on 401, or on a bad body', async () => {
    const calls = { n: 0 }
    await fetchConscience({ kernelUrl: 'http://k', token: 't', fetchImpl: fake(200, snapshot, calls) })
    await fetchConscience({ kernelUrl: 'http://k', token: 't', fetchImpl: fake(200, snapshot, calls) })
    expect(calls.n).toBe(1)
    resetConscienceCache()
    expect(await fetchConscience({ kernelUrl: 'http://k', token: '', fetchImpl: fake(200, snapshot, calls) })).toBeNull()
    expect(await fetchConscience({ kernelUrl: 'http://k', token: 't', fetchImpl: fake(401, { error: 'UNAUTHORIZED' }, calls) })).toBeNull()
    resetConscienceCache()
    expect(await fetchConscience({ kernelUrl: 'http://k', token: 't', fetchImpl: fake(200, { nope: 1 }, calls) })).toBeNull()
    expect(citeConscience(null)).toBeNull()
  })
})
