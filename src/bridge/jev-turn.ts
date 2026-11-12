import type { JevRouteRecord } from './jev-front.js'
import type { JevResult, ToolEvidence } from './harness-race.js'
import { selectAnswerRoute, type AnswerRoute } from './jev-routing.js'

export interface ExecutionPlan {
  kind: 'quick' | 'tools' | 'competing'
  route: string
  primary: 'single' | 'configured'
  competingCandidate: boolean
}

/** 2026-10-29 (CLI audit, throughput): `web` is a single executor with the search tool, not a second brain —
 *  the harness competitor only pays off on `deep`. Unknown/unapplied routes stay on the tools plan. */
export function executionPlan(route?: JevRouteRecord): ExecutionPlan {
  const applied = route && 'applied' in route && route.applied ? route.jev : 'unknown'
  if (applied === 'quick' || applied === 'tools') return { kind: applied, route: applied, primary: 'single', competingCandidate: false }
  if (applied === 'unknown' || applied === 'web') return { kind: 'tools', route: applied, primary: 'single', competingCandidate: false }
  return { kind: 'competing', route: applied, primary: 'configured', competingCandidate: true }
}

export interface TurnCandidate {
  text: string
  source: 'primary' | 'harness' | 'reviewer'
  evidence: ToolEvidence[]
  failed?: boolean
  late?: boolean   // 2026-10-31: the primary is still generating; the alternative is gated alone (competing plan)
}
export type Acceptance = { action: 'deliver' | 'review'; pDeliver: number; pDeliverOrders?: [number, number]; positionBias: number; order1: string; order2: string; ms: number } | { error: string; ms: number }
/** A judge may tag its verdict with the private shadow case it scored, so the selection is filed under that case. */
export type JudgeOutcome = JevResult & { caseId?: string }
export interface TurnDecision {
  candidate: TurnCandidate
  reason: string
  result?: JevResult          // the judgment the decision rests on (last pair judge)
  acceptance?: Acceptance     // the acceptance the decision rests on (last gate)
  results: JevResult[]        // 2026-10-29: every pair judgment this turn, in order (bug 8: first verdict was lost)
  acceptances: Acceptance[]   // 2026-10-29: every acceptance gate this turn, in order (bug 7: recovery overwrote the first)
  phaseMs: Record<string, number>
  caseId?: string
  reviews: number
  judgments: number
  plan: ExecutionPlan
}
export interface StepBudget { timeoutMs: number; signal: AbortSignal }
export interface TurnDependencies {
  judge: (alternative: TurnCandidate, primary: TurnCandidate, budget: StepBudget) => Promise<JudgeOutcome>
  assess: (candidate: TurnCandidate, budget: StepBudget) => Promise<Acceptance>
  review: (primary: TurnCandidate, alternative: TurnCandidate | null, budget: StepBudget) => Promise<TurnCandidate | null>
  event: (phase: string, fields?: Record<string, unknown>) => void
  settle?: (primary: TurnCandidate) => string | null   // 2026-11-11: a reason when deterministic checks already settled the turn (no gate)
}

/** Per-turn policy and bounded recovery. Physical GPU ownership stays in the service. */
export class JevTurnCoordinator {
  private decision?: Promise<TurnDecision>
  private deadline = 0
  private reviews = 0
  private judgments = 0
  private results: JevResult[] = []
  private acceptances: Acceptance[] = []
  private phaseMs: Record<string, number> = {}
  private caseId?: string
  constructor(readonly plan: ExecutionPlan, private deps: TurnDependencies,
    private limits = { candidateMs: 30_000, judgeMs: 90_000, reviewMs: 45_000, totalMs: 180_000, margin: .05 }) {}

  select(primary: TurnCandidate, alternative: Promise<TurnCandidate | null> = Promise.resolve(null)): Promise<TurnDecision> {
    return this.decision ??= this.run(primary, alternative)
  }

  private async step<T>(phase: string, limit: number, work: (budget: StepBudget) => Promise<T>): Promise<T> {
    const timeoutMs = Math.min(limit, this.deadline - Date.now())
    if (timeoutMs <= 0) throw new Error('turn-selection-deadline')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const t0 = Date.now()
    this.deps.event(phase)
    try {
      return await Promise.race([Promise.resolve().then(() => work({ timeoutMs, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`${phase}-timeout`)) }, timeoutMs) })])
    } finally {
      if (timer) clearTimeout(timer)
      this.phaseMs[phase] = (this.phaseMs[phase] ?? 0) + (Date.now() - t0)
    }
  }

  private finish(candidate: TurnCandidate, reason: string, result?: JevResult, acceptance?: Acceptance): TurnDecision {
    this.deps.event('selected', { source: candidate.source, reason, reviews: this.reviews, judgments: this.judgments })
    return { candidate, reason, result, acceptance, results: this.results, acceptances: this.acceptances, phaseMs: this.phaseMs, caseId: this.caseId,
      reviews: this.reviews, judgments: this.judgments, plan: this.plan }
  }

  private async assess(candidate: TurnCandidate): Promise<Acceptance> {
    this.judgments++
    let acceptance: Acceptance
    try { acceptance = await this.step('assessing', this.limits.judgeMs, b => this.deps.assess(candidate, b)) }
    catch { acceptance = { error: 'acceptance-unavailable-or-timeout', ms: 0 } }
    this.acceptances.push(acceptance)
    return acceptance
  }

  private async judge(alternative: TurnCandidate, primary: TurnCandidate): Promise<{ route: AnswerRoute; result: JevResult }> {
    this.judgments++
    let result: JudgeOutcome
    try { result = await this.step('judging', this.limits.judgeMs, b => this.deps.judge(alternative, primary, b)) }
    catch { result = { error: 'judge-unavailable-or-timeout', ms: 0 } }
    if (result.caseId) this.caseId = result.caseId
    this.results.push(result)
    return { route: selectAnswerRoute(result, this.limits.margin), result }
  }

  private async review(primary: TurnCandidate, alternative: TurnCandidate | null): Promise<TurnCandidate | null> {
    if (this.reviews >= 1) return null
    this.reviews++
    try {
      const reviewed = await this.step('reviewing', this.limits.reviewMs, b => this.deps.review(primary, alternative, b))
      return reviewed && !reviewed.failed && reviewed.text.trim() ? reviewed : null
    } catch { return null }
  }

  private async recover(primary: TurnCandidate, alternative: TurnCandidate | null, reason: string, result?: JevResult, acceptance?: Acceptance): Promise<TurnDecision> {
    const reviewed = await this.review(primary, alternative)
    if (!reviewed) return this.finish(primary, `${reason}:review-unavailable`, result, acceptance)
    if (reviewed.text.trim() === primary.text.trim()) {
      const again = await this.assess(reviewed)
      return this.finish(primary, `${reason}:${'action' in again && again.action === 'deliver' ? 'jev-deliver-after-review' : 'verification-inconclusive'}`, result, again)
    }
    const next = await this.judge(reviewed, primary)
    return this.finish(next.route.selected === 'harness' ? reviewed : primary, `reviewed:${next.route.reason}`, next.result, acceptance)
  }

  private async run(primary: TurnCandidate, pending: Promise<TurnCandidate | null>): Promise<TurnDecision> {
    this.deadline = Date.now() + this.limits.totalMs
    // 2026-11-11 (optimal grip): on a settled-skill turn the probes are the evidence and the referent/pickup checks
    // passed; Jev's gate said deliver on 25/25 such turns (10-30..11-02 logs). Deliver without opening a Jev window.
    if (this.plan.kind !== 'competing' && !primary.failed) {
      const settled = this.deps.settle?.(primary) ?? null
      if (settled) return this.finish(primary, `settled:${settled}`)
    }
    if (this.plan.kind === 'quick') {
      if (primary.failed) return this.finish(primary, 'primary-unavailable')
      const assessment = await this.assess(primary)
      if ('error' in assessment) return this.finish(primary, 'acceptance-unavailable', undefined, assessment)
      if (assessment.action === 'deliver') return this.finish(primary, 'jev-deliver', undefined, assessment)
      return this.recover(primary, null, 'jev-requested-review', undefined, assessment)
    }
    if (this.plan.kind === 'tools') {
      if (primary.failed) return this.finish(primary, 'executor-failed')
      // 2026-10-29 (CLI audit #1): the RIGHT reviewer used to run on every tools turn and its rewrite was
      // discarded half the time. Jev gates the executor's report first; the critic only runs on a `review`
      // verdict (or when the gate is unavailable). A critic can correct the report but cannot execute or repeat the task.
      const assessment = await this.assess(primary)
      if ('action' in assessment && assessment.action === 'deliver') return this.finish(primary, 'jev-deliver', undefined, assessment)
      return this.recover(primary, null, 'error' in assessment ? 'acceptance-unavailable' : 'evidence-review', undefined, assessment)
    }
    let alternative: TurnCandidate | null
    try { alternative = await this.step('waiting-candidate', this.limits.candidateMs, () => pending) }
    catch { alternative = null }
    if (!alternative || alternative.failed || !alternative.text.trim()) return this.finish(primary, 'harness-unavailable')
    if (primary.failed && primary.late) {
      // 2026-10-31 (optimal grip: stop when settled): the harness answered and the LEFT is still generating past its
      // grace. Gate the harness answer alone, as a tools report; a review can correct it but the pair judge is skipped.
      const assessment = await this.assess(alternative)
      if ('action' in assessment && assessment.action === 'deliver') return this.finish(alternative, 'primary-late:jev-deliver', undefined, assessment)
      return this.recover(alternative, null, 'error' in assessment ? 'primary-late:acceptance-unavailable' : 'primary-late:evidence-review', undefined, assessment)
    }
    if (primary.failed) return this.finish(alternative, 'primary-unavailable')
    const first = await this.judge(alternative, primary)
    if (first.route.reason === 'jev-uncertain' || first.route.reason === 'jev-order-disagreement') {
      return this.recover(primary, alternative, first.route.reason, first.result)
    }
    return this.finish(first.route.selected === 'harness' ? alternative : primary, first.route.reason, first.result)
  }
}
