import { describe, expect, it } from 'vitest'
import { detectIntent, jobTitle } from '../brain/intent.js'

describe('detectIntent — fast lane by default', () => {
  it('control words win over everything', () => {
    expect(detectIntent('status').intent).toBe('control_status')
    expect(detectIntent('Jobs?').intent).toBe('control_status')
    expect(detectIntent('stop').intent).toBe('control_stop')
    expect(detectIntent('stop #3')).toMatchObject({ intent: 'control_stop', jobId: 3 })
    expect(detectIntent('stop job 12')).toMatchObject({ intent: 'control_stop', jobId: 12 })
  })

  it('explicit dual brain strips the trigger phrase', () => {
    const r = detectIntent('Jarvis use dual brain for this task: should we move the ledger witness to the NAS?')
    expect(r.intent).toBe('dual_explicit')
    expect(r.stripped).toBe('should we move the ledger witness to the NAS?')
    expect(detectIntent('dual-brain mode please, what is the best plan for Privia').intent).toBe('dual_explicit')
  })

  it('accepts a pending offer only when one is pending', () => {
    expect(detectIntent('yes', { pendingDualOffer: true }).intent).toBe('dual_accept')
    expect(detectIntent('go deep', { pendingDualOffer: true }).intent).toBe('dual_accept')
    expect(detectIntent('yes', { pendingDualOffer: false }).intent).toBe('fast')
  })

  it('imperatives and diagnose phrasing are tasks', () => {
    expect(detectIntent('check whether the station is on air').intent).toBe('task')
    expect(detectIntent('Jarvis, can you look into the fable custodian cron on pretoria').intent).toBe('task')
    expect(detectIntent('why is RFA down again').intent).toBe('task')
    expect(detectIntent('task: rotate the elevenlabs key').intent).toBe('task')
    expect(detectIntent('anything', { tier0: { topRoute: 'dispatch', topCosine: 0.41 } }).intent).toBe('task')
    expect(detectIntent('anything', { tier0: { topRoute: 'dispatch', topCosine: 0.2 } }).intent).toBe('fast')
  })

  it('deliberation gets a fast answer plus an offer; chit-chat is fast', () => {
    expect(detectIntent('Should we move the whole clinical archive onto the ledger vault long-term, or keep the walker?').intent).toBe('deep_offer')
    expect(detectIntent('x', { tier0: { topRoute: 'deep_review', topCosine: 0.5 } }).intent).toBe('deep_offer')
    expect(detectIntent('good morning').intent).toBe('fast')
    expect(detectIntent('what time is the sportscast?').intent).toBe('fast')
  })

  it('jobTitle trims to one line', () => {
    expect(jobTitle('  check   the\nstation ')).toBe('check the station')
    expect(jobTitle('a'.repeat(80), 20).length).toBe(20)
  })
})
