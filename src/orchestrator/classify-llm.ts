// W18 — LLM fallback classifier.
//
// The keyword classifier in classify.ts handles ~80% of inbound Telegram
// messages with zero cost / zero latency. When it returns 'chat' (its
// safe default), this module asks Frank's local Ollama (port 11434,
// gemma4:e2b 2B model) to classify the message into chat | query |
// workflow | status.
//
// Why direct Ollama, not Frank's dual-brain at :30100?
//   - Frank's brain proxy ignores max_tokens — for technical questions
//     it routes to DEEP and writes 4000-token help essays instead of
//     one-word classifications. Direct Ollama respects num_predict.
//   - Local: no API key plumbing, no rate limits, no external dep.
//   - Free: Frank's GPUs are already running.
//   - Fast: gemma4:e2b ~60ms p50 once warm (9s cold-start one-time).
//   - Fallback-safe: if Frank is down we return the regex result.
//
// Cache: a small in-memory LRU keyed on the normalized text. Stops us
// from re-paying for "thanks!" / "hi" / repeated test inputs. Capped at
// CACHE_MAX entries; oldest evicted on insert.
//
// Observability: every LLM-classifier hit posts a kernel event so cost
// + accuracy can be audited from the shell.

import type { IntentClass } from './types.js'
import { classifyIntent } from './classify.js'

const VALID_CLASSES: ReadonlySet<IntentClass> = new Set([
  'chat',
  'query',
  'workflow',
  'status',
])

const DEFAULT_OLLAMA_URL = 'http://192.168.0.108:11434/api/chat'
const DEFAULT_MODEL = 'gemma4:e2b'
// 10s default: covers cold-start (~9s gemma4:e2b model load). Once
// warm, calls return in <100ms — the timeout is a safety net not a
// latency budget. server.ts preheats on boot via warmupClassifierLLM().
const DEFAULT_TIMEOUT_MS = 10_000
const CACHE_MAX = 100

// Treat anything shorter than this as "obvious chat" and skip the LLM
// call entirely. "thanks!" / "hi" / "ok" don't deserve a network round-trip.
const MIN_LLM_LEN = 4

// Slash commands are caller-routed; never burn a classification on them.
const SLASH_PREFIX = '/'

const SYSTEM_PROMPT = `Classify into exactly one lowercase word: chat, query, workflow, or status.
- chat: greeting, acknowledgement, conversational
- query: read-only information request (read X, show X, what is X, today/tomorrow cases, what is playing)
- workflow: imperative action on a system (restart, debug, fix, rerun, let us work on X, reindex)
- status: health/liveness check across nodes
Reply with one word only.`

const FEWSHOTS: Array<{ user: string; assistant: string }> = [
  { user: 'restart all nodes', assistant: 'workflow' },
  { user: 'todays cases', assistant: 'query' },
  { user: 'thanks', assistant: 'chat' },
]

interface ClassifyLLMConfig {
  /** Override Ollama URL. Default: http://192.168.0.108:11434/api/chat */
  url?: string
  model?: string
  /** Hard cap per call. Default 2_000ms. Falls back to regex result on timeout. */
  timeoutMs?: number
  /** Disable the LLM stage entirely — regex-only behavior. Default true. */
  enabled?: boolean
  /** Test-only fetch injection. Defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Optional kernel-event hook called after each LLM call (for telemetry). */
  onLLMCall?: (info: {
    text: string
    raw: string
    parsed: IntentClass
    durationMs: number
    ok: boolean
    fromCache: boolean
  }) => void
}

function readConfigFromEnv(): Required<Omit<ClassifyLLMConfig, 'fetchFn' | 'onLLMCall'>> {
  const enabled =
    (process.env.JARVIS_LLM_CLASSIFIER_ENABLED ?? 'true').toLowerCase() !== 'false'
  return {
    url: process.env.JARVIS_LLM_CLASSIFIER_URL ?? DEFAULT_OLLAMA_URL,
    model: process.env.JARVIS_LLM_CLASSIFIER_MODEL ?? DEFAULT_MODEL,
    timeoutMs: Number(process.env.JARVIS_LLM_CLASSIFIER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    enabled,
  }
}

// ─── LRU cache ──────────────────────────────────────────────────────────

const cache = new Map<string, IntentClass>()

function cacheGet(key: string): IntentClass | undefined {
  const v = cache.get(key)
  if (v === undefined) return undefined
  // Touch — re-insert to mark recently used.
  cache.delete(key)
  cache.set(key, v)
  return v
}

function cacheSet(key: string, value: IntentClass): void {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value)
}

export function _resetClassifyLLMCacheForTests(): void {
  cache.clear()
}

/**
 * Fire a no-op classification at boot so the gemma4:e2b model gets
 * loaded into GPU memory before the first real Telegram turn arrives.
 * Without this, the first Telegram message after a Prime restart pays
 * the 9s cold-load. Fire-and-forget; failures are logged-and-ignored.
 */
export async function warmupClassifierLLM(): Promise<void> {
  try {
    await classifyIntentWithLLM('thanks')
  } catch {
    // best-effort; the first real call will retry.
  }
}

// ─── core ───────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function parseClassifierOutput(raw: string): IntentClass | null {
  // Tolerant: strip punctuation/quotes, take first word, lowercase.
  const word = raw
    .replace(/[`*_"'.,!?]/g, '')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
  if (!word) return null
  if (VALID_CLASSES.has(word as IntentClass)) return word as IntentClass
  return null
}

async function fetchOllamaClassification(
  text: string,
  cfg: Required<Omit<ClassifyLLMConfig, 'fetchFn' | 'onLLMCall'>>,
  fetchFn: typeof fetch,
): Promise<{ raw: string; parsed: IntentClass | null }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ]
  for (const f of FEWSHOTS) {
    messages.push({ role: 'user', content: f.user })
    messages.push({ role: 'assistant', content: f.assistant })
  }
  messages.push({ role: 'user', content: text })

  const body = {
    model: cfg.model,
    stream: false,
    // keep_alive=-1 pins the model in GPU memory indefinitely so
    // subsequent classifications don't pay the cold-load cost again.
    options: { num_predict: 8, temperature: 0, keep_alive: -1 },
    messages,
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  try {
    const resp = await fetchFn(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!resp.ok) return { raw: `HTTP ${resp.status}`, parsed: null }
    // Ollama and OpenAI-compatible shapes both supported:
    //  Ollama: { message: { content } }
    //  OpenAI:  { choices: [{ message: { content } }] }
    const data = (await resp.json()) as {
      message?: { content?: string }
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw =
      data.message?.content ?? data.choices?.[0]?.message?.content ?? ''
    return { raw, parsed: parseClassifierOutput(raw) }
  } catch (err) {
    return { raw: err instanceof Error ? err.message : String(err), parsed: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Two-stage classification.
 *
 *  1. Regex first (sync, free, zero latency). If it returns anything
 *     other than 'chat', that's a confident match — return immediately.
 *  2. LLM second only when regex returned 'chat'. The LLM gets a small
 *     few-shot prompt + caches by normalized text. Falls back to
 *     'chat' on any error / parse failure / timeout.
 *
 *  Config from env (overridable per-call for tests):
 *    JARVIS_LLM_CLASSIFIER_ENABLED  default true
 *    JARVIS_LLM_CLASSIFIER_URL      default Frank brain
 *    JARVIS_LLM_CLASSIFIER_MODEL    default "frank"
 *    JARVIS_LLM_CLASSIFIER_TIMEOUT_MS  default 2000
 */
export async function classifyIntentWithLLM(
  text: string,
  config: ClassifyLLMConfig = {},
): Promise<IntentClass> {
  if (!text || typeof text !== 'string') return 'chat'
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'chat'
  if (trimmed.startsWith(SLASH_PREFIX)) return 'chat'

  // Regex first.
  const regexClass = classifyIntent(trimmed)
  if (regexClass !== 'chat') return regexClass

  // Tiny messages: not worth the round-trip.
  if (trimmed.length < MIN_LLM_LEN) return 'chat'

  // Merge env defaults with caller overrides, but skip undefined values
  // so callers that pass {enabled: undefined} don't clobber the env default.
  const envCfg = readConfigFromEnv()
  const cfg = {
    url: config.url ?? envCfg.url,
    model: config.model ?? envCfg.model,
    timeoutMs: config.timeoutMs ?? envCfg.timeoutMs,
    enabled: config.enabled ?? envCfg.enabled,
  }

  if (!cfg.enabled) return 'chat'

  const key = normalize(trimmed)
  const cached = cacheGet(key)
  if (cached !== undefined) {
    config.onLLMCall?.({
      text: trimmed,
      raw: '(cached)',
      parsed: cached,
      durationMs: 0,
      ok: true,
      fromCache: true,
    })
    return cached
  }

  const fetchFn = config.fetchFn ?? fetch
  const start = Date.now()
  const result = await fetchOllamaClassification(trimmed, cfg, fetchFn)
  const durationMs = Date.now() - start
  const parsed: IntentClass = result.parsed ?? 'chat'

  // Only cache valid responses — if the LLM was unreachable we want to
  // retry next time.
  if (result.parsed !== null) cacheSet(key, parsed)

  config.onLLMCall?.({
    text: trimmed,
    raw: result.raw,
    parsed,
    durationMs,
    ok: result.parsed !== null,
    fromCache: false,
  })

  return parsed
}
