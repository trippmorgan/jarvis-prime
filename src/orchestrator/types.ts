// W17 — Orchestrator type contracts.
//
// Prime is the user of jarvis-os. Tripp talks to Prime in Telegram;
// Prime decides which lieutenants to employ, dispatches commands via
// the W16 envelope bus, monitors results, reports back.
//
// All of these types are consumed by:
//   classify.ts (IntentClass)
//   plan.ts     (Plan, PlanStep)
//   execute.ts  (ExecEvent, OrchestrationResult)
//   index.ts    (orchestrate entrypoint)

export type IntentClass = 'chat' | 'query' | 'workflow' | 'status'

export type CommandTarget =
  | 'prime'
  | 'frank'
  | 'scalpel'
  | 'argus'
  | 'dj-jarvis'
  | 'openclaw'
  | string // raw agent_id is also valid

export interface PlanStep {
  target: CommandTarget
  command_type: string
  args: Record<string, unknown>
  /** Optional human description shown in activity timeline + Telegram. */
  description?: string
}

export interface Plan {
  class: IntentClass
  steps: PlanStep[]
  /** Human-readable headline; rendered first in the Telegram reply. */
  summary: string
}

export type ExecEventKind =
  | 'plan_formed'
  | 'step_dispatched'
  | 'step_complete'
  | 'step_failed'
  | 'awaiting_confirm'
  | 'orchestration_done'

export interface ExecEvent {
  kind: ExecEventKind
  step?: PlanStep
  step_number?: number
  total_steps?: number
  envelope_id?: string
  required_phrase?: string
  result?: unknown
  reason?: string
}

export interface OrchestrationResult {
  class: IntentClass
  session_id?: string
  events: ExecEvent[]
  final_reply: string
  completed: boolean
}

export interface TelegramMessage {
  text: string
  chat_id: string
  from?: string
  thread_id?: string
}

// ─── AVSO v2 — Wave 1 / T1: command schema + redaction contract ──────────
//
// The four v2 command kinds. The raw spoken patient string and the
// dictated write text are INBOUND PHI on the accepted Telegram/Scalpel
// path. They must NEVER reach the Anthropic session, logs, memory,
// commits, or a kernel envelope beyond a redacted placeholder. The
// command context that gets constructed here therefore carries ONLY:
//   kind, optional field_id, risk_tier, correlation_id, and a redacted
//   placeholder (<PATIENT_QUERY> / <WRITE_TEXT>).
//
// This module is the single source of truth for the placeholder strings,
// the kind set, the risk tiers, and the correlation-id scheme. T2's
// pending-write ledger and a later wave's classify/plan routing reuse
// these — keep them simple and stable.

export const AVSO_V2_PLACEHOLDER = {
  PATIENT_QUERY: '<PATIENT_QUERY>',
  WRITE_TEXT: '<WRITE_TEXT>',
} as const

export type AvsoV2Kind =
  | 'athena-patient-search'
  | 'athena-input-prepare'
  | 'athena-input-commit'
  | 'athena-schedule-date-probe'

export const AVSO_V2_KINDS: readonly AvsoV2Kind[] = [
  'athena-patient-search',
  'athena-input-prepare',
  'athena-input-commit',
  'athena-schedule-date-probe',
] as const

// Risk tiers (mirror of commands.py COMMAND_TIER + execute.ts):
//   schedule-date-probe : 0  read-only UI probe
//   patient-search      : 1  blind typist into a PHI driver, no confirm
//   input-prepare       : 1  stages a pending write, no mutation
//   input-commit        : 3  the actual write — typed confirm gate
const AVSO_V2_TIER: Record<AvsoV2Kind, number> = {
  'athena-schedule-date-probe': 0,
  'athena-patient-search': 1,
  'athena-input-prepare': 1,
  'athena-input-commit': 3,
}

export function avsoV2Tier(kind: AvsoV2Kind): number {
  return AVSO_V2_TIER[kind]
}

function isAvsoV2Kind(k: string): k is AvsoV2Kind {
  return (AVSO_V2_KINDS as readonly string[]).includes(k)
}

// Short per-kind abbreviation for the correlation id (so a glance at a
// log line tells you what the (PHI-free) id belongs to).
const AVSO_V2_ABBREV: Record<AvsoV2Kind, string> = {
  'athena-patient-search': 'ps',
  'athena-input-prepare': 'ip',
  'athena-input-commit': 'ic',
  'athena-schedule-date-probe': 'sp',
}

/**
 * Correlation-id scheme: `avso-<kindAbbrev>-<time36>-<rand6>`.
 *
 * - Pure: clock + rng are injectable for deterministic tests; default to
 *   real ones. Carries NO PHI by construction (kind abbrev + time + rng
 *   only). Lowercase, hyphen-separated, URL-safe.
 * - The commit step re-uses the prepare step's id so T2's ledger can
 *   link an affirmative back to the staged write.
 */
export function newCorrelationId(
  kind: AvsoV2Kind,
  now: () => number = Date.now,
  rng: () => number = Math.random,
): string {
  const abbrev = AVSO_V2_ABBREV[kind] ?? 'xx'
  const t = Math.floor(now()).toString(36)
  const r = Math.floor(rng() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')
    .slice(0, 6)
  return `avso-${abbrev}-${t}-${r}`
}

/** The redacted command context shipped in a v2 PlanStep's args. */
export interface AvsoV2Context {
  kind: AvsoV2Kind
  risk_tier: number
  correlation_id: string
  field_id?: string
  /** Always the literal <PATIENT_QUERY> placeholder, never raw text. */
  patient_query?: string
  /** Always the literal <WRITE_TEXT> placeholder, never raw text. */
  write_text?: string
  /** Non-PHI date token for the schedule probe (e.g. YYYY-MM-DD). */
  date?: string
}

export interface BuildAvsoV2ContextInput {
  kind: AvsoV2Kind
  /** Raw patient query — CONSUMED here, replaced by a placeholder. */
  rawPatientQuery?: string
  /** Raw dictated write text — CONSUMED here, replaced by a placeholder. */
  rawWriteText?: string
  fieldId?: string
  date?: string
  /** commit re-uses the prepare's id; otherwise a fresh id is minted. */
  correlationId?: string
}

/**
 * Deterministic, local, no-LLM, no-network redaction + envelope-shape
 * helper. Given raw (PHI) inputs, returns a context that contains ONLY
 * the whitelisted keys with the raw text replaced by a fixed placeholder.
 * The raw text is never copied into the returned object — it is dropped
 * on the floor here; the trusted Telegram/Scalpel-side path resolves the
 * real value out of band by correlation id.
 */
export function buildAvsoV2Context(input: BuildAvsoV2ContextInput): AvsoV2Context {
  if (!isAvsoV2Kind(input.kind)) {
    throw new Error(`buildAvsoV2Context: unknown v2 kind ${input.kind}`)
  }
  const ctx: AvsoV2Context = {
    kind: input.kind,
    risk_tier: avsoV2Tier(input.kind),
    correlation_id: input.correlationId ?? newCorrelationId(input.kind),
  }
  if (input.fieldId) ctx.field_id = input.fieldId
  if (input.date) ctx.date = input.date

  // Redaction: the kind decides which placeholder appears. We NEVER read
  // the raw text into the context — presence of the raw arg only flips a
  // placeholder on. This is what makes the synthetic token provably
  // absent from the constructed envelope.
  if (input.kind === 'athena-patient-search') {
    if (input.rawPatientQuery !== undefined) {
      ctx.patient_query = AVSO_V2_PLACEHOLDER.PATIENT_QUERY
    }
  } else if (input.kind === 'athena-input-prepare' || input.kind === 'athena-input-commit') {
    if (input.rawWriteText !== undefined) {
      ctx.write_text = AVSO_V2_PLACEHOLDER.WRITE_TEXT
    }
  }
  // schedule-date-probe carries no patient/write text at all.
  return ctx
}
