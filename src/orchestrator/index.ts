// W17 T7 — Orchestrator scaffold + public entrypoint.
//
// One function: orchestrate(message). Telegram handler calls this; it
// classifies, builds a plan, executes, composes a reply, and returns
// the full OrchestrationResult. Activity timeline events + session
// linkage live in T13 (timeline.ts).

import { classifyIntent } from './classify.js'
import { classifyIntentWithLLM } from './classify-llm.js'
import { buildPlan } from './plan.js'
import { buildPlanWithLLM } from './plan-llm.js'
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
  /** W18 — disable the LLM fallback (regex-only). Default: respect the
   *  JARVIS_LLM_CLASSIFIER_ENABLED env. Set false in tests to skip the
   *  network round-trip. */
  llmClassifierEnabled?: boolean
}

// W21.4 — Prime's conversational brain doesn't know what the
// orchestrator can do, so "what skills / list orchestration skills"
// got a generic GSD answer. This is the single source of truth for the
// orchestrated workflow vocabulary, returned deterministically.
const SKILLS_INTENT =
  /\b(list|show|what(?:'s| are)?|which)\b[^.\n]*\b(orchestrat\w*|workflow|skills?|commands?|can you (?:do|run))\b|\bwhat can you (?:do|orchestrate|run)\b|\borchestrat\w* (?:skills?|commands?|menu|help)\b/i

const ORCHESTRATOR_SKILLS = [
  '*Jarvis Prime — orchestrated workflows*',
  '(plain English in Telegram; tier-3 steps pause for your confirm)',
  '',
  '📻 *WPFQ radio*',
  '• "now playing" / "station check" / "dpl coverage" / "play history" / "upcoming" / "station logs"',
  '• "build the morning show [date]" → research→…→preview, then *publish* gate (T3)',
  '🐦 *Social*',
  '• "draft a tweet about <topic>" → draft, then *publish* gate (T3 → @xAIDJPretoria)',
  '🏥 *Clinical* — "patient schedule" / "OR schedule" (redacted; PHI stays on-box)',
  '🧠 *Frank* — "list/read/rerun frank experiment <name>"',
  '🛰 *Ops* — "network status", "morning briefing", "restart <svc> on <node>", "inspect mcp", "chrome-cdp status"',
  '',
  'At a confirm gate: reply *publish* to proceed or *cancel* to abort.',
].join('\n')

// W21.4 — a precise, human label for what a gated step will actually
// do, so the confirm/abort/hold messages are unambiguous (a tweet vs.
// the morning show vs. a station mutation).
export function actionLabel(commandType?: string, args?: Record<string, unknown>): string {
  const a = args ?? {}
  switch (commandType) {
    case 'social-post':
      return `post the X/Twitter ${a.topic && a.topic !== 'now-playing' ? `post about "${String(a.topic).slice(0, 40)}"` : 'now-playing post'} to @xAIDJPretoria`
    case 'morning-show-publish':
      return `PUBLISH THE MORNING SHOW${a.date ? ` (${a.date})` : ''} to the WPFQ playout`
    case 'restart-service':
      return `restart ${a.service ?? 'service'}${a.target ? ` on ${a.target}` : ''}`
    case 'execute-script':
      return `run script ${a.script ?? a.path ?? ''}`.trim()
    case 'social-draft':
      return 'prepare an X/Twitter draft'
    default:
      return commandType ?? 'this action'
  }
}

export async function orchestrate(
  message: TelegramMessage,
  opts: OrchestrateOptions = {},
): Promise<OrchestrationResult> {
  // W21.4 — deterministic skills catalog (before classify): keeps Prime
  // honest about its own orchestration vocabulary.
  if (message.text && SKILLS_INTENT.test(message.text.trim())) {
    return {
      class: 'query',
      session_id: opts.sessionId,
      events: [],
      final_reply: ORCHESTRATOR_SKILLS,
      completed: true,
    }
  }

  // W18 — two-stage classify: regex first (fast, free), Frank-brain
  // LLM second only when regex returns 'chat'. Falls back to 'chat' if
  // Frank is unreachable. See classify-llm.ts for the prompt + cache.
  const klass = await classifyIntentWithLLM(message.text, {
    enabled: opts.llmClassifierEnabled,
    onLLMCall: (info) => {
      // Best-effort telemetry. Fire-and-forget — never blocks orchestrate.
      void emitTimelineFor(
        {
          kind: 'plan_formed',
          step_number: 0,
          total_steps: 0,
          result: {
            llm_classifier: true,
            from_cache: info.fromCache,
            duration_ms: info.durationMs,
            ok: info.ok,
            parsed: info.parsed,
          },
        } as ExecEvent,
        opts.sessionId,
      ).catch(() => undefined)
    },
  })

  if (klass === 'chat') {
    return {
      class: 'chat',
      session_id: opts.sessionId,
      events: [],
      final_reply: '', // caller falls back to its normal conversational reply
      completed: true,
    }
  }

  let plan = buildPlan(message.text, klass)

  // For class='status' the plan's steps[] is empty by design — fill it
  // with one health-check per alive lieutenant via the fan-out helper.
  if (klass === 'status' && plan.steps.length === 0) {
    const steps = await statusFanOutSteps()
    plan.steps.push(...steps)
  }

  // W19c — when the hard-coded planner couldn't match a template
  // (workflow/query class only), ask the LLM planner to pick one
  // command from the catalog. Returns null if no clean mapping exists,
  // in which case we keep the original empty plan and the orchestrator
  // replies "no concrete plan yet".
  if (plan.steps.length === 0 && (klass === 'workflow' || klass === 'query')) {
    const llmPlan = await buildPlanWithLLM(message.text, klass)
    if (llmPlan) plan = llmPlan
  }

  const events: ExecEvent[] = []

  if (plan.steps.length === 0) {
    // No concrete plan (no hard-coded template matched and the LLM
    // planner couldn't form one). The orchestrator must NOT claim the
    // message and stonewall with a canned "no plan template yet" line —
    // that suppresses the conversational brain entirely (the bug Tripp
    // hit: every solo/deep-brain message returning the dead-end string).
    //
    // Contract: the orchestrator only takes ownership of a message when
    // it has an actionable plan or a status/query fan-out. Otherwise it
    // yields by reporting class:'chat' with an empty reply, so the
    // Telegram hook delegates to the normal dual-brain handler. A
    // classifier over-promotion is now harmless — it just flows to
    // conversation instead of dead-ending.
    return {
      class: 'chat',
      session_id: opts.sessionId,
      events: [],
      final_reply: '',
      completed: true,
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
    // W21 — surface what is being confirmed. A T3 gate with no preview
    // ("reply with phrase to proceed") is the exact "generic/unusable"
    // UX the SuperServer diagnosis flagged. The step(s) before the gate
    // (e.g. social-draft, morning-show-build) have already completed and
    // carry the draft text / preview summary — render them so Tripp sees
    // the artifact before typing the confirm phrase.
    const out = [`${plan.summary}`, '']
    for (const ev of completed) {
      const ctx = (ev.result as Record<string, unknown>) ?? {}
      out.push(`✅ ${ev.step?.target} ${ev.step?.command_type}:`)
      out.push(renderResult(ctx))
      out.push('')
    }
    // W21.4 — name the EXACT action. "publish" confirmed a morning-show
    // when Tripp meant a tweet because the gate said only "publish".
    out.push(
      `⏸ **Confirm: ${actionLabel(awaiting.step?.command_type, awaiting.step?.args)}**`,
      `(step ${awaiting.step_number}/${awaiting.total_steps}) — review above.`,
      `Reply **publish** to do exactly that, or *cancel* to abort.`,
    )
    return out.join('\n')
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
    // No step produced a result and nothing explicitly failed: the
    // planner couldn't form an actionable step for this request. Be
    // honest instead of emitting a bare summary line that reads like a
    // silent success ("workflow complete"). This is the path the
    // SuperServer diagnosis flagged as "generic/unusable".
    return [
      plan.summary,
      '',
      "⚠️ I couldn't turn that into an actionable plan, so nothing ran.",
      'Rephrase it as a concrete request — e.g. "network status",',
      '"frank health", or "now playing on the station".',
    ].join('\n')
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

  // W17.3 — rerun-experiment: multi-line with new dir + answer excerpt.
  if (typeof ctx.new_experiment === 'string' && typeof ctx.rerun_of === 'string') {
    const lines: string[] = []
    lines.push(`rerun of ${ctx.rerun_of}`)
    lines.push(`  → ${ctx.new_experiment}`)
    if (typeof ctx.duration_seconds === 'number') lines.push(`  duration: ${ctx.duration_seconds}s`)
    if (typeof ctx.routing === 'string' && ctx.routing) lines.push(`  routing: ${ctx.routing}${ctx.mode ? ' · mode=' + ctx.mode : ''}`)
    if (typeof ctx.tokens === 'object' && ctx.tokens) {
      const t = ctx.tokens as Record<string, unknown>
      if (typeof t.completion_tokens === 'number') lines.push(`  tokens: in=${t.prompt_tokens ?? '?'} out=${t.completion_tokens}`)
    }
    if (typeof ctx.answer_excerpt === 'string' && ctx.answer_excerpt) {
      const ex = String(ctx.answer_excerpt).slice(0, 200).replace(/\s+/g, ' ').trim()
      lines.push(`  answer: "${ex}…"`)
    }
    return lines.join('\n')
  }

  // W20 — patient-schedule (Scalpel, PHI-redacted). The handler never
  // emits identifiers; only counts/times/type-histogram + an honest
  // status when the Athena CDP session is offline.
  if (typeof ctx.patient_count === 'number' || ctx.status === 'athena-cdp-offline'
      || ctx.status === 'extract-failed' || ctx.status === 'extractor-missing') {
    if (ctx.status && ctx.status !== 'ok') {
      const note = typeof ctx.note === 'string' ? ` — ${ctx.note}` : ''
      return `schedule unavailable (${ctx.status})${note}`
    }
    const parts: string[] = [`${ctx.patient_count} cases`]
    if (typeof ctx.providers_count === 'number') parts.push(`${ctx.providers_count} provider(s)`)
    if (ctx.first_or_at) parts.push(`first ${ctx.first_or_at}`)
    if (ctx.last_or_at) parts.push(`last ${ctx.last_or_at}`)
    if (ctx.cases_by_type && typeof ctx.cases_by_type === 'object') {
      const h = Object.entries(ctx.cases_by_type as Record<string, number>)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')
      if (h) parts.push(`[${h}]`)
    }
    if (typeof ctx.archive_path === 'string') parts.push('(full in clinical-archive)')
    return `ok · ${parts.join(' · ')}`
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

  // Social post results — show the generated/published text and the docs
  // that were read before acting. Live publish is guarded by tier_action=3.
  if (ctx.command_type === 'social-draft' || ctx.command_type === 'social-post' || typeof ctx.post_text === 'string') {
    const platform = typeof ctx.platform === 'string' ? ctx.platform : 'social'
    const mode = ctx.dry_run === true ? 'draft' : ctx.posted === true ? 'posted' : 'not posted'
    const lines = [`${platform.toUpperCase()} ${mode}`]
    if (typeof ctx.post_text === 'string') lines.push(`  ${ctx.post_text}`)
    if (typeof ctx.tweet_id === 'string') lines.push(`  id: ${ctx.tweet_id}`)
    if (Array.isArray(ctx.context_files_read)) lines.push(`  context: ${ctx.context_files_read.join(', ')}`)
    if (typeof ctx.error === 'string') lines.push(`  error: ${ctx.error}`)
    return lines.join('\n')
  }

  // W21 — morning-show pipeline (Process B). The handler returns a
  // plan/status snapshot (mode=plan|started|done) for build, and a
  // deploy summary for publish. Surface the pipeline stages, the show
  // dir, which artifacts already exist, and the AutoImporter guardrails.
  if (
    (typeof ctx.command_type === 'string' && ctx.command_type.startsWith('morning-show')) ||
    typeof ctx.show_date === 'string' ||
    Array.isArray(ctx.pipeline)
  ) {
    const stage = String(ctx.stage ?? (String(ctx.command_type ?? '').endsWith('publish') ? 'publish' : 'build'))
    const mode = String(ctx.mode ?? 'plan')
    const date = String(ctx.show_date ?? ctx.date ?? '?')
    const lines = [`🎙 morning-show ${stage} · ${date} · ${mode}`]
    if (typeof ctx.error === 'string') lines.push(`  ⚠️ ${ctx.error}`)
    if (Array.isArray(ctx.pipeline)) {
      for (const s of ctx.pipeline as Array<Record<string, unknown>>) {
        const done = s.exists === true ? '✓' : s.exists === false ? '·' : ' '
        lines.push(`  ${done} ${s.stage}${s.script ? ` → ${s.script}` : ''}`)
      }
    }
    if (typeof ctx.hours === 'string' || typeof ctx.hours === 'number') lines.push(`  hours: ${ctx.hours}`)
    if (typeof ctx.show_dir === 'string') lines.push(`  dir: ${ctx.show_dir}`)
    if (Array.isArray(ctx.previews) && ctx.previews.length > 0) {
      lines.push(`  previews: ${(ctx.previews as string[]).slice(0, 4).join(', ')}`)
    }
    if (typeof ctx.asset_count === 'number') lines.push(`  ${ctx.asset_count} deploy assets`)
    if (typeof ctx.deploy_plan_path === 'string') lines.push(`  deploy-plan: ${ctx.deploy_plan_path}`)
    if (typeof ctx.verified === 'boolean') lines.push(`  verified: ${ctx.verified ? 'yes — Playlists rows present' : 'NO'}`)
    if (Array.isArray(ctx.guardrails) && ctx.guardrails.length > 0) {
      lines.push(`  guardrails: ${(ctx.guardrails as string[]).slice(0, 3).join(' · ')}`)
    }
    return lines.join('\n')
  }

  // Station query results — surface the structured fields from dj-jarvis
  if (typeof ctx.query === 'string') {
    const lines: string[] = []
    if (ctx.query === 'now-playing') {
      if (typeof ctx.title === 'string') lines.push(`🎵 ${ctx.title}`)
      if (typeof ctx.artist === 'string') lines.push(`   ${ctx.artist}`)
      if (typeof ctx.elapsed === 'string' || typeof ctx.position === 'string') {
        const pos = ctx.elapsed ?? ctx.position
        const dur = ctx.duration ?? ctx.total
        lines.push(`   ${pos}${dur ? ` / ${dur}` : ''}`)
      }
      if (typeof ctx.player === 'string') lines.push(`   player: ${ctx.player}`)
    } else if (ctx.query === 'station-check') {
      // W20 — fields produced by _q_station_check in commands.py.
      if (typeof ctx.verdict === 'string') {
        lines.push(ctx.alive === true ? `✅ ${ctx.verdict}` : `⚠️ ${ctx.verdict}`)
      } else {
        lines.push('station-check complete')
      }
      if (typeof ctx.last_track === 'string') lines.push(`   last: ${ctx.last_track}`)
      if (typeof ctx.staleness_seconds === 'number') {
        const m = Math.round(ctx.staleness_seconds / 60)
        lines.push(`   last logged ${m}m ago`)
      }
      if (typeof ctx.tracks_logged_today === 'number') lines.push(`   ${ctx.tracks_logged_today} tracks logged today`)
      // Legacy fields (kept for any older handler still in the field)
      if (typeof ctx.api_status === 'string') lines.push(`API: ${ctx.api_status}`)
      if (typeof ctx.dpl_coverage === 'string') lines.push(`DPL: ${ctx.dpl_coverage}`)
    } else if (ctx.query === 'play-history' && Array.isArray(ctx.tracks)) {
      const tr = ctx.tracks as Array<Record<string, unknown>>
      lines.push(`${tr.length} recent tracks:`)
      for (const t of tr.slice(-5)) lines.push(`   • ${t.title} — ${t.artist}`)
    } else if (ctx.query === 'dpl-coverage' && typeof ctx.days_covered === 'number') {
      lines.push(`DPL coverage: ${ctx.days_covered} day(s) of pre-built music`)
    } else if (typeof ctx.output === 'string') {
      return ctx.output.slice(0, 500)
    }
    if (lines.length > 0) return lines.join('\n')
    if (typeof ctx.result === 'string') return ctx.result.slice(0, 500)
  }

  // W21.1 — never emit a bare "fail" with no reason. If the handler
  // failed, surface why (error / non-ok status) so the user sees
  // "fail: station source unavailable" not a mute "fail".
  if (ctx.ok === false) {
    const why =
      (typeof ctx.error === 'string' && ctx.error) ||
      (typeof ctx.status === 'string' && ctx.status !== 'ok' && ctx.status) ||
      'no detail returned'
    return `fail: ${String(why).slice(0, 300)}`
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
// W21 — pure render fns exported for unit tests (confirm-gate preview,
// morning-show + social rendering). No side effects.
export { composeFinalReply, renderResult }
