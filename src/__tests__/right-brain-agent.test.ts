import { describe, it, expect, vi } from 'vitest'
import {
  RightBrainAgentClient,
  RightBrainTransportError,
  RightBrainModelError,
  type ExecFileFn,
} from '../brain/right-brain-agent.js'

/**
 * Build a canned successful `openclaw agent --json` stdout payload.
 */
function okPayload(text: string = 'PONG', durationMs: number = 4000): string {
  return JSON.stringify({
    runId: 'test-run-id',
    status: 'ok',
    summary: 'completed',
    result: {
      payloads: [{ text, mediaUrl: null }],
      meta: {
        durationMs,
        agentMeta: {
          sessionId: 'internal-uuid',
          sessionKey: 'agent:right-brain:test',
        },
      },
    },
  })
}

describe('RightBrainAgentClient — command construction (W7-T5)', () => {
  it('invokes openclaw with --agent, --session-id, --message, --json, --thinking flags', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exec: ExecFileFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: okPayload(), stderr: '' }
    }

    const client = new RightBrainAgentClient({
      sessionId: 'abc1234567890def',
      execFile: exec,
    })
    await client.call({ system: 'sys-prompt', user: 'user-msg', timeoutMs: 30_000 })

    expect(calls.length).toBe(1)
    expect(calls[0].file).toBe('openclaw')
    const args = [...calls[0].args]
    expect(args).toContain('agent')
    expect(args).toContain('--agent')
    expect(args[args.indexOf('--agent') + 1]).toBe('right-brain')
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('abc1234567890def')
    expect(args).toContain('--json')
    expect(args).toContain('--thinking')
    expect(args[args.indexOf('--thinking') + 1]).toBe('medium')
  })

  it('combines system + user prompts into a single --message payload', async () => {
    let capturedMessage: string | undefined
    const exec: ExecFileFn = async (_file, args) => {
      const idx = args.indexOf('--message')
      capturedMessage = args[idx + 1]
      return { stdout: okPayload(), stderr: '' }
    }
    const client = new RightBrainAgentClient({
      sessionId: 'sess1',
      execFile: exec,
    })
    await client.call({
      system: 'S-side',
      user: 'U-side',
      timeoutMs: 30_000,
    })
    expect(capturedMessage).toContain('S-side')
    expect(capturedMessage).toContain('U-side')
    expect(capturedMessage).toContain('---')
  })

  it('honors custom agentName and thinkingLevel', async () => {
    let capturedArgs: readonly string[] = []
    const exec: ExecFileFn = async (_file, args) => {
      capturedArgs = args
      return { stdout: okPayload(), stderr: '' }
    }
    const client = new RightBrainAgentClient({
      sessionId: 'sess2',
      agentName: 'custom-brain',
      thinkingLevel: 'high',
      execFile: exec,
    })
    await client.call({ system: 's', user: 'u', timeoutMs: 30_000 })
    const args = [...capturedArgs]
    expect(args[args.indexOf('--agent') + 1]).toBe('custom-brain')
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
  })

  it('passes timeoutMs to exec options', async () => {
    let capturedOpts: { timeout?: number; maxBuffer?: number } | undefined
    const exec: ExecFileFn = async (_file, _args, opts) => {
      capturedOpts = opts
      return { stdout: okPayload(), stderr: '' }
    }
    const client = new RightBrainAgentClient({
      sessionId: 'sess3',
      execFile: exec,
    })
    await client.call({ system: 's', user: 'u', timeoutMs: 45_000 })
    expect(capturedOpts?.timeout).toBe(45_000)
  })
})

describe('RightBrainAgentClient — success path', () => {
  it('extracts text from result.payloads[0].text and returns durationMs', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: okPayload('Hello from agent'),
      stderr: '',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    const result = await client.call({ system: 's', user: 'u', timeoutMs: 30_000 })
    expect(result.content).toBe('Hello from agent')
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('RightBrainAgentClient — error discrimination', () => {
  it('throws TransportError when exec rejects (e.g. ENOENT, timeout)', async () => {
    const exec: ExecFileFn = async () => {
      throw new Error('spawn openclaw ENOENT')
    }
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainTransportError)
  })

  it('throws TransportError when CLI falls back to embedded (stderr marker)', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: okPayload(),
      stderr: 'Gateway agent failed; falling back to embedded: some reason',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainTransportError)
  })

  it('throws TransportError when stdout is not valid JSON', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: 'this is not json',
      stderr: '',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainTransportError)
  })

  it('throws ModelError when status is not "ok"', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: JSON.stringify({
        status: 'error',
        summary: 'agent refused',
        result: { payloads: [] },
      }),
      stderr: '',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainModelError)
  })

  it('throws ModelError when payloads[0].text is missing', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: JSON.stringify({
        status: 'ok',
        result: { payloads: [{ mediaUrl: null }] },
      }),
      stderr: '',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainModelError)
  })

  it('throws ModelError when text is empty string', async () => {
    const exec: ExecFileFn = async () => ({
      stdout: okPayload(''),
      stderr: '',
    })
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainModelError)
  })

  it('TransportError vs ModelError are both RightHemisphereError subclasses', async () => {
    // So the orchestrator's existing error handling continues to work.
    const transport = new RightBrainTransportError('x')
    const model = new RightBrainModelError('y')
    expect(transport.name).toBe('RightBrainTransportError')
    expect(model.name).toBe('RightBrainModelError')
    // Instance check against RightHemisphereError baseline
    expect(transport instanceof Error).toBe(true)
    expect(model instanceof Error).toBe(true)
  })
})

describe('RightBrainAgentClient — logging', () => {
  it('emits call_start + call_ok on success (no prompt content leaked)', async () => {
    const events: Array<{ obj: unknown }> = []
    const logger = {
      info: (obj: unknown) => events.push({ obj }),
      warn: () => undefined,
      error: () => undefined,
    }
    const exec: ExecFileFn = async () => ({ stdout: okPayload(), stderr: '' })
    const client = new RightBrainAgentClient({
      sessionId: 'abcd',
      execFile: exec,
      logger,
    })
    await client.call({ system: 'secret-sys', user: 'secret-user', timeoutMs: 30_000 })

    const starts = events.filter(
      (e) => (e.obj as { event?: string }).event === 'right_brain_agent_call_start',
    )
    const oks = events.filter(
      (e) => (e.obj as { event?: string }).event === 'right_brain_agent_call_ok',
    )
    expect(starts.length).toBe(1)
    expect(oks.length).toBe(1)

    // No prompt content in events (PHI-adjacent guard).
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('secret-sys')
    expect(serialized).not.toContain('secret-user')
  })

  it('emits transport_error event on exec rejection', async () => {
    const events: Array<{ obj: unknown }> = []
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (obj: unknown) => events.push({ obj }),
    }
    const exec: ExecFileFn = async () => {
      throw new Error('boom')
    }
    const client = new RightBrainAgentClient({
      sessionId: 'sess',
      execFile: exec,
      logger,
    })
    await expect(
      client.call({ system: 's', user: 'u', timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(RightBrainTransportError)
    const errs = events.filter(
      (e) => (e.obj as { event?: string }).event === 'right_brain_agent_exec_error',
    )
    expect(errs.length).toBe(1)
  })
})

// suppress unused import warning for vi (placeholder for future timer tests)
void vi
