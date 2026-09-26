import { describe, it, expect } from 'vitest'
import { mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withShadowLock } from '../bridge/shadow-lock.js'
import { queueDiagnostics } from '../bridge/shadow-diagnostics.js'
import { collectCase } from '../bridge/shadow-review.js'
const dir = () => mkdtempSync(join(tmpdir(), 'shadow-worker-test-'))
describe('shared shadow inference lock', () => {
  it('refuses overlapping online/drain work and releases after completion', async () => {
    const d = dir(); let release!: () => void; let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    const hold = new Promise<void>(r => { release = r })
    const first = withShadowLock(d, async () => { entered(); await hold; return 1 })
    await ready
    await expect(withShadowLock(d, async () => 2)).rejects.toThrow('shadow-worker-busy')
    release(); expect(await first).toBe(1)
    await expect(withShadowLock(d, async () => 3)).resolves.toBe(3)
  })
  it('releases after request failure so pending cases can retry', async () => {
    const d = dir()
    await expect(withShadowLock(d, async () => { throw Error('timeout') })).rejects.toThrow('timeout')
    await expect(withShadowLock(d, async () => 'recovered')).resolves.toBe('recovered')
  })
  it('reports pending count and age without returning private content', () => {
    const d = dir()
    expect(queueDiagnostics(d)).toEqual({ cases: 0, predictions: 0, pending: 0, oldestPendingSeconds: 0, independentDeclarations: 0 })
    const c = collectCase({ messageId: 'test', chatId: 'test', task: 'PRIVATE-TEXT', harness: 'PRIVATE-A', jarvis: 'PRIVATE-B', evidence: { harness: [], jarvis: [] } }, d)
    const when = new Date(Date.now() - 65000)
    utimesSync(join(d, 'cases', c.id + '.json'), when, when)
    const report = queueDiagnostics(d)
    expect(report.pending).toBe(1); expect(report.oldestPendingSeconds).toBeGreaterThanOrEqual(65)
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
  })
})
