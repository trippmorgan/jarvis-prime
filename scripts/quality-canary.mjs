#!/usr/bin/env node

import 'dotenv/config'
import { executePlan } from '../dist/orchestrator/execute.js'

const kernelUrl = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const token = process.env.KERNEL_TOKEN ?? ''

if (!token) throw new Error('KERNEL_TOKEN missing')

async function kernel(path, body) {
  const response = await fetch(`${kernelUrl}/api/v1/registry${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`kernel ${path} returned ${response.status}`)
  return response.json()
}

const targets = ['prime', 'scalpel', 'argus', 'dj-jarvis']
const plan = {
  class: 'status',
  summary: 'Daily command-path quality canary',
  steps: targets.map((target) => ({
    target,
    command_type: 'health-check',
    args: { canary: true },
    description: `${target} read-only quality canary`,
  })),
}

const { session } = await kernel('/sessions/start', {
  agent_id: 'agent_orchestrator-prime-jarvis-os',
  channel: 'quality-canary',
  owner: 'prime',
  intent: 'daily read-only command-path canary',
})

let completed = false
let successes = 0
let failures = 0
try {
  for await (const event of executePlan(plan, session.id, 30_000)) {
    if (event.kind === 'step_complete') successes += 1
    if (event.kind === 'step_failed') failures += 1
    if (event.kind === 'orchestration_done') completed = event.result?.completed === true
  }
} finally {
  await kernel(`/sessions/${session.id}/end`, {
    outcome: { completed, kind: 'quality-canary', successes, failures },
  }).catch(() => {})
}

console.log(JSON.stringify({ ok: completed, targets: targets.length, successes, failures }))
if (!completed) process.exitCode = 1
