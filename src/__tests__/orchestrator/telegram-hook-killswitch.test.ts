// 2026-06-26 kill switch — the plain-English workflow orchestrator is OFF by
// default (JARVIS_WORKFLOW_ORCHESTRATOR_ENABLED unset/!=1). Every Telegram
// message must flow straight to the conversational brain (onChat), verbatim,
// with the orchestrator never consulted.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { orchestrate, classifyIntent } = vi.hoisted(() => {
  delete process.env.JARVIS_WORKFLOW_ORCHESTRATOR_ENABLED
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

import { createTelegramOrchestratorHook } from '../../orchestrator/telegram-hook.js'

function makeHook() {
  const deliver = vi.fn().mockResolvedValue(undefined)
  const onChat = vi.fn().mockResolvedValue(undefined)
  const handle = createTelegramOrchestratorHook({ deliver, onChat })
  return { handle, deliver, onChat }
}

describe('workflow-orchestrator kill switch (default off)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hands every message to onChat verbatim — orchestrator never runs', async () => {
    const { handle, deliver, onChat } = makeHook()

    await handle('chatA', 'pull my schedule for monday', 'userA')

    expect(orchestrate).not.toHaveBeenCalled()
    expect(onChat).toHaveBeenCalledTimes(1)
    expect(onChat).toHaveBeenCalledWith('chatA', 'pull my schedule for monday', 'userA')
    // No orchestrator chatter delivered — the conversational brain owns the reply.
    expect(deliver).not.toHaveBeenCalled()
  })

  it('even workflow-classified text bypasses the orchestrator', async () => {
    classifyIntent.mockReturnValue('workflow')
    const { handle, onChat } = makeHook()

    await handle('chatB', 'swap the 3pm song and publish it', 'userB')

    expect(orchestrate).not.toHaveBeenCalled()
    expect(onChat).toHaveBeenCalledWith('chatB', 'swap the 3pm song and publish it', 'userB')
  })

  it('confirm-looking replies (publish/yes) go to onChat, never arm a T3 gate', async () => {
    const { handle, deliver, onChat } = makeHook()

    await handle('chatC', 'publish', 'userC')

    expect(orchestrate).not.toHaveBeenCalled()
    expect(onChat).toHaveBeenCalledWith('chatC', 'publish', 'userC')
    expect(deliver).not.toHaveBeenCalled()
  })
})
