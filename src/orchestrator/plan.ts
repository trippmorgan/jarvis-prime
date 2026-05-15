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

  // Station / radio queries → dj-jarvis via jarvis-os envelope bus
  {
    pattern: /\b(what'?s\s+playing|now\s+playing|on\s+(?:the\s+)?air|current\s+(?:song|track))\b/i,
    build: () => ({
      class: 'query',
      summary: 'Checking what\'s currently playing on WPFQ.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'now-playing' },
          description: 'Query PlayoutONE for the current track on WPFQ',
        },
      ],
    }),
  },
  {
    pattern: /\b(station|wpfq|radio)\b.*\b(check|status|health)\b/i,
    build: () => ({
      class: 'query',
      summary: 'Running full WPFQ station health check.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'station-check' },
          description: 'Full station diagnostic — API heartbeat, AE Launcher, DPL coverage, disk, logger',
        },
      ],
    }),
  },
  {
    pattern: /\b(dpl\s+coverage|schedule\s+coverage)\b/i,
    build: () => ({
      class: 'query',
      summary: 'Checking DPL music schedule coverage on WPFQ.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'dpl-coverage' },
          description: 'Check how many days of pre-built music exist in PlayoutONE Playlists',
        },
      ],
    }),
  },
  {
    pattern: /\b(play\s*history|play\s*log)\b/i,
    build: () => ({
      class: 'query',
      summary: 'Pulling recent play history from WPFQ.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'play-history' },
          description: 'Tail the play-history TSV from Pretoria for recent tracks',
        },
      ],
    }),
  },
  {
    pattern: /\b(upcoming\s+(songs?|tracks?|music|schedule))\b/i,
    build: () => ({
      class: 'query',
      summary: 'Listing upcoming tracks on WPFQ.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'upcoming' },
          description: 'List upcoming music rows in the PlayoutONE Playlists table',
        },
      ],
    }),
  },
  {
    pattern: /\b(station|wpfq|radio|pretoria)\b.*\blogs?\b/i,
    build: () => ({
      class: 'query',
      summary: 'Pulling station automation logs from Pretoria.',
      steps: [
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'station-logs' },
          description: 'Tail recent automation logs (watchdog, scheduler, backup)',
        },
      ],
    }),
  },
]

// ─── Workflow plans ─────────────────────────────────────────────────────

const WORKFLOW_PLANS: PatternToPlan[] = [
  // W19b — "morning check" / "morning briefing" / "daily briefing".
  // A single cross-lieutenant workflow that gathers the four
  // most-asked-about signals in one round-trip: clinical schedule
  // (Scalpel, redacted), radio station health (DJ-Jarvis), heavy-compute
  // state (Frank), and Prime's own MCP/agent inventory. Demonstrates
  // multi-target sequential dispatch over the W17 envelope bus.
  {
    pattern: /\b(morning\s+(?:check|briefing|brief)|daily\s+briefing|sit\s*rep)\b/i,
    build: () => ({
      class: 'workflow',
      summary: 'Morning briefing — gathering signals across four lieutenants.',
      steps: [
        {
          target: 'scalpel',
          command_type: 'patient-schedule',
          args: { date: 'today' },
          description: 'Today\'s OR schedule (redacted counts + times)',
        },
        {
          target: 'dj-jarvis',
          command_type: 'station-query',
          args: { query: 'station-check' },
          description: 'WPFQ station health (API, AE Launcher, DPL coverage, disk, logger)',
        },
        {
          target: 'frank',
          command_type: 'health-check',
          args: {},
          description: 'Heavy-compute node liveness + load',
        },
        {
          target: 'prime',
          command_type: 'inspect-mcp',
          args: {},
          description: 'Prime\'s registered MCP servers inventory',
        },
      ],
    }),
  },

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

  // W17.3 — "rerun frank experiment <name>" / "re-run experiment <name> on frank".
  // Even more specific than the read pattern; must come first.
  {
    pattern: /\b(?:rerun|re-run|re-?execute)\s+(?:\w+\s+)?(?:frank|voldemort)?\s*experiments?\s+(?<name>[\w][\w\-]+)/i,
    build: (m) => {
      const name = (m.groups?.name as string)
      return {
        class: 'workflow',
        summary: `Rerunning experiment ${name} on Frank.`,
        steps: [
          {
            target: 'frank',
            command_type: 'rerun-experiment',
            args: { name },
            description: `Re-dispatch question from ${name} through Frank's dual-brain`,
          },
        ],
      }
    },
  },
  // W17.2 — "read frank experiment <name>" / "show frank experiment <name>".
  // More specific than the bare list pattern below; must come first.
  {
    pattern: /\b(?:read|show|fetch|open|details?\s+(?:of|on)?)\s+(?:\w+\s+)?(?:frank|voldemort)\s+experiment(?:s)?\s+(?<name>[\w][\w\-]+)/i,
    build: (m) => {
      const name = (m.groups?.name as string)
      return {
        class: 'workflow',
        summary: `Reading experiment ${name} on Frank.`,
        steps: [
          {
            target: 'frank',
            command_type: 'read-experiment',
            args: { name },
            description: `Read experiment ${name} metadata + first response`,
          },
        ],
      }
    },
  },
  // W17.2 — "list frank experiments" / target-first ("frank: read franks workspace experiments")
  {
    pattern: /\b(?:frank|voldemort)\b.*\bexperiments?\b/i,
    build: () => ({
      class: 'workflow',
      summary: 'Listing experiments in Frank\'s workspace.',
      steps: [
        {
          target: 'frank',
          command_type: 'list-experiments',
          args: { limit: 20 },
          description: 'List recent experiments in Frank\'s workspace',
        },
      ],
    }),
  },
  // W17.2 — reverse word order: "experiments on frank" / "experiments in frank workspace"
  {
    pattern: /\bexperiments?\b.*\b(?:on|in|from)\s+(?:frank|voldemort)/i,
    build: () => ({
      class: 'workflow',
      summary: 'Listing experiments in Frank\'s workspace.',
      steps: [
        {
          target: 'frank',
          command_type: 'list-experiments',
          args: { limit: 20 },
          description: 'List recent experiments in Frank\'s workspace',
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
