/**
 * intent.ts — fast-lane-by-default routing (2026-09-04).
 *
 * Tripp: "fast lane by default; long tasks become agent jobs with Telegram
 * monitoring; status/stop; dual brain only when I ask or when Jarvis offers".
 * This is the pure decision. No I/O, no model call, ~microseconds.
 *
 * Precedence: control words → explicit dual → accepting an offer →
 * task-like → deep-looking (answer fast AND offer dual) → fast.
 */

export type Intent =
  | 'control_status'
  | 'control_stop'
  | 'dual_explicit'
  | 'dual_accept'
  | 'task'
  | 'deep_offer'
  | 'fast'

export interface IntentResult {
  intent: Intent
  /** For control_stop: the job number, when given. */
  jobId?: number
  /** For dual_explicit: the message with the trigger phrase removed. */
  stripped?: string
  /** Why (for logs). */
  reason: string
}

export interface IntentContext {
  tier0?: { topRoute: string | null; topCosine: number } | null
  /** A dual-brain offer is pending for this chat (set by a prior deep_offer). */
  pendingDualOffer?: boolean
}

const STATUS_RE = /^\s*(status|jobs|what(?:'s| is) running)\s*[?!.]*\s*$/i
const STOP_RE = /^\s*stop(?:\s+(?:job\s*)?#?\s*(\d+))?\s*[.!]*\s*$/i
const DUAL_RE = /\b(?:use\s+)?dual[\s-]?brain(?:\s+mode)?\b/i
const DUAL_STRIP_RE =
  /^\s*(?:jarvis[,:]?\s*)?(?:please\s+)?(?:use\s+)?dual[\s-]?brain(?:\s+mode)?(?:\s+(?:for|on)\s+(?:this|that)(?:\s+(?:task|one|question))?)?[,:!.\s-]*/i
const ACCEPT_RE = /^\s*(?:yes|yeah|yep|yup|y|ok|okay|sure|go|do it|go ahead|please|deeper|go deep|dual brain)\b[\s!.]*$/i

/** Imperative openers that mean "go do work" rather than "tell me". */
const TASK_VERB_RE =
  /^\s*(?:jarvis[,:]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|go\s+|let's\s+)?(?:check|run|fix|build|deploy|look\s+(?:at|into)|investigate|find\s+out|dig\s+into|ssh|restart|update|write|create|analy[sz]e|review|compare|verify|test|pull|push|install|configure|set\s+up|debug|audit|scan|sync|back\s*up|migrate|clean\s+up|search|grep|tail|diagnose|troubleshoot|make|add|remove|delete|rename|refactor|implement|generate|rebuild|redeploy|commit|export|import|convert|render|publish|schedule|monitor)\b/i
const TASK_PROBLEM_RE =
  /\b(?:why\s+(?:is|are|did|does)|what(?:'s| is)\s+wrong\s+with|is\s+\S+\s+(?:down|up|broken))\b.*\b(?:down|failing|failed|broken|not\s+working|slow|erroring|crash|dead|stuck)\b/i
const TASK_PREFIX_RE = /^\s*(?:task|job|todo)\s*[:\-]/i

const DEEP_RE =
  /\b(?:should\s+(?:i|we)|design|architect(?:ure)?|strategy|strategic|think\s+through|pros\s+and\s+cons|trade-?offs?|philosoph|long[-\s]term|roadmap|plan\s+for|what\s+do\s+you\s+think\s+about|opinion\s+on|consider\s+whether|weigh)\b/i

const TIER0_TASK_ROUTES = new Set(['tool_call', 'dispatch'])
const TIER0_MIN = 0.3

export function detectIntent(text: string, ctx: IntentContext = {}): IntentResult {
  const t = text.trim()
  if (t.length === 0) return { intent: 'fast', reason: 'empty' }

  if (STATUS_RE.test(t)) return { intent: 'control_status', reason: 'status word' }
  const stop = STOP_RE.exec(t)
  if (stop) return { intent: 'control_stop', jobId: stop[1] ? Number(stop[1]) : undefined, reason: 'stop word' }

  if (DUAL_RE.test(t)) {
    const stripped = t.replace(DUAL_STRIP_RE, '').trim() || t.replace(DUAL_RE, '').trim()
    return { intent: 'dual_explicit', stripped, reason: 'dual-brain phrase' }
  }
  if (ctx.pendingDualOffer && ACCEPT_RE.test(t)) return { intent: 'dual_accept', reason: 'accepted pending offer' }

  const tier0 = ctx.tier0 ?? null
  const tier0Task = !!tier0 && tier0.topRoute !== null && TIER0_TASK_ROUTES.has(tier0.topRoute) && tier0.topCosine >= TIER0_MIN
  if (TASK_PREFIX_RE.test(t)) return { intent: 'task', reason: 'task: prefix' }
  if (TASK_VERB_RE.test(t)) return { intent: 'task', reason: 'imperative verb' }
  if (TASK_PROBLEM_RE.test(t)) return { intent: 'task', reason: 'diagnose phrasing' }
  if (tier0Task) return { intent: 'task', reason: `tier0 ${tier0!.topRoute} ${tier0!.topCosine.toFixed(2)}` }

  const tier0Deep = !!tier0 && tier0.topRoute === 'deep_review' && tier0.topCosine >= TIER0_MIN
  if (tier0Deep || (t.length >= 60 && DEEP_RE.test(t))) return { intent: 'deep_offer', reason: tier0Deep ? 'tier0 deep_review' : 'deliberation phrasing' }

  return { intent: 'fast', reason: 'default' }
}

/** Short human title for a job monitor line. */
export function jobTitle(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}
