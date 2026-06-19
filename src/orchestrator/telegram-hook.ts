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

import { createHash } from 'node:crypto'
import { orchestrate, classifyIntent, renderResult, actionLabel } from './index.js'
import type { ExecEvent, PlanStep } from './types.js'
import { buildAvsoV2PlanStep } from './plan.js'
import type {
  AthenaWriteLedger,
  ConfirmRequest,
  LedgerResolution,
} from './athena-write-ledger.js'

const KERNEL_URL = process.env.KERNEL_URL ?? 'http://100.80.111.84:3000'
const KERNEL_TOKEN = process.env.KERNEL_TOKEN ?? ''
const PRIME_AGENT_ID = 'agent_orchestrator-prime-jarvis-os'

const CONFIRM_TTL_MS = 10 * 60 * 1000
const CONFIRM_REMINDER_MS = 8 * 60 * 1000
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
// chatId → reminder timer handle. Cleared when the gate is resolved.
const confirmReminders = new Map<string, ReturnType<typeof setTimeout>>()

function clearConfirmReminder(chatId: string): void {
  const timer = confirmReminders.get(chatId)
  if (timer) {
    clearTimeout(timer)
    confirmReminders.delete(chatId)
  }
}

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
        clearConfirmReminder(chatId)
        // fall through — stale gate, treat the message normally
      } else {
        const decision = classifyConfirmReply(text, pend.phrase)
        if (decision === 'confirm') {
          pendingConfirms.delete(chatId)
          clearConfirmReminder(chatId)
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
          clearConfirmReminder(chatId)
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
              // Schedule a reminder nudge before the gate expires silently
              const prevTimer = confirmReminders.get(chatId)
              if (prevTimer) clearTimeout(prevTimer)
              const reminderTimer = setTimeout(async () => {
                const still = pendingConfirms.get(chatId)
                if (still && still.envelopeId === ev.envelope_id) {
                  try {
                    await cfg.deliver(chatId, `⏰ Reminder: still waiting on your call — **${label}**.\nReply *publish* to confirm or *cancel* to abort. Expires in ~2 min.`)
                  } catch { /* swallow */ }
                }
                confirmReminders.delete(chatId)
              }, CONFIRM_REMINDER_MS)
              confirmReminders.set(chatId, reminderTimer)
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

// ── AVSO v2 (Wave 1 T2) — pending-write ledger integration ──────────────
//
// Additive ONLY. This is the seam the future v2 confirm path calls when a
// Telegram affirmative arrives that *might* release a staged Athena EMR
// write. It is intentionally a thin, pure delegation to the ledger so the
// safety decision lives in one tested place (athena-write-ledger.ts) and
// nothing here can commit a write on its own. It does NOT touch the
// existing T3 envelope confirm routing above; the eventual v2 wiring will
// call this explicitly. PHI-safe by construction: it neither logs nor
// returns anything beyond what the ledger already exposes (the ledger
// itself never emits the staged text).
export function resolveAthenaPendingWrite(
  ledger: AthenaWriteLedger,
  req: ConfirmRequest,
): LedgerResolution {
  return ledger.confirm(req)
}

// ── AVSO v2 (Wave 3 T9) — Telegram confirm integration (the L3 gate) ────
//
// This is the human audit gate for the free-text EMR write. It is
// ADDITIVE and deliberately separate from the W21 envelope-confirm
// routing above — but it reuses, rather than reinvents, that mechanism:
//
//   • the same "armed pending per chat + intercept the next reply"
//     shape as `pendingConfirms` (here: `athenaConfirms`),
//   • the same affirmative/negative grammar (`AFFIRM` / `NEGATE`) — but
//     the AFFIRMATIVE here must be EXACT (ok/yes/…), never a fuzzy
//     "publish"-style match, because the safety decision is delegated
//     to the byte-exact `AthenaWriteLedger` (C3),
//   • a confirm gate UX consistent with the existing tier-3 confirm
//     ("reply ok / cancel"), not a parallel verb.
//
// C5: the confirm message echoes the EXACT to-be-written text + the
// resolved field that the caller resolved on the TRUSTED Telegram-side
// path — it is NEVER reconstructed from the redacted orchestrate result
// or an LLM transcript. That echo is the one SPEC-sanctioned outbound
// exception (Tripp must verify what gets written). The text NEVER
// crosses into the kernel envelope (the commit dispatch is the redacted
// `athena-input-commit` PlanStep), a log line, or memory.

const ATHENA_CONFIRM_TTL_MS = 10 * 60 * 1000

interface AthenaPendingConfirm {
  correlationId: string
  field: string
  /** Trusted Telegram-side copy of the text, held only to (a) re-echo
   *  on retry and (b) fingerprint the ledger commit. Never logged. */
  text: string
  createdAt: number
}
// chatId → armed AVSO write confirm. Module-scoped (one poller process),
// same pattern as `pendingConfirms`.
const athenaConfirms = new Map<string, AthenaPendingConfirm>()

/** Test-only: drop all armed AVSO confirms between cases. */
export function __resetAthenaConfirms(): void {
  athenaConfirms.clear()
}

/** True iff a non-affirmative reply should ABORT (explicit cancel/no)
 *  rather than merely keep the gate armed for a retry. */
function isAthenaCancel(reply: string): boolean {
  const norm = reply.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim()
  return NEGATE.has(norm)
}

/** True iff the reply is an EXACT affirmative. Reuses the W21 AFFIRM
 *  set, but — unlike the fuzzy tier-3 phrase match — requires an exact
 *  normalized hit (no canonical-phrase aliasing), because the actual
 *  go/no-go is the byte-exact ledger match, not this string. */
function isAthenaAffirmative(reply: string): boolean {
  const norm = reply.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim()
  return AFFIRM.has(norm)
}

export interface AthenaConfirmDeliverCfg {
  deliver: (chatId: string, text: string) => Promise<void>
}

// ── Φ-PHI-Flow B3 (Phase 2 / Wave 2 / T8) — commit-side audit hook ───────
//
// The WRITE-COMMIT signed access block. Sibling task T5 owns the real
// emitter (`jarvis-prime/src/orchestrator/phi-gate.ts:emitAccessBlock`).
// We do NOT import it: the emitter is an *injected dependency* (exactly
// the `dispatchCommit` idiom above) so (a) production wires the real
// `phi-gate.ts` emitter, (b) tests inject a mock, and (c) this hook is
// structurally PHI-blind — it can only ever hand the emitter the
// non-PHI command descriptor, never the staged write text.
//
// FROZEN T5 contract (build to it; do not deviate):
//   emitAccessBlock(
//     {decision, resourceHash, corrId, cmdKind, tier, deviceId, ts},
//     deps): void
// `resourceHash` / `cmdKind` / `corrId` are non-PHI; `resourceHash` is
// derived HERE from the non-PHI command descriptor (corrId|field|kind),
// NEVER the write text. The write-ledger's stored text is never read by
// this hook — the SPEC-v2 C5 sanctioned echo is a SEPARATE concern on
// the `deliver` path; the audit block is corrId-only (SPEC R5).
export type PhiGateDecision = 'allow:committed' | 'deny:cancelled'

export interface PhiGateAccessBlockArgs {
  decision: PhiGateDecision
  /** Salted/opaque digest of the NON-PHI descriptor (never the text). */
  resourceHash: string
  /** The REDACTED correlation id — the only thing this block keys off. */
  corrId: string
  cmdKind: string
  tier: number
  deviceId: string
  /** ISO timestamp of the resolution. */
  ts: string
}

/** The injected T5 emitter surface. `deps` is opaque to this hook (T5
 *  owns the chain client); we pass through whatever the caller wires. */
export type EmitAccessBlockFn = (
  args: PhiGateAccessBlockArgs,
  deps?: unknown,
) => void

/** AVSO write-commit is a tier-3 clinical mutation. */
const PHI_GATE_COMMIT_KIND = 'athena-input-commit'
const PHI_GATE_COMMIT_TIER = 3

/**
 * Non-PHI resource digest for the audit block. Hashes ONLY the
 * correlation id + resolved field id + command kind — all non-PHI
 * descriptors. The staged write text is NEVER an input here; that is
 * the structural PHI-blindness guarantee (G2/AC2). The salt concern
 * belongs to T5's chain (`audit-ledger.ts` re-salts a reference); this
 * is just a stable opaque handle so the block is not the raw corrId.
 */
function phiGateResourceHash(corrId: string, fieldId: string): string {
  return createHash('sha256')
    .update(`${PHI_GATE_COMMIT_KIND}|${corrId}|${fieldId}`)
    .digest('hex')
}

export interface AthenaConfirmReplyCfg extends AthenaConfirmDeliverCfg {
  /** Emits the redacted `athena-input-commit` dispatch (kernel-bound).
   *  The caller wires this to the real envelope path; in tests it is a
   *  sink. It is given the already-redacted PlanStep — the raw text is
   *  NEVER passed here. */
  dispatchCommit: (step: PlanStep) => Promise<unknown>
  /**
   * Φ-PHI-Flow B3 commit-side audit emitter (T5's `emitAccessBlock`).
   * OPTIONAL: when absent the confirm path behaves exactly as before
   * (backward compatible). When present, the hook emits exactly ONE
   * signed access block per confirm/cancel resolution, keyed off the
   * REDACTED correlation id only — never the write-ledger text.
   */
  emitAccessBlock?: EmitAccessBlockFn
  /** Opaque deps forwarded to `emitAccessBlock` (T5's chain client).
   *  This hook never inspects it. */
  phiGateDeps?: unknown
  /** Enrolled device identity for the audit block. Non-PHI. Defaults to
   *  the chat id when the caller has not resolved a device. */
  deviceId?: string
}

export interface AthenaConfirmContext {
  chatId: string
  /** The prepare correlation id — the commit re-uses it (T1 contract). */
  correlationId: string
  /** The resolved clinical field the write targets. */
  field: string
  /** The EXACT text to be written, from the trusted Telegram-side path
   *  (NOT the redacted orchestrate result). */
  text: string
}

export type AthenaConfirmArmResult =
  | { armed: true }
  | { armed: false; reason: 'already_pending' }

/**
 * Compose + send the confirm message for an available `athena-input`
 * PREPARE result, and open the matching pending-write ledger entry.
 *
 * The message shows the EXACT field + text (C5 sanctioned echo). The
 * ledger is the single safety authority: if a write is already in
 * flight for this chat, the second is REJECTED (no clobber) and the
 * user is told without leaking the second text.
 */
export async function composeAthenaConfirm(
  cfg: AthenaConfirmDeliverCfg,
  ctx: AthenaConfirmContext,
  ledger: AthenaWriteLedger,
): Promise<AthenaConfirmArmResult> {
  const opened = ledger.open({
    sessionKey: ctx.chatId,
    correlationId: ctx.correlationId,
    field: ctx.field,
    text: ctx.text,
  })
  if (!opened.accepted) {
    // A write is already armed for this chat. Do NOT echo the new text.
    await cfg.deliver(
      ctx.chatId,
      `⏸ A different Athena write is already awaiting your confirm on this chat. ` +
        `Reply *ok* to confirm that one or *cancel* to drop it before staging another.`,
    )
    return { armed: false, reason: 'already_pending' }
  }

  athenaConfirms.set(ctx.chatId, {
    correlationId: ctx.correlationId,
    field: ctx.field,
    text: ctx.text,
    createdAt: Date.now(),
  })

  // The one SPEC-sanctioned echo: show EXACTLY what will be written so
  // Tripp can audit it. Consistent with the tier-3 confirm UX.
  await cfg.deliver(
    ctx.chatId,
    [
      `⏸ **Confirm Athena write — field: ${ctx.field}**`,
      `This will write the following EXACT text into Athena:`,
      '',
      ctx.text,
      '',
      `Reply *ok* (or *yes*) to write it, or *cancel* to abort. ` +
        `Nothing is written until you confirm; this expires soon.`,
    ].join('\n'),
  )
  return { armed: true }
}

export interface AthenaConfirmReplyResult {
  /** True iff this reply was claimed by the AVSO confirm path. */
  handled: boolean
  /** True iff the ledger committed and the commit dispatch was emitted. */
  committed: boolean
}

/**
 * Resolve the user's reply against an armed AVSO write.
 *
 *   • exact affirmative (ok/yes/…) → `resolveAthenaPendingWrite` against
 *     the TRUSTED reply context; if it returns committed → emit ONE
 *     redacted `athena-input-commit` dispatch carrying the prepare
 *     correlation id, then clear the gate.
 *   • explicit cancel/no → abort, clear the gate, no commit.
 *   • anything else (typo / unrelated) → NO commit; the gate STAYS
 *     armed so Tripp can still confirm (until TTL).
 *   • stale / expired / mismatch → NO commit, honest "not confirmed".
 *
 * `replyContext` overrides the trusted field/text/corr used for the
 * ledger match (defaults to the staged values). It exists so the
 * caller can pass the freshly-resolved Telegram-side context; a
 * mismatch (tamper / wrong field) provably refuses to commit.
 */
export async function handleAthenaConfirmReply(
  cfg: AthenaConfirmReplyCfg,
  chatId: string,
  reply: string,
  ledger: AthenaWriteLedger,
  replyContext?: { correlationId: string; field: string; text: string },
): Promise<AthenaConfirmReplyResult> {
  const pend = athenaConfirms.get(chatId)
  if (!pend) {
    // Nothing armed here — let the normal flow handle this message.
    // No armed write ⇒ nothing to audit (no corrId/resolution exists).
    return { handled: false, committed: false }
  }

  // ── Φ-PHI-Flow B3 — commit-side signed access block ───────────────────
  //
  // One block per resolution, keyed off the REDACTED correlation id only.
  // `pend.correlationId` / `pend.field` are non-PHI descriptors (the
  // redacted id minted upstream + the resolved field name); the staged
  // `pend.text` / `resolution.text` is NEVER read here — that is the
  // structural PHI-blindness guarantee (G2/AC2; SPEC R5). Idempotent by
  // construction: a `resolved` latch ensures at most one emit even if a
  // future edit adds another return path. No-ops cleanly when the caller
  // did not inject `emitAccessBlock` (backward compatible).
  let phiGateAudited = false
  const emitPhiGateBlock = (decision: PhiGateDecision): void => {
    if (phiGateAudited) return
    phiGateAudited = true
    const emit = cfg.emitAccessBlock
    if (!emit) return
    try {
      emit(
        {
          decision,
          resourceHash: phiGateResourceHash(pend.correlationId, pend.field),
          corrId: pend.correlationId,
          cmdKind: PHI_GATE_COMMIT_KIND,
          tier: PHI_GATE_COMMIT_TIER,
          deviceId: cfg.deviceId ?? chatId,
          ts: new Date().toISOString(),
        },
        cfg.phiGateDeps,
      )
    } catch {
      // The audit emitter must never break the confirm path. T5 owns
      // emit-failure handling (re-auth / integrity alert, PLAN R3).
    }
  }

  // Stale gate: drop it and abort honestly (do not silently fall through
  // to a write).
  if (Date.now() - pend.createdAt > ATHENA_CONFIRM_TTL_MS) {
    emitPhiGateBlock('deny:cancelled')
    athenaConfirms.delete(chatId)
    ledger.cancel(chatId)
    await cfg.deliver(
      chatId,
      `✋ That Athena write expired — write cancelled, not confirmed. Nothing was written.`,
    )
    return { handled: true, committed: false }
  }

  if (isAthenaCancel(reply)) {
    emitPhiGateBlock('deny:cancelled')
    athenaConfirms.delete(chatId)
    ledger.cancel(chatId)
    await cfg.deliver(
      chatId,
      `✋ Cancelled — write cancelled, not confirmed. Nothing was written to Athena.`,
    )
    return { handled: true, committed: false }
  }

  if (!isAthenaAffirmative(reply)) {
    // Not an exact affirmative and not an explicit cancel: keep the gate
    // armed (Tripp can still confirm) but commit nothing. This resolution
    // did NOT commit ⇒ a deny:cancelled audit event (corrId-only).
    emitPhiGateBlock('deny:cancelled')
    await cfg.deliver(
      chatId,
      `⏸ Write cancelled — not confirmed (I only act on an exact *ok* / *yes*). ` +
        `The write is still staged for field *${pend.field}* — reply *ok* to write it, or *cancel* to drop it.`,
    )
    return { handled: true, committed: false }
  }

  // Exact affirmative → ask the LEDGER (the single safety authority).
  const match = replyContext ?? {
    correlationId: pend.correlationId,
    field: pend.field,
    text: pend.text,
  }
  const resolution = resolveAthenaPendingWrite(ledger, {
    sessionKey: chatId,
    correlationId: match.correlationId,
    field: match.field,
    text: match.text,
  })

  if (!resolution.committed) {
    // Ledger refused (expired / correlation|field|text mismatch). NO
    // commit. A non-matching attempt does not consume a still-valid
    // entry, so leave `athenaConfirms` only if the ledger is truly gone.
    if (resolution.reason === 'expired' || resolution.reason === 'no_pending') {
      athenaConfirms.delete(chatId)
    }
    // Ledger refused (tamper / mismatch / expiry) ⇒ deny:cancelled.
    // `resolution.reason` is a non-PHI status string; the block keys off
    // corrId only and never carries the refused text.
    emitPhiGateBlock('deny:cancelled')
    await cfg.deliver(
      chatId,
      `✋ Write cancelled — not confirmed (${resolution.reason}). Nothing was written to Athena.`,
    )
    return { handled: true, committed: false }
  }

  // Committed. Clear the gate and emit the REDACTED commit dispatch. The
  // PlanStep builder drops the raw text on the floor and ships only the
  // placeholder + the re-used correlation id (T1 contract).
  athenaConfirms.delete(chatId)
  const step = buildAvsoV2PlanStep({
    kind: 'athena-input-commit',
    rawWriteText: resolution.text,
    fieldId: resolution.field,
    correlationId: resolution.correlationId,
  })
  // The kernel-bound dispatch can reject (kernel down / network error).
  // If it does, the ledger entry is already consumed and the gate is
  // already cleared, but the write did NOT reach the kernel — so the
  // honest outcome is "not confirmed", the audit block is deny:cancelled
  // (nothing executed downstream), and the failure must NOT propagate
  // uncaught into the Telegram poller. The error is non-PHI by
  // construction (the redacted step carries `<WRITE_TEXT>`, never the
  // staged text), but we deliberately do not echo it to avoid leaking
  // any kernel-side detail into the chat.
  try {
    await cfg.dispatchCommit(step)
  } catch {
    // Dispatch failed — emit the deny block (the write was authorized by
    // the human but NOT executed) and tell Tripp honestly. Single-use
    // entry is already gone; he must re-stage to retry.
    emitPhiGateBlock('deny:cancelled')
    await cfg.deliver(
      chatId,
      `⚠️ Couldn't reach Athena to write that (field *${resolution.field}*) — ` +
        `not confirmed. Nothing was written. Please re-stage the write to retry.`,
    )
    return { handled: true, committed: false }
  }
  // B3 two-phase: emit the signed allow block POST-dispatch / PRE-return
  // (PLAN T8 AC — "authorized/executed"). Keyed off the redacted corrId;
  // the committed write text is never an input to this block.
  emitPhiGateBlock('allow:committed')
  await cfg.deliver(
    chatId,
    `✅ Confirmed — writing to Athena (field *${resolution.field}*).`,
  )
  return { handled: true, committed: true }
}

/**
 * The Telegram reply for a patient-search (`athena-patient-nav`). It is
 * NON-PHI by construction: it never echoes the query or any result —
 * the search is a blind typist; Tripp picks the patient on the Athena
 * screen. This function takes the query only to make that contract
 * explicit at the call site; it deliberately ignores it.
 */
export function composeAthenaPatientSearchReply(_input: {
  query?: string
}): string {
  return (
    `🔎 Search submitted in Athena — pick the patient on screen. ` +
    `(I never see the name or any record; this is a blind hand-off.)`
  )
}
