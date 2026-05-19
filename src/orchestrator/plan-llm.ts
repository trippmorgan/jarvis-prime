// W19c — LLM-driven plan generation.
//
// When the keyword classifier (or LLM classifier) decides a message is
// `workflow|query|status` but the hard-coded PatternToPlan templates
// in plan.ts don't match, we ask Frank's local Ollama gemma4:e2b to
// pick ONE structured command from the catalog below. The result is
// validated against the known target+command_type set; hallucinations
// are rejected and the message degrades to the existing "no concrete
// plan" reply.
//
// The catalog deliberately mirrors COMMAND_TIER in
// scripts/room-listener/commands.py — keep them in sync when new
// commands ship.

import type { IntentClass, Plan, PlanStep } from './types.js'

const VALID_TARGETS: ReadonlySet<string> = new Set([
  'prime',
  'frank',
  'scalpel',
  'argus',
  'dj-jarvis',
])

interface CommandSpec {
  command_type: string
  targets: string[] // empty = any node
  description: string
  argsHint: string
}

const COMMAND_CATALOG: CommandSpec[] = [
  { command_type: 'health-check',     targets: [], description: 'Basic uptime + load probe', argsHint: '{}' },
  { command_type: 'fetch-logs',       targets: [], description: 'Tail N lines from a log file path', argsHint: '{"path":"/var/log/x.log","lines":50}' },
  { command_type: 'inspect-mcp',      targets: ['prime'], description: 'List registered MCP servers on Prime', argsHint: '{}' },
  { command_type: 'chrome-cdp-status', targets: ['prime'], description: 'Probe chrome-cdp debug port', argsHint: '{}' },
  { command_type: 'list-experiments', targets: ['frank'], description: 'List Frank workspace experiments', argsHint: '{"limit":20}' },
  { command_type: 'read-experiment',  targets: ['frank'], description: 'Read a specific Frank experiment by name', argsHint: '{"name":"<experiment-id>"}' },
  { command_type: 'rerun-experiment', targets: ['frank'], description: "Rerun an experiment's question through Frank's brain", argsHint: '{"name":"<experiment-id>"}' },
  { command_type: 'station-query',    targets: ['dj-jarvis'], description: 'WPFQ radio query (now-playing/station-check/dpl-coverage/play-history/upcoming/station-logs)', argsHint: '{"query":"now-playing"}' },
  { command_type: 'social-draft',     targets: ['prime'], description: 'Read PretoriaFields README/playbook/social strategy and draft a WPFQ X/Twitter post without publishing', argsHint: '{"platform":"x","topic":"now-playing","dry_run":true,"workspace":"/home/tripp/.openclaw/workspace/PretoriaFields"}' },
  { command_type: 'social-post',      targets: ['prime'], description: 'Prepare or publish a WPFQ social post after reading PretoriaFields README/playbook/social strategy; X/Twitter publishing requires confirmation', argsHint: '{"platform":"x","topic":"now-playing","dry_run":true,"workspace":"/home/tripp/.openclaw/workspace/PretoriaFields"}' },
  { command_type: 'patient-schedule', targets: ['scalpel'], description: 'Today\'s OR schedule, redacted', argsHint: '{"date":"today"}' },
  { command_type: 'ollama-operation', targets: ['frank'], description: 'list/unload/load an Ollama model on Frank', argsHint: '{"op":"list"}' },
]

function commandIsValid(target: string, commandType: string): boolean {
  if (!VALID_TARGETS.has(target)) return false
  const spec = COMMAND_CATALOG.find((c) => c.command_type === commandType)
  if (!spec) return false
  if (spec.targets.length > 0 && !spec.targets.includes(target)) return false
  return true
}

function catalogPrompt(): string {
  const lines = ['Available commands (command_type → eligible targets → description):']
  for (const c of COMMAND_CATALOG) {
    const t = c.targets.length === 0 ? 'any' : c.targets.join('|')
    lines.push(`  - ${c.command_type} (${t}): ${c.description}. args=${c.argsHint}`)
  }
  return lines.join('\n')
}

const SYSTEM_PROMPT = `You are a command planner for Jarvis Prime, an orchestrator over five lieutenant nodes: prime, frank, scalpel, argus, dj-jarvis.

Given a user message, return exactly ONE JSON object with this shape:
{"target":"<node>","command_type":"<cmd>","args":{...},"summary":"<one-line>"}

Rules:
- target must be one of: prime, frank, scalpel, argus, dj-jarvis
- command_type must be from the catalog below
- args is an object (often {}); follow the catalog hint when possible
- summary is a short sentence describing what will happen
- If no command in the catalog applies cleanly, return {"target":"none","command_type":"none","args":{},"summary":"no match"}

${catalogPrompt()}

Reply with JSON only — no prose, no markdown fences.`

interface LLMPlanConfig {
  url?: string
  model?: string
  timeoutMs?: number
  enabled?: boolean
  fetchFn?: typeof fetch
  onLLMCall?: (info: {
    text: string
    raw: string
    parsedTarget: string | null
    parsedCommand: string | null
    durationMs: number
    ok: boolean
    fromCache: boolean
  }) => void
}

function readConfigFromEnv(): Required<Omit<LLMPlanConfig, 'fetchFn' | 'onLLMCall'>> {
  return {
    // gemma4:e4b (4B) — the 2B variant can classify but can't emit
    // structured JSON reliably. e4b adds ~3s vs e2b but writes valid
    // {target, command_type, args} >95% of the time.
    url: process.env.JARVIS_LLM_PLANNER_URL ?? 'http://192.168.0.108:11434/api/chat',
    model: process.env.JARVIS_LLM_PLANNER_MODEL ?? 'gemma4:e4b',
    timeoutMs: Number(process.env.JARVIS_LLM_PLANNER_TIMEOUT_MS ?? 15_000),
    enabled: (process.env.JARVIS_LLM_PLANNER_ENABLED ?? 'true').toLowerCase() !== 'false',
  }
}

// ─── LRU cache ──────────────────────────────────────────────────────────

const CACHE_MAX = 50
const cache = new Map<string, Plan | null>()

function cacheGet(key: string): Plan | null | undefined {
  const v = cache.get(key)
  if (v === undefined) return undefined
  cache.delete(key)
  cache.set(key, v)
  return v
}

function cacheSet(key: string, value: Plan | null): void {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value)
}

export function _resetLLMPlanCacheForTests(): void {
  cache.clear()
}

/**
 * Preload gemma4:e4b into GPU memory at boot so the first
 * dynamically-planned Telegram turn doesn't pay the 9s cold-load.
 * Fire-and-forget.
 */
export async function warmupPlannerLLM(): Promise<void> {
  try {
    await buildPlanWithLLM('warmup', 'workflow')
    cache.clear() // don't keep the warmup result in cache
  } catch {
    // best-effort; first real call will retry.
  }
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

interface ParsedPlan {
  target: string
  command_type: string
  args: Record<string, unknown>
  summary: string
}

function parsePlanResponse(raw: string): ParsedPlan | null {
  // Try to find a JSON object inside the response — gemma4 sometimes
  // wraps in markdown fences or adds a leading word despite format:json.
  let candidate = raw.trim()
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]+?)\s*```/)
  if (fenceMatch) candidate = fenceMatch[1].trim()
  const braceStart = candidate.indexOf('{')
  const braceEnd = candidate.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidate = candidate.slice(braceStart, braceEnd + 1)
  }
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>
    const target = typeof obj.target === 'string' ? obj.target.toLowerCase() : ''
    const command_type = typeof obj.command_type === 'string' ? obj.command_type : ''
    const args = (typeof obj.args === 'object' && obj.args !== null
      ? (obj.args as Record<string, unknown>)
      : {})
    const summary = typeof obj.summary === 'string' ? obj.summary : ''
    if (!target || !command_type) return null
    return { target, command_type, args, summary }
  } catch {
    return null
  }
}

async function fetchOllamaPlan(
  text: string,
  klass: IntentClass,
  cfg: Required<Omit<LLMPlanConfig, 'fetchFn' | 'onLLMCall'>>,
  fetchFn: typeof fetch,
): Promise<{ raw: string; parsed: ParsedPlan | null }> {
  const body = {
    model: cfg.model,
    stream: false,
    // NOTE: deliberately NOT using Ollama's format='json' — empirically
    // gemma4 returns empty content when format='json' + long system
    // prompt are combined. Plain prompting + tolerant parser works.
    options: { num_predict: 200, temperature: 0, keep_alive: -1 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `[class=${klass}] ${text}` },
    ],
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
    const data = (await resp.json()) as {
      message?: { content?: string }
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw =
      data.message?.content ?? data.choices?.[0]?.message?.content ?? ''
    return { raw, parsed: parsePlanResponse(raw) }
  } catch (err) {
    return { raw: err instanceof Error ? err.message : String(err), parsed: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build a plan via LLM when buildPlan() in plan.ts returned 0 steps.
 *
 * Behaviour:
 *   - chat class: never fires (chat never reaches the planner)
 *   - LLM hallucinates target or command: returns null Plan
 *   - LLM call fails: returns null Plan
 *   - LLM returns "none/none": returns null Plan (caller falls through)
 *
 *  Returns:
 *    - Plan with one step when the LLM picked a valid {target, command}
 *    - null when nothing usable could be produced
 */
export async function buildPlanWithLLM(
  text: string,
  klass: IntentClass,
  config: LLMPlanConfig = {},
): Promise<Plan | null> {
  if (klass === 'chat') return null
  if (klass === 'status') return null // status uses fan-out, not LLM
  if (!text || !text.trim()) return null

  const envCfg = readConfigFromEnv()
  const cfg = {
    url: config.url ?? envCfg.url,
    model: config.model ?? envCfg.model,
    timeoutMs: config.timeoutMs ?? envCfg.timeoutMs,
    enabled: config.enabled ?? envCfg.enabled,
  }
  if (!cfg.enabled) return null

  const key = `${klass}::${normalize(text)}`
  const cached = cacheGet(key)
  if (cached !== undefined) {
    config.onLLMCall?.({
      text,
      raw: '(cached)',
      parsedTarget: cached?.steps[0]?.target ?? null,
      parsedCommand: cached?.steps[0]?.command_type ?? null,
      durationMs: 0,
      ok: cached !== null,
      fromCache: true,
    })
    return cached
  }

  const fetchFn = config.fetchFn ?? fetch
  const start = Date.now()
  const result = await fetchOllamaPlan(text, klass, cfg, fetchFn)
  const durationMs = Date.now() - start

  let plan: Plan | null = null
  if (result.parsed && commandIsValid(result.parsed.target, result.parsed.command_type)) {
    const step: PlanStep = {
      target: result.parsed.target,
      command_type: result.parsed.command_type,
      args: result.parsed.args,
      description: result.parsed.summary || `LLM-generated ${result.parsed.command_type}`,
    }
    plan = {
      class: klass,
      summary:
        result.parsed.summary ||
        `Running ${result.parsed.command_type} on ${result.parsed.target}.`,
      steps: [step],
    }
  }

  // Cache regardless — repeated unmatched messages shouldn't hammer the LLM.
  cacheSet(key, plan)

  config.onLLMCall?.({
    text,
    raw: result.raw,
    parsedTarget: result.parsed?.target ?? null,
    parsedCommand: result.parsed?.command_type ?? null,
    durationMs,
    ok: plan !== null,
    fromCache: false,
  })

  return plan
}
