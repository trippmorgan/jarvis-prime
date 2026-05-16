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

import { orchestrate, classifyIntent, renderResult, actionLabel } from './index.js'
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
  label: string
  createdAt: number
}
// chatId → pending T3 confirmation. Module-scoped: one poller process.
const pendingConfirms = new Map<string, PendingConfirm>()

// W21.2 — humans do not type "CONFIRM SOCIAL-POST" verbatim. Accept the
// canonical minted phrase OR a natural affirmative; treat explicit
// negatives as abort; treat anything else as AMBIGUOUS (re-prompt, keep
// the gate) so an unrelated message never silently publishes, cancels,
// or falls through to chat losing the gate.
const AFFIRM = new Set([
  'confirm', 'confirmed', 'publish', 'publish it', 'post', 'post it',
  'send', 'send it', 'ship', 'ship it', 'yes', 'yep', 'yeah', 'y',
  'go', 'go ahead', 'do it', 'approved', 'approve', 'ok', 'okay', 'k',
])
const NEGATE = new Set([
  'no', 'nope', 'cancel', 'abort', 'stop', 'nevermind', 'never mind',
  "don't", 'do not', 'dont', 'reject', 'discard', 'kill it',
])

export function classifyConfirmReply(
  reply: string,
  phrase: string,
): 'confirm' | 'cancel' | 'ambiguous' {
  const norm = reply.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim()
  if (norm === phrase.trim().toLowerCase()) return 'confirm'
  if (AFFIRM.has(norm)) return 'confirm'
  if (NEGATE.has(norm)) return 'cancel'
  return 'ambiguous'
}

// W21.15 — orchestrator failure must fall back to the conversational
// brain (Tripp's principle: the orchestrator is an optimization, the
// LLM is the floor — a failed/timed-out orchestrated answer must hand
// the problem to Prime, never die into a dead "❌ Step x/y failed").
// Kill-switch: JARVIS_ORCH_FALLBACK_ENABLED=0.
const ORCH_FALLBACK_ENABLED = process.env.JARVIS_ORCH_FALLBACK_ENABLED !== '0'

/** PHI-safe one-liner of what failed: command_type + status reason only
 *  (reasons are statuses like extract-error / poll-timeout — never PHI). */
export function summarizeOrchFailures(events: ExecEvent[]): string {
  const failed = events.filter((e) => e.kind === 'step_failed')
  return failed
    .slice(0, 4)
    .map((f) => {
      const tgt = f.step?.target ? `${f.step.target} ` : ''
      const cmd = f.step?.command_type ?? 'step'
      return `${tgt}${cmd} → ${String(f.reason ?? 'unknown')}`
    })
    .join('; ')
}

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
      // W21.8 — REPORT OUTCOMES FAITHFULLY. The old code prefixed every
      // result with "✅ Confirmed." even when the action FAILED, so a
      // post that died on missing X credentials read as a success. The
      // header must reflect what actually happened, not just that the
      // gate was confirmed.
      const ok = ctx.ok !== false && !ctx.error
      const head = ok
        ? '✅ Done — confirmed and executed.'
        : '❌ Confirmed, but it did NOT complete:'
      return `${head}\n${renderResult(ctx)}`
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS))
  }
  return '⏳ Confirmed and dispatched, but no result came back in time — it may not have completed. Check the session timeline before assuming it did.'
}

export interface TelegramHookConfig {
  /** Sends a message to a chat. Wired to TelegramPoller.sendMessage. */
  deliver: (chatId: string, text: string) => Promise<void>
  /** Called when the message is 'chat' class — delegates to the existing handler. */
  onChat: (chatId: string, text: string, userId: string) => Promise<void> | void
  /**
   * W21.7 — intent oversight. Re-reads an auto/deterministic reply
   * against conversation context and returns a correction if it missed
   * the user's actual intent. Optional: when absent, behaviour is
   * unchanged. Runs fire-and-forget AFTER the fast reply, so it never
   * delays the user. Must never throw (return {ok:true} on any doubt).
   */
  reviewIntent?: (args: {
    chatId: string
    userText: string
    autoReply: string
    klass: string
  }) => Promise<{ ok: boolean; correction?: string }>
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
        const decision = classifyConfirmReply(text, pend.phrase)
        if (decision === 'confirm') {
          pendingConfirms.delete(chatId)
          // The kernel matches required_phrase EXACTLY (SQL =), so always
          // send the canonical minted phrase regardless of what natural
          // affirmative the user actually typed.
          const res = await kernelFetch(`/envelopes/${pend.envelopeId}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ phrase: pend.phrase }),
          })
          if (!res || (res as { __error?: boolean }).__error) {
            await cfg.deliver(
              chatId,
              `⚠️ Confirm failed (${(res as { status?: number })?.status ?? 'kernel unreachable'}). Nothing was published. Try the request again.`,
            )
            return
          }
          await cfg.deliver(chatId, `⏳ Confirmed — now going to ${pend.label}…`)
          const out = await pollConfirmResult(pend.envelopeId)
          await cfg.deliver(chatId, out)
          return
        }
        if (decision === 'cancel') {
          pendingConfirms.delete(chatId)
          await kernelFetch(`/envelopes/${pend.envelopeId}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'user declined' }),
          })
          await cfg.deliver(chatId, `✋ Aborted — did NOT ${pend.label}.`)
          return
        }
        // AMBIGUOUS: keep the gate armed, re-prompt with the EXACT
        // pending action (W21.4 — "publish" once confirmed a morning
        // show when Tripp meant a tweet; never leave it vague).
        await cfg.deliver(
          chatId,
          `⏸ Still waiting on your call: about to **${pend.label}**.\nReply *publish* to do that, or *cancel* to abort. (Auto-expires soon.)`,
        )
        return
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
              const label = actionLabel(ev.step?.command_type, ev.step?.args)
              const prev = pendingConfirms.get(chatId)
              if (prev && prev.envelopeId !== ev.envelope_id) {
                // A new gate replaces an un-answered one — say so, so a
                // later "publish" can't silently confirm the wrong thing.
                try {
                  await cfg.deliver(chatId, `↻ (Dropped the earlier un-confirmed step: ${prev.label}.)`)
                } catch { /* swallow */ }
              }
              pendingConfirms.set(chatId, {
                envelopeId: ev.envelope_id,
                phrase: ev.required_phrase,
                commandType: ev.step?.command_type ?? 'command',
                label,
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

    // ── 3.5. Orchestration FAILED → hand off to the conversational
    // brain so Prime actually engages, instead of delivering a dead
    // "❌ Step x/y failed" reply. A pending confirm gate is NOT a
    // failure (it's handled in §4). Guardrails: onChat is conversational
    // and structurally cannot fire a tier-3 envelope; the augmented
    // context tells Prime to help/explain and never fabricate clinical/
    // PHI data; the failure note carries only command_type + status.
    const failedEvents = streamed.events.filter((e) => e.kind === 'step_failed')
    const gateArmed =
      pendingConfirms.has(chatId) ||
      streamed.events.some((e) => e.kind === 'awaiting_confirm')
    if (ORCH_FALLBACK_ENABLED && failedEvents.length > 0 && !gateArmed) {
      const why = summarizeOrchFailures(streamed.events)
      try {
        await cfg.deliver(
          chatId,
          `⚠️ The automated path didn't get there (${why}). Let me take this directly…`,
        )
      } catch { /* swallow */ }
      if (sessionId) {
        await endSession(sessionId, {
          completed: false,
          class: streamed.class,
          failed_count: failedEvents.length,
          fellBackToChat: true,
        })
      }
      const augmented =
        `[Context for you, Prime — do NOT echo this bracket to the user. ` +
        `An automated attempt to handle the message below failed: ${why}. ` +
        `Engage and genuinely help: explain plainly what happened and do ` +
        `what you can to solve it or give the real next step. Do NOT ` +
        `fabricate clinical/patient data, and do NOT claim an external ` +
        `action was performed.]\n\n${text}`
      return Promise.resolve(cfg.onChat(chatId, augmented, userId))
    }

    // ── 4. Deliver the composed reply (gate prompt incl. phrase) ─────
    if (streamed.final_reply && streamed.final_reply.length > 0) {
      try {
        await cfg.deliver(chatId, streamed.final_reply)
      } catch { /* swallow */ }

      // W21.7 — re-read this auto/deterministic reply against context
      // and correct it if it missed intent. Fire-and-forget AFTER the
      // fast reply so the user is never delayed; the correction (if
      // any) arrives as a follow-up. The correction is delivered raw —
      // it does NOT re-enter handle(), so there is no reply loop.
      if (cfg.reviewIntent) {
        const replyForReview = streamed.final_reply
        void (async () => {
          try {
            const v = await cfg.reviewIntent!({ chatId, userText: text, autoReply: replyForReview, klass: streamed.class })
            if (v && v.ok === false && v.correction && v.correction.trim().length > 0) {
              await cfg.deliver(
                chatId,
                `↳ *Re-reading that* — I think you actually meant:\n${v.correction.trim()}`,
              )
            }
          } catch { /* oversight must never surface an error */ }
        })()
      }
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
