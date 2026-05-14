// W17 T9 — Plan builder.
//
// Given a classified message, build a structured Plan that the executor
// can run. The headline cases get hard-coded plans; anything else falls
// back to an empty plan (which the executor reports as "I'm not sure
// how to do that").
//
// Future: dynamic plans via Anthropic call. Hard-coded is fine for v1.

import type { IntentClass, Plan, PlanStep } from './types.js'

interface PatternToPlan {
  pattern: RegExp
  build: (m: RegExpMatchArray) => Plan
}

// ─── Query plans (PHI-aware) ────────────────────────────────────────────

const QUERY_PLANS: PatternToPlan[] = [
  {
    pattern: /\b(patient\s+schedule|morning\s+report|surgery\s+list|or\s+schedule)\b/i,
    build: () => ({
      class: 'query',
      summary: 'Pulling the redacted patient schedule from Scalpel.',
      steps: [
        {
          target: 'scalpel',
          command_type: 'patient-schedule',
          args: { date: 'today' },
          description: 'Fetch today\'s OR schedule (redacted summary; full version stays in clinical-archive)',
        },
      ],
    }),
  },
]

// ─── Workflow plans ─────────────────────────────────────────────────────

const WORKFLOW_PLANS: PatternToPlan[] = [
  // "frank restart ollama" or "restart ollama on frank"
  {
    pattern: /\brestart\s+(?<service>\w+(?:[-]\w+)*)\s+(?:on\s+)?(?<target>frank|scalpel|prime|argus|dj-jarvis)\b/i,
    build: (m) => {
      const service = (m.groups?.service as string).toLowerCase()
      const target = (m.groups?.target as string).toLowerCase()
      return {
        class: 'workflow',
        summary: `Restart ${service} on ${target}.`,
        steps: [
          {
            target,
            command_type: 'restart-service',
            args: { service },
            description: `pm2/systemctl restart ${service}`,
          },
        ],
      }
    },
  },
  {
    pattern: /\b(?<target>frank|scalpel|prime|argus|dj-jarvis)[,\s]+restart\s+(?<service>\w+(?:[-]\w+)*)/i,
    build: (m) => {
      const target = (m.groups?.target as string).toLowerCase()
      const service = (m.groups?.service as string).toLowerCase()
      return {
        class: 'workflow',
        summary: `Restart ${service} on ${target}.`,
        steps: [
          {
            target,
            command_type: 'restart-service',
            args: { service },
            description: `pm2/systemctl restart ${service}`,
          },
        ],
      }
    },
  },
  // "let's work on the athena chrome debugging tool"
  {
    pattern: /\b(athena|chrome[-\s]?cdp)\b.*\b(debug|status|check|inspect|investigat)/i,
    build: () => ({
      class: 'workflow',
      summary: 'Investigating chrome-cdp MCP status.',
      steps: [
        {
          target: 'prime',
          command_type: 'chrome-cdp-status',
          args: {},
          description: 'Probe whether the chrome-cdp debug port is listening',
        },
        {
          target: 'prime',
          command_type: 'inspect-mcp',
          args: {},
          description: 'List registered MCP servers on Prime',
        },
      ],
    }),
  },
  // "inspect mcp"
  {
    pattern: /\binspect\s+mcp\b/i,
    build: () => ({
      class: 'workflow',
      summary: 'Inspecting MCP servers on Prime.',
      steps: [
        {
          target: 'prime',
          command_type: 'inspect-mcp',
          args: {},
          description: 'List registered MCP servers on Prime',
        },
      ],
    }),
  },
]

// ─── Status plan (fan-out helper builds the steps live) ─────────────────

function statusPlan(): Plan {
  return {
    class: 'status',
    summary: 'Health-checking every alive lieutenant.',
    // Steps are filled by the fan-out helper at execute time. The plan
    // executor's status branch reads the live registry and emits one
    // health-check per alive lieutenant.
    steps: [],
  }
}

// ─── Public entry point ─────────────────────────────────────────────────

export function buildPlan(text: string, klass: IntentClass): Plan {
  if (klass === 'chat') {
    return { class: 'chat', summary: 'Conversational reply.', steps: [] }
  }
  if (klass === 'status') return statusPlan()

  const candidates = klass === 'query' ? QUERY_PLANS : WORKFLOW_PLANS
  for (const c of candidates) {
    const m = text.match(c.pattern)
    if (m) return c.build(m)
  }
  // No pattern matched — return a non-actionable plan so the orchestrator
  // can reply with "I'm not sure how to do that yet."
  return {
    class: klass,
    summary: 'I understood the intent but don\'t have a concrete plan template for this yet.',
    steps: [],
  }
}

export type { Plan, PlanStep }
