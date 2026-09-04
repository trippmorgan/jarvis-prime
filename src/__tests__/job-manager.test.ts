import { describe, expect, it, vi } from 'vitest'
import { JobManager, type JobRunResult } from '../jobs/job-manager.js'

function surface() {
  const sent: string[] = []
  const edits: Array<{ id: number; text: string }> = []
  return {
    sent,
    edits,
    s: {
      sendMessageAndGetId: vi.fn(async (_c: string, text: string) => { sent.push(text); return 100 + sent.length }),
      editMessageText: vi.fn(async (_c: string, id: number, text: string) => { edits.push({ id, text }); return true }),
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

describe('JobManager', () => {
  it('posts a monitor bubble at start, marks it done, delivers the result, attests', async () => {
    const sf = surface()
    const delivered: string[] = []
    const attested: number[] = []
    let clock = 1_000_000
    const jm = new JobManager({ surface: sf.s, deliverLong: async (_c, t) => { delivered.push(t) }, now: () => clock, tickMs: 1_000_000, attest: (j) => attested.push(j.id) })
    let resolveRun!: (r: JobRunResult) => void
    const job = await jm.start({ chatId: 'c', title: 'check the station', kind: 'task', agentLabel: 'Prime worker', run: (ctx) => new Promise((res) => { ctx.onActivity('Bash'); ctx.onActivity('Bash'); resolveRun = res }) })
    expect(job?.id).toBe(1)
    expect(sf.sent[0]).toMatch(/Task #1 · check the station/)
    expect(sf.sent[0]).toMatch(/Agent: Prime worker/)
    expect(jm.statusText('c')).toMatch(/1 running:[\s\S]*#1 check the station — 0:00 · Bash ×2/)
    clock += 252_000
    resolveRun({ output: 'all good' })
    await flush()
    expect(jm.running()).toHaveLength(0)
    expect(sf.edits.at(-1)?.text).toMatch(/✅ Task #1 done · 4:12 · Bash ×2/)
    expect(delivered[0]).toBe('📬 Task #1 result:\n\nall good')
    expect(attested).toEqual([1])
    expect(jm.statusText('c')).toMatch(/Recent:[\s\S]*#1 check the station — done in 4:12/)
  })

  it('stop aborts the run and posts the partial output', async () => {
    const sf = surface()
    const delivered: string[] = []
    const jm = new JobManager({ surface: sf.s, deliverLong: async (_c, t) => { delivered.push(t) }, tickMs: 1_000_000 })
    await jm.start({ chatId: 'c', title: 'long', kind: 'task', agentLabel: 'w', run: (ctx) => new Promise((res) => { ctx.signal.addEventListener('abort', () => res({ output: 'half way', aborted: true })) }) })
    expect(await jm.stop('c', 9)).toBe('No job #9 here.')
    expect(await jm.stop('c')).toMatch(/Stopping task #1/)
    await flush()
    expect(sf.edits.at(-1)?.text).toMatch(/⏹ Task #1 stopped/)
    expect(delivered[0]).toBe('📬 Task #1 (stopped):\n\nhalf way')
    expect(await jm.stop('c')).toBe('Nothing is running.')
  })

  it('refuses beyond maxConcurrent and asks for a number when several run', async () => {
    const sf = surface()
    const jm = new JobManager({ surface: sf.s, deliverLong: async () => {}, tickMs: 1_000_000, maxConcurrent: 2 })
    const never = () => new Promise<JobRunResult>(() => {})
    await jm.start({ chatId: 'c', title: 'a', kind: 'task', agentLabel: 'w', run: never })
    await jm.start({ chatId: 'c', title: 'b', kind: 'dual', agentLabel: 'w', run: never })
    expect(await jm.start({ chatId: 'c', title: 'c', kind: 'task', agentLabel: 'w', run: never })).toBeNull()
    expect(await jm.stop('c')).toMatch(/2 jobs running — say `stop #n`: #1, #2/)
  })

  it('a throwing run becomes a failed job with a delivered error line', async () => {
    const delivered: string[] = []
    const jm = new JobManager({ surface: null, deliverLong: async (_c, t) => { delivered.push(t) }, tickMs: 1_000_000 })
    await jm.start({ chatId: 'c', title: 'boom', kind: 'task', agentLabel: 'w', run: async () => { throw new Error('spawn died') } })
    await flush()
    expect(delivered[0]).toBe('📬 Task #1 (failed):\n\nTask failed: spawn died')
  })
})
