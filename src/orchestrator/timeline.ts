// W17 T13 — Activity timeline event emitter.
//
// Each orchestration step writes a kernel event so the shell's
// SessionActivity timeline shows the play-by-play. PHI-safe: the body
// describes the action (target + command_type), never the result data.

import type { ExecEvent } from './types.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''

const PRIME_AGENT_ID = 'agent_orchestrator-prime-jarvis-os'

interface EmitEventInput {
  body: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  metadata?: Record<string, unknown>
}

async function postEvent(input: EmitEventInput, sessionId?: string): Promise<void> {
  if (!KERNEL_TOKEN) return
  try {
    await fetch(`${KERNEL_URL}/api/v1/registry/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KERNEL_TOKEN}`,
      },
      body: JSON.stringify({
        agent_id: PRIME_AGENT_ID,
        severity: input.severity ?? 'info',
        body: input.body,
        metadata: {
          ...(input.metadata ?? {}),
          session_id: sessionId,
          kind: 'orchestration_step',
          source: 'jarvis-prime/orchestrator',
        },
      }),
    })
  } catch {
    // Timeline emission failure must never abort orchestration.
  }
}

/**
 * Translate an ExecEvent into a one-line activity timeline entry.
 * Called from the orchestrator's onEvent callback.
 */
export async function emitTimelineFor(ev: ExecEvent, sessionId?: string): Promise<void> {
  const meta: Record<string, unknown> = {
    exec_event_kind: ev.kind,
    step_number: ev.step_number,
    total_steps: ev.total_steps,
    command_envelope_id: ev.envelope_id,
  }
  switch (ev.kind) {
    case 'plan_formed':
      return postEvent({
        body: `Plan formed: ${ev.total_steps ?? 0} step(s)`,
        metadata: meta,
      }, sessionId)
    case 'step_dispatched':
      return postEvent({
        body: `→ ${ev.step?.target} ${ev.step?.command_type}`,
        metadata: meta,
      }, sessionId)
    case 'step_complete': {
      const ctx = (ev.result as Record<string, unknown>) ?? {}
      const ok = ctx.ok === true
      return postEvent({
        body: `← ${ev.step?.target} ${ev.step?.command_type} ${ok ? 'OK' : 'FAIL'}`,
        severity: ok ? 'success' : 'warning',
        metadata: meta,
      }, sessionId)
    }
    case 'step_failed':
      return postEvent({
        body: `✗ ${ev.step?.target} ${ev.step?.command_type} failed: ${ev.reason ?? 'unknown'}`,
        severity: 'error',
        metadata: meta,
      }, sessionId)
    case 'awaiting_confirm':
      return postEvent({
        body: `⏸ awaiting confirm: ${ev.step?.target} ${ev.step?.command_type} (T3+)`,
        severity: 'warning',
        metadata: meta,
      }, sessionId)
    case 'orchestration_done':
      return postEvent({
        body: `orchestration done: ${(ev.result as { completed?: boolean })?.completed ? 'all steps complete' : 'paused/failed'}`,
        severity: (ev.result as { completed?: boolean })?.completed ? 'success' : 'warning',
        metadata: meta,
      }, sessionId)
  }
}
