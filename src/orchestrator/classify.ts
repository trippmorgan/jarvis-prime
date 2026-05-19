// W17 T8 — Intent classifier.
//
// Hard-coded keyword rules first; an Anthropic LLM fallback is stubbed
// so plain conversational messages (the most common case) cost zero.
// Future iteration: when the keyword rules don't match cleanly, fall
// back to a single Anthropic classification call.

import type { IntentClass } from './types.js'

interface ClassRule {
  pattern: RegExp
  klass: IntentClass
}

// Order matters — first match wins. More specific rules go first.
const RULES: ClassRule[] = [
  // W21 — explicit "post/tweet/send … X … (wpfq|now-playing|station)"
  // outranks the station query rules below: an intent to *publish to X*
  // about the now-playing track is a workflow, not a now-playing query.
  // These require post-verb + x/twitter, so they never steal a plain
  // "what's playing" / "station check".
  { pattern: /\b(post|tweet|send)\b.*\b(x|twitter)\b.*\b(radio|wpfq|pretoria|now\s*playing|station)\b/i, klass: 'workflow' },
  { pattern: /\b(radio|wpfq|pretoria|now\s*playing|station)\b.*\b(post|tweet|send)\b.*\b(x|twitter)\b/i, klass: 'workflow' },

  // Station / radio queries → dj-jarvis (before generic status so "wpfq health check" routes to station)
  { pattern: /\b(what'?s\s+playing|now\s+playing|on\s+(?:the\s+)?air|current\s+(?:song|track))\b/i, klass: 'query' },
  { pattern: /\b(station|wpfq|radio|pretoria)\b.*\b(check|status|health|playing|coverage|upcoming|logs?)\b/i, klass: 'query' },
  { pattern: /\b(check|show|get)\b.*\b(station|wpfq|radio|what'?s\s+playing)\b/i, klass: 'query' },
  { pattern: /\b(dpl\s+coverage|play\s*history|play\s*log|schedule\s+coverage)\b/i, klass: 'query' },
  { pattern: /\b(upcoming\s+(songs?|tracks?|music|schedule))\b/i, klass: 'query' },

  // W18 — imperative verbs trump status patterns. "restart all nodes"
  // is a workflow even though it contains "all nodes". Placed BEFORE the
  // generic status rule so the verb wins the match race.
  { pattern: /^\s*(restart|stop|start|kill|reload|deploy|rebuild)\s+/i, klass: 'workflow' },

  // Status / health (generic — station-specific queries already captured above)
  { pattern: /\b(all\s+nodes|health\s*check|what'?s\s+(running|alive)|status\s+(of|all)|nodes?\s+status)\b/i, klass: 'status' },

  // AVSO v1 — Athena NAVIGATION (read-only, no PHI). A leading nav verb
  // + an Athena nav target. Placed BEFORE the W21.10 clinical/export
  // rule so "open the calendar" / "go to the schedule" route to the
  // nav plan, while data-retrieval phrasings ("show me my schedule",
  // "today's cases", anything with "my … schedule") fall through to the
  // export rule below. "my" is intentionally NOT an allowed determiner
  // (that signals export). Decoys ("schedule a meeting", "open the
  // door") lack a nav target → stay chat. klass=query so plan.ts picks
  // the athena-nav plan from QUERY_PLANS.
  { pattern: /\b(?:open|go\s+to|navigate\s+to|take\s+me\s+to|pull\s+up|bring\s+up|switch\s+to|jump\s+to)\s+(?:the\s+)?(?:athena\s+)?(?:calendar|appointment\s+book|today'?s\s+(?:appointments|schedule)|schedule(?:\s+screen)?|dashboard|athena\s+home|home\s+page)\b/i, klass: 'query' },

  // AVSO v2 — PATIENT NAVIGATION (blind typist into Athena
  // input#searchinput). Placed AFTER the v1 nav rule so v1 nav targets
  // ("pull up the calendar / appointment book / today's schedule") stay
  // the v1 nav plan; this rule needs a PATIENT signal — "chart for X",
  // "(pull up|open) patient X", or "search for patient X in athena". The
  // patient string is PHI; classify carries NOTHING but the class — the
  // redaction happens in plan.ts (placeholder + corr-id). Decoys ("pull
  // up the weather / news / that song") lack chart/patient → stay chat.
  // klass=query so plan.ts builds the athena-patient-search step.
  { pattern: /\b(?:open|pull\s+up|bring\s+up|find|look\s+up)\s+(?:the\s+)?(?:patient\s+)?chart\s+(?:for|of)\s+\S/i, klass: 'query' },
  { pattern: /\b(?:open|pull\s+up|bring\s+up|find|look\s+up)\s+(?:the\s+)?patient\s+\S/i, klass: 'query' },
  { pattern: /\bsearch\s+(?:for\s+)?(?:the\s+)?patient\s+.+?\b(?:in|on|via)\s+athena\b|\bsearch\s+athena\s+(?:for\s+)?(?:the\s+)?patient\s+\S/i, klass: 'query' },

  // AVSO v2 — FREE-TEXT INPUT write ("type/dictate/enter/write '<x>'
  // into|in <field>"). Requires a write verb + an explicit destination
  // ("into"/"in"/"to") so plain "type faster" / "what should I dictate"
  // stay chat. klass=workflow so plan.ts builds the two-phase
  // prepare(T1)→commit(T3) plan (or v2b-deferred / clarify). The
  // dictated text is PHI — classify carries only the class; redaction is
  // plan.ts's job (placeholder + corr-id).
  { pattern: /\b(?:type|dictate|enter|write|put|insert|add|append)\b[^.\n]*?\b(?:in|into|onto|on)\s+(?:the\s+)?(?:\w+[-\s]?)*\b(?:field|box|note|hpi|history|assessment|plan|complaint|impression|comment|free[-\s]?text|chief\s+complaint|problem\s+list|medication|meds?|order|orders?|diagnos[ei]s|dx|icd|disposition|allerg(?:y|ies))\b/i, klass: 'workflow' },
  { pattern: /\b(?:type|dictate|enter|write|insert|append)\s+["'].+?["']/i, klass: 'workflow' },
  { pattern: /\b(?:add|append|put)\s+["'].+?["']\s+(?:in|into|onto|to|on)\b/i, klass: 'workflow' },
  { pattern: /\bset\s+(?:the\s+)?(?:\w+[-\s]?)*\b(?:hpi|history|assessment|plan|note|impression|comment|disposition|problem\s+list|medication|meds?|order|orders?|diagnos[ei]s|dx|icd|allerg(?:y|ies))\b\s+to\b/i, klass: 'workflow' },

  // Clinical query (PHI path; PHI redactor must fire)
  // W21.10 — clinical / Athena. "use the athena skill" and "check my
  // schedule for Monday" were falling to chat (no live Athena there) →
  // "Athena request failed?". Broadened on CLINICAL signals only —
  // `athena`, possessive "my … schedule", "schedule for <day>" — so
  // the adversarial guards ("schedule a meeting", bare "what is on the
  // schedule") still stay chat. All of this routes to the PHI-SAFE
  // scalpel patient-schedule handler (redacted aggregates only).
  { pattern: /\bmy\s+(?:or\s+|surgery\s+|clinic\s+|case\s+)?schedule\b|\bschedule\s+(?:for\s+)?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|this\s+week|\d{4}-\d{2}-\d{2})\b|\bathena\b[^.\n]{0,24}\b(?:schedul\w*|patient|cases?|emr|clinic|appointment|skill|request|pull)\b|\b(?:schedul\w*|patient|cases?|emr|clinic|appointment)\b[^.\n]{0,24}\bathena\b|\b(?:patient\s+schedule|morning\s+report|surgery\s+list|or\s+schedule|today'?s\s+cases|tomorrow'?s\s+cases)\b/i, klass: 'query' },

  // W21 — Process A (X post), general phrasings. A plain "draft a tweet
  // about the new morning show" still orchestrates instead of falling
  // to chat. social-draft is T1 (auto), social-post is T3 (typed
  // confirm) — i.e. "confirm at publish only". (The WPFQ-specific
  // post-to-X rules live at the very top, above the station queries.)
  { pattern: /\b(post|send|write|draft|compose|publish|do|make|create|put\s+out)\b[^.\n]{0,40}\b(a\s+|an\s+|the\s+)?(tweet|x[-\s]?post)\b/i, klass: 'workflow' },
  { pattern: /\b(post|publish|share|put\s+out)\b[^.\n]{0,60}\b(to\s+|on\s+)?(x|twitter)\b/i, klass: 'workflow' },
  { pattern: /\btweet\s+(about|that|this|out)\b/i, klass: 'workflow' },

  // W21 — Process B (morning-show production pipeline). Distinct from
  // the W19b "morning briefing/sitrep" rule below (different tokens —
  // "morning show" ≠ "morning briefing"). research→write→render→
  // pull-songs→produce→preview is T1 (auto, preview gate); publish is
  // T3 (typed confirm). Tripp's own phrasing — "designed and published
  // the morning show" — matches the first rule via "design".
  { pattern: /\b(?:build|produc|mak|creat|design|generat|prep|publish|preview|deploy|render|deliver|do|run)\w*\b[^.\n]{0,40}\bmorning[-\s]?show\b/i, klass: 'workflow' },
  { pattern: /\bmorning[-\s]?show\b[^.\n]{0,40}\b(?:build|produc|publish|preview|status|pipeline|production|deploy|render)\w*\b/i, klass: 'workflow' },

  // Imperative workflow ("let's work on", "build", "debug", named services)
  { pattern: /^(let'?s|we should|please|hey jarvis,?)\s+(work on|build|debug|investigate|look into|fix|set up)/i, klass: 'workflow' },
  { pattern: /\b(restart|stop|start|kill|reload)\s+(the\s+)?\w+/i, klass: 'workflow' },
  { pattern: /\b(athena|chrome[-\s]?cdp|ollama|playoutone|music1)\b.*\b(debug|fix|status|check|inspect|investigat)/i, klass: 'workflow' },
  { pattern: /\b(debug|fix|inspect|investigat)\w*\s+(athena|chrome[-\s]?cdp|ollama|playoutone|music1|mcp)\b/i, klass: 'workflow' },

  // W17.2 — Frank workspace / experiments. Two word orders covered:
  //   "show me frank experiments" / "list frank experiments" / "utilizing frank, read franks workspace experiments"
  //   "experiments on frank" / "experiments in frank workspace"
  // W17.3 — also "rerun frank experiment <name>" — caught by the same broad rules.
  { pattern: /\b(frank|voldemort)\b.*\b(experiments?|workspace|methodology)\b/i, klass: 'workflow' },
  { pattern: /\b(experiments?|workspace|methodology)\b.*\b(on|in|from)\s+(frank|voldemort)\b/i, klass: 'workflow' },
  { pattern: /\b(rerun|re-run|re-?execute)\b.*\bexperiment/i, klass: 'workflow' },

  // W19b — cross-lieutenant "morning check" / "morning briefing".
  { pattern: /\b(morning\s+(?:check|briefing|brief)|daily\s+briefing|sit\s*rep)\b/i, klass: 'workflow' },

  // Simple plumbing checks
  { pattern: /\b(inspect|list)\s+(mcp|servers?|agents?)\b/i, klass: 'workflow' },
]

/**
 * Classify a Telegram message into one of {chat, query, workflow, status}.
 *
 * The default is 'chat' — meaning Prime answers conversationally with no
 * lieutenant orchestration. Only when a rule matches do we promote to a
 * non-chat class.
 */
export function classifyIntent(text: string): IntentClass {
  if (!text || typeof text !== 'string') return 'chat'
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'chat'
  if (trimmed.startsWith('/')) return 'chat'
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return rule.klass
  }
  return 'chat'
}

// W18: the LLM fallback now lives in classify-llm.ts and runs against
// Frank's local OpenAI-compatible brain. The old stub is gone; the
// orchestrator imports classifyIntentWithLLM directly from the new file.
