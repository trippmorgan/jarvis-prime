import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDeathWatch } from '../lieutenant/death-watch.js'

const noopLog = { info: () => {}, warn: () => {} }

describe('death-watch (pre-mortem snapshot)', () => {
  let dir: string
  let stop: (() => void) | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'death-watch-'))
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a snapshot immediately on start with rss + queue fields', () => {
    const path = join(dir, 'crash-trace.log')
    stop = startDeathWatch({
      path,
      getQueueDepth: () => 3,
      isProcessing: () => true,
      logger: noopLog,
    })
    expect(existsSync(path)).toBe(true)
    const snap = JSON.parse(readFileSync(path, 'utf-8').trim().split('\n').pop() as string)
    expect(snap.rssMb).toBeGreaterThan(0)
    expect(snap.queue).toBe(3)
    expect(snap.processing).toBe(true)
    expect(typeof snap.t).toBe('string')
  })

  it('caps the rolling buffer at `keep` lines (never grows unbounded)', () => {
    const path = join(dir, 'crash-trace.log')
    // keep=2; first snapshot fires on start, so prime the ring then re-read.
    stop = startDeathWatch({ path, intervalMs: 1, keep: 2, logger: noopLog })
    // Give the interval a few ticks, then assert the file never exceeds `keep`.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const lines = readFileSync(path, 'utf-8').trim().split('\n')
        expect(lines.length).toBeLessThanOrEqual(2)
        resolve()
      }, 30)
    })
  })

  it('degrades gracefully when no getters are provided', () => {
    const path = join(dir, 'crash-trace.log')
    stop = startDeathWatch({ path, logger: noopLog })
    const snap = JSON.parse(readFileSync(path, 'utf-8').trim().split('\n').pop() as string)
    expect(snap.queue).toBe(-1)
    expect(snap.processing).toBe(false)
  })

  it('stop() halts further snapshots', async () => {
    const path = join(dir, 'crash-trace.log')
    stop = startDeathWatch({ path, intervalMs: 5, keep: 100, logger: noopLog })
    await new Promise((r) => setTimeout(r, 20))
    stop()
    const countAfterStop = readFileSync(path, 'utf-8').trim().split('\n').length
    await new Promise((r) => setTimeout(r, 30))
    const countLater = readFileSync(path, 'utf-8').trim().split('\n').length
    expect(countLater).toBe(countAfterStop)
  })
})
