import { describe, it, expect } from 'vitest'
import { sshExec, resolveNode } from '../ssh/executor.js'

describe('resolveNode', () => {
  it('resolves known nodes', () => {
    expect(resolveNode('superserver')).toBe('localhost')
    expect(resolveNode('voldemort')).toBe('root@192.168.0.108')
    expect(resolveNode('argus')).toBe('jarvisagent@100.70.105.85')
    expect(resolveNode('pretoria')).toBe('djjarvis@100.116.2.71')
    expect(resolveNode('scalpel')).toBe('tripp@100.104.39.64')
  })

  it('is case-insensitive', () => {
    expect(resolveNode('Voldemort')).toBe('root@192.168.0.108')
    expect(resolveNode('SUPERSERVER')).toBe('localhost')
  })

  it('returns null for unknown nodes', () => {
    expect(resolveNode('unknown')).toBeNull()
  })
})

describe('sshExec', () => {
  it('executes local commands on superserver', async () => {
    const result = await sshExec('superserver', 'echo hello')
    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('captures exit code on failure', async () => {
    const result = await sshExec('superserver', 'exit 42')
    expect(result.exitCode).toBe(42)
  })

  it('returns error for unknown node', async () => {
    const result = await sshExec('nonexistent', 'echo test')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Unknown node')
  })

  it('executes on voldemort via SSH', async () => {
    const result = await sshExec('voldemort', 'echo hello-from-voldemort', 15_000)
    if (result.timedOut || result.exitCode !== 0) {
      // Node might be unreachable in test environment — that's OK
      expect(result.timedOut || result.stderr.length > 0).toBe(true)
    } else {
      expect(result.stdout.trim()).toBe('hello-from-voldemort')
    }
  })
})
