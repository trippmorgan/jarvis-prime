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
  'inspect-mcp':       0,
  'chrome-cdp-status': 0,
  'ollama-operation':  1,
  'run-diagnostic':    1,
  'restart-service':   2,
  'execute-script':    2,
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
): Promise<EmitResponse | null> {
  const deadline = new Date(Date.now() + deadlineSec * 1000).toISOString()
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
      tier_action: tierFor(step.command_type),
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

    const polled = await pollForResult(cmdId, pollTimeoutMs)
    if (polled.kind === 'result') {
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
