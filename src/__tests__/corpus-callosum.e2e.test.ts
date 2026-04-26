/**
 * Corpus-callosum Wave 5 T16 — end-to-end smoke test.
 *
 * Vertical slice: MessageProcessor -> (real) corpusCallosum orchestrator ->
 * (mocked) HemisphereClients -> (mocked) Telegram deliver.
 *
 * The CALL boundary into the LLMs (HemisphereClient.call) is the mock point,
 * so each real cross-hemisphere call is a spy. The orchestrator itself is NOT
 * stubbed — this test exercises the full pipeline wiring together.
 *
 * The MessageProcessor today only accepts an `orchestrator?: OrchestratorFn`
 * override (not raw hemispheres), so we wrap the real `corpusCallosum(...)` in
 * a closure that closes over our fake left/right clients. This still
 * satisfies the "5 hemisphere calls" assertion and exercises the real
 * orchestrator logic.
 *
 * Satisfies SPEC AC1+AC2+AC3+AC4:
 *   AC1: natural-language dual-brain path executes 5 hemisphere calls
 *   AC2: slash commands bypass dual-brain (single-brain only)
 *   AC3: clinical override bypasses dual-brain (single-brain only)
 *   AC4: killswitch (corpusCallosumEnabled=false) bypasses dual-brain
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor } from '../bridge/processor.js'
import { corpusCallosum } from '../brain/corpus-callosum.js'
import type { HemisphereClient } from '../brain/types.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))

// W8.8.6 — left-hemisphere routes to spawnClaudeStream when caller provides
// onStreamEvent (corpus-callosum sets it when onEvent is present). Delegate
// to the same mock so existing fixtures stay simple.
vi.mock('../claude/spawner-stream.js', async () => {
  const { spawnClaude } = await import('../claude/spawner.js')
  return { spawnClaudeStream: spawnClaude }
})

import { spawnClaude } from '../claude/spawner.js'

type CallArg = { system: string; user: string; timeoutMs: number }

/**
 * Fake HemisphereClient that pops canned responses off a queue and records
 * every invocation. Mirrors the pattern used in corpus-callosum.test.ts.
 */
function makeFakeHemisphere(responses: Array<{ content: string; durationMs?: number }>): HemisphereClient & {
  calls: CallArg[]
} {
  const calls: CallArg[] = []
  const queue = [...responses]
  return {
    calls,
    async call(input) {
      calls.push({ system: input.system, user: input.user, timeoutMs: input.timeoutMs })
      const next = queue.shift()
      if (!next) throw new Error(`FakeHemisphere: no response queued for call #${calls.length}`)
      return { content: next.content, durationMs: next.durationMs ?? 1 }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Build a MessageProcessor wired to a real corpusCallosum orchestrator whose
 * left/right HemisphereClients are our fakes. This is the vertical slice.
 */
function makeE2EProcessor(opts: {
  left: HemisphereClient
  right: HemisphereClient
  corpusCallosumEnabled?: boolean
  clinicalOverride?: boolean
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jp-e2e-'))
  const historyPath = join(tmpDir, 'history.jsonl')
  const deliverMock = vi.fn().mockResolvedValue(undefined)
  const log = Fastify({ logger: false }).log

  // Wrap the REAL orchestrator with our fake hemispheres. Pipeline wiring +
  // orchestrator logic execute end-to-end; only the LLM leaf calls are faked.
  const orchestrator = async (input: { userMsg: string; history: any; basePrompt: string }) =>
    corpusCallosum(
      {
        left: opts.left,
        right: opts.right,
        basePrompt: input.basePrompt,
        timeoutMs: 5000,
        logger: log as any,
      },
      { userMsg: input.userMsg, history: input.history },
    )

  const processor = new MessageProcessor(
    {
      claudePath: '/usr/bin/claude',
      claudeModel: 'sonnet',
      claudeTimeoutMs: 120_000,
      workingDir: '/tmp',
      nodeName: 'Jarvis Prime',
      botUsername: 'trippassistant_bot',
      historyPath,
      corpusCallosumEnabled: opts.corpusCallosumEnabled ?? true,
      gatewayUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'test-token',
      rightModel: 'gpt-5.4 codex',
      corpusCallosumTimeoutMs: 5000,
      clinicalOverride: opts.clinicalOverride,
      orchestrator,
      defaultMode: 'dual',
    },
    deliverMock,
    log,
  )

  return { processor, deliverMock, historyPath }
}

describe('corpus-callosum E2E smoke (Wave 5 T16)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC1: natural-language message fires 5 hemisphere calls (3 left, 2 right) and delivers integrated text', async () => {
    // Left fires 3 times: pass-1 draft, pass-2 revision, integration.
    // Right fires 2 times: pass-1 draft, pass-2 revision.
    const left = makeFakeHemisphere([
      { content: 'L1-DRAFT', durationMs: 5 },
      { content: 'L2-REVISED', durationMs: 5 },
      { content: 'INTEGRATED-FINAL-ANSWER', durationMs: 5 },
    ])
    const right = makeFakeHemisphere([
      { content: 'R1-DRAFT', durationMs: 5 },
      { content: 'R2-REVISED', durationMs: 5 },
    ])

    const { processor, deliverMock, historyPath } = makeE2EProcessor({
      left, right, corpusCallosumEnabled: true,
    })

    processor.submit('chat-A', 'What is Gibson\'s theory of affordances?', 'user-A')
    await waitFor(() => deliverMock.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 30)) // let history writer flush

    // 5 mock hemisphere calls total — AC1
    expect(left.calls.length).toBe(3)
    expect(right.calls.length).toBe(2)

    // Order is enforced by the orchestrator: p1 parallel, p2 parallel, then integration on left.
    // Both passes' prompts are distinct — verify left's 3 calls each have a different system prompt
    // (pass-1 affordance vs pass-2 revision vs integration).
    const leftSystems = left.calls.map((c) => c.system)
    expect(new Set(leftSystems).size).toBe(3)

    // spawnClaude must NOT be called on dual-brain path
    expect(spawnClaude).not.toHaveBeenCalled()

    // Final delivery gets the integration output
    expect(deliverMock).toHaveBeenCalledWith('chat-A', 'INTEGRATED-FINAL-ANSWER')

    // History contains only user + final assistant (no drafts)
    expect(existsSync(historyPath)).toBe(true)
    const raw = readFileSync(historyPath, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0].role).toBe('user')
    expect(entries[1].role).toBe('assistant')
    expect(entries[1].content).toBe('INTEGRATED-FINAL-ANSWER')
    // No draft content leaked
    expect(raw).not.toContain('L1-DRAFT')
    expect(raw).not.toContain('R1-DRAFT')
    expect(raw).not.toContain('L2-REVISED')
    expect(raw).not.toContain('R2-REVISED')
  })

  it('AC2: slash command bypasses dual-brain (left=0, right=0, single-brain Claude only)', async () => {
    const left = makeFakeHemisphere([]) // should never be called
    const right = makeFakeHemisphere([])

    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'network ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right, corpusCallosumEnabled: true,
    })

    processor.submit('chat-A', '/network-status', 'user-A')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    // Dual-brain NOT invoked
    expect(left.calls.length).toBe(0)
    expect(right.calls.length).toBe(0)

    // Single-brain Claude fired exactly once
    expect(spawnClaude).toHaveBeenCalledTimes(1)

    expect(deliverMock).toHaveBeenCalledWith('chat-A', 'network ok')
  })

  it('AC3: clinical override bypasses dual-brain (left=0, right=0, single-brain Claude only)', async () => {
    const left = makeFakeHemisphere([])
    const right = makeFakeHemisphere([])

    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'clinical result',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right, corpusCallosumEnabled: true, clinicalOverride: true,
    })

    // Benign natural-language text — would normally go through dual-brain
    processor.submit('chat-A', 'Any normal text here', 'user-A')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    // Clinical path forces single-brain
    expect(left.calls.length).toBe(0)
    expect(right.calls.length).toBe(0)
    expect(spawnClaude).toHaveBeenCalledTimes(1)
    expect(deliverMock).toHaveBeenCalledWith('chat-A', 'clinical result')
  })

  it('AC4: killswitch (corpusCallosumEnabled=false) bypasses dual-brain even for natural language', async () => {
    const left = makeFakeHemisphere([])
    const right = makeFakeHemisphere([])

    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'single brain reply',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      timedOut: false,
    })

    const { processor, deliverMock } = makeE2EProcessor({
      left, right, corpusCallosumEnabled: false,
    })

    processor.submit('chat-A', 'What do you think of this?', 'user-A')
    await waitFor(() => deliverMock.mock.calls.length > 0)

    expect(left.calls.length).toBe(0)
    expect(right.calls.length).toBe(0)
    expect(spawnClaude).toHaveBeenCalledTimes(1)
    expect(deliverMock).toHaveBeenCalledWith('chat-A', 'single brain reply')
  })
})
