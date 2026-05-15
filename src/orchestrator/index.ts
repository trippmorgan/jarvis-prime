// W17 T7 — Orchestrator scaffold + public entrypoint.
//
// One function: orchestrate(message). Telegram handler calls this; it
// classifies, builds a plan, executes, composes a reply, and returns
// the full OrchestrationResult. Activity timeline events + session
// linkage live in T13 (timeline.ts).

import { classifyIntent } from './classify.js'
import { buildPlan } from './plan.js'
import { executePlan } from './execute.js'
import { statusFanOutSteps, renderStatusTable, parseStatusRow } from './status.js'
import { emitTimelineFor } from './timeline.js'
import type { ExecEvent, OrchestrationResult, TelegramMessage } from './types.js'

export interface OrchestrateOptions {
  /** If provided, ExecEvents are streamed via this callback for live
   *  progress in Telegram. */
  onEvent?: (e: ExecEvent) => void | Promise<void>
  /** Session id from /sessions/start. Plumbed into command envelopes. */
  sessionId?: string
}

export async function orchestrate(
  message: TelegramMessage,
  opts: OrchestrateOptions = {},
): Promise<OrchestrationResult> {
  const klass = classifyIntent(message.text)

  if (klass === 'chat') {
    return {
      class: 'chat',
      session_id: opts.sessionId,
      events: [],
      final_reply: '', // caller falls back to its normal conversational reply
      completed: true,
    }
  }

  const plan = buildPlan(message.text, klass)

  // For class='status' the plan's steps[] is empty by design — fill it
  // with one health-check per alive lieutenant via the fan-out helper.
  if (klass === 'status' && plan.steps.length === 0) {
    const steps = await statusFanOutSteps()
    plan.steps.push(...steps)
  }

  const events: ExecEvent[] = []

  if (plan.steps.length === 0) {
    return {
      class: klass,
      session_id: opts.sessionId,
      events: [],
      final_reply: plan.summary,
      completed: false,
    }
  }

  for await (const ev of executePlan(plan, opts.sessionId)) {
    events.push(ev)
    // T13: every step lands a timeline entry on the kernel events log.
    await emitTimelineFor(ev, opts.sessionId)
    if (opts.onEvent) {
      try {
        await opts.onEvent(ev)
      } catch {
        // Streaming failures don't abort orchestration.
      }
    }
  }

  return {
    class: klass,
    session_id: opts.sessionId,
    events,
    final_reply: composeFinalReply(plan, events, klass),
    completed: events.some((e) => e.kind === 'orchestration_done' && (e.result as { completed?: boolean })?.completed === true),
  }
}

function composeFinalReply(plan: { summary: string }, events: ExecEvent[], klass: string): string {
  const completed = events.filter((e) => e.kind === 'step_complete')
  const failed = events.filter((e) => e.kind === 'step_failed')
  const awaiting = events.find((e) => e.kind === 'awaiting_confirm')

  if (awaiting) {
    return [
      `${plan.summary}`,
      `\n⏸ Step ${awaiting.step_number}/${awaiting.total_steps} (${awaiting.step?.command_type}) is **awaiting confirmation**.`,
      `Reply with: \`${awaiting.required_phrase ?? '(typed-phrase)'}\` to proceed.`,
    ].join('\n')
  }

  // Status class always renders the table, even when some lieutenants
  // timed out — a partial table is more useful than an abort message.
  if (klass === 'status') {
    const rows: ReturnType<typeof parseStatusRow>[] = []
    for (const ev of completed) {
      rows.push(parseStatusRow(ev.step?.target ?? '?', (ev.result as Record<string, unknown>) ?? null))
    }
    for (const ev of failed) {
      rows.push(parseStatusRow(ev.step?.target ?? '?', { ok: false, error: ev.reason }))
    }
    if (rows.length === 0) return plan.summary
    return renderStatusTable(rows)
  }

  // Non-status: pause-on-failure remains the SPEC-locked behavior.
  if (failed.length > 0) {
    const f = failed[0]
    return [
      `${plan.summary}`,
      `\n❌ Step ${f.step_number}/${f.total_steps} (${f.step?.command_type}) failed: ${f.reason ?? 'unknown'}.`,
    ].join('\n')
  }

  if (completed.length === 0) {
    return plan.summary
  }

  const lines = [plan.summary, '']
  for (const ev of completed) {
    const ctx = (ev.result as Record<string, unknown>) ?? {}
    lines.push(`✅ ${ev.step?.target} ${ev.step?.command_type}: ${renderResult(ctx)}`)
  }
  return lines.join('\n')
}

function renderResult(ctx: Record<string, unknown>): string {
  // Tight summary — full result is in the result envelope. Telegram is
  // not the place to dump 4KB of stdout.

  // W17.2 — list-experiments: multi-line summary so the Telegram reply
  // actually shows the experiment names, not a bare "ok · count=20".
  if (Array.isArray(ctx.experiments)) {
    const exps = ctx.experiments as Record<string, unknown>[]
    const total = typeof ctx.total === 'number' ? ctx.total : exps.length
    if (exps.length === 0) return 'ok · no experiments found'
    const top = exps.slice(0, 5).map((e) => {
      const nm = String(e.name ?? '?')
      const en = e.experiment_name ? ` — "${String(e.experiment_name).slice(0, 60)}"` : ''
      const phi = typeof e.avg_phi_bilateral === 'number' ? ` Φ=${e.avg_phi_bilateral}` : ''
      return `  • ${nm}${en}${phi}`
    })
    const hidden = total - top.length
    const more = hidden > 0 ? `\n  … +${hidden} more not shown` : ''
    return `${total} experiments\n${top.join('\n')}${more}`
  }

  // W17.2 — read-experiment: detail line with the headline fields.
  if (ctx.experiment && typeof ctx.experiment === 'object') {
    const e = ctx.experiment as Record<string, unknown>
    const parts: string[] = []
    if (e.experiment_name) parts.push(`"${String(e.experiment_name).slice(0, 80)}"`)
    if (e.status) parts.push(`status=${e.status}`)
    if (typeof e.avg_phi_bilateral === 'number') parts.push(`Φ_bi=${e.avg_phi_bilateral}`)
    if (typeof e.duration_seconds === 'number') parts.push(`${Math.round(Number(e.duration_seconds))}s`)
    if (typeof ctx.response_count === 'number') parts.push(`${ctx.response_count} responses`)
    if (typeof e.minted_coins === 'number') parts.push(`${e.minted_coins} coins`)
    return parts.length > 0 ? `ok · ${parts.join(' · ')}` : 'ok'
  }

  const ok = ctx.ok === true ? 'ok' : 'fail'
  const bits: string[] = [ok]
  if (typeof ctx.uname === 'string') {
    const platform = ctx.uname.split(' ')[0]
    bits.push(platform)
  }
  if (typeof ctx.uptime === 'string') {
    const m = ctx.uptime.match(/load average:\s+([\d.]+),/)
    if (m) bits.push(`load=${m[1]}`)
  }
  if (typeof ctx.pm2_online === 'number') bits.push(`pm2=${ctx.pm2_online}`)
  if (typeof ctx.patient_count === 'number') bits.push(`${ctx.patient_count} cases`)
  if (typeof ctx.listening === 'boolean') bits.push(`listening=${ctx.listening}`)
  if (typeof ctx.count === 'number') bits.push(`count=${ctx.count}`)
  if (typeof ctx.row_count === 'number') bits.push(`${ctx.row_count} rows`)
  return bits.join(' · ')
}

export type { IntentClass, Plan, PlanStep, ExecEvent, OrchestrationResult, TelegramMessage } from './types.js'
export { classifyIntent } from './classify.js'
export { buildPlan } from './plan.js'
export { executePlan, tierFor, COMMAND_TIER } from './execute.js'
