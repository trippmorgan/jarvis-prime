// Φ-PHI-Flow Wave 2 — B1 rollout switch (mirrors T7's `PHI_GATE_ENFORCE`).
//
// Backbone: phi-flow/.planning/PLAN.md (T6/T7 rollout parity) +
// jarvis-os/scripts/room-listener/commands.py:_phi_gate_enforced.
//
// THE GAP THIS COVERS: T6 added the B1 pre-dispatch guard which, for
// PHI-bearing kinds, REQUIRES a signed device envelope and otherwise
// fails closed (`phi-gate-deny:no-envelope`). That is correct ONCE
// Φ-PHI-Flow is deployed. It is NOT deployed (no enrollment/broker
// live), and AVSO v2 (already on Scalpel) is driven via Telegram WITHOUT
// a device envelope — so an always-on B1 would deny every AVSO command.
//
// The Scalpel-side sibling guard (T7, `_phi_gate_guard` /
// `_phi_gate_enforced`) already solved this with an env rollout switch
// `PHI_GATE_ENFORCE` (default/unset = DISARMED = clean passthrough;
// armed = enforce). B1 gets the SAME switch, same env var name, same
// disarmed-default semantics:
//
//   • DISARMED (env unset / not "1"/"true"/"yes"/"on") → B1 is NOT in
//     the path. PHI-bearing kinds with NO envelope emit normally,
//     exactly like pre-T6. Broker is NEVER consulted. True
//     bytes-for-bytes passthrough — NOT fail-open-after-trying.
//   • ARMED (`PHI_GATE_ENFORCE=1`/`true`) → current T6 behavior verbatim
//     (verify device envelope; fail-closed deny on missing/invalid).
//
// This is a ROLLOUT switch, NOT a fail-open: armed it is still strictly
// fail-closed; disarmed the guard simply isn't wired yet because
// Φ-PHI-Flow is not deployed.
//
// HARD: synthetic only, no PHI, no network, no live services. Kernel
// `fetch` is stubbed so emits are observable (call count) but never
// leave the process. Env is set/restored per-test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// execute.ts binds KERNEL_TOKEN at module-load time. vi.hoisted runs
// BEFORE the static import below so kernelFetch() is "armed".
vi.hoisted(() => {
  process.env.KERNEL_TOKEN = 'zz-test-token'
})

import {
  executePlan,
  __setPhiGateBrokerForTest,
  __resetPhiGateBrokerForTest,
} from '../../orchestrator/execute.js'
import { AVSO_V2_KINDS } from '../../orchestrator/types.js'
import type { Plan, PlanStep, ExecEvent } from '../../orchestrator/types.js'

// Synthetic, well-formed device-signed envelope (T3 schema shape). No
// PHI: opaque handles only.
const SYNTH_ENVELOPE = {
  v: 1 as const,
  deviceId: 'zzdev-synthetic-0001',
  ts: 1_700_000_000_000,
  nonce: 'ZZsyntheticNonce0001',
  cmd: { kind: 'athena-patient-search', tier: 1 },
  payloadRef: 'phref:zzsynthetic',
  sig: 'zzsig-synthetic-not-real',
}

let fetchCalls: string[] = []
function installKernelFetchStub() {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(String(url))
      const u = String(url)
      if (u.includes('/envelopes/emit')) {
        return {
          ok: true,
          json: async () => ({ envelope: { id: 'env-zz-1', status: 'pending', tier_action: 1 } }),
        } as unknown as Response
      }
      if (u.includes('/envelopes?parent_envelope_id=')) {
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
  return { class: 'query', steps: [step], summary: 'synthetic rollout test plan' }
}

async function drain(plan: Plan): Promise<ExecEvent[]> {
  const evs: ExecEvent[] = []
  for await (const ev of executePlan(plan)) evs.push(ev)
  return evs
}

// Save/restore PHI_GATE_ENFORCE so no test bleeds into another.
let savedEnforce: string | undefined
beforeEach(() => {
  savedEnforce = process.env.PHI_GATE_ENFORCE
  delete process.env.PHI_GATE_ENFORCE
  installKernelFetchStub()
  __resetPhiGateBrokerForTest()
})
afterEach(() => {
  if (savedEnforce === undefined) delete process.env.PHI_GATE_ENFORCE
  else process.env.PHI_GATE_ENFORCE = savedEnforce
  vi.unstubAllGlobals()
  __resetPhiGateBrokerForTest()
})

describe('Φ-PHI-Flow B1 rollout switch — DISARMED (default, PHI_GATE_ENFORCE unset)', () => {
  it('PHI v2 kind with NO envelope → emits normally (pre-T6), broker NEVER consulted', async () => {
    // This is the exact AVSO-via-Telegram path: no device envelope. Pre-T6
    // it emitted; T6-as-shipped would deny:no-envelope. Disarmed must
    // restore the pre-T6 byte-for-byte behavior.
    const broker = vi.fn(() => ({
      decision: 'deny' as const, // would deny if (wrongly) consulted
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search', // PHI-bearing v2 kind
      args: { correlation_id: 'avso-ps-zz-disarmed-1' }, // NO phi_envelope
    }
    const evs = await drain(planWith(step))

    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('every AVSO v2 kind with NO envelope → all pass through (emit), zero deny', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    for (const kind of AVSO_V2_KINDS) {
      installKernelFetchStub() // reset call log per kind
      const step: PlanStep = {
        target: 'scalpel',
        command_type: kind,
        args: { correlation_id: `avso-zz-${kind}` }, // NO phi_envelope
      }
      const evs = await drain(planWith(step))
      expect(emitCalls(), `kind=${kind} should emit when disarmed`).toBe(1)
      expect(
        evs.find((e) => e.kind === 'step_failed'),
        `kind=${kind} must not fail when disarmed`,
      ).toBeFalsy()
    }
    expect(broker).not.toHaveBeenCalled()
  })

  it('v1 athena-nav with NO envelope → passes through (emit), no deny', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-nav',
      args: { intent: 'open-orders' }, // NO phi_envelope
    }
    const evs = await drain(planWith(step))

    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(1)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('v1 patient-schedule with NO envelope → passes through (emit), no deny', async () => {
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'patient-schedule',
      args: { date: '2026-05-19' }, // NO phi_envelope
    }
    const evs = await drain(planWith(step))

    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(1)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('disarmed is true passthrough — broker NEVER consulted even when an envelope IS present', async () => {
    // Proves disarmed is "guard not in the path", NOT
    // "fail-open-after-trying": with an envelope present and an
    // allow-broker injected, the broker still must not be called.
    const broker = vi.fn(() => ({
      decision: 'allow' as const,
      code: 'ok',
      resourceHash: 'zzhash',
      corrId: 'zz',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-disarmed-env', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(broker).not.toHaveBeenCalled() // not "tried then ignored"
    expect(emitCalls()).toBe(1)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it.each(['', '0', 'false', 'no', 'off', 'disarmed', 'FALSE'])(
    'PHI_GATE_ENFORCE=%j is treated as DISARMED → emits with no envelope',
    async (val) => {
      process.env.PHI_GATE_ENFORCE = val
      const broker = vi.fn(() => ({
        decision: 'deny' as const,
        code: 'should-not-be-called',
        resourceHash: 'x',
        corrId: 'x',
      }))
      __setPhiGateBrokerForTest(broker)

      const step: PlanStep = {
        target: 'scalpel',
        command_type: 'athena-patient-search',
        args: { correlation_id: 'avso-ps-zz-falsey' }, // NO phi_envelope
      }
      const evs = await drain(planWith(step))

      expect(broker).not.toHaveBeenCalled()
      expect(emitCalls()).toBe(1)
      expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
    },
  )
})

describe('Φ-PHI-Flow B1 rollout switch — ARMED (PHI_GATE_ENFORCE=1/true)', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'PHI_GATE_ENFORCE=%j arms the guard: PHI kind + NO envelope → phi-gate-deny:no-envelope, zero emit',
    async (val) => {
      process.env.PHI_GATE_ENFORCE = val
      const broker = vi.fn(() => ({
        decision: 'allow' as const, // even if it WOULD allow, no envelope = deny
        code: 'ok',
        resourceHash: 'x',
        corrId: 'x',
      }))
      __setPhiGateBrokerForTest(broker)

      const step: PlanStep = {
        target: 'scalpel',
        command_type: 'athena-nav',
        args: { intent: 'open-orders' }, // NO phi_envelope
      }
      const evs = await drain(planWith(step))

      expect(broker).not.toHaveBeenCalled()
      expect(emitCalls()).toBe(0)
      const failed = evs.find((e) => e.kind === 'step_failed')
      expect(failed?.reason).toBe('phi-gate-deny:no-envelope')
    },
  )

  it('ARMED + broker DENY → zero emit + step_failed(phi-gate-deny:<code>)', async () => {
    process.env.PHI_GATE_ENFORCE = '1'
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'bad-sig',
      resourceHash: 'zzhash-deny',
      corrId: 'avso-ps-zz-deny',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = {
      target: 'scalpel',
      command_type: 'athena-patient-search',
      args: { correlation_id: 'avso-ps-zz-armed-deny', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(broker).toHaveBeenCalledTimes(1)
    expect(emitCalls()).toBe(0)
    expect(evs.find((e) => e.kind === 'step_failed')?.reason).toBe('phi-gate-deny:bad-sig')
  })

  it('ARMED + broker ALLOW → emits exactly as today', async () => {
    process.env.PHI_GATE_ENFORCE = 'true'
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
      args: { correlation_id: 'avso-ps-zz-armed-allow', phi_envelope: SYNTH_ENVELOPE },
    }
    const evs = await drain(planWith(step))

    expect(broker).toHaveBeenCalledTimes(1)
    expect(emitCalls()).toBe(1)
    expect(evs.some((e) => e.kind === 'step_dispatched')).toBe(true)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })

  it('ARMED — non-PHI kind still bypasses the guard entirely (emit, broker untouched)', async () => {
    process.env.PHI_GATE_ENFORCE = '1'
    const broker = vi.fn(() => ({
      decision: 'deny' as const,
      code: 'should-not-be-called',
      resourceHash: 'x',
      corrId: 'x',
    }))
    __setPhiGateBrokerForTest(broker)

    const step: PlanStep = { target: 'frank', command_type: 'health-check', args: {} }
    const evs = await drain(planWith(step))

    expect(broker).not.toHaveBeenCalled()
    expect(emitCalls()).toBe(1)
    expect(evs.find((e) => e.kind === 'step_failed')).toBeFalsy()
  })
})
