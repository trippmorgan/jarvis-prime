// Adversarial workflow-class orchestration tests.
//
// Goes beyond happy-path: classification boundaries, plan coverage,
// tier safety, sequential execution, pause-on-failure, malformed inputs,
// ambiguous intent, deep-brain/orchestrator boundary.

import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../../orchestrator/classify.js'
import { buildPlan } from '../../orchestrator/plan.js'
import { tierFor, COMMAND_TIER } from '../../orchestrator/execute.js'
import type { IntentClass } from '../../orchestrator/types.js'

// ─── 1. Classifier boundary cases ──────────────────────────────────────

describe('classifier: chat vs workflow boundaries', () => {
  it('chat does NOT promote to workflow for casual mentions of services', () => {
    expect(classifyIntent('I was thinking about ollama yesterday')).toBe('chat')
    expect(classifyIntent('frank is a great name for a node')).toBe('chat')
    expect(classifyIntent('what do you think about MCP design?')).toBe('chat')
  })

  it('conversational questions about architecture stay chat', () => {
    expect(classifyIntent('how does the orchestrator work?')).toBe('chat')
    expect(classifyIntent('explain the dual brain system')).toBe('chat')
    expect(classifyIntent('what is the tier model?')).toBe('chat')
  })

  it('imperative "restart" always promotes to workflow regardless of context', () => {
    expect(classifyIntent('restart the thing')).toBe('workflow')
    expect(classifyIntent('stop everything')).toBe('workflow')
    expect(classifyIntent('kill the process')).toBe('workflow')
    expect(classifyIntent('start playoutone')).toBe('workflow')
    expect(classifyIntent('reload nginx')).toBe('workflow')
  })

  // GAP: "restart all nodes" is an imperative (should be workflow) but
  // W18 — fixed. The imperative-verb rule now precedes the status rule
  // in classify.ts RULES order, so "restart all nodes" wins as workflow.
  it('"restart all nodes" → workflow (W18 reorder fixed first-match)', () => {
    expect(classifyIntent('restart all nodes')).toBe('workflow')
  })

  it('"status of all" is status, not workflow', () => {
    expect(classifyIntent('status of all systems')).toBe('status')
    expect(classifyIntent('all nodes status please')).toBe('status')
  })
})

describe('classifier: status edge cases', () => {
  it('health check variants', () => {
    expect(classifyIntent('healthcheck')).toBe('status')
    expect(classifyIntent('health check')).toBe('status')
    expect(classifyIntent('HEALTH CHECK')).toBe('status')
    expect(classifyIntent('run a health check')).toBe('status')
  })

  it("what's alive / running", () => {
    expect(classifyIntent("what's alive")).toBe('status')
    expect(classifyIntent("what's running right now")).toBe('status')
    expect(classifyIntent('whats running')).toBe('status')
  })

  it('node status singular', () => {
    expect(classifyIntent('node status')).toBe('status')
  })
})

describe('classifier: query (PHI) edge cases', () => {
  it('clinical terms trigger query class', () => {
    expect(classifyIntent("tomorrow's cases")).toBe('query')
    expect(classifyIntent('surgery list for today')).toBe('query')
    expect(classifyIntent('OR schedule')).toBe('query')
  })

  it('non-clinical "schedule" does NOT promote to query', () => {
    expect(classifyIntent('schedule a meeting')).toBe('chat')
    expect(classifyIntent('what is on the schedule')).toBe('chat')
  })
})

describe('classifier: workflow service-specific patterns', () => {
  it('named service + action verb', () => {
    expect(classifyIntent('ollama status check')).toBe('workflow')
    expect(classifyIntent('check athena status')).toBe('workflow')
    expect(classifyIntent('investigate music1 issue')).toBe('workflow')
    expect(classifyIntent('debug playoutone')).toBe('workflow')
    expect(classifyIntent('inspect chrome-cdp')).toBe('workflow')
  })

  it('reverse order: action + service', () => {
    expect(classifyIntent('debug chrome-cdp')).toBe('workflow')
    expect(classifyIntent('fix ollama')).toBe('workflow')
    expect(classifyIntent('investigate athena login')).toBe('workflow')
  })

  it('inspect agents / servers', () => {
    expect(classifyIntent('inspect mcp')).toBe('workflow')
    expect(classifyIntent('list servers')).toBe('workflow')
    expect(classifyIntent('inspect agents')).toBe('workflow')
    expect(classifyIntent('list mcp servers')).toBe('workflow')
  })
})

describe('classifier: injection / adversarial inputs', () => {
  it('extremely long input defaults to chat', () => {
    const long = 'a '.repeat(5000)
    expect(classifyIntent(long)).toBe('chat')
  })

  it('null / undefined / non-string defensively returns chat', () => {
    expect(classifyIntent(null as unknown as string)).toBe('chat')
    expect(classifyIntent(undefined as unknown as string)).toBe('chat')
    expect(classifyIntent(42 as unknown as string)).toBe('chat')
  })

  it('regex DOS (catastrophic backtracking) does not hang', () => {
    const start = Date.now()
    classifyIntent('restart ' + 'a'.repeat(500) + '!')
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100)
  })

  it('newlines / control chars in input', () => {
    expect(classifyIntent('restart\nollama\non\nfrank')).toBe('workflow')
    expect(classifyIntent('all\tnodes\tstatus')).toBe('status')
  })

  it('unicode / emoji input defaults to chat', () => {
    expect(classifyIntent('🚀🔥💥')).toBe('chat')
    expect(classifyIntent('статус всех нодов')).toBe('chat')
  })
})

// ─── 2. Plan builder coverage ──────────────────────────────────────────

describe('plan: restart service variations', () => {
  it('restart <service> on <target> — all known targets', () => {
    const targets = ['frank', 'scalpel', 'prime', 'argus', 'dj-jarvis']
    for (const t of targets) {
      const p = buildPlan(`restart nginx on ${t}`, 'workflow')
      expect(p.steps.length).toBe(1)
      expect(p.steps[0].target).toBe(t)
      expect(p.steps[0].command_type).toBe('restart-service')
      expect(p.steps[0].args.service).toBe('nginx')
    }
  })

  it('reverse order: <target>, restart <service>', () => {
    const p = buildPlan('frank, restart pm2-all', 'workflow')
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].args.service).toBe('pm2-all')
  })

  it('service names with hyphens', () => {
    const p = buildPlan('restart jarvis-dispatch on prime', 'workflow')
    expect(p.steps[0].args.service).toBe('jarvis-dispatch')
  })

  it('unknown target → falls through to unmatched plan (not a crash)', () => {
    const p = buildPlan('restart nginx on unknown-node', 'workflow')
    expect(p.steps.length).toBe(0)
    expect(p.summary).toMatch(/don't have a concrete plan/i)
  })
})

describe('plan: chrome-cdp multi-step', () => {
  it('service-first order produces 2 steps: cdp-status then inspect-mcp', () => {
    const p = buildPlan('chrome cdp debug', 'workflow')
    expect(p.steps.length).toBe(2)
    expect(p.steps[0].command_type).toBe('chrome-cdp-status')
    expect(p.steps[1].command_type).toBe('inspect-mcp')
  })

  it('hyphenated variant also produces 2-step plan', () => {
    const p = buildPlan('chrome-cdp debug', 'workflow')
    expect(p.steps.length).toBe(2)
  })

  // GAP: planner only has service-first regex for chrome-cdp. "debug chrome cdp"
  // classifies as workflow but falls through to unmatched plan. Needs a reverse-
  // order pattern in plan.ts (like restart-service has).
  it('KNOWN GAP: verb-first "debug chrome cdp" → classifier=workflow but planner=unmatched', () => {
    expect(classifyIntent('debug chrome cdp')).toBe('workflow')
    const p = buildPlan('debug chrome cdp', 'workflow')
    expect(p.steps.length).toBe(0) // planner can't match
  })

  // GAP: "debug the chrome cdp tool" — classifier's \s+ between verb and service
  // doesn't allow intervening words like "the". Falls all the way to chat.
  it('KNOWN GAP: "debug the chrome-cdp tool" — intervening word breaks classifier', () => {
    expect(classifyIntent('debug the chrome-cdp tool')).toBe('chat')
  })

  it('athena trigger also produces chrome-cdp plan (service-first)', () => {
    const p = buildPlan('check athena debug port', 'workflow')
    expect(p.steps[0].command_type).toBe('chrome-cdp-status')
  })
})

describe('plan: unmatched workflow graceful fallback', () => {
  const unmatchedInputs = [
    'do something weird',
    'deploy the satellite',
    'upgrade kubernetes',
    'analyze the logs from yesterday',
    'brew a fresh pot of coffee',
  ]

  for (const input of unmatchedInputs) {
    it(`"${input}" → empty plan, not a crash`, () => {
      const p = buildPlan(input, 'workflow')
      expect(p.steps.length).toBe(0)
      expect(p.summary).toBeDefined()
      expect(p.summary.length).toBeGreaterThan(0)
    })
  }
})

describe('plan: status plan has empty steps (executor fills)', () => {
  it('status plan always starts with 0 steps', () => {
    const p = buildPlan('all nodes status', 'status')
    expect(p.steps.length).toBe(0)
    expect(p.class).toBe('status')
  })
})

describe('plan: query plans', () => {
  it('all query patterns produce scalpel patient-schedule', () => {
    const queries = ['patient schedule', 'morning report', 'surgery list', 'OR schedule']
    for (const q of queries) {
      const p = buildPlan(q, 'query')
      expect(p.steps.length).toBe(1)
      expect(p.steps[0].target).toBe('scalpel')
      expect(p.steps[0].command_type).toBe('patient-schedule')
    }
  })

  it('unmatched query → empty plan (not a crash)', () => {
    const p = buildPlan('random query text', 'query')
    expect(p.steps.length).toBe(0)
  })
})

// ─── 3. Tier safety gates ──────────────────────────────────────────────

describe('tier: safety classification', () => {
  it('read-only commands are tier 0', () => {
    const tier0 = ['health-check', 'fetch-logs', 'station-query', 'patient-schedule', 'inspect-mcp', 'chrome-cdp-status']
    for (const cmd of tier0) {
      expect(tierFor(cmd)).toBe(0)
    }
  })

  it('mutation commands are tier 1+', () => {
    expect(tierFor('ollama-operation')).toBe(1)
    expect(tierFor('run-diagnostic')).toBe(1)
    expect(tierFor('restart-service')).toBe(2)
    expect(tierFor('execute-script')).toBe(2)
  })

  it('unknown commands default to tier 2 (safe-by-default)', () => {
    expect(tierFor('delete-everything')).toBe(2)
    expect(tierFor('format-disk')).toBe(2)
    expect(tierFor('drop-database')).toBe(2)
    expect(tierFor('')).toBe(2)
  })

  it('no tier 0 command exists that could mutate state', () => {
    const tier0Commands = Object.entries(COMMAND_TIER)
      .filter(([, tier]) => tier === 0)
      .map(([cmd]) => cmd)
    // 'athena-nav' (AVSO v1) is tier-0 and read-only by construction:
    // click-only navigation with NO field-write capability — proven by
    // athena-nav-selftest.js (static + about:blank integration) and the
    // cmd_athena_nav whitelist. It cannot mutate EMR state.
    //
    // 'athena-schedule-date-probe' (AVSO v2, PLAN-v2 T8) is tier-0 and
    // read-only by the same construction: a nav-chrome-only UI
    // classification probe (legacy Calendar vs Appointment-Schedule).
    // It reads chrome markers ONLY — no patient grid/data selectors, no
    // field-write capability, no PHI (SPEC AD10/AD12, T6 driver +
    // synthetic-DOM selftest). It cannot mutate EMR state, so it is in
    // the same read-only family as athena-nav.
    const readOnlyPrefixes = ['health', 'fetch', 'station-query', 'patient', 'athena-nav', 'athena-schedule-date-probe', 'inspect', 'chrome-cdp-status', 'list-', 'read-']
    for (const cmd of tier0Commands) {
      const isSafe = readOnlyPrefixes.some((p) => cmd.startsWith(p))
      expect(isSafe).toBe(true)
    }
  })

  it('COMMAND_TIER has no negative values', () => {
    for (const [cmd, tier] of Object.entries(COMMAND_TIER)) {
      expect(tier).toBeGreaterThanOrEqual(0)
    }
  })
})

// ─── 4. End-to-end classify→plan pipeline ──────────────────────────────

describe('classify→plan integration', () => {
  function classifyAndPlan(text: string) {
    const klass = classifyIntent(text)
    return buildPlan(text, klass)
  }

  it('"restart ollama on frank" → workflow plan with correct step', () => {
    const p = classifyAndPlan('restart ollama on frank')
    expect(p.class).toBe('workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].command_type).toBe('restart-service')
    expect(p.steps[0].args.service).toBe('ollama')
  })

  it('"inspect mcp" → workflow with inspect-mcp step', () => {
    const p = classifyAndPlan('inspect mcp')
    expect(p.class).toBe('workflow')
    expect(p.steps[0].command_type).toBe('inspect-mcp')
  })

  it('"how are you" → chat, no steps', () => {
    const p = classifyAndPlan('how are you doing?')
    expect(p.class).toBe('chat')
    expect(p.steps.length).toBe(0)
  })

  it('"all nodes status" → status, empty steps (filled at runtime)', () => {
    const p = classifyAndPlan('all nodes status')
    expect(p.class).toBe('status')
    expect(p.steps.length).toBe(0)
  })

  it('ambiguous: "start the status check" classifies as workflow (imperative verb wins)', () => {
    const klass = classifyIntent('start the status check')
    expect(klass).toBe('workflow')
  })

  it('"please debug ollama on frank" → workflow', () => {
    const p = classifyAndPlan('please debug ollama on frank')
    expect(p.class).toBe('workflow')
  })
})

// ─── 5. Priority ordering in classifier ────────────────────────────────

describe('classifier priority: first-match-wins', () => {
  it('status patterns take priority over workflow verbs', () => {
    expect(classifyIntent('status of all nodes')).toBe('status')
  })

  it('query (PHI) patterns take priority over generic workflow', () => {
    expect(classifyIntent('patient schedule')).toBe('query')
  })

  it('workflow imperative verbs fire after status and query', () => {
    expect(classifyIntent("let's work on something")).toBe('workflow')
  })
})

// ─── 6. Plan step structure contracts ──────────────────────────────────

describe('plan step contracts', () => {
  it('every step has target, command_type, and args', () => {
    const plans = [
      buildPlan('restart nginx on frank', 'workflow'),
      buildPlan('inspect mcp', 'workflow'),
      buildPlan('debug chrome-cdp', 'workflow'),
      buildPlan('morning report', 'query'),
    ]
    for (const p of plans) {
      for (const step of p.steps) {
        expect(step.target).toBeDefined()
        expect(typeof step.target).toBe('string')
        expect(step.target.length).toBeGreaterThan(0)
        expect(step.command_type).toBeDefined()
        expect(typeof step.command_type).toBe('string')
        expect(step.args).toBeDefined()
        expect(typeof step.args).toBe('object')
      }
    }
  })

  it('restart-service step always has service in args', () => {
    const p = buildPlan('restart pm2 on scalpel', 'workflow')
    expect(p.steps[0].args).toHaveProperty('service')
    expect(typeof p.steps[0].args.service).toBe('string')
  })
})

// ─── 7. Deep-brain boundary ────────────────────────────────────────────

describe('deep-brain vs orchestrator boundary', () => {
  it('architecture questions should NOT trigger orchestration', () => {
    const thinkHard = [
      'what do you think about the orchestrator design?',
      'explain the dual brain corpus callosum',
      'how should we approach the next milestone?',
      'what are the tradeoffs of this tier model?',
      'can you review the codebase architecture?',
    ]
    for (const q of thinkHard) {
      expect(classifyIntent(q)).toBe('chat')
    }
  })

  it('imperative actions should NOT fall into deep-brain', () => {
    const actions = [
      'restart ollama on frank',
      'inspect mcp',
      'debug chrome-cdp',
      'all nodes status',
    ]
    for (const a of actions) {
      expect(classifyIntent(a)).not.toBe('chat')
    }
  })
})

// ─── 8. Edge case: slash commands ──────────────────────────────────────

describe('slash commands vs orchestrator', () => {
  it('slash commands are NOT captured by the classifier (they route earlier)', () => {
    expect(classifyIntent('/station-check')).toBe('chat')
    expect(classifyIntent('/deploy jarvis-prime')).toBe('chat')
    expect(classifyIntent('/network-status')).toBe('chat')
  })
})

// ─── 9. Case insensitivity ─────────────────────────────────────────────

describe('case insensitivity', () => {
  it('all caps', () => {
    expect(classifyIntent('ALL NODES STATUS')).toBe('status')
    expect(classifyIntent('RESTART OLLAMA ON FRANK')).toBe('workflow')
    expect(classifyIntent('MORNING REPORT')).toBe('query')
  })

  it('mixed case', () => {
    expect(classifyIntent('All Nodes Status')).toBe('status')
    expect(classifyIntent('Restart Ollama On Frank')).toBe('workflow')
    expect(classifyIntent('Morning Report')).toBe('query')
  })
})
