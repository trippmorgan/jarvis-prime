import { localService, shadowDir } from './shadow-review.js'
import { withShadowLock } from './shadow-lock.js'
import type { Acceptance, StepBudget, TurnCandidate } from './jev-turn.js'
import type { HarnessRaceConfig } from './harness-race.js'

export const DELIVER_OPTION = 'Deliver this answer as written: it fulfills the request and its factual or execution claims are supported by the supplied evidence.'
export const REVIEW_OPTION = 'Request one evidence-based review or revision before delivery: the answer is incomplete, unsupported, or needs correction.'

export function candidateEvidence(candidate: TurnCandidate): string {
  const steps = candidate.evidence.slice(-8).map((e, i) => `${i + 1}. ${e.tool} [${e.status ?? 'observed'}] ${e.input.slice(0, 160)}\n${e.result.slice(0, 320)}`)
  return steps.length ? steps.join('\n') : '(No execution evidence was captured; do not infer that execution succeeded.)'
}

/**
 * 2026-10-20: what the (no-tools) LLM reviewer sees. The Jev acceptance gate above is a small classifier and keeps
 * its 8-step window; the reviewer has a large context, so it gets the whole turn in order: the last `fullSteps`
 * with long results, every earlier step with a short result, under a total character budget that drops the
 * OLDEST compact lines first. Steps are numbered chronologically so "1." is what ran first.
 */
export function reviewerEvidence(candidate: TurnCandidate, opts: { fullSteps?: number; inputChars?: number; resultChars?: number; compactResultChars?: number; totalChars?: number } = {}): string {
  const { fullSteps = 24, inputChars = 300, resultChars = 1200, compactResultChars = 240, totalChars = 36_000 } = opts
  const all = candidate.evidence
  if (!all.length) return '(No execution evidence was captured; do not infer that execution succeeded.)'
  const cut = Math.max(0, all.length - fullSteps)
  const line = (e: TurnCandidate['evidence'][number], i: number, chars: number) =>
    `${i + 1}. ${e.tool} [${e.status ?? 'observed'}] ${e.input.slice(0, inputChars)}\n${e.result.slice(0, chars)}`
  const full = all.slice(cut).map((e, j) => line(e, cut + j, resultChars))
  const compact = all.slice(0, cut).map((e, j) => line(e, j, compactResultChars))
  let dropped = 0
  const size = () => [...compact, ...full].join('\n').length
  while (compact.length && size() > totalChars) { compact.shift(); dropped++ }
  const head = `EXECUTION EVIDENCE: ${all.length} tool step(s) this turn, in order${dropped ? ` (the ${dropped} oldest omitted for length)` : ''}. ` +
    'A claim matching a result below is OBSERVED, even if it appears early in the list.'
  return [head, ...compact, ...full].join('\n')
}

/** Both option orders gate a single answer without generating an unnecessary competitor.
 *  2026-10-29 (CLI audit): the old rule (average ≥ .65 AND both orders > .5) delivered 0 of 4 quick answers in
 *  production and sent every one to a reviewer. Rule now: both orders prefer DELIVER above `jevAcceptMin`
 *  (default .5, env FRANK_JEV_ACCEPT_MIN). Per-order values are returned so the gate can be calibrated later. */
export async function askJevAcceptance(cfg: HarnessRaceConfig, task: string, candidate: TurnCandidate, budget: StepBudget,
  fetchImpl: typeof fetch = fetch): Promise<Acceptance> {
  const start = Date.now()
  const minDeliver = typeof cfg.jevAcceptMin === 'number' && Number.isFinite(cfg.jevAcceptMin) ? Math.min(.95, Math.max(.5, cfg.jevAcceptMin)) : .5
  if (!cfg.jevUrl || !localService(cfg.jevUrl)) return { error: 'acceptance-requires-local-jev', ms: 0 }
  try {
    return await withShadowLock(shadowDir(), async () => {
      const deliver: number[] = [], slotA: number[] = [], hashes: string[] = []
      for (const options of [[DELIVER_OPTION, REVIEW_OPTION], [REVIEW_OPTION, DELIVER_OPTION]]) {
        const r = await fetchImpl(`${cfg.jevUrl!.replace(/\/$/, '')}/decide`, {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
          signal: AbortSignal.any([budget.signal, AbortSignal.timeout(budget.timeoutMs)]),
          body: JSON.stringify({ state: `TASK:\n${task.slice(0, 2000)}\n\nEXECUTION EVIDENCE:\n${candidateEvidence(candidate)}\n\nANSWER:\n${candidate.text.slice(0, 6000)}`,
            question: 'What should happen to this answer before the user receives it?', options, head: 'shipped', delivery_gate: true }),
        })
        if (!r.ok) throw new Error('acceptance-http-error')
        const d = await r.json() as { head?: string; hash?: string; probabilities?: Record<string, number> }
        const a = d.probabilities?.[options[0]], b = d.probabilities?.[options[1]]
        if (d.head !== 'shipped' || !d.hash || typeof a !== 'number' || typeof b !== 'number' || ![a, b].every(Number.isFinite) || a < 0 || b < 0 || a > 1 || b > 1 || Math.abs(a + b - 1) > 1e-5) throw new Error('invalid-acceptance-result')
        deliver.push(d.probabilities![DELIVER_OPTION]); slotA.push(a); hashes.push(d.hash)
      }
      const pDeliver = (deliver[0] + deliver[1]) / 2
      return { action: deliver.every(p => p > minDeliver) ? 'deliver' : 'review', pDeliver, pDeliverOrders: [deliver[0], deliver[1]],
        positionBias: (slotA[0] + slotA[1]) / 2 - .5, order1: hashes[0], order2: hashes[1], ms: Date.now() - start }
    })
  } catch { return { error: 'acceptance-unavailable-or-invalid', ms: Date.now() - start } }
}
