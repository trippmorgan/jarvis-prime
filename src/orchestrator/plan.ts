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

// W21.10 — resolve a date token from the message to today | tomorrow |
// YYYY-MM-DD so "schedule for Monday" pulls Monday, not today. Pure
// date math (no PHI). Weekday → next occurrence on/after today, ET.
function resolveScheduleDate(text: string): string {
  const t = text.toLowerCase()
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]
  if (/\btomorrow\b/.test(t)) return 'tomorrow'
  if (/\btoday\b/.test(t)) return 'today'
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
  if (m) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const target = days.indexOf(m[1])
    let d = now.getDay()
    let add = (target - d + 7) % 7
    if (add === 0) add = 0 // same weekday → today's clinic
    const dt = new Date(now)
    dt.setDate(now.getDate() + add)
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  }
  return 'today'
}

// AVSO v1 — resolve a nav verb phrase to a W22 nav-map intent name.
// nav-map currently exposes calendar_menu + todays_schedule; "appointment
// book" maps to calendar_menu (the Calendar menu is its entry primitive)
// until an appointment_book intent is captured (SPEC v2, post Appointment
// Schedule migration — ATHENA-NAV-RESEARCH.md §3).
function resolveNavIntent(text: string): string {
  const t = text.toLowerCase()
  if (/\bcalendar\b|\bappointment\s+book\b/.test(t)) return 'calendar_menu'
  return 'todays_schedule' // today's schedule|appointments, schedule, dashboard, home
}

const QUERY_PLANS: PatternToPlan[] = [
  // AVSO v1 — Athena NAVIGATION (read-only, tier-0, NO confirm gate).
  // MUST precede the clinical/export plan so nav verbs navigate instead
  // of pulling a redacted schedule. Mirrors the classify.ts nav rule.
  {
    pattern: /\b(?:open|go\s+to|navigate\s+to|take\s+me\s+to|pull\s+up|bring\s+up|switch\s+to|jump\s+to)\s+(?:the\s+)?(?:athena\s+)?(?:calendar|appointment\s+book|today'?s\s+(?:appointments|schedule)|schedule(?:\s+screen)?|dashboard|athena\s+home|home\s+page)\b/i,
    build: (m) => {
      const intent = resolveNavIntent(m.input ?? '')
      return {
        class: 'query',
        summary: `Navigating Athena on Scalpel (${intent}). Read-only — no patient data leaves the box.`,
        steps: [
          {
            target: 'scalpel',
            command_type: 'athena-nav',
            args: { intent },
            description: `Execute the '${intent}' nav-map intent in Athena (W22). Returns a non-PHI status only.`,
          },
        ],
      }
    },
  },

  {
    pattern: /\bmy\s+(?:or\s+|surgery\s+|clinic\s+|case\s+)?schedule\b|\bschedule\s+(?:for\s+)?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b|\bathena\b[^.\n]{0,24}\b(?:schedul\w*|patient|cases?|emr|clinic|appointment|skill|request|pull)\b|\b(?:schedul\w*|patient|cases?|emr|clinic|appointment)\b[^.\n]{0,24}\bathena\b|\b(?:patient\s+schedule|morning\s+report|surgery\s+list|or\s+schedule|today'?s\s+cases|tomorrow'?s\s+cases)\b/i,
    build: (m) => {
      const date = resolveScheduleDate(m.input ?? '')
      return {
        class: 'query',
        summary: `Pulling the redacted ${date === 'today' ? 'OR' : date} schedule from Scalpel (Athena).`,
        steps: [
          {
            target: 'scalpel',
            command_type: 'patient-schedule',
            args: { date },
            description: `Fetch the ${date} OR schedule (redacted summary; full PHI stays in clinical-archive)`,
          },
        ],
      }
    },
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

// W21 — shared builder for the general X-post templates. social-draft
// (T1, auto) → social-post (T3, typed-confirm). "Confirm at publish
// only" — the draft is rendered at the gate.
function buildXPostPlan(rawTopic: string | undefined): Plan {
  const topic = (rawTopic ?? 'now-playing').trim().replace(/["']/g, '').slice(0, 80) || 'now-playing'
  const args = {
    platform: 'x',
    topic,
    workspace: '/home/tripp/.openclaw/workspace/PretoriaFields',
    context_files: ['README.md', 'PLAYBOOK.md', 'SOCIAL-MEDIA-STRATEGY.md'],
  }
  return {
    class: 'workflow',
    summary: `Drafting a WPFQ X/Twitter post${topic === 'now-playing' ? '' : ` about: ${topic}`}, then pausing for publish confirmation.`,
    steps: [
      {
        target: 'prime',
        command_type: 'social-draft',
        args: { ...args, dry_run: true },
        description: 'Read PretoriaFields docs + live now-playing, draft the ≤280-char X post',
      },
      {
        target: 'prime',
        command_type: 'social-post',
        args: { ...args, dry_run: false },
        description: 'Publish the X post to @xAIDJPretoria (T3 — typed confirmation required)',
      },
    ],
  }
}

// ─── Workflow plans ─────────────────────────────────────────────────────

const WORKFLOW_PLANS: PatternToPlan[] = [
  // Social posting for WPFQ. Target Prime first so the handler can read the
  // PretoriaFields workspace docs (PLAYBOOK + social strategy) before it
  // talks to station systems or any external API. `social-post` is tier 3,
  // so live publishing pauses for typed confirmation instead of blindly
  // posting to X.
  {
    pattern: /\b(post|tweet|send)\b.*\b(x|twitter)\b.*\b(radio|wpfq|pretoria|now\s*playing|station)\b/i,
    build: () => ({
      class: 'workflow',
      summary: 'Preparing a WPFQ X/Twitter post using PretoriaFields workspace context.',
      steps: [
        {
          target: 'prime',
          command_type: 'social-draft',
          args: {
            platform: 'x',
            topic: 'now-playing',
            dry_run: true,
            workspace: '/home/tripp/.openclaw/workspace/PretoriaFields',
            context_files: ['README.md', 'PLAYBOOK.md', 'SOCIAL-MEDIA-STRATEGY.md'],
          },
          description: 'Read PretoriaFields README/playbook/social strategy and draft the WPFQ X/Twitter post',
        },
        {
          target: 'prime',
          command_type: 'social-post',
          args: {
            platform: 'x',
            topic: 'now-playing',
            dry_run: false,
            workspace: '/home/tripp/.openclaw/workspace/PretoriaFields',
            context_files: ['README.md', 'PLAYBOOK.md', 'SOCIAL-MEDIA-STRATEGY.md'],
          },
          description: 'Read PretoriaFields docs, query current WPFQ track, then publish an X/Twitter now-playing post after confirmation',
        },
      ],
    }),
  },
  {
    pattern: /\b(radio|wpfq|pretoria|now\s*playing|station)\b.*\b(post|tweet|send)\b.*\b(x|twitter)\b/i,
    build: () => ({
      class: 'workflow',
      summary: 'Preparing a WPFQ X/Twitter post using PretoriaFields workspace context.',
      steps: [
        {
          target: 'prime',
          command_type: 'social-draft',
          args: {
            platform: 'x',
            topic: 'now-playing',
            dry_run: true,
            workspace: '/home/tripp/.openclaw/workspace/PretoriaFields',
            context_files: ['README.md', 'PLAYBOOK.md', 'SOCIAL-MEDIA-STRATEGY.md'],
          },
          description: 'Read PretoriaFields README/playbook/social strategy and draft the WPFQ X/Twitter post',
        },
        {
          target: 'prime',
          command_type: 'social-post',
          args: {
            platform: 'x',
            topic: 'now-playing',
            dry_run: false,
            workspace: '/home/tripp/.openclaw/workspace/PretoriaFields',
            context_files: ['README.md', 'PLAYBOOK.md', 'SOCIAL-MEDIA-STRATEGY.md'],
          },
          description: 'Read PretoriaFields docs, query current WPFQ track, then publish an X/Twitter now-playing post after confirmation',
        },
      ],
    }),
  },

  // W21 — Process A general entries. Plain "draft a tweet about X" /
  // "post to X about the morning show" with no explicit WPFQ token.
  // Two constrained patterns (so a bare "publish the morning show"
  // can't be hijacked into an X post): (1) literal tweet / x-post
  // token, (2) post|publish|share + explicit "to/on x|twitter". Both
  // build the same 2-step plan: social-draft (T1, auto) → social-post
  // (T3, typed-confirm). Topic extracted after about/re/covering;
  // defaults to now-playing. Draft is surfaced at the confirm gate
  // ("confirm at publish only").
  {
    pattern: /\b(?:tweet|x[-\s]?post)\b(?:[^.\n]*?\b(?:about|re|covering)\s+(?<topic>[^.\n]{2,80}))?/i,
    build: (m) => buildXPostPlan(m.groups?.topic),
  },
  {
    pattern: /\b(?:post|publish|share|put\s+out)\b[^.\n]{0,40}\b(?:to\s+|on\s+)(?:x|twitter)\b(?:[^.\n]*?\b(?:about|re|covering)\s+(?<topic>[^.\n]{2,80}))?/i,
    build: (m) => buildXPostPlan(m.groups?.topic),
  },

  // W21 — Process B: morning-show production. Codifies the pipeline
  // that built the 2026-05-18 show: research → write → render →
  // pull-songs → produce → preview (one auto T1 build step), then a
  // T3 publish step (AutoImporter + verify) that the kernel parks in
  // awaiting_input for typed confirmation. Decision: "preview gate
  // only" — the human checkpoint is the preview shown at the publish
  // gate; scripts are auto-approved. Optional date token: a
  // YYYY-MM-DD, a weekday name, "tomorrow", or "next <weekday>";
  // defaults to the next scheduled (Mon–Fri) show.
  {
    pattern: /\bmorning[-\s]?show\b(?:[^.\n]*?\b(?<date>\d{4}-\d{2}-\d{2}|tomorrow|today|next\s+\w+day|monday|tuesday|wednesday|thursday|friday))?/i,
    build: (m) => {
      const date = (m.groups?.date ?? 'next').trim().toLowerCase()
      return {
        class: 'workflow',
        summary: `Morning-show pipeline for ${date === 'next' ? 'the next scheduled show' : date}: build → preview, then pause for publish confirmation.`,
        steps: [
          {
            target: 'prime',
            command_type: 'morning-show-build',
            args: { date, hours: 'all' },
            description: 'research → write → render → pull-songs → produce → preview (auto; scripts pre-approved)',
          },
          {
            target: 'prime',
            command_type: 'morning-show-publish',
            args: { date },
            description: 'AutoImporter publish + verify Playlists rows (T3 — typed confirmation; preview shown at the gate)',
          },
        ],
      }
    },
  },

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
