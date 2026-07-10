// W21.15 — orchestrator failure falls back to the conversational brain.
// Tripp's principle: the orchestrator is an optimization, the LLM is the
// floor. A failed/timed-out orchestrated answer must hand the problem to
// Prime (onChat), never die into a dead "❌ Step x/y failed" reply.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { orchestrate, classifyIntent } = vi.hoisted(() => {
  // These tests exercise the legacy orchestrated path, which is behind the
  // 2026-06-26 kill switch (default off). Force it on before the module-level
  // flag in telegram-hook.ts is evaluated at import time.
  process.env.JARVIS_WORKFLOW_ORCHESTRATOR_ENABLED = '1'
  return {
    orchestrate: vi.fn(),
    classifyIntent: vi.fn(() => 'workflow'),
  }
})
vi.mock('../../orchestrator/index.js', () => ({
  orchestrate,
  classifyIntent: (t: string) => classifyIntent(t),
  renderResult: (c: Record<string, unknown>) => JSON.stringify(c),
  actionLabel: (cmd?: string) => cmd ?? 'do it',
}))

import {
  createTelegramOrchestratorHook,
  summarizeOrchFailures,
} from '../../orchestrator/telegram-hook.js'
import type { ExecEvent } from '../../orchestrator/types.js'

const FAIL_EVENTS: ExecEvent[] = [
  {
    kind: 'step_failed',
    step: { target: 'scalpel', command_type: 'patient-schedule' },
    step_number: 1,
    total_steps: 1,
    reason: 'extract-error',
  } as unknown as ExecEvent,
]

function makeHook() {
  const deliver = vi.fn().mockResolvedValue(undefined)
  const onChat = vi.fn().mockResolvedValue(undefined)
  const handle = createTelegramOrchestratorHook({ deliver, onChat })
  return { handle, deliver, onChat }
}

describe('summarizeOrchFailures', () => {
  it('renders command_type + reason only (PHI-safe), capped at 4', () => {
    expect(summarizeOrchFailures(FAIL_EVENTS)).toBe(
      'scalpel patient-schedule → extract-error',
    )
    expect(summarizeOrchFailures([])).toBe('')
  })
})

describe('W21.15 — orchestration failure → conversational brain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    classifyIntent.mockReturnValue('workflow')
  })

  it('failed run hands the message to onChat with PHI-safe failure context', async () => {
    orchestrate.mockResolvedValue({
      class: 'workflow',
      events: FAIL_EVENTS,
      final_reply: '❌ Step 1/1 (patient-schedule) failed: extract-error.',
      completed: false,
    })
    const { handle, deliver, onChat } = makeHook()

    await handle('chatA', 'pull my schedule for monday', 'userA')

    // Dead "❌ Step" reply was NOT delivered as the final word.
    const delivered = deliver.mock.calls.map((c) => String(c[1])).join('\n')
    expect(delivered).not.toContain('❌ Step 1/1')
    expect(delivered).toContain('automated path')

    // Prime took over with the original text + bracketed failure context.
    expect(onChat).toHaveBeenCalledTimes(1)
    const augmented = String(onChat.mock.calls[0][1])
    expect(augmented).toContain('pull my schedule for monday')
    expect(augmented).toContain('scalpel patient-schedule → extract-error')
    expect(augmented).toContain('do NOT')
    expect(augmented).toContain('fabricate clinical')
  })

  it('a pending confirm gate is NOT a failure — no fallback, gate reply delivered', async () => {
    orchestrate.mockResolvedValue({
      class: 'workflow',
      events: [
        { kind: 'awaiting_confirm', step: { command_type: 'social-post' } } as unknown as ExecEvent,
      ],
      final_reply: 'Draft ready. Reply **publish** to post.',
      completed: false,
    })
    const { handle, deliver, onChat } = makeHook()

    await handle('chatB', 'tweet about the show', 'userB')

    expect(onChat).not.toHaveBeenCalled()
    expect(deliver.mock.calls.map((c) => String(c[1])).join('\n')).toContain(
      'Reply **publish**',
    )
  })

  it('a successful run delivers its reply (no fallback)', async () => {
    orchestrate.mockResolvedValue({
      class: 'query',
      events: [{ kind: 'step_complete' } as unknown as ExecEvent],
      final_reply: '✅ all nodes healthy',
      completed: true,
    })
    const { handle, deliver, onChat } = makeHook()

    await handle('chatC', 'network status', 'userC')

    expect(onChat).not.toHaveBeenCalled()
    expect(deliver.mock.calls.map((c) => String(c[1])).join('\n')).toContain(
      'all nodes healthy',
    )
  })
})
