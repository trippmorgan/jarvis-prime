// W21.7 — intent oversight.
//
// The orchestrator classifies terse messages WITHOUT conversation
// context, so "Update" ran the GSD self-updater, "Publish" hit an empty
// pipeline, "list orchestration skills" dumped GSD commands. Tripp's
// directive: an auto-reply may go out fast, but it must then be
// re-read against the actual context and corrected if it missed.
//
// This module is the re-read. It is deliberately CONSERVATIVE: it
// defaults to "ok" on any doubt, timeout, parse failure, or model
// hiccup. A wrong "you missed it" correction is worse than a missed
// one (it would spam/contradict), so the bar to emit a correction is
// high. Runs AFTER the fast reply is delivered (fire-and-forget), so
// its latency never delays the user.
//
// Scope (enforced by the caller): only auto/deterministic replies —
// regex/LLM-classified workflows, the skills & recap intercepts, gate
// prompts. The conversational brain's own replies already had context
// and are NOT reviewed.

export interface OversightTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface OversightInput {
  userText: string
  autoReply: string
  klass: string
  recentTurns: OversightTurn[]
}

export interface OversightVerdict {
  ok: boolean
  correction?: string
}

interface OversightConfig {
  url?: string
  model?: string
  timeoutMs?: number
  enabled?: boolean
  fetchFn?: typeof fetch
}

const DEFAULT_URL = 'http://192.168.0.108:11434/api/chat'
const DEFAULT_MODEL = 'gemma4:e4b'
const DEFAULT_TIMEOUT_MS = 8_000

// W21.6-style breaker: if the judge is unreachable/slow, stop trying
// for a cooldown rather than lagging every turn's follow-up.
const BREAKER_TRIP = 2
const BREAKER_COOLDOWN_MS = 120_000
let _fails = 0
let _breakerUntil = 0

export function _resetOversightBreakerForTests(): void {
  _fails = 0
  _breakerUntil = 0
}

function readEnv(): Required<Omit<OversightConfig, 'fetchFn'>> {
  return {
    url: process.env.JARVIS_INTENT_OVERSIGHT_URL ?? DEFAULT_URL,
    model: process.env.JARVIS_INTENT_OVERSIGHT_MODEL ?? DEFAULT_MODEL,
    timeoutMs: Number(process.env.JARVIS_INTENT_OVERSIGHT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    enabled: (process.env.JARVIS_INTENT_OVERSIGHT_ENABLED ?? 'true').toLowerCase() !== 'false',
  }
}

const SYSTEM_PROMPT = `You audit an automated assistant's reply for INTENT match, using the recent conversation.
The assistant classifies terse messages without context, so it sometimes answers the wrong frame
(e.g. user says "Update" meaning "status update" but it ran a software updater; "Publish" meaning
"confirm the thing we were just doing" but it said "nothing is queued").

Decide: did the assistant's reply plausibly address what the user actually wanted IN CONTEXT?

Output rules — follow EXACTLY:
- If it plausibly addressed the intent, OR you are unsure, output exactly: OK
- Only if it clearly answered the WRONG thing, output: FIX: <one or two sentences telling the user
  what you think they actually meant and asking them to confirm or restate>
Default to OK. Do not nitpick tone or completeness. One line only.`

// --- Jarvis conscience (jarvis-ledger Phase D) -----------------------------
// The Φ-selected, chain-attested working set of the network's most
// integrated memories — Tripp's standing corrections and active-project
// truths. The oversight judge reads replies against it: contradicting a
// standing principle counts as answering the wrong thing. Loaded from the
// consolidation engine's snapshot file; absent/unreadable → judge runs
// exactly as before (never throws, never blocks).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let conscienceCache: { block: string; readAt: number } = { block: '', readAt: 0 }

function conscienceBlock(): string {
  if (Date.now() - conscienceCache.readAt < 60_000) return conscienceCache.block
  let block = ''
  try {
    const cfgDir = process.env.PHI_LEDGER_DIR ?? join(homedir(), '.config', 'phi-ledger')
    const snapshot = JSON.parse(
      readFileSync(join(cfgDir, 'conscience', 'current.json'), 'utf8'),
    ) as { schemaVersion?: number; items?: Array<{ slug?: string; description?: string }> }
    const items = Array.isArray(snapshot.items) ? snapshot.items.slice(0, 8) : []
    if (snapshot.schemaVersion === 1 && items.length > 0) {
      const lines = items
        .filter((i) => i.slug && i.description)
        .map((i) => `- ${i.slug}: ${String(i.description).replace(/\s+/g, ' ').slice(0, 140)}`)
      block = [
        '',
        'STANDING PRINCIPLES (Jarvis conscience — chain-attested working memory):',
        ...lines,
        'If the auto-reply CONTRADICTS one of these principles, that also counts as answering',
        'the wrong thing → FIX. Principles inform the verdict; when unsure, still output OK.',
      ].join('\n')
    }
  } catch {
    /* no conscience file → unchanged behavior */
  }
  conscienceCache = { block, readAt: Date.now() }
  return block
}

function buildSystemPrompt(): string {
  return SYSTEM_PROMPT + conscienceBlock()
}

function buildUserBlock(i: OversightInput): string {
  const ctx = i.recentTurns
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.content.replace(/\s+/g, ' ').slice(0, 280)}`)
    .join('\n')
  return [
    'RECENT CONTEXT:',
    ctx || '(none)',
    '',
    `LATEST USER MESSAGE: ${i.userText.slice(0, 400)}`,
    `ASSISTANT AUTO-REPLY (class=${i.klass}): ${i.autoReply.replace(/\s+/g, ' ').slice(0, 600)}`,
    '',
    'Verdict (OK or FIX: ...):',
  ].join('\n')
}

function parseVerdict(raw: string): OversightVerdict {
  const text = raw.trim()
  // Conservative: anything that isn't an explicit, non-empty FIX is OK.
  const m = text.match(/^\s*FIX:\s*(.+)/is)
  if (!m) return { ok: true }
  const correction = m[1].replace(/\s+/g, ' ').trim()
  if (correction.length < 4) return { ok: true }
  return { ok: false, correction: correction.slice(0, 500) }
}

/**
 * Re-read an auto-reply against context. Returns {ok:true} unless the
 * judge is confident the reply missed the user's intent. Never throws;
 * any failure → {ok:true} (no correction, no spam).
 */
export async function reviewOrchestratorReply(
  input: OversightInput,
  config: OversightConfig = {},
): Promise<OversightVerdict> {
  const env = readEnv()
  const cfg = {
    url: config.url ?? env.url,
    model: config.model ?? env.model,
    timeoutMs: config.timeoutMs ?? env.timeoutMs,
    enabled: config.enabled ?? env.enabled,
  }
  if (!cfg.enabled) return { ok: true }
  if (!input.userText || !input.autoReply) return { ok: true }
  if (Date.now() < _breakerUntil) return { ok: true }

  const fetchFn = config.fetchFn ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  try {
    const resp = await fetchFn(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        options: { num_predict: 120, temperature: 0, keep_alive: -1 },
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserBlock(input) },
        ],
      }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      _recordFail()
      return { ok: true }
    }
    const data = (await resp.json()) as {
      message?: { content?: string }
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.message?.content ?? data.choices?.[0]?.message?.content ?? ''
    if (!raw.trim()) {
      _recordFail()
      return { ok: true }
    }
    _fails = 0
    _breakerUntil = 0
    return parseVerdict(raw)
  } catch {
    _recordFail()
    return { ok: true }
  } finally {
    clearTimeout(timer)
  }
}

function _recordFail(): void {
  _fails += 1
  if (_fails >= BREAKER_TRIP) {
    _breakerUntil = Date.now() + BREAKER_COOLDOWN_MS
    _fails = 0
  }
}
