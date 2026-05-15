// W17 T9 tests — buildPlan

import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../orchestrator/plan.js'

describe('buildPlan', () => {
  it('chat → 0 steps', () => {
    const p = buildPlan('how are you', 'chat')
    expect(p.class).toBe('chat')
    expect(p.steps.length).toBe(0)
  })

  it('morning report → scalpel patient-schedule', () => {
    const p = buildPlan('morning report', 'query')
    expect(p.class).toBe('query')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('scalpel')
    expect(p.steps[0].command_type).toBe('patient-schedule')
  })

  it('patient schedule → same plan', () => {
    const p = buildPlan('pull up my patient schedule', 'query')
    expect(p.steps[0].command_type).toBe('patient-schedule')
  })

  it('"frank restart ollama" → restart-service step on frank', () => {
    const p = buildPlan('frank restart ollama', 'workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].command_type).toBe('restart-service')
    expect(p.steps[0].args.service).toBe('ollama')
  })

  it('"restart ollama on frank" → same plan', () => {
    const p = buildPlan('restart ollama on frank', 'workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].command_type).toBe('restart-service')
  })

  it('chrome-cdp debug workflow → multi-step plan', () => {
    const p = buildPlan("let's work on the athena chrome-cdp debugging tool", 'workflow')
    expect(p.steps.length).toBeGreaterThan(0)
    const types = p.steps.map((s) => s.command_type)
    expect(types).toContain('chrome-cdp-status')
  })

  it('status → empty steps (executor fills them via fan-out)', () => {
    const p = buildPlan('all nodes status', 'status')
    expect(p.class).toBe('status')
    expect(p.steps.length).toBe(0)
  })

  it('unmatched workflow → empty plan with descriptive summary', () => {
    const p = buildPlan('do the impossible thing', 'workflow')
    expect(p.steps.length).toBe(0)
    expect(p.summary).toMatch(/don't have a concrete plan/i)
  })

  // W17.2 — Frank workspace / experiments.

  it('"list frank experiments" → list-experiments on frank', () => {
    const p = buildPlan('list frank experiments', 'workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].command_type).toBe('list-experiments')
  })

  it('"read frank experiment <name>" → read-experiment with name arg', () => {
    const p = buildPlan('read frank experiment 2026-03-08-05-04-54', 'workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].target).toBe('frank')
    expect(p.steps[0].command_type).toBe('read-experiment')
    expect(p.steps[0].args.name).toBe('2026-03-08-05-04-54')
  })

  it('target-first "Frank: read experiments" → list-experiments fallback', () => {
    const p = buildPlan('utilizing Frank: read franks workspace experiments', 'workflow')
    expect(p.steps.length).toBe(1)
    expect(p.steps[0].command_type).toBe('list-experiments')
  })
})
