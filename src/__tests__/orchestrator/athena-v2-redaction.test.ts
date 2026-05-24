// AVSO v2 — Wave 1 / T1: command schema + redaction contract.
//
// These tests are the SAFETY CONTRACT. They prove that the four v2
// command kinds (athena-patient-search, athena-input-prepare,
// athena-input-commit, athena-schedule-date-probe) construct command
// contexts that:
//   - carry ONLY {kind, optional field id, risk tier, correlation id,
//     redacted placeholder}
//   - NEVER carry the raw synthetic patient-query / write-text token
//   - DO carry a correlation id + a risk tier + the placeholder
//
// PHI rule: synthetic tokens only. The whole point is asserting these
// tokens are ABSENT from the generated envelope context.

import { describe, it, expect } from 'vitest'
import {
  AVSO_V2_PLACEHOLDER,
  AVSO_V2_KINDS,
  avsoV2Tier,
  newCorrelationId,
  buildAvsoV2Context,
} from '../../orchestrator/types.js'

// Synthetic, obviously-fake tokens. NEVER realistic patient data.
const SYNTH_QUERY = 'ZZSYNTH_PATIENT_Qx'
const SYNTH_WRITE = 'ZZSYNTH_WRITETEXT'

function jsonOf(v: unknown): string {
  return JSON.stringify(v)
}

describe('AVSO v2 — placeholder + kind constants', () => {
  it('placeholder strings are the SPEC-mandated tokens', () => {
    expect(AVSO_V2_PLACEHOLDER.PATIENT_QUERY).toBe('<PATIENT_QUERY>')
    expect(AVSO_V2_PLACEHOLDER.WRITE_TEXT).toBe('<WRITE_TEXT>')
  })

  it('the four v2 kinds are exactly defined', () => {
    expect([...AVSO_V2_KINDS].sort()).toEqual(
      [
        'athena-input-commit',
        'athena-input-prepare',
        'athena-patient-search',
        'athena-schedule-date-probe',
      ].sort(),
    )
  })
})

describe('AVSO v2 — correlation id scheme', () => {
  it('is deterministic-shaped, avso-prefixed, url-safe, and unique', () => {
    const a = newCorrelationId('athena-patient-search')
    const b = newCorrelationId('athena-patient-search')
    expect(a).toMatch(/^avso-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/)
    expect(a).not.toBe(b) // unique per call
    // url-safe: no PHI could ever ride here, but be strict anyway
    expect(a).toBe(encodeURIComponent(a))
  })

  it('accepts an injectable clock + rng for deterministic tests', () => {
    const id = newCorrelationId('athena-input-commit', () => 0, () => 0)
    expect(id).toMatch(/^avso-/)
    // same injected clock/rng → same id (pure function)
    const id2 = newCorrelationId('athena-input-commit', () => 0, () => 0)
    expect(id2).toBe(id)
  })
})

describe('AVSO v2 — risk tiers', () => {
  it('schedule-date-probe is read-only tier 0', () => {
    expect(avsoV2Tier('athena-schedule-date-probe')).toBe(0)
  })
  it('patient-search + input-prepare are tier 1 (PHI driver / staging, no confirm)', () => {
    expect(avsoV2Tier('athena-patient-search')).toBe(1)
    expect(avsoV2Tier('athena-input-prepare')).toBe(1)
  })
  it('input-commit is tier 3 (the write — typed confirm gate)', () => {
    expect(avsoV2Tier('athena-input-commit')).toBe(3)
  })
})

describe('AVSO v2 — redacted context construction (the safety contract)', () => {
  it('patient-search context REDACTS the raw query and carries placeholder + corr id + tier', () => {
    const ctx = buildAvsoV2Context({
      kind: 'athena-patient-search',
      rawPatientQuery: SYNTH_QUERY,
    })
    const blob = jsonOf(ctx)
    // The whole point: the synthetic PHI token must be ABSENT.
    expect(blob).not.toContain(SYNTH_QUERY)
    // …and the placeholder must be PRESENT.
    expect(ctx.patient_query).toBe(AVSO_V2_PLACEHOLDER.PATIENT_QUERY)
    expect(blob).toContain('<PATIENT_QUERY>')
    // …with a correlation id + a numeric risk tier + the kind.
    expect(ctx.kind).toBe('athena-patient-search')
    expect(ctx.correlation_id).toMatch(/^avso-/)
    expect(ctx.risk_tier).toBe(1)
    // no write-text key on a search context
    expect(ctx).not.toHaveProperty('write_text')
  })

  it('input-prepare context REDACTS write text + keeps field id + placeholder', () => {
    const ctx = buildAvsoV2Context({
      kind: 'athena-input-prepare',
      rawWriteText: SYNTH_WRITE,
      fieldId: 'assessment',
    })
    const blob = jsonOf(ctx)
    expect(blob).not.toContain(SYNTH_WRITE)
    expect(ctx.write_text).toBe(AVSO_V2_PLACEHOLDER.WRITE_TEXT)
    expect(blob).toContain('<WRITE_TEXT>')
    expect(ctx.field_id).toBe('assessment')
    expect(ctx.correlation_id).toMatch(/^avso-/)
    expect(ctx.risk_tier).toBe(1)
  })

  it('input-commit context REDACTS write text, is tier 3, and echoes the correlation id', () => {
    const corr = newCorrelationId('athena-input-prepare')
    const ctx = buildAvsoV2Context({
      kind: 'athena-input-commit',
      rawWriteText: SYNTH_WRITE,
      fieldId: 'assessment',
      correlationId: corr, // commit re-uses the prepare's id (ledger linkage)
    })
    const blob = jsonOf(ctx)
    expect(blob).not.toContain(SYNTH_WRITE)
    expect(ctx.write_text).toBe(AVSO_V2_PLACEHOLDER.WRITE_TEXT)
    expect(ctx.correlation_id).toBe(corr)
    expect(ctx.risk_tier).toBe(3)
    expect(ctx.field_id).toBe('assessment')
  })

  it('schedule-date-probe carries NO patient/write text at all (read-only)', () => {
    const ctx = buildAvsoV2Context({
      kind: 'athena-schedule-date-probe',
      date: '2026-05-19',
    })
    const blob = jsonOf(ctx)
    expect(blob).not.toContain(SYNTH_QUERY)
    expect(blob).not.toContain(SYNTH_WRITE)
    expect(ctx).not.toHaveProperty('patient_query')
    expect(ctx).not.toHaveProperty('write_text')
    expect(ctx.date).toBe('2026-05-19')
    expect(ctx.risk_tier).toBe(0)
    expect(ctx.correlation_id).toMatch(/^avso-/)
  })

  it('field id is OPTIONAL — absent when not supplied', () => {
    const ctx = buildAvsoV2Context({
      kind: 'athena-patient-search',
      rawPatientQuery: SYNTH_QUERY,
    })
    expect(ctx).not.toHaveProperty('field_id')
  })

  it('the constructed context whitelist contains ONLY allowed keys (no leak surface)', () => {
    const ctx = buildAvsoV2Context({
      kind: 'athena-input-commit',
      rawWriteText: SYNTH_WRITE,
      fieldId: 'plan',
    })
    const allowed = new Set([
      'kind',
      'field_id',
      'risk_tier',
      'correlation_id',
      'patient_query',
      'write_text',
      'date',
    ])
    for (const k of Object.keys(ctx)) {
      expect(allowed.has(k)).toBe(true)
    }
  })

  it('redaction is deep: even if raw text contains a placeholder-looking substring it is dropped', () => {
    const sneaky = `${SYNTH_WRITE} <PATIENT_QUERY> trailing`
    const ctx = buildAvsoV2Context({
      kind: 'athena-input-prepare',
      rawWriteText: sneaky,
      fieldId: 'hpi',
    })
    expect(jsonOf(ctx)).not.toContain(SYNTH_WRITE)
    expect(ctx.write_text).toBe(AVSO_V2_PLACEHOLDER.WRITE_TEXT)
  })
})

describe('AVSO v2 — plan envelope shape for the four kinds', () => {
  // plan.ts must expose a builder that, for each v2 kind, emits a
  // PlanStep whose args are a redacted v2 context (placeholder + corr
  // id + tier) targeting scalpel. NO routing/classify logic here —
  // contract only.
  it('buildAvsoV2PlanStep emits a redacted scalpel step for patient-search', async () => {
    const { buildAvsoV2PlanStep } = await import('../../orchestrator/plan.js')
    const step = buildAvsoV2PlanStep({
      kind: 'athena-patient-search',
      rawPatientQuery: SYNTH_QUERY,
    })
    expect(step.target).toBe('scalpel')
    expect(step.command_type).toBe('athena-patient-search')
    expect(JSON.stringify(step)).not.toContain(SYNTH_QUERY)
    expect(step.args.patient_query).toBe('<PATIENT_QUERY>')
    expect(step.args.correlation_id).toMatch(/^avso-/)
    expect(step.args.risk_tier).toBe(1)
  })

  it('buildAvsoV2PlanStep emits a redacted scalpel step for input-commit', async () => {
    const { buildAvsoV2PlanStep } = await import('../../orchestrator/plan.js')
    const step = buildAvsoV2PlanStep({
      kind: 'athena-input-commit',
      rawWriteText: SYNTH_WRITE,
      fieldId: 'assessment',
    })
    expect(step.target).toBe('scalpel')
    expect(JSON.stringify(step)).not.toContain(SYNTH_WRITE)
    expect(step.args.write_text).toBe('<WRITE_TEXT>')
    expect(step.args.field_id).toBe('assessment')
    expect(step.args.risk_tier).toBe(3)
  })
})
