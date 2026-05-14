// W17 T10 tests — executePlan
//
// Unit-level: tierFor + COMMAND_TIER coverage. The full kernel
// integration test lives in Wave D (T14, T15).

import { describe, it, expect } from 'vitest'
import { COMMAND_TIER, tierFor } from '../../orchestrator/execute.js'

describe('COMMAND_TIER mirror', () => {
  it('matches the python COMMAND_TIER (W17 T1)', () => {
    expect(COMMAND_TIER['health-check']).toBe(0)
    expect(COMMAND_TIER['fetch-logs']).toBe(0)
    expect(COMMAND_TIER['restart-service']).toBe(2)
    expect(COMMAND_TIER['execute-script']).toBe(2)
    expect(COMMAND_TIER['ollama-operation']).toBe(1)
    expect(COMMAND_TIER['station-query']).toBe(0)
    expect(COMMAND_TIER['patient-schedule']).toBe(0)
    expect(COMMAND_TIER['inspect-mcp']).toBe(0)
    expect(COMMAND_TIER['chrome-cdp-status']).toBe(0)
  })
})

describe('tierFor', () => {
  it('returns the configured tier for known types', () => {
    expect(tierFor('health-check')).toBe(0)
    expect(tierFor('restart-service')).toBe(2)
  })

  it('defaults unknown types to 2 (safe)', () => {
    expect(tierFor('frobnicate')).toBe(2)
    expect(tierFor('')).toBe(2)
  })
})
