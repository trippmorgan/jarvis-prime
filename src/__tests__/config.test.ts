import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../config.js'

/**
 * loadConfig() parses process.env through a Zod schema. Tests manipulate
 * process.env directly, then restore it after each test to avoid bleeding
 * into sibling tests.
 */
const KEYS = [
  'PORT',
  'CLAUDE_PATH',
  'CLAUDE_MODEL',
  'CLAUDE_TIMEOUT_MS',
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TRIPP_CHAT_ID',
  'WORKSPACE_DIR',
  'DELIVERY_QUEUE_DIR',
  'CORPUS_CALLOSUM_ENABLED',
  'OPENCLAW_CHAT_MODEL_RIGHT',
  'CORPUS_CALLOSUM_TIMEOUT_MS',
  'CORPUS_CLINICAL_OVERRIDE',
  'JARVIS_EVOLVING_MESSAGE_ENABLED',
  'RIGHT_BRAIN_AGENT_ENABLED',
  'RIGHT_BRAIN_AGENT_FALLBACK',
  'JARVIS_ROUTER_ENABLED',
] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const key of KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
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

describe('loadConfig defaults', () => {
  it('returns default values for non-gateway vars when env is empty (disabled dual-brain)', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.PORT).toBe(3100)
    expect(cfg.CLAUDE_MODEL).toBe('sonnet')
    expect(cfg.CLAUDE_TIMEOUT_MS).toBe(120_000)
    expect(cfg.OPENCLAW_GATEWAY_URL).toBe('http://127.0.0.1:18789')
    expect(cfg.WORKSPACE_DIR).toBe('/home/tripp/.openclaw/workspace')
  })

  it('defaults CORPUS_CALLOSUM_ENABLED to true when gateway creds are present', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    const cfg = loadConfig()
    expect(cfg.CORPUS_CALLOSUM_ENABLED).toBe(true)
  })

  it('defaults OPENCLAW_CHAT_MODEL_RIGHT to "gpt-5.4 codex"', () => {
    // Defaults rely on OPENCLAW_GATEWAY_* being present since ENABLED defaults to true.
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    const cfg = loadConfig()
    expect(cfg.OPENCLAW_CHAT_MODEL_RIGHT).toBe('gpt-5.4 codex')
  })

  it('defaults CORPUS_CALLOSUM_TIMEOUT_MS to 1200000', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    const cfg = loadConfig()
    expect(cfg.CORPUS_CALLOSUM_TIMEOUT_MS).toBe(1_200_000)
  })

  it('defaults JARVIS_WORKING_DIR to SuperServer path', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    const cfg = loadConfig()
    expect(cfg.JARVIS_WORKING_DIR).toBe('/home/tripp/.openclaw/workspace/jarvis-prime/')
  })

  it('reads JARVIS_WORKING_DIR from env when set (port portability)', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    process.env.JARVIS_WORKING_DIR = '/home/jarvisagent/.openclaw/workspace/jarvis-prime/'
    const cfg = loadConfig()
    expect(cfg.JARVIS_WORKING_DIR).toBe('/home/jarvisagent/.openclaw/workspace/jarvis-prime/')
  })

  it('defaults JARVIS_EVOLVING_MESSAGE_ENABLED to true (W6-T1)', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.JARVIS_EVOLVING_MESSAGE_ENABLED).toBe(true)
  })
})

describe('loadConfig JARVIS_EVOLVING_MESSAGE_ENABLED (W6-T1)', () => {
  it('parses "false" as false', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.JARVIS_EVOLVING_MESSAGE_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.JARVIS_EVOLVING_MESSAGE_ENABLED).toBe(false)
  })

  it('parses "true" as true', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.JARVIS_EVOLVING_MESSAGE_ENABLED = 'true'
    const cfg = loadConfig()
    expect(cfg.JARVIS_EVOLVING_MESSAGE_ENABLED).toBe(true)
  })
})

describe('loadConfig explicit overrides', () => {
  it('reads CORPUS_CALLOSUM_ENABLED=false from env', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.CORPUS_CALLOSUM_ENABLED).toBe(false)
  })

  it('reads OPENCLAW_CHAT_MODEL_RIGHT override from env', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.OPENCLAW_CHAT_MODEL_RIGHT = 'custom-model-x'
    const cfg = loadConfig()
    expect(cfg.OPENCLAW_CHAT_MODEL_RIGHT).toBe('custom-model-x')
  })

  it('reads CORPUS_CALLOSUM_TIMEOUT_MS override as a number', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.CORPUS_CALLOSUM_TIMEOUT_MS = '45000'
    const cfg = loadConfig()
    expect(cfg.CORPUS_CALLOSUM_TIMEOUT_MS).toBe(45_000)
    expect(typeof cfg.CORPUS_CALLOSUM_TIMEOUT_MS).toBe('number')
  })
})

describe('loadConfig boolean parsing', () => {
  it('parses "true" as true', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'true'
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    expect(loadConfig().CORPUS_CALLOSUM_ENABLED).toBe(true)
  })

  it('parses "false" as false', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    expect(loadConfig().CORPUS_CALLOSUM_ENABLED).toBe(false)
  })

  it('parses "1" as true', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = '1'
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    expect(loadConfig().CORPUS_CALLOSUM_ENABLED).toBe(true)
  })

  it('parses "0" as false', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = '0'
    expect(loadConfig().CORPUS_CALLOSUM_ENABLED).toBe(false)
  })
})

describe('loadConfig RIGHT_BRAIN_AGENT_ENABLED (W7-T2)', () => {
  it('defaults RIGHT_BRAIN_AGENT_ENABLED to false (ships dark)', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_ENABLED).toBe(false)
  })

  it('parses "true" as true', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.RIGHT_BRAIN_AGENT_ENABLED = 'true'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_ENABLED).toBe(true)
  })

  it('parses "false" as false when explicitly set', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.RIGHT_BRAIN_AGENT_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_ENABLED).toBe(false)
  })
})

describe('loadConfig RIGHT_BRAIN_AGENT_FALLBACK (W7-T2)', () => {
  it('defaults RIGHT_BRAIN_AGENT_FALLBACK to true (fallback active)', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_FALLBACK).toBe(true)
  })

  it('parses "false" to disable fallback', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.RIGHT_BRAIN_AGENT_FALLBACK = 'false'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_FALLBACK).toBe(false)
  })

  it('parses "true" as true when explicitly set', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.RIGHT_BRAIN_AGENT_FALLBACK = 'true'
    const cfg = loadConfig()
    expect(cfg.RIGHT_BRAIN_AGENT_FALLBACK).toBe(true)
  })
})

describe('loadConfig JARVIS_ROUTER_ENABLED (W8-T2)', () => {
  it('defaults JARVIS_ROUTER_ENABLED to false (ships dark)', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.JARVIS_ROUTER_ENABLED).toBe(false)
  })

  it('parses "true" as true', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.JARVIS_ROUTER_ENABLED = 'true'
    const cfg = loadConfig()
    expect(cfg.JARVIS_ROUTER_ENABLED).toBe(true)
  })

  it('parses "false" as false when explicitly set', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.JARVIS_ROUTER_ENABLED = 'false'
    const cfg = loadConfig()
    expect(cfg.JARVIS_ROUTER_ENABLED).toBe(false)
  })
})

describe('loadConfig conditional required for OPENCLAW gateway', () => {
  it('throws when CORPUS_CALLOSUM_ENABLED=true and OPENCLAW_GATEWAY_URL is empty', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'true'
    process.env.OPENCLAW_GATEWAY_URL = ''
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    expect(() => loadConfig()).toThrow()
  })

  it('throws when CORPUS_CALLOSUM_ENABLED=true and OPENCLAW_GATEWAY_TOKEN is empty', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'true'
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = ''
    expect(() => loadConfig()).toThrow()
  })

  it('throws when CORPUS_CALLOSUM_ENABLED=true and OPENCLAW_GATEWAY_TOKEN is absent (default empty)', () => {
    // No CORPUS_CALLOSUM_ENABLED set → default true. No token → default "" → should throw.
    expect(() => loadConfig()).toThrow()
  })

  it('passes when CORPUS_CALLOSUM_ENABLED=true and both gateway vars present', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'true'
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token'
    expect(() => loadConfig()).not.toThrow()
  })

  it('passes when CORPUS_CALLOSUM_ENABLED=false and gateway vars are absent', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    // No OPENCLAW_GATEWAY_URL, no OPENCLAW_GATEWAY_TOKEN
    expect(() => loadConfig()).not.toThrow()
  })

  it('passes when CORPUS_CALLOSUM_ENABLED=false and gateway vars are empty strings', () => {
    process.env.CORPUS_CALLOSUM_ENABLED = 'false'
    process.env.OPENCLAW_GATEWAY_URL = ''
    process.env.OPENCLAW_GATEWAY_TOKEN = ''
    expect(() => loadConfig()).not.toThrow()
  })
})
