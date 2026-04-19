import { describe, it, expect } from 'vitest'
import { getLieutenantStatus, formatStatusTable } from '../lieutenant/status.js'

describe('getLieutenantStatus', () => {
  it('returns status for superserver (local)', async () => {
    const status = await getLieutenantStatus('superserver')
    expect(status.reachable).toBe(true)
    expect(status.node).toBe('SuperServer')
    expect(status.uptime).toBeDefined()
    expect(status.disk).toBeDefined()
    expect(status.memory).toBeDefined()
  })

  it('returns error for unknown node', async () => {
    const status = await getLieutenantStatus('nonexistent')
    expect(status.reachable).toBe(false)
    expect(status.error).toContain('Unknown node')
  })
})

describe('formatStatusTable', () => {
  it('formats reachable and unreachable nodes', () => {
    const table = formatStatusTable([
      { node: 'SuperServer', reachable: true, uptime: 'up 5 days', disk: '45%', memory: '8G/64G', openclawRunning: true, services: {} },
      { node: 'Argus', reachable: false, services: {}, error: 'timeout' },
    ])
    expect(table).toContain('SuperServer')
    expect(table).toContain('UP')
    expect(table).toContain('Argus')
    expect(table).toContain('DOWN')
  })
})
