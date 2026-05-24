// Φ-PHI-Flow Phase 2 / Wave 2 — T6: Prime-side pre-dispatch verify (Insertion B1).
//
// Backbone: phi-flow/.planning/PLAN.md (T6) +
// phi-flow/.planning/research/03-avso-cdp-gateway-broker.md §2 (Insertion B1).
//
// What B1 must do, additively, inside execute.ts:emitCommand(), for the
// PHI-bearing kind set ONLY (isAvsoV2Kind || 'athena-nav' ||
// 'patient-schedule'): immediately BEFORE the kernel emit, call the T5
// broker's verifyDeviceRequest(env, deps) → { decision, code,
// resourceHash, corrId }.
//   • decision==='deny'  → DO NOT emit; reuse the EXISTING step_failed
//     path with reason:'phi-gate-deny:<code>' (fail-closed by reuse →
//     summarizeOrchFailures turns it into an honest, non-PHI message).
//   • decision==='allow' → emit exactly as today.
//   • a NON-PHI kind                → broker is NEVER consulted; emit as today.
//   • a PHI kind with NO device envelope in the redacted ctx → treat as
//     deny (fail-closed), broker not even called.
//
// T5 (sibling, concurrent) owns the broker module (phi-gate.ts). We do
// NOT import it. We inject a MOCK that matches its FROZEN surface:
//   verifyDeviceRequest(env, deps): { decision:'allow'|'deny', code,
//                                     resourceHash, corrId }
//
// HARD: synthetic only, no PHI, no network, no live services. The kernel
// `fetch` is stubbed so a real emit is observable (call count) but never
// leaves the process.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// execute.ts binds KERNEL_TOKEN at module-load time
// (`process.env.KERNEL_TOKEN ?? ''`). vi.hoisted runs BEFORE the
// static import below, so this guarantees kernelFetch() is "armed"
// (token present) and the global fetch stub is actually exercised —
// nothing leaves the process (fetch itself is stubbed in beforeEach).
vi.hoisted(() => {
  process.env.KERNEL_TOKEN = 'zz-test-token'
})

import {
  executePlan,
  __setPhiGateBrokerForTest,
  __resetPhiGateBrokerForTest,
} from '../../orchestrator/execute.js'
import type { Plan, PlanStep, ExecEvent } from '../../orchestrator/types.js'
import { summarizeOrchFailures } from '../../orchestrator/telegram-hook.js'

// ── A synthetic, well-formed device-signed envelope (T3 schema shape).
// No PHI: opaque handles only. This is the non-PHI field that rides in
// the redacted ctx (step.args), exactly like correlation_id does.
const SYNTH_ENVELOPE = {
  v: 1 as const,
  deviceId: 'zzdev-synthetic-0001',
  ts: 1_700_000_000_000,
  nonce: 'ZZsyntheticNonce0001',
  cmd: { kind: 'athena-patient-search', tier: 1 },
  payloadRef: 'phref:zzsynthetic',
  sig: 'zzsig-synthetic-not-real',
}

// ── Kernel fetch stub: records calls, never hits the network. Returns a
// minimal EmitResponse for the emit POST and an empty list for polls so
// the executor short-circuits quickly without a real result.
let fetchCalls: string[] = []
function installKernelFetchStub() {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push(String(url))
      const u = String(url)
      if (u.includes('/envelopes/emit')) {
        return {
          ok: true,
          json: async () => ({
            envelope: { id: 'env-zz-1', status: 'pending', tier_action: 1 },
          }),
        } as unknown as Response
      }
      if (u.includes('/envelopes?parent_envelope_id=')) {
        // One result so the step completes fast (kind 'result').
        return {
          ok: true,
          json: async () => ({ envelopes: [{ id: 'r1', context: { ok: true }, from_agent_id: 'x' }], count: 1 }),
        } as unknown as Response
      }
      if (u.match(/\/envelopes\/[^?]+$/)) {
        return {
          ok: true,
          json: async () => ({ envelope: { id: 'env-zz-1', status: 'pending', failure_type: null } }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({}) } as unknown as Response
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
// jarvis-os/scripts/room-listener/tests/test_phi_gate_b2.py). EVERY
// test in THIS file exercises the ARMED B1 guard (the T6 enforcement
// contract). Wave-2 added the `PHI_GATE_ENFORCE` rollout switch whose
// DEFAULT is DISARMED (passthrough) so AVSO v2 keeps working via
// Telegram before Φ-PHI-Flow is deployed; the disarmed/passthrough
// behavior has its own dedicated file (phi-gate-b1-rollout.test.ts).
// So this enforcement suite must explicitly arm the switch, exactly as
// the Scalpel T7 suite does. Save/restore so nothing bleeds across.
let savedEnforce: string | undefined
beforeEach(() => {
  savedEnforce = process.env.PHI_GATE_ENFORCE
  process.env.PHI_GATE_ENFORCE = '1'
  installKernelFetchStub()
  __resetPhiGateBrokerForTest()
})
afterEach(() => {
  if (savedEnforce === undefined) delete process.env.PHI_GATE_ENFORCE
  else process.env.PHI_GATE_ENFORCE = savedEnforce
  vi.unstubAllGlobals()
  __resetPhiGateBrokerForTest()
})

describe('Φ-PHI-Flow T6 / B1 — Prime-side pre-dispatch verify', () => {
  it('PHI kind + broker DENY → zero emit + step_failed(phi-gate-deny:<code>)', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'bad-sig',
      resourceHash: 'zzhash-deny',
      corrId: 'avso-ps-zz-deny',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search', // a PHI-bearing v2 kind
      args: { correlation_id: 'avso-ps-zz-1', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    // The broker was consulted with the device envelope.
    expect(broker).toHaveBeenCalledTimes(1)
    const [envArg] = broker.mock.calls[0]
    expect(envArg).toMatchObject({ deviceId: 'zzdev-synthetic-0001' })

    // ZERO emit — fail closed; the PHI request never reached the kernel.
    expect(emitCalls()).toBe(0)

    // It reused the EXISTING step_failed path with the deny reason.
    const failed = evs.find((e) => e.kind === 'step_failed')
    expect(failed).toBeTruthy()
    expect(failed?.reason).toBe('phi-gate-deny:bad-sig')

    // And summarizeOrchFailures turns that into an honest, non-PHI line.
    const summary = summarizeOrchFailures(evs)
    expect(summary).toContain('athena-patient-search')
    expect(summary).toContain('phi-gate-deny:bad-sig')
    // No synthetic identity / signature material leaks into the summary.
    expect(summary).not.toContain('zzdev-synthetic-0001')
    expect(summary).not.toContain('zzsig-synthetic-not-real')

    // The run ends (orchestration_done), not hung.
    expect(evs.some((e) => e.kind === 'orchestration_done')).toBe(true)
  })

  it('PHI kind + broker ALLOW → emits exactly as before', async () => {
    const broker = vi.fn(() => ({
      decision: 'allow' as const,
      code: 'ok',
      resourceHash: 'zzhash-allow',
      corrId: 'avso-ps-zz-allow',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-2', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(broker).toHaveBeenCalledTimes(1)
    // Allowed → emitted exactly once, exactly as today.
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('NON-PHI kind → broker is NEVER consulted; emits as today', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const, // would deny if (wrongly) called
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'frank',
      command_type: 'health-check', // a non-PHI kind
      args: {},
    }
    const evs = await drain(planWith(step))

    // Broker untouched, emit happened — non-PHI path is unaffected.
    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('PHI kind with NO device envelope in ctx → deny (fail-closed), broker not called', async () => {
    const broker = vi.fn(() => ({
      decision: 'allow' as const, // even if it WOULD allow, no envelope = deny
      code: 'ok',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-nav', // PHI-bearing (extra set member)
      args: { intent: 'open-orders' }, // NO phi_envelope present
    }
    const evs = await drain(planWith(step))

    // Missing envelope on a PHI kind = fail closed WITHOUT trusting the broker.
    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(0)
    const failed = evs.find((e) => e.kind === 'step_failed')
    expect(failed?.reason).toBe('phi-gate-deny:no-envelope')
  })

  it('patient-schedule (PHI set member) + deny also fails closed', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'revoked',
      resourceHash: 'zzhash',
      corrId: 'zz',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'patient-schedule',
      args: { date: '2026-05-19', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(broker).toHaveBeenCalledTimes(1)
    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe('phi-gate-deny:revoked')
  })

  it('default (no test broker injected) → PHI kind fails closed when phi-gate.ts is absent', async () => {
    // T5 owns phi-gate.ts and is concurrent. Until it lands, the lazy
    // default broker import must FAIL CLOSED for PHI kinds — never emit.
    __resetPhiGateBrokerForTest() // ensure the real lazy default is in effect
    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-3', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(emitCalls()).toBe(0)
    const failed = evs.find((e) => e.kind === 'step_failed')
    expect(failed?.kind).toBe('step_failed')
    expect(String(failed?.reason)).toMatch(/^phi-gate-deny:/)
  })
})
