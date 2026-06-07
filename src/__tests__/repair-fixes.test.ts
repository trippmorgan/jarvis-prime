import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recallMemory } from '../context/memory-recall.js'
import { startEventLoopWatchdog } from '../lieutenant/watchdog.js'
import { TelegramPoller } from '../telegram/poller.js'

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never

describe('memory recall (Fix 3)', () => {
  const origToken = process.env.KERNEL_TOKEN
  beforeEach(() => {
    process.env.KERNEL_TOKEN = 'test-token'
    delete process.env.JARVIS_MEMORY_RECALL_ENABLED
  })
  afterEach(() => {
    process.env.KERNEL_TOKEN = origToken
    vi.restoreAllMocks()
  })

  it('formats hippocampus notes + active projects into a memory block', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/hippocampus/search')) {
        return new Response(
          JSON.stringify({ results: [{ slug: 'a', name: 'Repair Loop', description: 'daily repair', type: 'project' }] }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ rows: [{ project: 'memory-graphify', status: 'in-progress', summary: 'phase 1', next_action: 'write gate qs' }] }),
        { status: 200 },
      )
    })

    const block = await recallMemory('how does the repair loop work')
    expect(block).toContain('Memory check')
    expect(block).toContain('Repair Loop')
    expect(block).toContain('memory-graphify')
    expect(block).toContain('next: write gate qs')
  })

  it('drops done/archived projects', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/hippocampus/search')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      return new Response(JSON.stringify({ rows: [{ project: 'old', status: 'done', summary: 'x' }] }), { status: 200 })
    })
    expect(await recallMemory('anything')).toBe('')
  })

  it('is fail-soft: returns empty string when the kernel errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await recallMemory('q')).toBe('')
  })

  it('returns empty when no KERNEL_TOKEN', async () => {
    process.env.KERNEL_TOKEN = ''
    expect(await recallMemory('q')).toBe('')
  })

  it('honors the JARVIS_MEMORY_RECALL_ENABLED=false killswitch', async () => {
    process.env.JARVIS_MEMORY_RECALL_ENABLED = 'false'
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await recallMemory('q')).toBe('')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('telegram offset persistence (Fix 1)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp-offset-'))
    path = join(dir, 'telegram-offset.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('restores a persisted offset and uses it in the next getUpdates call', async () => {
    writeFileSync(path, JSON.stringify({ offset: 738951594 }))
    const poller = new TelegramPoller({
      botToken: 'x',
      allowedChatIds: ['1'],
      pollTimeoutSecs: 0,
      offsetPersistPath: path,
      onMessage: async () => {},
      logger: noopLog,
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    )
    await (poller as unknown as { poll: () => Promise<void> }).poll()
    expect(String(fetchSpy.mock.calls[0][0])).toContain('offset=738951594')
    vi.restoreAllMocks()
  })

  it('persists the advanced offset BEFORE handling (so a wedge cannot re-poison on restart)', async () => {
    let persistedAtHandle: string | null = null
    const poller = new TelegramPoller({
      botToken: 'x',
      allowedChatIds: ['1'],
      pollTimeoutSecs: 0,
      offsetPersistPath: path,
      // When the handler runs, the offset must already be on disk.
      onMessage: async () => {
        persistedAtHandle = existsSync(path) ? readFileSync(path, 'utf-8') : null
      },
      logger: noopLog,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: [{ update_id: 42, message: { message_id: 1, from: { id: 1, first_name: 'T' }, chat: { id: 1, type: 'private' }, date: 0, text: 'hi' } }] }),
        { status: 200 },
      ),
    )
    await (poller as unknown as { poll: () => Promise<void> }).poll()
    expect(persistedAtHandle).toContain('43') // update_id + 1
    expect(JSON.parse(readFileSync(path, 'utf-8')).offset).toBe(43)
    vi.restoreAllMocks()
  })
})

describe('event-loop watchdog (Fix 2)', () => {
  it('starts and stops cleanly without firing (huge threshold)', () => {
    const stop = startEventLoopWatchdog({ thresholdMs: 9_999_999, heartbeatMs: 1000 })
    expect(typeof stop).toBe('function')
    stop() // tears down the worker; must not throw
  })
})
