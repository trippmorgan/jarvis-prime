import { isJevVerdict, type JevResult } from './harness-race.js'

export interface AnswerRoute {
  selected: 'harness' | 'jarvis'
  reason: 'jev-harness' | 'jev-jarvis' | 'jev-unavailable' | 'jev-uncertain' | 'jev-order-disagreement' | 'invalid-jev-result' | 'harness-unavailable' | 'primary-unavailable'
}

/** Selection probabilities are model preferences, not calibrated correctness estimates. */
export function selectAnswerRoute(result: JevResult | undefined, margin = 0.05): AnswerRoute {
  if (!isJevVerdict(result)) return { selected: 'jarvis', reason: 'jev-unavailable' }
  const p = result.pHarness, bias = result.positionBias
  // Recover P(harness) in each order from the service's average and signed bias.
  const first = p + bias, second = p - bias
  if (result.head !== 'shipped' || !result.order1 || !result.order2 ||
      ![p, result.pJarvis, bias, first, second].every(Number.isFinite) ||
      Math.abs(p + result.pJarvis - 1) > 1e-5 ||
      first < -1e-5 || first > 1 + 1e-5 || second < -1e-5 || second > 1 + 1e-5) {
    return { selected: 'jarvis', reason: 'invalid-jev-result' }
  }
  if (Math.abs(p - 0.5) < margin || Math.abs(p - 0.5) < 1e-6) return { selected: 'jarvis', reason: 'jev-uncertain' }
  if ((first > 0.5) !== (second > 0.5) || Math.abs(first - 0.5) < 1e-6 || Math.abs(second - 0.5) < 1e-6) {
    return { selected: 'jarvis', reason: 'jev-order-disagreement' }
  }
  return p > 0.5 ? { selected: 'harness', reason: 'jev-harness' } : { selected: 'jarvis', reason: 'jev-jarvis' }
}

/** A late candidate can finish but cannot reopen a completed delivery decision. */
export async function waitForCandidate(done: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
