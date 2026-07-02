import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Wave-2 T7 — buildServer wiring tests.
 *
 * Focused coverage only:
 *  1. The Wave-1 boot guard (assertLeftRuntimeConfig) fires during startup:
 *     a remote LEFT_OLLAMA_URL with an empty LEFT_API_KEY refuses to boot.
 *  2. The MessageProcessor receives defaultMode 'dual' and a
 *     defaultLeftRuntime derived from USE_CLAUDE_LEFT.
 *
 * MessageProcessor is mocked so buildServer never spawns real hemisphere
 * clients or touches the on-disk mode-state/history files. The Telegram
 * poller stays null (no TELEGRAM_BOT_TOKEN in the cleared env) and the
 * reporter is the Noop variant (LANGFUSE disabled by default).
 */

const { processorCtorSpy } = vi.hoisted(() => ({ processorCtorSpy: vi.fn() }))

vi.mock('../bridge/processor.js', () => ({
  MessageProcessor: class {
    constructor(...args: unknown[]) {
      processorCtorSpy(...args)
    }
    submit() {}
    getQueueLength() {
      return 0
    }
    isProcessing() {
      return false
    }
  },
}))

import { loadConfig } from '../config.js'
import { buildServer } from '../server.js'

const KEYS = [
  'USE_CLAUDE_LEFT',
  'LEFT_OLLAMA_URL',
  'LEFT_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'JARVIS_TELEGRAM_DISABLED',
  'LANGFUSE_ENABLED',
  'OPENCLAW_GATEWAY_TOKEN',
] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  processorCtorSpy.mockClear()
  savedEnv = {}
  for (const key of KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Required by the config schema when CORPUS_CALLOSUM_ENABLED (default true).
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
})

afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('buildServer boot guard (Wave-1 assertLeftRuntimeConfig)', () => {
  it('refuses to boot when LEFT_OLLAMA_URL is remote and LEFT_API_KEY is empty', async () => {
    // Defaults: remote https://ollama.com URL, empty key, USE_CLAUDE_LEFT=false.
    const cfg = loadConfig()
    await expect(buildServer(cfg)).rejects.toThrow(/LEFT_API_KEY/)
    expect(processorCtorSpy).not.toHaveBeenCalled()
  })

  it('boots when LEFT_API_KEY is provided for a remote URL', async () => {
    process.env.LEFT_API_KEY = 'test-key'
    const cfg = loadConfig()
    const ctx = await buildServer(cfg)
    expect(ctx.processor).toBeDefined()
    await ctx.server.close()
  })

  it('boots when USE_CLAUDE_LEFT=true even with an empty LEFT_API_KEY', async () => {
    process.env.USE_CLAUDE_LEFT = 'true'
    const cfg = loadConfig()
    const ctx = await buildServer(cfg)
    expect(ctx.processor).toBeDefined()
    await ctx.server.close()
  })
})

describe('buildServer processor config (Wave-2 dual-brain defaults)', () => {
  it('passes defaultMode "dual" and defaultLeftRuntime "openclaw" when USE_CLAUDE_LEFT=false', async () => {
    process.env.LEFT_API_KEY = 'test-key'
    const cfg = loadConfig()
    const ctx = await buildServer(cfg)
    expect(processorCtorSpy).toHaveBeenCalledTimes(1)
    const processorConfig = processorCtorSpy.mock.calls[0][0] as Record<string, unknown>
    expect(processorConfig.defaultMode).toBe('dual')
    expect(processorConfig.defaultLeftRuntime).toBe('openclaw')
    await ctx.server.close()
  })

  it('passes defaultLeftRuntime "claude" when USE_CLAUDE_LEFT=true', async () => {
    process.env.USE_CLAUDE_LEFT = 'true'
    const cfg = loadConfig()
    const ctx = await buildServer(cfg)
    expect(processorCtorSpy).toHaveBeenCalledTimes(1)
    const processorConfig = processorCtorSpy.mock.calls[0][0] as Record<string, unknown>
    expect(processorConfig.defaultMode).toBe('dual')
    expect(processorConfig.defaultLeftRuntime).toBe('claude')
    await ctx.server.close()
  })
})
