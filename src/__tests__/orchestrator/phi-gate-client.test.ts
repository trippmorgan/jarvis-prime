// Φ-PHI-Flow Phase 2 / Wave 3a — G1b: localhost HTTP broker client.
//
// Backbone: phi-flow/.planning/PLAN.md + research/03 §2 (Insertion B1).
//
// Wave 2 T6 added the B1 guard in execute.ts with an injectable
// `phiGateBroker` whose lazy DEFAULT dynamic-imported './phi-gate.js'
// (absent in jarvis-prime → fail-closed). Tripp's decision: the broker
// is a LOCALHOST SERVICE on SuperServer. G1b replaces that lazy
// fail-closed default with a real localhost HTTP client that calls the
// G1a server, keeping T6's guard structure + fail-closed behaviour.
//
// FROZEN SERVICE CONTRACT (sibling G1a builds the server to this):
//   POST http://127.0.0.1:${PHI_GATE_PORT}/verify
//        body {envelope}
//     → 200 {decision:'allow'|'deny',code,resourceHash,corrId,attestation}
//   unreachable / non-200 / timeout / malformed
//     → treat as deny:'broker-unreachable' (FAIL-CLOSED — never allow on
//        doubt).
//
// What this test pins (the DEFAULT broker — NO test broker injected):
//   • PHI kind + service ALLOW (200 allow)        → emit proceeds.
//   • PHI kind + service DENY  (200 deny)         → step_failed
//        (phi-gate-deny:<code>), ZERO emit.
//   • service unreachable / timeout / 500 / garbage JSON
//        → deny:broker-unreachable, ZERO emit (fail-closed).
//   • NON-PHI kind                                → client NEVER called,
//        emits as today.
//
// HARD: synthetic only, no PHI, localhost-only, NO live broker service —
// a tiny throwaway http.Server is bound to 127.0.0.1 on an ephemeral
// port and PHI_GATE_PORT is pointed at it. The kernel `fetch` is stubbed
// so a real emit is observable (call count) but never leaves the process.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'

// execute.ts binds KERNEL_TOKEN at module-load time. vi.hoisted runs
// BEFORE the static import below so kernelFetch() is "armed" (token
// present) and the global fetch stub is actually exercised — nothing
// leaves the process (fetch itself is stubbed in beforeEach).
vi.hoisted(() => {
  process.env.KERNEL_TOKEN = 'zz-test-token'
})

import {
  executePlan,
  __resetPhiGateBrokerForTest,
} from '../../orchestrator/execute.js'
import type { Plan, PlanStep, ExecEvent } from '../../orchestrator/types.js'
import { summarizeOrchFailures } from '../../orchestrator/telegram-hook.js'

// ── A synthetic, well-formed device-signed envelope (T3 schema shape).
// No PHI: opaque handles only. Rides in the redacted ctx (step.args),
// exactly like correlation_id does.
const SYNTH_ENVELOPE = {
  v: 1 as const,
  deviceId: 'zzdev-synthetic-0001',
  ts: 1_700_000_000_000,
  nonce: 'ZZsyntheticNonce0001',
  cmd: { kind: 'athena-patient-search', tier: 1 },
  payloadRef: 'phref:zzsynthetic',
  sig: 'zzsig-synthetic-not-real',
}

// ── A throwaway localhost broker server. Its handler is swapped per
// test. Bound to 127.0.0.1 on an ephemeral port; PHI_GATE_PORT points
// at it so the REAL default client (not an injected mock) hits it.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
let server: http.Server
let handler: Handler
const verifyHits: Array<{ method: string; url: string; body: string }> = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/verify') {
        verifyHits.push({ method: req.method ?? '', url: req.url ?? '', body })
      }
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  process.env.PHI_GATE_PORT = String(port)
})

afterAll(async () => {
  delete process.env.PHI_GATE_PORT
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// ── Kernel fetch stub: records calls, never hits the network. The REAL
// global fetch is restored just for 127.0.0.1 broker calls so the
// default client exercises a true HTTP round-trip to our local server.
const realFetch = globalThis.fetch
let fetchCalls: string[] = []
function installKernelFetchStub() {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const u = String(url)
      // Let the phi-gate client talk to our local throwaway server for real.
      if (u.includes('127.0.0.1') && u.includes('/verify')) {
        return realFetch(url as string, init)
      }
      fetchCalls.push(u)
      if (u.includes('/envelopes/emit')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ envelope: { id: 'env-zz-1', status: 'pending', tier_action: 1 } }),
        } as unknown as Response)
      }
      if (u.includes('/envelopes?parent_envelope_id=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ envelopes: [{ id: 'r1', context: { ok: true }, from_agent_id: 'x' }], count: 1 }),
        } as unknown as Response)
      }
      if (u.match(/\/envelopes\/[^?]+$/)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ envelope: { id: 'env-zz-1', status: 'pending', failure_type: null } }),
        } as unknown as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as unknown as Response)
    }),
  )
}

function emitCalls(): number {
  return fetchCalls.filter((u) => u.includes('/envelopes/emit')).length
}
function planWith(step: PlanStep): Plan {
  return { class: 'query', steps: [step], summary: 'synthetic test plan' }
}
async function drain(plan: Plan): Promise<ExecEvent[]> {
  const evs: ExecEvent[] = []
  for await (const ev of executePlan(plan)) evs.push(ev)
  return evs
}

// ── Rollout-switch arm (mirrors the T7 sibling suite's autouse
// `_arm_enforcement` fixture in
// jarvis-os/scripts/room-listener/tests/test_phi_gate_b2.py). Every
// test in THIS file exercises the ARMED B1 guard against the REAL
// default HTTP broker. Wave-2 added the `PHI_GATE_ENFORCE` rollout
// switch whose DEFAULT is DISARMED (passthrough) so AVSO v2 keeps
// working via Telegram before Φ-PHI-Flow is deployed; the
// disarmed/passthrough behavior has its own dedicated file
// (phi-gate-b1-rollout.test.ts). So this enforcement suite must
// explicitly arm the switch, exactly as the Scalpel T7 suite does.
let savedEnforce: string | undefined
beforeEach(() => {
  savedEnforce = process.env.PHI_GATE_ENFORCE
  process.env.PHI_GATE_ENFORCE = '1'
  verifyHits.length = 0
  installKernelFetchStub()
  __resetPhiGateBrokerForTest() // REAL default broker (the HTTP client)
})
afterEach(() => {
  if (savedEnforce === undefined) delete process.env.PHI_GATE_ENFORCE
  else process.env.PHI_GATE_ENFORCE = savedEnforce
  vi.unstubAllGlobals()
  __resetPhiGateBrokerForTest()
})

describe('Φ-PHI-Flow G1b — localhost HTTP broker client (default broker)', () => {
  it('PHI kind + service ALLOW (200) → POSTs {envelope} to 127.0.0.1/verify, emit proceeds', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          decision: 'allow',
          code: 'ok',
          resourceHash: 'zzhash-allow',
          corrId: 'avso-ps-zz-allow',
          attestation: 'zzattest-allow-token',
        }),
      )
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-1', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    // The default client hit the FROZEN endpoint with the envelope body.
    expect(verifyHits.length).toBe(1)
    expect(verifyHits[0].method).toBe('POST')
    const sent = JSON.parse(verifyHits[0].body)
    expect(sent.envelope).toMatchObject({ deviceId: 'zzdev-synthetic-0001' })

    // Allowed → emitted exactly once, exactly as today.
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('PHI kind + service DENY (200) → ZERO emit + step_failed(phi-gate-deny:<code>)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          decision: 'deny',
          code: 'bad-sig',
          resourceHash: 'zzhash-deny',
          corrId: 'avso-ps-zz-deny',
          attestation: '',
        }),
      )
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-2', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(verifyHits.length).toBe(1)
    expect(emitCalls()).toBe(0)
    const failed = evs.find((e) => e.kind === 'step_failed')
    expect(failed?.reason).toBe('phi-gate-deny:bad-sig')

    // The honest, non-PHI summary path still engages and leaks nothing.
    const summary = summarizeOrchFailures(evs)
    expect(summary).toContain('phi-gate-deny:bad-sig')
    expect(summary).not.toContain('zzdev-synthetic-0001')
    expect(summary).not.toContain('zzsig-synthetic-not-real')
    expect(evs.some((e) => e.kind === 'orchestration_done')).toBe(true)
  })

  it('service 500 → deny:broker-unreachable, ZERO emit (fail-closed)', async () => {
    handler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'kaboom' }))
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-3', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(emitCalls()).toBe(0)
    const failed = evs.find((e) => e.kind === 'step_failed')
    expect(failed?.reason).toBe('phi-gate-deny:broker-unreachable')
  })

  it('service returns garbage (non-JSON) → deny:broker-unreachable, ZERO emit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('not json at all <<<>>>')
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'patient-schedule',
      args: { date: '2026-05-19', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe(
      'phi-gate-deny:broker-unreachable',
    )
  })

  it('service returns 200 but missing/odd decision field → deny:broker-unreachable', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'ok', resourceHash: 'x', corrId: 'y' })) // no `decision`
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-4', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe(
      'phi-gate-deny:broker-unreachable',
    )
  })

  it('service UNREACHABLE (port closed) → deny:broker-unreachable, ZERO emit', async () => {
    const saved = process.env.PHI_GATE_PORT
    // Point at a port nothing is listening on → ECONNREFUSED.
    process.env.PHI_GATE_PORT = '1'
    try {
      const step: PlanStep = {
        target: 'scalpel',
        command_type: 'athena-patient-search',
        args: { correlation_id: 'avso-ps-zz-5', phi_envelope: SYNTH_ENVELOPE },
      }
      const evs = await drain(planWith(step))

      expect(emitCalls()).toBe(0)
      expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe(
        'phi-gate-deny:broker-unreachable',
      )
    } finally {
      process.env.PHI_GATE_PORT = saved
    }
  })

  it('service TIMEOUT (slow response) → deny:broker-unreachable, ZERO emit', async () => {
    handler = (_req, res) => {
      // Never respond within the client's short timeout.
      setTimeout(() => {
        try {
          res.writeHead(200)
          res.end('{}')
        } catch {
          /* socket may already be gone */
        }
      }, 8000).unref()
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-6', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe(
      'phi-gate-deny:broker-unreachable',
    )
  }, 10_000)

  it('NON-PHI kind → broker client is NEVER called; emits as today', async () => {
    handler = (_req, res) => {
      // If wrongly called it would allow — but it must not be called.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ decision: 'allow', code: 'ok', resourceHash: 'x', corrId: 'y', attestation: 'z' }))
    }

    const step: PlanStep = {
      target: 'frank',
      command_type: 'health-check', // a non-PHI kind
      args: {},
    }
    const evs = await drain(planWith(step))

    expect(verifyHits.length).toBe(0) // client never consulted
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('PHI kind with NO device envelope → deny:no-envelope, client NOT called', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ decision: 'allow', code: 'ok', resourceHash: 'x', corrId: 'y', attestation: 'z' }))
    }

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-nav',
      args: { intent: 'open-orders' }, // NO phi_envelope
    }
    const evs = await drain(planWith(step))

    expect(verifyHits.length).toBe(0) // fail closed WITHOUT trusting the broker
    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe(
      'phi-gate-deny:no-envelope',
    )
  })
})
