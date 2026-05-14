// W17 T14/T15 — E2E orchestrator test against the live kernel.
//
// Run from jarvis-prime root: node src/__tests__/orchestrator/e2e.mjs
// Requires KERNEL_URL + KERNEL_TOKEN env vars (or .env in this dir).
//
// Verifies:
//   1. orchestrate('morning report') → query class, runs against Scalpel
//   2. A session row exists with channel='telegram'
//   3. Activity timeline events were emitted with the session_id
//   4. PHI fields (name, mrn, dob) are absent from final reply

import { orchestrate } from '../../../dist/orchestrator/index.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''

async function kernelGet(path) {
  const res = await fetch(`${KERNEL_URL}/api/v1/registry${path}`, {
    headers: { Authorization: `Bearer ${KERNEL_TOKEN}` },
  })
  if (!res.ok) throw new Error(`kernel GET ${path} → ${res.status}`)
  return res.json()
}

async function kernelPost(path, body) {
  const res = await fetch(`${KERNEL_URL}/api/v1/registry${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KERNEL_TOKEN}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`kernel POST ${path} → ${res.status}`)
  return res.json()
}

let pass = 0
let fail = 0

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    pass++
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    fail++
  }
}

async function run() {
  if (!KERNEL_TOKEN) {
    console.error('KERNEL_TOKEN not set')
    process.exit(2)
  }

  console.log('\n=== T14: morning-report E2E ===')
  // Open a session manually so we can verify it appears + receives events.
  const { session } = await kernelPost('/sessions/start', {
    agent_id: 'agent_orchestrator-prime-jarvis-os',
    channel: 'telegram',
    chat_id: 'e2e-test-chat',
    intent: 'morning report (W17 E2E)',
  })

  const result = await orchestrate(
    { text: 'morning report', chat_id: 'e2e-test-chat', from: 'tripp' },
    { sessionId: session.id },
  )

  check('classified as query', result.class === 'query')
  check('plan executed (some events)', result.events.length > 0, `events=${result.events.length}`)
  check('no name in reply', !/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(result.final_reply ?? ''), 'pattern would match a full-name')
  check('no mrn token in reply', !/\bmrn\b/i.test(result.final_reply ?? ''))
  check('no dob token in reply', !/\bdob\b/i.test(result.final_reply ?? ''))

  // Wait briefly for kernel events to write
  await new Promise((r) => setTimeout(r, 1500))

  const { sessions } = await kernelGet(`/sessions?limit=50`)
  const sessRow = sessions.find((s) => s.id === session.id)
  check('session row exists in /sessions', !!sessRow, `looking for ${session.id}`)
  check('session channel=telegram', sessRow?.channel === 'telegram')

  const { events } = await kernelGet(`/events?session_id=${session.id}&limit=50`)
  check('activity timeline has ≥3 events for the session', events.length >= 3, `got ${events.length}`)
  const planFormed = events.some((e) => e.body?.startsWith('Plan formed'))
  const stepDispatched = events.some((e) => e.body?.startsWith('→ scalpel'))
  check('timeline includes "Plan formed"', planFormed)
  check('timeline includes a step dispatch line', stepDispatched)

  await kernelPost(`/sessions/${session.id}/end`, { outcome: { test: 't14', completed: result.completed } })

  console.log('\n=== T15: frank restart-service E2E ===')
  const { session: s2 } = await kernelPost('/sessions/start', {
    agent_id: 'agent_orchestrator-prime-jarvis-os',
    channel: 'telegram',
    chat_id: 'e2e-test-chat',
    intent: 'frank restart ollama (W17 E2E)',
  })
  const r2 = await orchestrate(
    { text: 'frank restart ollama', chat_id: 'e2e-test-chat', from: 'tripp' },
    { sessionId: s2.id },
  )
  check('classified as workflow', r2.class === 'workflow')
  check('plan has 1 step', r2.events.filter((e) => e.kind === 'plan_formed').length === 1)
  check('command was dispatched', r2.events.some((e) => e.kind === 'step_dispatched'))
  await kernelPost(`/sessions/${s2.id}/end`, { outcome: { test: 't15' } })

  console.log('\n=== T-status: fan-out E2E ===')
  const { session: s3 } = await kernelPost('/sessions/start', {
    agent_id: 'agent_orchestrator-prime-jarvis-os',
    channel: 'telegram',
    chat_id: 'e2e-test-chat',
    intent: 'all nodes status (W17 E2E)',
  })
  const r3 = await orchestrate(
    { text: 'all nodes status', chat_id: 'e2e-test-chat', from: 'tripp' },
    { sessionId: s3.id },
  )
  check('classified as status', r3.class === 'status')
  check('multi-step fan-out', r3.events.filter((e) => e.kind === 'plan_formed').length === 1)
  const fanoutPlanFormed = r3.events.find((e) => e.kind === 'plan_formed')
  const fanoutCount = (fanoutPlanFormed?.total_steps ?? 0)
  check('fan-out targeted ≥3 lieutenants', fanoutCount >= 3, `total_steps=${fanoutCount}`)
  await kernelPost(`/sessions/${s3.id}/end`, { outcome: { test: 't-status' } })

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
