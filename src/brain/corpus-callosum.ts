/**
 * Corpus callosum orchestrator — Wave 3 (T09-T12).
 *
 * Runs the Gibsonian dual-brain flow for one user message:
 *   Pass 1 (parallel)   — left + right produce independent drafts.
 *   Pass 2 (parallel)   — each hemisphere revises after seeing the other's
 *                         pass-1 draft (corpus-callosum exchange).
 *   Integration         — Claude (left) alone integrates the two pass-2
 *                         drafts into one final response to Tripp. Retried
 *                         exactly once on failure.
 *
 * Only metadata is logged (event name, hemisphere tag, pass number, counts,
 * durations). System/user prompts and draft content NEVER leave this file
 * via the logger — PHI-adjacent data stays internal.
 */
import {
  integrationPrompt,
} from "./integration.js"
import {
  leftAffordancePrompt,
  leftRevisionPrompt,
  rightAffordancePrompt,
  rightRevisionPrompt,
} from "./affordance.js"
import {
  IntegrationError,
  type BrainResult,
  type HemisphereClient,
  type HistoryEntry,
} from "./types.js"

/** Minimal structured logger — subset of Fastify's pino surface. */
export interface CorpusCallosumLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface CorpusCallosumDeps {
  /** Claude — used for pass-1 left, pass-2 left, and the final integration. */
  left: HemisphereClient
  /** GPT via OpenClaw — used for pass-1 right and pass-2 right. */
  right: HemisphereClient
  /** Shared Jarvis Prime system/context prompt. */
  basePrompt: string
  /** Per-call timeout (ms) passed down to each hemisphere. */
  timeoutMs: number
  /** Optional structured logger. */
  logger?: CorpusCallosumLogger
  /**
   * Called at each phase start for UX labeling. Does NOT expose content.
   * Fires for: "callosum_pass1_start", "callosum_pass2_start",
   * "callosum_integration_start". Throws are swallowed — a misbehaving
   * callback must never break the orchestrator.
   */
  onEvent?: (eventName: string) => void
}

export interface CorpusCallosumInput {
  userMsg: string
  history: HistoryEntry[]
}

/**
 * Run the full corpus-callosum flow end to end. Returns the final integrated
 * text plus a trace of the four hemisphere drafts for logging / debugging.
 *
 * Throws:
 *   - LeftHemisphereError  if pass-1 or pass-2 left fails (bubbled from client).
 *   - RightHemisphereError if pass-1 or pass-2 right fails (bubbled from client).
 *   - IntegrationError     if the integration call fails on both its attempt
 *                          and its one retry. The original error is preserved
 *                          via `cause`.
 */
export async function corpusCallosum(
  deps: CorpusCallosumDeps,
  input: CorpusCallosumInput,
): Promise<BrainResult> {
  const { left, right, basePrompt, timeoutMs, logger, onEvent } = deps
  const { userMsg, history } = input

  const emit = (eventName: string): void => {
    if (!onEvent) return
    try {
      onEvent(eventName)
    } catch {
      // Swallow — UX callbacks must never break orchestrator flow.
    }
  }

  const start = Date.now()

  logger?.info(
    { event: "callosum_start", userMsgLength: userMsg.length },
    "corpus callosum start",
  )

  // --- T09: Pass 1 — parallel independent drafts ---------------------------
  logger?.info({ event: "callosum_pass1_start" }, "pass 1 start")
  emit("callosum_pass1_start")

  const p1LeftPrompt = leftAffordancePrompt(basePrompt, history, userMsg)
  const p1RightPrompt = rightAffordancePrompt(basePrompt, history, userMsg)

  // Promise.all — first rejection aborts the wave and bubbles the typed error.
  const [p1LeftResult, p1RightResult] = await Promise.all([
    left.call({ system: p1LeftPrompt.system, user: p1LeftPrompt.user, timeoutMs }),
    right.call({ system: p1RightPrompt.system, user: p1RightPrompt.user, timeoutMs }),
  ])

  logger?.info(
    {
      event: "callosum_pass1_ok",
      leftMs: p1LeftResult.durationMs,
      rightMs: p1RightResult.durationMs,
    },
    "pass 1 ok",
  )

  // --- T10: Pass 2 — revision exchange (parallel) --------------------------
  logger?.info({ event: "callosum_pass2_start" }, "pass 2 start")
  emit("callosum_pass2_start")

  const p2LeftPrompt = leftRevisionPrompt(
    basePrompt,
    history,
    userMsg,
    p1LeftResult.content, // my draft
    p1RightResult.content, // other draft
  )
  const p2RightPrompt = rightRevisionPrompt(
    basePrompt,
    history,
    userMsg,
    p1RightResult.content, // my draft
    p1LeftResult.content, // other draft
  )

  const [p2LeftResult, p2RightResult] = await Promise.all([
    left.call({ system: p2LeftPrompt.system, user: p2LeftPrompt.user, timeoutMs }),
    right.call({ system: p2RightPrompt.system, user: p2RightPrompt.user, timeoutMs }),
  ])

  logger?.info(
    {
      event: "callosum_pass2_ok",
      leftMs: p2LeftResult.durationMs,
      rightMs: p2RightResult.durationMs,
    },
    "pass 2 ok",
  )

  // --- T11: Integration — Claude only, with one-shot retry -----------------
  logger?.info({ event: "callosum_integration_start" }, "integration start")
  emit("callosum_integration_start")

  const intPrompt = integrationPrompt(
    basePrompt,
    history,
    userMsg,
    p2LeftResult.content,
    p2RightResult.content,
  )

  const integrationStart = Date.now()
  let integrationContent: string
  let integrationCallDurationMs: number

  try {
    const first = await left.call({
      system: intPrompt.system,
      user: intPrompt.user,
      timeoutMs,
    })
    integrationContent = first.content
    integrationCallDurationMs = first.durationMs
  } catch (firstErr) {
    logger?.warn(
      { event: "callosum_integration_retry" },
      "integration first attempt failed, retrying once",
    )
    try {
      const second = await left.call({
        system: intPrompt.system,
        user: intPrompt.user,
        timeoutMs,
      })
      integrationContent = second.content
      integrationCallDurationMs = second.durationMs
    } catch (secondErr) {
      logger?.error(
        {
          event: "callosum_integration_failed",
          error:
            secondErr instanceof Error
              ? secondErr.message
              : String(secondErr),
        },
        "integration failed after retry",
      )
      if (secondErr instanceof IntegrationError) {
        throw secondErr
      }
      throw new IntegrationError(
        `integration failed after retry: ${
          secondErr instanceof Error ? secondErr.message : String(secondErr)
        }`,
        secondErr,
      )
    }
  }

  const integrationMs = Date.now() - integrationStart
  const finalText = integrationContent.trim()

  logger?.info(
    { event: "callosum_integration_ok", integrationMs },
    "integration ok",
  )

  const totalMs = Date.now() - start
  logger?.info({ event: "callosum_done", totalMs }, "corpus callosum done")

  return {
    finalText,
    trace: {
      p1Left: {
        hemisphere: "left",
        pass: 1,
        content: p1LeftResult.content,
        durationMs: p1LeftResult.durationMs,
      },
      p1Right: {
        hemisphere: "right",
        pass: 1,
        content: p1RightResult.content,
        durationMs: p1RightResult.durationMs,
      },
      p2Left: {
        hemisphere: "left",
        pass: 2,
        content: p2LeftResult.content,
        durationMs: p2LeftResult.durationMs,
      },
      p2Right: {
        hemisphere: "right",
        pass: 2,
        content: p2RightResult.content,
        durationMs: p2RightResult.durationMs,
      },
      integrationMs,
      totalMs,
    },
  }
  // Note: integrationCallDurationMs is intentionally unused in the returned
  // trace — the spec measures integration wall time via Date.now() deltas,
  // which captures retry overhead. The individual call duration is available
  // for future extension if needed.
  void integrationCallDurationMs
}
