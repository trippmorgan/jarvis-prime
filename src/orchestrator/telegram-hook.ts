// W17 T11 — Telegram orchestrator hook.
//
// Wraps the existing MessageProcessor.submit path with a pre-check:
// if the orchestrator classifies the message as anything other than
// 'chat', it handles delivery itself and short-circuits. Conversational
// messages flow through to MessageProcessor unchanged.
//
// Session linkage: every non-chat orchestration opens a session via
// /sessions/start, ends with /sessions/end. The shell Sessions sidebar
// then shows the entry; the activity timeline (T13) populates as steps
// run.

import { orchestrate } from './index.js'
import type { ExecEvent } from './types.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''

const PRIME_AGENT_ID = 'agent_orchestrator-prime-jarvis-os'

async function kernelPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  if (!KERNEL_TOKEN) return null
  try {
    const res = await fetch(`${KERNEL_URL}/api/v1/registry${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KERNEL_TOKEN}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

interface SessionResp {
  session: { id: string }
}

async function startSession(chatId: string, intent: string): Promise<string | undefined> {
  const resp = (await kernelPost('/sessions/start', {
    agent_id: PRIME_AGENT_ID,
    channel: 'telegram',
    chat_id: chatId,
    intent: intent.slice(0, 200),
  })) as SessionResp | null
  return resp?.session?.id
}

async function endSession(sessionId: string, outcome: Record<string, unknown>): Promise<void> {
  await kernelPost(`/sessions/${sessionId}/end`, { outcome })
}

export interface TelegramHookConfig {
  /** Function that sends a message to a chat. Wired to TelegramPoller.sendMessage. */
  deliver: (chatId: string, text: string) => Promise<void>
  /** Function the hook calls when the message is 'chat' class — delegates to the existing handler. */
  onChat: (chatId: string, text: string, userId: string) => Promise<void> | void
}

/**
 * Build a Telegram `onMessage` handler that routes orchestration intents
 * to the orchestrator and falls through to the chat handler otherwise.
 *
 * Wire into server.ts:
 *
 *   const hook = createTelegramOrchestratorHook({
 *     deliver: poller.sendMessage.bind(poller),
 *     onChat: (chatId, text, userId) => processor.submit(chatId, text, userId),
 *   })
 *   poller = new TelegramPoller({ ..., onMessage: hook })
 */
export function createTelegramOrchestratorHook(cfg: TelegramHookConfig) {
  return async function handle(chatId: string, text: string, userId: string): Promise<void> {
    // First pass: classify-only. Cheap; lets us bail before opening a session.
    const result = await orchestrate({ chat_id: chatId, text, from: userId })
    if (result.class === 'chat') {
      // Conversational — let the existing MessageProcessor own it.
      return Promise.resolve(cfg.onChat(chatId, text, userId))
    }
    // Open the session AFTER classification so chat messages don't
    // pollute the Sessions sidebar.
    const sessionId = await startSession(chatId, text)

    // Stream progress updates back to the Telegram thread.
    const progressMessages: string[] = []
    const sendProgress = async (line: string) => {
      progressMessages.push(line)
      try {
        await cfg.deliver(chatId, line)
      } catch {
        /* swallow — the session log still has it */
      }
    }

    // Re-run with a session id + onEvent streaming so the timeline +
    // Telegram updates fire together. (orchestrate is idempotent for a
    // given input; the cost is one re-classification and one re-plan.)
    const streamed = await orchestrate(
      { chat_id: chatId, text, from: userId },
      {
        sessionId,
        onEvent: async (ev: ExecEvent) => {
          if (ev.kind === 'step_dispatched') {
            await sendProgress(`→ ${ev.step?.target} ${ev.step?.command_type} (step ${ev.step_number}/${ev.total_steps})`)
          } else if (ev.kind === 'awaiting_confirm') {
            await sendProgress(
              `⏸ Step ${ev.step_number}/${ev.total_steps} (${ev.step?.command_type}) awaiting confirmation.\nReply: \`${ev.required_phrase ?? '(typed phrase)'}\``,
            )
          }
        },
      },
    )

    // Final reply only if we haven't already streamed enough.
    if (streamed.final_reply && streamed.final_reply.length > 0) {
      try {
        await cfg.deliver(chatId, streamed.final_reply)
      } catch {
        /* swallow */
      }
    }

    if (sessionId) {
      const outcome = {
        completed: streamed.completed,
        class: streamed.class,
        step_count: streamed.events.filter((e) => e.kind === 'step_complete').length,
        failed_count: streamed.events.filter((e) => e.kind === 'step_failed').length,
      }
      await endSession(sessionId, outcome)
    }
  }
}
