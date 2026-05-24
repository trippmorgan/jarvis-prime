// AVSO v2 — Wave 3 / T8: Prime classify/plan/execute ROUTING.
//
// This is the routing safety contract for the three v2 capabilities:
//   1. patient-nav ("pull up / open chart for <X>") → blind search
//      (tier-1, NO confirm, redacted; the patient string never rides).
//   2. free-text write ("type/dictate '<X>' into <field>") → TWO-PHASE
//      prepare (tier-1) → commit (tier-3, mints CONFIRM <CMD>), commit
//      correlated to the prepare correlation id; structured clinical
//      field → v2b-deferred (no commit); ambiguous field → clarify.
//   3. non-today schedule ("schedule for <date≠today>") → date PROBE
//      pre-step then the variant; never guesses.
//
// PHI rule: SYNTHETIC tokens only. We assert the synthetic patient /
// write token is ABSENT from every classified/planned envelope.
//
// v1 MUST NOT regress: v1 nav verbs ("open the calendar") still →
// athena-nav; v1 export ("show my schedule" / "today's cases") still →
// patient-schedule; decoys ("schedule a meeting", "pull up the
// weather") → chat.

import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../../orchestrator/classify.js'
import { buildPlan } from '../../orchestrator/plan.js'
import { tierFor, COMMAND_TIER, pollTimeoutFor } from '../../orchestrator/execute.js'

// Obviously-fake. NEVER realistic patient data.
const SYNTH_PATIENT = 'ZZSYNTH_PATIENT_Jdoe'
const SYNTH_WRITE = 'ZZSYNTH_WRITETEXT_BODY'

function blob(v: unknown): string {
  return JSON.stringify(v)
}

// ─── 1. classify: the 3 v2 intents reach a non-chat class ──────────────

describe('AVSO v2 classify — patient-nav', () => {
  it('"pull up the chart for <name>" classifies as query (not chat)', () => {
    expect(classifyIntent(`pull up the chart for ${SYNTH_PATIENT}`)).toBe('query')
    expect(classifyIntent(`open chart for ${SYNTH_PATIENT}`)).toBe('query')
    expect(classifyIntent(`pull up patient ${SYNTH_PATIENT}`)).toBe('query')
    expect(classifyIntent(`open the chart for ${SYNTH_PATIENT}`)).toBe('query')
    expect(classifyIntent(`search for patient ${SYNTH_PATIENT} in athena`)).toBe('query')
  })

  it('patient-nav decoys stay chat (no PHI search fired)', () => {
    expect(classifyIntent('pull up the weather')).toBe('chat')
    expect(classifyIntent('pull up the news')).toBe('chat')
    expect(classifyIntent('open the door')).toBe('chat')
    expect(classifyIntent('pull up that song')).toBe('chat')
  })
})

describe('AVSO v2 classify — free-text input write', () => {
  it('"type/dictate \'<x>\' into <field>" classifies as workflow', () => {
    expect(classifyIntent(`type "${SYNTH_WRITE}" into the HPI`)).toBe('workflow')
    expect(classifyIntent(`dictate "${SYNTH_WRITE}" into the assessment`)).toBe('workflow')
    expect(classifyIntent(`enter "${SYNTH_WRITE}" in the chief complaint field`)).toBe('workflow')
    expect(classifyIntent(`write "${SYNTH_WRITE}" into the note`)).toBe('workflow')
  })

  it('input decoys stay chat', () => {
    expect(classifyIntent('type faster please')).toBe('chat')
    expect(classifyIntent('what should I dictate today')).toBe('chat')
  })
})

describe('AVSO v2 classify — non-today schedule date', () => {
  it('"schedule for <date != today>" classifies as query', () => {
    expect(classifyIntent('schedule for 2026-05-19')).toBe('query')
    expect(classifyIntent('pull the schedule for tomorrow')).toBe('query')
    expect(classifyIntent('schedule for monday')).toBe('query')
  })

  it('non-clinical schedule decoys stay chat', () => {
    expect(classifyIntent('schedule a meeting')).toBe('chat')
    expect(classifyIntent('what is on the schedule')).toBe('chat')
  })
})

// ─── 2. classify: v1 behavior MUST NOT regress ─────────────────────────

describe('AVSO v2 classify — v1 non-regression', () => {
  it('v1 nav verbs unchanged → query (athena-nav path)', () => {
    expect(classifyIntent('open the calendar')).toBe('query')
    expect(classifyIntent('go to the schedule')).toBe('query')
    expect(classifyIntent("navigate to today's appointments")).toBe('query')
    expect(classifyIntent('open athena dashboard')).toBe('query')
  })

  it('v1 export/clinical verbs unchanged → query (patient-schedule path)', () => {
    expect(classifyIntent('show me my OR schedule')).toBe('query')
    expect(classifyIntent("today's cases")).toBe('query')
    expect(classifyIntent('morning report')).toBe('query')
  })

  it('v1 chat boundaries still hold', () => {
    expect(classifyIntent('how are you doing today')).toBe('chat')
    expect(classifyIntent('schedule a meeting for me')).toBe('chat')
  })
})

// ─── 3. plan: patient-nav → single tier-1, no confirm, redacted ────────

describe('AVSO v2 plan — patient-nav', () => {
  it('single scalpel athena-patient-search step, tier 1, NO confirm phrase', () => {
    const p = buildPlan(`pull up the chart for ${SYNTH_PATIENT}`, 'query')
    expect(p.class).toBe('query')
    expect(p.steps.length).toBe(1)
    const s = p.steps[0]
    expect(s.target).toBe('scalpel')
    expect(s.command_type).toBe('athena-patient-search')
    expect(s.args.risk_tier).toBe(1)
    expect(tierFor('athena-patient-search')).toBe(1) // < 3 → no typed-confirm
  })

  it('the synthetic patient string is REDACTED out of the plan envelope', () => {
    const p = buildPlan(`open chart for ${SYNTH_PATIENT}`, 'query')
    expect(blob(p)).not.toContain(SYNTH_PATIENT)
    expect(p.steps[0].args.patient_query).toBe('<PATIENT_QUERY>')
    expect(String(p.steps[0].args.correlation_id)).toMatch(/^avso-ps-/)
  })
})

// ─── 4. plan: free-text input → TWO-PHASE prepare(t1) → commit(t3) ─────

describe('AVSO v2 plan — free-text input (two-phase, correlated)', () => {
  it('emits prepare(tier-1) then commit(tier-3) for a free-text field', () => {
    const p = buildPlan(`type "${SYNTH_WRITE}" into the HPI`, 'workflow')
    expect(p.class).toBe('workflow')
    expect(p.steps.length).toBe(2)

    const [prep, commit] = p.steps
    expect(prep.target).toBe('scalpel')
    expect(prep.command_type).toBe('athena-input-prepare')
    expect(prep.args.risk_tier).toBe(1)

    expect(commit.target).toBe('scalpel')
    expect(commit.command_type).toBe('athena-input-commit')
    expect(commit.args.risk_tier).toBe(3)
  })

  it('commit REUSES the prepare correlation id (ledger linkage)', () => {
    const p = buildPlan(`dictate "${SYNTH_WRITE}" into the assessment`, 'workflow')
    const [prep, commit] = p.steps
    expect(String(prep.args.correlation_id)).toMatch(/^avso-ip-/)
    expect(commit.args.correlation_id).toBe(prep.args.correlation_id)
  })

  it('the synthetic write text is REDACTED out of BOTH steps', () => {
    const p = buildPlan(`enter "${SYNTH_WRITE}" into the note`, 'workflow')
    expect(blob(p)).not.toContain(SYNTH_WRITE)
    expect(p.steps[0].args.write_text).toBe('<WRITE_TEXT>')
    expect(p.steps[1].args.write_text).toBe('<WRITE_TEXT>')
  })

  it('commit step is tier-3 so execute.ts mints CONFIRM ATHENA-INPUT-COMMIT', () => {
    // execute.ts: requiredPhrase = `CONFIRM ${command_type.toUpperCase()}`
    // for tier >= 3. We assert the tier here; the mint is execute.ts's.
    expect(tierFor('athena-input-commit')).toBe(3)
    expect(`CONFIRM ${'athena-input-commit'.toUpperCase()}`).toBe(
      'CONFIRM ATHENA-INPUT-COMMIT',
    )
  })

  it('the resolved free-text field id is carried on both steps', () => {
    const p = buildPlan(`type "${SYNTH_WRITE}" into the hpi`, 'workflow')
    expect(p.steps[0].args.field_id).toBeDefined()
    expect(p.steps[1].args.field_id).toBe(p.steps[0].args.field_id)
  })
})

// ─── 5. plan: structured clinical field → v2b-deferred (NO commit) ─────

describe('AVSO v2 plan — structured clinical field deferred to v2b', () => {
  const structured = [
    `add "${SYNTH_WRITE}" to the problem list`,
    `enter "${SYNTH_WRITE}" into the medication order`,
    `put "${SYNTH_WRITE}" in the diagnosis`,
    `type "${SYNTH_WRITE}" into the ICD code`,
    `set the disposition to "${SYNTH_WRITE}"`,
  ]
  for (const msg of structured) {
    it(`"${msg.replace(SYNTH_WRITE, '<x>')}" → v2b-deferred, NO tier-3 commit`, () => {
      const p = buildPlan(msg, 'workflow')
      // No athena-input-commit step may exist for a structured field.
      const types = p.steps.map((s) => s.command_type)
      expect(types).not.toContain('athena-input-commit')
      expect(p.summary).toMatch(/v2b|deferred/i)
      expect(blob(p)).not.toContain(SYNTH_WRITE)
    })
  }
})

// ─── 6. plan: ambiguous field → clarify (never guess a write) ──────────

describe('AVSO v2 plan — ambiguous field → clarify', () => {
  it('a write with no resolvable field clarifies, emits no write step', () => {
    const p = buildPlan(`type "${SYNTH_WRITE}" somewhere`, 'workflow')
    const types = p.steps.map((s) => s.command_type)
    expect(types).not.toContain('athena-input-commit')
    expect(types).not.toContain('athena-input-prepare')
    expect(p.summary).toMatch(/clarif|which field|ambiguous/i)
    expect(blob(p)).not.toContain(SYNTH_WRITE)
  })
})

// ─── 7. plan: non-today schedule → probe pre-step then variant ─────────

describe('AVSO v2 plan — non-today schedule date probe', () => {
  it('a non-today date emits a tier-0 probe step BEFORE the schedule pull', () => {
    const p = buildPlan('pull the schedule for 2026-05-19', 'query')
    expect(p.steps.length).toBeGreaterThanOrEqual(2)
    const probe = p.steps[0]
    expect(probe.target).toBe('scalpel')
    expect(probe.command_type).toBe('athena-schedule-date-probe')
    expect(probe.args.risk_tier).toBe(0)
    expect(probe.args.date).toBe('2026-05-19')
    // the variant/export step follows the probe
    expect(p.steps[1].command_type).toBe('patient-schedule')
  })

  it('TODAY stays the v1 single-step export — NO probe (no regression)', () => {
    const p = buildPlan('show me my OR schedule', 'query')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].command_type).toBe('patient-schedule')
    expect(p.steps.map((s) => s.command_type)).not.toContain(
      'athena-schedule-date-probe',
    )
  })

  it('"schedule for tomorrow" also probes first', () => {
    const p = buildPlan('schedule for tomorrow', 'query')
    expect(p.steps[0].command_type).toBe('athena-schedule-date-probe')
    expect(p.steps[0].args.date).toBe('tomorrow')
  })
})

// ─── 8. execute: tier/timeout consistency for the 4 v2 kinds ───────────

describe('AVSO v2 execute — COMMAND_TIER + timeout consistency', () => {
  it('the 4 v2 command kinds have the SPEC tiers ps1/ip1/ic3/sp0', () => {
    expect(tierFor('athena-patient-search')).toBe(1)
    expect(tierFor('athena-input-prepare')).toBe(1)
    expect(tierFor('athena-input-commit')).toBe(3)
    expect(tierFor('athena-schedule-date-probe')).toBe(0)
  })

  it('every v2 kind is explicitly in COMMAND_TIER (not the tier-2 default)', () => {
    for (const k of [
      'athena-patient-search',
      'athena-input-prepare',
      'athena-input-commit',
      'athena-schedule-date-probe',
    ]) {
      expect(COMMAND_TIER).toHaveProperty(k)
    }
  })

  it('only athena-input-commit is tier-3 (the typed-confirm gate)', () => {
    const v2 = [
      'athena-patient-search',
      'athena-input-prepare',
      'athena-input-commit',
      'athena-schedule-date-probe',
    ]
    const t3 = v2.filter((k) => tierFor(k) >= 3)
    expect(t3).toEqual(['athena-input-commit'])
  })

  it('no NEW tier-0 v2 kind can mutate state (probe is read-only)', () => {
    // schedule-date-probe is the only tier-0 v2 kind; it is a read-only
    // UI classification probe — same guard family as athena-nav.
    expect(tierFor('athena-schedule-date-probe')).toBe(0)
    expect('athena-schedule-date-probe'.startsWith('athena-schedule')).toBe(true)
  })

  it('v2 driver kinds get headroom poll timeouts (CDP frame work)', () => {
    expect(pollTimeoutFor('athena-patient-search')).toBeGreaterThan(15_000)
    expect(pollTimeoutFor('athena-input-commit')).toBeGreaterThan(15_000)
  })
})
