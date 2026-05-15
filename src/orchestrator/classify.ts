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
  // Station / radio queries → dj-jarvis (before generic status so "wpfq health check" routes to station)
  { pattern: /\b(what'?s\s+playing|now\s+playing|on\s+(?:the\s+)?air|current\s+(?:song|track))\b/i, klass: 'query' },
  { pattern: /\b(station|wpfq|radio|pretoria)\b.*\b(check|status|health|playing|coverage|upcoming|logs?)\b/i, klass: 'query' },
  { pattern: /\b(check|show|get)\b.*\b(station|wpfq|radio|what'?s\s+playing)\b/i, klass: 'query' },
  { pattern: /\b(dpl\s+coverage|play\s*history|play\s*log|schedule\s+coverage)\b/i, klass: 'query' },
  { pattern: /\b(upcoming\s+(songs?|tracks?|music|schedule))\b/i, klass: 'query' },

  // Status / health (generic — station-specific queries already captured above)
  { pattern: /\b(all\s+nodes|health\s*check|what'?s\s+(running|alive)|status\s+(of|all)|nodes?\s+status)\b/i, klass: 'status' },

  // Clinical query (PHI path; PHI redactor must fire)
  { pattern: /\b(patient\s+schedule|morning\s+report|surgery\s+list|or\s+schedule|today'?s\s+cases|tomorrow'?s\s+cases)\b/i, klass: 'query' },

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

/**
 * Stub for the LLM fallback. Returns 'chat' until W18 wires the
 * Anthropic call. Kept here so the orchestrator can call it without
 * conditional logic; cost stays zero in v1.
 */
export async function classifyIntentWithLLM(text: string): Promise<IntentClass> {
  void text
  return 'chat'
}
