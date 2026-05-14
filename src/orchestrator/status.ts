// W17 T12 — Status fan-out helper.
//
// Used by buildPlan when class='status'. Reads the live registry for
// alive lieutenants, builds a per-node health-check plan that the
// regular executePlan flow consumes, returns the aggregated table for
// rendering in Telegram.

import type { PlanStep } from './types.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''

// The same set of lieutenant aliases used everywhere else. status fan-out
// targets the canonical `-self` row for each node.
const TARGETS = ['prime', 'frank', 'scalpel', 'argus', 'dj-jarvis'] as const

interface AgentRow {
  id: string
  node: string
  status: string
  importance?: number
}

interface AgentsResponse {
  agents: AgentRow[]
}

/**
 * Discover which lieutenants are alive enough to be worth probing.
 * Returns the subset of TARGETS whose canonical agent has status='running'
 * in the registry. Unreachable kernel → empty list (caller can decide
 * to still fan-out optimistically).
 */
export async function aliveLieutenants(): Promise<string[]> {
  if (!KERNEL_TOKEN) return [...TARGETS]
  try {
    const res = await fetch(`${KERNEL_URL}/api/v1/registry/agents?status=running&limit=500`, {
      headers: { Authorization: `Bearer ${KERNEL_TOKEN}` },
    })
    if (!res.ok) return [...TARGETS]
    const data = (await res.json()) as AgentsResponse
    const running = new Set(data.agents.map((a) => a.node))
    return TARGETS.filter((t) => running.has(t))
  } catch {
    return [...TARGETS]
  }
}

/**
 * Build per-node health-check plan steps. Used by the executor when
 * the plan's class is 'status' and steps[] is empty.
 */
export async function statusFanOutSteps(): Promise<PlanStep[]> {
  const alive = await aliveLieutenants()
  return alive.map((target) => ({
    target,
    command_type: 'health-check',
    args: {},
    description: `${target} health probe`,
  }))
}

interface StatusRow {
  node: string
  ok: boolean
  pm2_online?: number | null
  uptime?: string
  load?: string
  error?: string
}

/**
 * Render an array of fan-out result envelopes as a Markdown table for
 * Telegram. Called by the orchestrator after executePlan completes for
 * a class='status' plan.
 */
export function renderStatusTable(rows: StatusRow[]): string {
  const lines: string[] = []
  lines.push('*Node status*')
  lines.push('```')
  lines.push('node         ok   load     pm2   uptime')
  for (const r of rows) {
    const ok = r.ok ? '✓' : '✗'
    const load = (r.load ?? '-').padEnd(8)
    const pm2 = String(r.pm2_online ?? '-').padEnd(5)
    const up = (r.uptime ?? '-').slice(0, 25)
    lines.push(`${r.node.padEnd(12)} ${ok}    ${load} ${pm2} ${up}`)
  }
  lines.push('```')
  return lines.join('\n')
}

/**
 * Parse a fan-out result envelope's context into a StatusRow.
 */
export function parseStatusRow(node: string, ctx: Record<string, unknown> | null): StatusRow {
  if (!ctx) return { node, ok: false, error: 'no result' }
  const ok = ctx.ok === true
  const uptime = typeof ctx.uptime === 'string' ? ctx.uptime : undefined
  const load = uptime ? (uptime.match(/load average:\s+([\d.]+)/)?.[1]) : undefined
  return {
    node,
    ok,
    pm2_online: typeof ctx.pm2_online === 'number' ? ctx.pm2_online : null,
    uptime: uptime?.split('up')[1]?.trim().split(',')[0],
    load,
  }
}
