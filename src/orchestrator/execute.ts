// W17 T10 — Plan executor.
//
// Runs each PlanStep against the W16 command layer:
//   1. POST /envelopes/emit { kind:'command', to_agent_id, deadline,
//      tier_action (looked up via COMMAND_TIER map mirror) }
//   2. Poll /envelopes?parent_envelope_id=<id> until a result arrives or
//      the local timeout fires.
//   3. Yield ExecEvent objects (plan_formed → step_dispatched →
//      step_complete | step_failed | awaiting_confirm → orchestration_done).
//
// The caller (Telegram handler) consumes these events to stream
// progress back to Tripp's thread.

import type { ExecEvent, Plan, PlanStep } from './types.js'
import { AVSO_V2_KINDS } from './types.js'

// ─── Φ-PHI-Flow T6 / Insertion B1 — Prime-side pre-dispatch verify ───────
//
// Backbone: phi-flow/.planning/PLAN.md (T6) + research/03 §2 (Insertion
// B1). This is an ADDITIVE guard mirroring the existing early-return
// idioms (the `!emit` branch here, `_avso_v2_scalpel_guard` /
// `no-confirm-token` on the Scalpel side). It changes nothing for
// non-PHI kinds.
//
// For the PHI-bearing kind set ONLY — the four AVSO v2 kinds plus
// 'athena-nav' and 'patient-schedule' — emitCommand() consults the T5
// broker (verifyDeviceRequest) immediately BEFORE the kernel emit:
//   • deny / missing-envelope → DO NOT emit; the executor reuses the
//     EXISTING step_failed path with reason:'phi-gate-deny:<code>'
//     (fail-closed by reuse → summarizeOrchFailures already turns that
//     into an honest, non-PHI message + the W21.15 fallback engages).
//   • allow → emit exactly as today.
//
// Wave 3a / G1b — the broker is a LOCALHOST SERVICE on SuperServer
// (Tripp's decision). The default broker is now a localhost HTTP client
// to the G1a server (sibling, concurrent) at 127.0.0.1:${PHI_GATE_PORT}.
// T6's guard/emit/tier/poll logic is UNCHANGED — only the absent-module
// lazy stub is replaced with a real default client. Any unreachable /
// non-200 / timeout / malformed broker response FAILS CLOSED (deny), so
// a PHI request can never emit unverified — even if G1a is not yet up.
// Tests inject a MOCK matching the FROZEN surface via
// __setPhiGateBrokerForTest, or exercise this real client against a
// throwaway localhost server.

/** The FROZEN T5 broker surface. The device-signed envelope is opaque to
 *  B1 (no PHI by T3 schema construction); we only branch on `decision`.
 *  `attestation` rides through for B2 (Scalpel-side re-verify) — a
 *  non-PHI signed claim, like corrId; threaded as an OPTIONAL field so
 *  injected mocks built to the pre-G1b shape still satisfy the type. */
type PhiGateBroker = (
  env: unknown,
  deps?: unknown,
) =>
  | { decision: 'allow' | 'deny'; code: string; resourceHash: string; corrId: string; attestation?: string }
  | Promise<{ decision: 'allow' | 'deny'; code: string; resourceHash: string; corrId: string; attestation?: string }>

/** The PHI-bearing command kinds B1 gates. AVSO non-PHI kinds and every
 *  other command type are intentionally absent → broker never consulted. */
const PHI_BEARING_KINDS: ReadonlySet<string> = new Set<string>([
  ...AVSO_V2_KINDS,
  'athena-nav',
  'patient-schedule',
])

function isPhiBearingKind(commandType: string): boolean {
  return PHI_BEARING_KINDS.has(commandType)
}

/** Is B1 enforcement ACTIVE on this box? Rollout contract — the exact
 *  mirror of the Scalpel-side T7 `_phi_gate_enforced` (see
 *  jarvis-os/scripts/room-listener/commands.py), same env var name,
 *  same disarmed-default semantics.
 *
 *  B1 (this Prime-side guard) is the component that begins REQUIRING a
 *  signed device envelope on every PHI-bearing command. Until Φ-PHI-Flow
 *  is deployed and enrollment is live, no legitimate request carries a
 *  device envelope — AVSO v2 (already on Scalpel) is driven via Telegram
 *  WITHOUT one — so blanket-denying here would be a false AVSO
 *  regression. B1 therefore enforces only when its operator explicitly
 *  arms it via `PHI_GATE_ENFORCE` (set on Prime at the same time T7 is
 *  armed on the Scalpel listener). This is a rollout switch, NOT a
 *  fail-open: once armed, a missing/invalid/forged envelope or an
 *  unreachable broker is DENIED with no kernel emit. When disarmed the
 *  box is provably pre-enrollment and the AVSO path is byte-for-byte its
 *  pre-T6 self — the broker is never consulted, no envelope is required,
 *  nothing is denied; the guard simply is not in the path yet. Flagged
 *  for the Wave-gate integration item: Φ-PHI-Flow deploy MUST set this
 *  on both Prime and the Scalpel listener together. */
function _phiGateEnforced(): boolean {
  const v = (process.env.PHI_GATE_ENFORCE ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

// ─── G1b — localhost HTTP broker client (the real default broker) ───────
//
// FROZEN SERVICE CONTRACT (G1a builds the server to this, verbatim):
//   POST http://127.0.0.1:${PHI_GATE_PORT}/verify  body {envelope}
//     → 200 {decision:'allow'|'deny',code,resourceHash,corrId,attestation}
//   unreachable / non-200 / timeout / malformed
//     → treat as deny:'broker-unreachable' (FAIL-CLOSED — never allow on
//        doubt).
//
// PHI_GATE_PORT is the single source of truth shared with G1a; the
// literal default is only the fallback when the env var is unset (G1a
// uses the SAME default '9787'). The broker is localhost-only by
// construction (127.0.0.1, never a routable host) — it never leaves
// SuperServer. Resolved per-request (NOT at module load) so the port is
// honoured even if it is set after this module is imported.
const PHI_GATE_PORT_DEFAULT = '9787'
function phiGateVerifyUrl(): string {
  const port = process.env.PHI_GATE_PORT ?? PHI_GATE_PORT_DEFAULT
  return `http://127.0.0.1:${port}/verify`
}
const PHI_GATE_TIMEOUT_MS = 4000

/** The fail-closed deny every doubt resolves to. Reusing T6's exact
 *  return shape so the existing guard path is untouched. */
function brokerUnreachable(): {
  decision: 'deny'
  code: string
  resourceHash: string
  corrId: string
  attestation: string
} {
  return { decision: 'deny', code: 'broker-unreachable', resourceHash: '', corrId: '', attestation: '' }
}

// Localhost HTTP client to the G1a broker service. Never throws — any
// transport error, non-200, timeout, or malformed body fails CLOSED.
const httpDefaultBroker: PhiGateBroker = async (env) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PHI_GATE_TIMEOUT_MS)
  try {
    const res = await fetch(phiGateVerifyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope: env }),
      signal: ac.signal,
    })
    if (!res.ok) return brokerUnreachable()
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return brokerUnreachable() // malformed / non-JSON → fail closed
    }
    const b = body as Record<string, unknown> | null
    const decision = b?.decision
    if (decision !== 'allow' && decision !== 'deny') {
      // Missing/odd decision → cannot trust the verdict → fail closed.
      return brokerUnreachable()
    }
    return {
      decision,
      code: typeof b?.code === 'string' ? (b.code as string) : decision === 'allow' ? 'ok' : 'deny',
      resourceHash: typeof b?.resourceHash === 'string' ? (b.resourceHash as string) : '',
      corrId: typeof b?.corrId === 'string' ? (b.corrId as string) : '',
      // attestation rides through for B2 (Scalpel re-verify) — non-PHI,
      // like corrId. Empty string if the server omitted it.
      attestation: typeof b?.attestation === 'string' ? (b.attestation as string) : '',
    }
  } catch {
    // ECONNREFUSED / DNS / abort(timeout) / any transport error.
    return brokerUnreachable()
  } finally {
    clearTimeout(timer)
  }
}

let phiGateBroker: PhiGateBroker = httpDefaultBroker

/** Test seam — inject a mock broker matching the FROZEN T5 surface. */
export function __setPhiGateBrokerForTest(broker: PhiGateBroker): void {
  phiGateBroker = broker
}

/** Test seam — restore the real localhost HTTP fail-closed default broker. */
export function __resetPhiGateBrokerForTest(): void {
  phiGateBroker = httpDefaultBroker
}

/** Deny sentinel returned by emitCommand() when B1 refuses a PHI request.
 *  The executor translates it into the EXISTING step_failed path. */
interface PhiGateDeny {
  __phiGateDeny: true
  code: string
}

function isPhiGateDeny(x: unknown): x is PhiGateDeny {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { __phiGateDeny?: unknown }).__phiGateDeny === true
  )
}

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''
const POLL_INTERVAL_MS = 1000
const DEFAULT_DEADLINE_SEC = 5 * 60
const DEFAULT_POLL_TIMEOUT_MS = 60_000

// Mirror of scripts/room-listener/commands.py COMMAND_TIER. Keep in sync.
export const COMMAND_TIER: Record<string, number> = {
  'health-check':      0,
  'fetch-logs':        0,
  'station-query':     0,
  'patient-schedule':  0,
  'athena-nav':        0,   // AVSO v1 — read-only nav, NO confirm gate (AC6)
  // AVSO v2 (PLAN-v2 T8). Tiers mirror types.ts AVSO_V2_TIER + SPEC L3:
  //   schedule-date-probe : 0  read-only nav-chrome UI probe (no PHI)
  //   patient-search      : 1  blind typist into searchinput, NO confirm
  //   input-prepare       : 1  stages a pending write, no mutation
  //   input-commit        : 3  the actual write — typed-confirm gate
  //                            (execute.ts mints CONFIRM ATHENA-INPUT-COMMIT)
  'athena-schedule-date-probe': 0,
  'athena-patient-search':      1,
  'athena-input-prepare':       1,
  'athena-input-commit':        3,
  'inspect-mcp':       0,
  'chrome-cdp-status': 0,
  'list-experiments':  0,
  'read-experiment':   0,
  'rerun-experiment':  1,
  'ollama-operation':  1,
  'social-draft':      1,
  'morning-show-build':   1,
  'run-diagnostic':    1,
  'restart-service':   2,
  'execute-script':    2,
  'social-post':       3,
  'morning-show-publish': 3,
}

// W17.3 — per-command poll timeout override. Commands that involve LLM
// inference on Frank (dual-brain reasoning, multi-second-per-token) need
// considerably more headroom than the 60s default. Anything not listed
// falls back to DEFAULT_POLL_TIMEOUT_MS.
const POLL_TIMEOUT_OVERRIDE_MS: Record<string, number> = {
  'rerun-experiment': 240_000,   // Frank brain ~30-180s per substantive Q
  'ollama-operation': 120_000,
  'patient-schedule': 100_000,   // Athena CDP frameset scrape ~60-80s
  'athena-nav':        60_000,   // AVSO v1 — click-only nav (Pendo + steps), ~10-30s
  // AVSO v2 — Scalpel CDP frame work (GlobalNav search / free-text field
  // resolve + type + submit / nav-chrome probe) outlasts the 15s status
  // budget; give the same headroom family as athena-nav / patient-schedule.
  'athena-patient-search':       60_000,
  'athena-input-prepare':        60_000,
  'athena-input-commit':         90_000,
  'athena-schedule-date-probe':  60_000,
  'morning-show-build':  120_000, // plan/status mode is fast; headroom if execute=true kicks the pipeline
}

export function pollTimeoutFor(command_type: string, fallback: number = DEFAULT_POLL_TIMEOUT_MS): number {
  return POLL_TIMEOUT_OVERRIDE_MS[command_type] ?? fallback
}

export function tierFor(command_type: string): number {
  return COMMAND_TIER[command_type] ?? 2
}

const ALIAS_TO_AGENT: Record<string, string> = {
  prime:       'agent_orchestrator-prime-jarvis-os',
  frank:       'agent_heavy-compute-frank-self',
  scalpel:     'agent_clinical-ops-scalpel-self',
  argus:       'agent_vision-security-argus-self',
  'dj-jarvis': 'agent_playout-orchestrator-dj-jarvis-self',
  openclaw:    'openclaw-codex',
}

function resolveAgent(target: string): string {
  return ALIAS_TO_AGENT[target] ?? target
}

async function kernelFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!KERNEL_TOKEN) return null
  try {
    const res = await fetch(`${KERNEL_URL}/api/v1/registry${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${KERNEL_TOKEN}`,
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface EmitResponse {
  envelope: { id: string; status: string; tier_action: number; required_phrase?: string | null }
}

interface ListResponse {
  envelopes: Array<{ id: string; context: Record<string, unknown> | null; from_agent_id: string | null }>
  count: number
}

interface EnvelopeResponse {
  envelope: { id: string; status: string; failure_type: string | null }
}

async function emitCommand(
  step: PlanStep,
  sessionId: string | undefined,
  deadlineSec: number,
): Promise<EmitResponse | PhiGateDeny | null> {
  // ─── Φ-PHI-Flow B1 — pre-dispatch verify (ADDITIVE, PHI kinds only) ───
  // Immediately before the kernel emit, exactly per research/03 §2 B1.
  // Non-PHI kinds skip this entirely (broker never consulted). The
  // device-signed envelope rides in the redacted ctx as a non-PHI field
  // (step.args.phi_envelope) — like correlation_id; it carries no raw PHI
  // by T3 schema construction. Missing envelope on a PHI kind, or any
  // broker deny, fails CLOSED via the existing step_failed path.
  //
  // ROLLOUT SWITCH (mirrors Scalpel T7 `_phi_gate_enforced`): the entire
  // B1 block below is active ONLY when `PHI_GATE_ENFORCE` is armed.
  // Disarmed (default / unset / not 1|true|yes|on) → this branch is NOT
  // entered: no envelope is required, the broker is never consulted,
  // nothing is denied. PHI-bearing kinds emit byte-for-byte exactly as
  // pre-T6 (AVSO v2 keeps working through Telegram unchanged). This is a
  // rollout switch, NOT a fail-open — see _phiGateEnforced. T6's
  // guard/emit/deny internals below are UNCHANGED; only its ACTIVATION
  // is wrapped.
  if (_phiGateEnforced() && isPhiBearingKind(step.command_type)) {
    const env = (step.args as Record<string, unknown> | undefined)?.phi_envelope
    if (env === undefined || env === null) {
      // Fail closed WITHOUT trusting the broker — no envelope, no emit.
      return { __phiGateDeny: true, code: 'no-envelope' }
    }
    let decision: 'allow' | 'deny'
    let code: string
    try {
      const verdict = await phiGateBroker(env, { kind: step.command_type })
      decision = verdict.decision
      code = verdict.code
    } catch {
      // A throwing broker is a deny (fail-closed by construction).
      decision = 'deny'
      code = 'broker-error'
    }
    if (decision !== 'allow') {
      return { __phiGateDeny: true, code: code || 'deny' }
    }
    // allow → fall through and emit exactly as today.
  }

  const deadline = new Date(Date.now() + deadlineSec * 1000).toISOString()
  const tier = tierFor(step.command_type)
  // W21.1 — the kernel stores `input.required_phrase ?? null` and never
  // mints one itself, so a T3 step with no phrase lands awaiting_input
  // with required_phrase=null → Telegram shows "(typed-phrase)" and the
  // confirm route (… AND required_phrase = $2) can never match. The
  // orchestrator must supply the phrase for tier≥3 steps.
  const requiredPhrase =
    tier >= 3 ? `CONFIRM ${step.command_type.toUpperCase()}` : undefined
  return kernelFetch<EmitResponse>('/envelopes/emit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'command',
      from_agent_id: ALIAS_TO_AGENT.prime,
      to_agent_id: resolveAgent(step.target),
      task_goal: step.description ?? `${step.target}: ${step.command_type}`,
      context: {
        command_type: step.command_type,
        session_id: sessionId,
        ...step.args,
      },
      tier_action: tier,
      ...(requiredPhrase ? { required_phrase: requiredPhrase } : {}),
      deadline,
    }),
  })
}

async function pollForResult(
  commandId: string,
  timeoutMs: number,
): Promise<{ kind: 'result'; result: unknown } | { kind: 'failed'; reason: string } | { kind: 'timeout' }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const list = await kernelFetch<ListResponse>(`/envelopes?parent_envelope_id=${commandId}&limit=1`)
    if (list && list.envelopes.length > 0) {
      const ev = list.envelopes[0]
      const ctx = ev.context ?? {}
      return { kind: 'result', result: ctx }
    }
    // Also short-circuit if the command itself was flipped to failed
    const cmd = await kernelFetch<EnvelopeResponse>(`/envelopes/${commandId}`)
    if (cmd?.envelope.status === 'failed') {
      return { kind: 'failed', reason: cmd.envelope.failure_type ?? 'unknown' }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { kind: 'timeout' }
}

/**
 * Execute a plan, yielding ExecEvent objects as work progresses.
 *
 * Workflow-continuation rule: pause on the first failed step (do not
 * proceed to subsequent steps). This matches the SPEC default
 * resolved 2026-05-14.
 *
 * For tier_action >= 3 steps, the envelope lands in 'awaiting_input'
 * with a required_phrase. The executor yields an 'awaiting_confirm'
 * event and stops; the Telegram layer is responsible for posting the
 * phrase prompt and confirming via the existing /envelopes/:id/confirm
 * route. That confirm flips it to 'pending', which the lieutenant
 * listener then claims and executes — the result arrives normally and
 * the orchestrator can be re-entered to resume.
 */
export async function* executePlan(
  plan: Plan,
  sessionId?: string,
  pollTimeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): AsyncIterable<ExecEvent> {
  yield {
    kind: 'plan_formed',
    total_steps: plan.steps.length,
    result: { summary: plan.summary, steps: plan.steps.map((s) => ({ target: s.target, command_type: s.command_type })) },
  }

  // For class='status' fan-out: emit ALL commands first, then poll for
  // all results. This is semantically the right model — a status table
  // wants every lieutenant's answer, not "first one that times out wins".
  // It's also faster (parallel) and doesn't abort the table on one
  // unreachable node.
  if (plan.class === 'status') {
    yield* executeFanOut(plan, sessionId, pollTimeoutMs)
    return
  }

  let stepNumber = 0
  let allOk = true
  for (const step of plan.steps) {
    stepNumber += 1
    const emit = await emitCommand(step, sessionId, DEFAULT_DEADLINE_SEC)
    if (isPhiGateDeny(emit)) {
      // Φ-PHI-Flow B1 — fail-closed by REUSING the existing step_failed
      // path. summarizeOrchFailures() turns this into an honest, non-PHI
      // message; the W21.15 conversational fallback then engages.
      yield { kind: 'step_failed', step, step_number: stepNumber, total_steps: plan.steps.length, reason: `phi-gate-deny:${emit.code}` }
      yield { kind: 'orchestration_done', result: { completed: false } }
      return
    }
    if (!emit) {
      yield { kind: 'step_failed', step, step_number: stepNumber, total_steps: plan.steps.length, reason: 'emit-failed (kernel unreachable?)' }
      yield { kind: 'orchestration_done', result: { completed: false } }
      return
    }
    const cmdId = emit.envelope.id

    if (emit.envelope.status === 'awaiting_input') {
      yield {
        kind: 'awaiting_confirm',
        step,
        step_number: stepNumber,
        total_steps: plan.steps.length,
        envelope_id: cmdId,
        required_phrase: emit.envelope.required_phrase ?? undefined,
      }
      // Stop — the Telegram layer takes over from here.
      yield { kind: 'orchestration_done', result: { completed: false, paused_at: stepNumber } }
      return
    }

    yield { kind: 'step_dispatched', step, step_number: stepNumber, total_steps: plan.steps.length, envelope_id: cmdId }

    // W17.3 — per-command-type poll override. LLM-inference commands
    // (e.g. rerun-experiment) outlast the default 60s on substantive Qs.
    const effectivePollMs = pollTimeoutFor(step.command_type, pollTimeoutMs)
    const polled = await pollForResult(cmdId, effectivePollMs)
    if (polled.kind === 'result') {
      // W21.1 — a result envelope can carry a SOFT failure: the handler
      // ran but returned {ok:false,...}. That is NOT a completed step.
      // Treating it as success let a failed social-draft proceed to the
      // T3 publish gate ("✅ social-draft: fail ⏸ awaiting confirm").
      // A soft-failed step aborts the workflow exactly like a hard fail.
      const rc = (polled.result ?? {}) as Record<string, unknown>
      if (rc.ok === false) {
        const reason =
          (typeof rc.error === 'string' && rc.error) ||
          (typeof rc.status === 'string' && rc.status !== 'ok' && rc.status) ||
          'handler returned ok:false'
        yield { kind: 'step_failed', step, step_number: stepNumber, total_steps: plan.steps.length, envelope_id: cmdId, reason, result: polled.result }
        yield { kind: 'orchestration_done', result: { completed: false } }
        return
      }
      yield { kind: 'step_complete', step, step_number: stepNumber, total_steps: plan.steps.length, envelope_id: cmdId, result: polled.result }
    } else if (polled.kind === 'failed') {
      yield { kind: 'step_failed', step, step_number: stepNumber, total_steps: plan.steps.length, envelope_id: cmdId, reason: polled.reason }
      yield { kind: 'orchestration_done', result: { completed: false } }
      return
    } else {
      yield { kind: 'step_failed', step, step_number: stepNumber, total_steps: plan.steps.length, envelope_id: cmdId, reason: 'poll-timeout' }
      yield { kind: 'orchestration_done', result: { completed: false } }
      return
    }
  }
  yield { kind: 'orchestration_done', result: { completed: allOk } }
}

/**
 * Status fan-out: dispatch all in parallel, gather all results
 * (success or failure), never abort the table for a partial outage.
 * Uses a tighter per-step timeout (15s) since we're waiting on the
 * slowest lieutenant.
 */
async function* executeFanOut(
  plan: Plan,
  sessionId: string | undefined,
  perStepTimeoutMs: number = 15_000,
): AsyncIterable<ExecEvent> {
  // Emit all commands first.
  const dispatched: Array<{ step: typeof plan.steps[number]; envelopeId: string; stepNumber: number } | { step: typeof plan.steps[number]; failed: true; reason: string; stepNumber: number }> = []
  let n = 0
  for (const step of plan.steps) {
    n += 1
    const emit = await emitCommand(step, sessionId, DEFAULT_DEADLINE_SEC)
    if (isPhiGateDeny(emit)) {
      // Φ-PHI-Flow B1 — fail-closed in the status fan-out too (additive,
      // same shape as the emit-failed branch). PHI kinds are not normally
      // status-class, but the gate must hold on every path that emits.
      const reason = `phi-gate-deny:${emit.code}`
      dispatched.push({ step, failed: true, reason, stepNumber: n })
      yield { kind: 'step_failed', step, step_number: n, total_steps: plan.steps.length, reason }
      continue
    }
    if (!emit) {
      dispatched.push({ step, failed: true, reason: 'emit-failed', stepNumber: n })
      yield { kind: 'step_failed', step, step_number: n, total_steps: plan.steps.length, reason: 'emit-failed' }
      continue
    }
    dispatched.push({ step, envelopeId: emit.envelope.id, stepNumber: n })
    yield { kind: 'step_dispatched', step, step_number: n, total_steps: plan.steps.length, envelope_id: emit.envelope.id }
  }

  // Poll all in parallel.
  const settled = await Promise.all(
    dispatched.map(async (d) => {
      if ('failed' in d) return d
      const polled = await pollForResult(d.envelopeId, perStepTimeoutMs)
      return { ...d, polled }
    }),
  )

  let okCount = 0
  for (const r of settled) {
    if ('failed' in r) continue
    const polled = r.polled
    if (polled.kind === 'result') {
      okCount += 1
      yield { kind: 'step_complete', step: r.step, step_number: r.stepNumber, total_steps: plan.steps.length, envelope_id: r.envelopeId, result: polled.result }
    } else if (polled.kind === 'failed') {
      yield { kind: 'step_failed', step: r.step, step_number: r.stepNumber, total_steps: plan.steps.length, envelope_id: r.envelopeId, reason: polled.reason }
    } else {
      yield { kind: 'step_failed', step: r.step, step_number: r.stepNumber, total_steps: plan.steps.length, envelope_id: r.envelopeId, reason: 'poll-timeout' }
    }
  }
  yield { kind: 'orchestration_done', result: { completed: okCount === plan.steps.length, ok_count: okCount, total: plan.steps.length } }
}
