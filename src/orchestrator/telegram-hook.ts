// W17 T11 — Telegram orchestrator hook.  (W21.1 rework)
//
// Routes orchestration intents to the orchestrator and falls through to
// the conversational handler otherwise. Two correctness fixes over the
// original:
//
//   1. SINGLE orchestrate() pass. The original called orchestrate()
//      once to "classify" and again to execute — but orchestrate()
//      actually runs the whole plan, so every workflow executed TWICE
//      (double draft, and worse: double restart / double post). Now we
//      do one streamed pass; a cheap regex pre-class only decides
//      whether to open a Sessions-sidebar row (optimization, not
//      correctness).
//
//   2. The T3 confirm reply is now wired. When a step parks in
//      awaiting_input the hook remembers {chatId → envelope, phrase}.
//      The user's next message: exact phrase → POST /envelopes/:id/
//      confirm (kernel flips it to pending, the lieutenant executes,
//      the result is polled back and delivered); anything else →
//      POST /envelopes/:id/cancel (abort) and the new message is
//      handled normally. Before this, typing the phrase did nothing.

import { orchestrate, classifyIntent, renderResult } from './index.js'
import type { ExecEvent } from './types.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''
const PRIME_AGENT_ID = 'agent_orchestrator-prime-jarvis-os'

const CONFIRM_TTL_MS = 10 * 60 * 1000
const CONFIRM_POLL_MS = 1500
const CONFIRM_POLL_TIMEOUT_MS = 180_000

interface PendingConfirm {
  envelopeId: string
  phrase: string
  commandType: string
  createdAt: number
}
// chatId → pending T3 confirmation. Module-scoped: one poller process.
const pendingConfirms = new Map<string, PendingConfirm>()

async function kernelFetch(
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  if (!KERNEL_TOKEN) return null
  try {
    const res = await fetch(`${KERNEL_URL}/api/v1/registry${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KERNEL_TOKEN}`,
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) return { __error: true, status: res.status }
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

interface SessionResp {
  session: { id: string }
}

async function startSession(chatId: string, intent: string): Promise<string | undefined> {
  const resp = (await kernelFetch('/sessions/start', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: PRIME_AGENT_ID,
      channel: 'telegram',
      chat_id: chatId,
      intent: intent.slice(0, 200),
    }),
  })) as SessionResp | null
  return resp?.session?.id
}

async function endSession(sessionId: string, outcome: Record<string, unknown>): Promise<void> {
  await kernelFetch(`/sessions/${sessionId}/end`, { method: 'POST', body: JSON.stringify({ outcome }) })
}

/** Poll for the result child of a confirmed envelope and render it. */
async function pollConfirmResult(envelopeId: string): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < CONFIRM_POLL_TIMEOUT_MS) {
    const list = await kernelFetch(`/envelopes?parent_envelope_id=${envelopeId}&limit=1`)
    const envelopes = (list?.envelopes as Array<{ context?: Record<string, unknown> }>) ?? []
    if (envelopes.length > 0) {
      const ctx = envelopes[0].context ?? {}
      return `✅ Confirmed.\n${renderResult(ctx)}`
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS))
  }
  return '✅ Confirmed — sent for execution, but no result came back in time. Check the session timeline.'
}

export interface TelegramHookConfig {
  /** Sends a message to a chat. Wired to TelegramPoller.sendMessage. */
  deliver: (chatId: string, text: string) => Promise<void>
  /** Called when the message is 'chat' class — delegates to the existing handler. */
  onChat: (chatId: string, text: string, userId: string) => Promise<void> | void
}

export function createTelegramOrchestratorHook(cfg: TelegramHookConfig) {
  return async function handle(chatId: string, text: string, userId: string): Promise<void> {
    // ── 0. Pending T3 confirmation intercept ──────────────────────────
    const pend = pendingConfirms.get(chatId)
    if (pend) {
      if (Date.now() - pend.createdAt > CONFIRM_TTL_MS) {
        pendingConfirms.delete(chatId)
        // fall through — stale gate, treat the message normally
      } else {
        const reply = text.trim()
        const matches = reply.toUpperCase() === pend.phrase.toUpperCase()
        if (matches) {
          pendingConfirms.delete(chatId)
          const res = await kernelFetch(`/envelopes/${pend.envelopeId}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ phrase: pend.phrase }),
          })
          if (!res || res.__error) {
            await cfg.deliver(
              chatId,
              `⚠️ Confirm failed (${res?.status ?? 'kernel unreachable'}). Nothing was published. Try the request again.`,
            )
            return
          }
          await cfg.deliver(chatId, `⏳ Confirmed \`${pend.commandType}\` — executing…`)
          const out = await pollConfirmResult(pend.envelopeId)
          await cfg.deliver(chatId, out)
          return
        }
        // Any non-matching message aborts the gate, then is handled normally.
        pendingConfirms.delete(chatId)
        await kernelFetch(`/envelopes/${pend.envelopeId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'user did not confirm' }),
        })
        await cfg.deliver(chatId, `✋ Aborted — \`${pend.commandType}\` not published.`)
        // continue ↓ — process this new message
      }
    }

    // ── 1. Cheap regex pre-class: only to decide session creation ─────
    // (Correctness no longer depends on this; orchestrate() does the
    // real LLM-backed classify + plan + execute exactly once below.)
    const pre = classifyIntent(text)
    const sessionId = pre !== 'chat' ? await startSession(chatId, text) : undefined

    // ── 2. Single orchestrate pass with streaming ────────────────────
    const streamed = await orchestrate(
      { chat_id: chatId, text, from: userId },
      {
        sessionId,
        onEvent: async (ev: ExecEvent) => {
          if (ev.kind === 'step_dispatched') {
            try {
              await cfg.deliver(chatId, `→ ${ev.step?.target} ${ev.step?.command_type} (step ${ev.step_number}/${ev.total_steps})`)
            } catch { /* swallow */ }
          } else if (ev.kind === 'awaiting_confirm') {
            if (ev.envelope_id && ev.required_phrase) {
              pendingConfirms.set(chatId, {
                envelopeId: ev.envelope_id,
                phrase: ev.required_phrase,
                commandType: ev.step?.command_type ?? 'command',
                createdAt: Date.now(),
              })
            }
          }
        },
      },
    )

    // ── 3. Not an orchestration → conversational brain ───────────────
    if (streamed.class === 'chat') {
      if (sessionId) await endSession(sessionId, { completed: true, class: 'chat', noop: true })
      return Promise.resolve(cfg.onChat(chatId, text, userId))
    }

    // ── 4. Deliver the composed reply (gate prompt incl. phrase) ─────
    if (streamed.final_reply && streamed.final_reply.length > 0) {
      try {
        await cfg.deliver(chatId, streamed.final_reply)
      } catch { /* swallow */ }
    }

    if (sessionId) {
      await endSession(sessionId, {
        completed: streamed.completed,
        class: streamed.class,
        step_count: streamed.events.filter((e) => e.kind === 'step_complete').length,
        failed_count: streamed.events.filter((e) => e.kind === 'step_failed').length,
        awaiting: pendingConfirms.has(chatId),
      })
    }
  }
}
