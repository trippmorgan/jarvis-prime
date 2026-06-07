/**
 * Corpus callosum orchestrator — Wave 3 (T09-T12), extended Wave 8 (T10).
 *
 * Legacy flow (routerEnabled=false or absent):
 *   Pass 1 (parallel)   — left + right produce independent drafts.
 *   Pass 2 (parallel)   — each hemisphere revises after seeing the other's
 *                         pass-1 draft (corpus-callosum exchange).
 *   Integration         — Claude (left) alone integrates the two pass-2
 *                         drafts into one final response. Retried once.
 *
 * Router flow (Wave 8, routerEnabled=true):
 *   Pass 1 is SEQUENTIAL instead of parallel — right depends on left's
 *   dispatch decision.
 *     1. Left plans + drafts via leftPlanningPrompt (emits <dispatch> + <tools>).
 *     2. Parse left's dispatch + tools-evidence blocks.
 *     3. Optionally invoke the skill shim (if dispatch.mode === "skill" and
 *        left did not also run that skill — otherwise reject as duplicate and
 *        fall through to research mode).
 *     4. Right drafts via buildRightPass1Prompt, receiving the skill output
 *        as <skill-evidence> or a research-mode framing.
 *   Pass 2 + Integration remain unchanged.
 *
 * Only metadata is logged (event name, hemisphere tag, pass number, counts,
 * durations). System/user prompts and draft content NEVER leave this file
 * via the logger — PHI-adjacent data stays internal.
 */
import {
  integrationPrompt,
  integrationPromptWithSelfCheck,
  integrationRetryPrompt,
  parseSelfCheck,
  stripSelfCheck,
  SELF_CORRECTION_CAVEAT,
} from "./integration.js"
import {
  leftAffordancePrompt,
  leftPlanningPrompt,
  leftRevisionPrompt,
  rightAffordancePrompt,
  rightRevisionPrompt,
  type ToolsCrossVisibility,
  type ToolsUsedSummary,
} from "./affordance.js"
import {
  parseDispatch,
  parseLeftToolsEvidence,
} from "./dispatch-parser.js"
import { buildRightPass1Prompt } from "./right-prompts.js"
import { ALLOWED_SKILLS } from "./skill-registry.js"
import type {
  Dispatch,
  ToolEvidence,
} from "./dispatch-types.js"
import type {
  InvokeOptions,
  SkillInvocationResult,
} from "./right-brain-skill-shim.js"
import type { SkillDispatch } from "./dispatch-types.js"
import {
  IntegrationError,
  LeftHemisphereError,
  type BrainResult,
  type HemisphereClient,
  type HistoryEntry,
} from "./types.js"

/**
 * Caveat prepended to the final answer when the integration-stage left call
 * fails (typically a timeout) and we fall back to pass-2 left's draft. DIL
 * 2026-05-26 finding #3 — surface a partial-but-useful result instead of a
 * hard error to the user. Distinct from SELF_CORRECTION_CAVEAT so router-mode
 * self-check stripping doesn't trip on it.
 */
export const INTEGRATION_FALLBACK_CAVEAT =
  "_(Integration step timed out — delivering the pre-integration draft. Some refinement may be missing.)_\n\n"

/** Minimal structured logger — subset of Fastify's pino surface. */
export interface CorpusCallosumLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/**
 * Minimal interface the orchestrator needs from the skill shim. The full
 * class (RightBrainSkillShim) satisfies this; tests can supply a stub.
 */
export interface SkillShim {
  invoke(
    dispatch: SkillDispatch,
    opts: InvokeOptions,
  ): Promise<SkillInvocationResult>
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
   * Called at each phase boundary for UX. Most events carry no payload
   * (pass1_start, pass2_start, integration_start). The "callosum_pass2_ok"
   * event ships the two pass-2 drafts so the UX layer can render a
   * deliberation card before integration begins. Throws are swallowed — a
   * misbehaving callback must never break the orchestrator.
   */
  onEvent?: (eventName: string, payload?: CallosumEventPayload) => void
  /**
   * Wave 8 — enable the router path. Left plans + dispatches in pass-1 and
   * right drafts either via the shim's skill output or from workspace memory.
   * Default: false (legacy parallel-pass-1 flow).
   */
  routerEnabled?: boolean
  /**
   * Wave 8 — injected skill shim used when dispatch.mode === "skill". If
   * absent and a skill dispatch arrives, the orchestrator falls back to
   * research mode (treated as "no tools available").
   */
  skillShim?: SkillShim
}

/**
 * Payload shape for orchestrator UX events. Structurally a record — the
 * emitter's per-event convention documents which keys are present. Legacy
 * event `callosum_pass2_ok` carries p2Left/p2Right/leftMs/rightMs; Wave 8
 * router events carry `skill`, `mode`, `warning`, `topicCount`, `durationMs`
 * as applicable.
 */
export type CallosumEventPayload =
  | {
      p2Left?: string
      p2Right?: string
      leftMs?: number
      rightMs?: number
      mode?: "skill" | "research"
      skill?: string
      topicCount?: number
      warning?: string
      durationMs?: number
      /** W8-T13 — router-mode deliberation card evidence. */
      leftTools?: ToolEvidence[]
      rightTools?: ToolEvidence[]
      rightMode?: "skill" | "research"
      rightSkill?: string
      /** W8.8.6 — hemisphere stream events for verbose UX. */
      hemisphere?: "left" | "right"
      phase?: "pass1" | "pass2" | "integration"
      streamEvent?: unknown
    }
  | undefined

export interface CorpusCallosumInput {
  userMsg: string
  history: HistoryEntry[]
  /**
   * Dual-brain timeout telemetry (additive, 2026-06-07). Caller sets this
   * to `true` when the dispatch is a retry of a prior timed-out dispatch
   * for the same user turn. Default `false`. Used purely as a structured
   * log field — no routing or behavior delta.
   */
  retry?: boolean
}

// -----------------------------------------------------------------------------
// Dual-brain timeout telemetry (additive, 2026-06-07)
// -----------------------------------------------------------------------------
//
// Emits a single structured log event `dual_brain_dispatch_telemetry` per
// dispatch via the existing logger surface (pino-shape). Fields:
//   - task_class     "freeform" | "research" | `skill:<name>` (router mode)
//   - route          "dual-brain" | "integrator-left-fallback" | "dual-brain-errored"
//   - elapsed_bucket "<60s" | "60-120s" | "120-180s" | "180s-timeout"
//                    Buckets are picked to straddle the current default
//                    LEFT_HEMISPHERE_FAST_TIMEOUT_MS (180_000) so dispatches
//                    can be triaged against the soft ceiling. We do NOT
//                    reference the threshold value to keep the buckets stable
//                    if the threshold is tuned. The terminal label name is
//                    aspirational — anything >=180s falls in it regardless.
//   - load           int >= 1, concurrent in-flight dispatches at start
//   - retry          boolean, propagated from input.retry
//   - outcome        "completed" | "timed_out" | "errored"
//
// Strictly additive — no threshold changes, no routing changes, no PHI.
// -----------------------------------------------------------------------------
export type DualBrainTelemetryRoute =
  | "dual-brain"
  | "integrator-left-fallback"
  | "dual-brain-errored"

export type DualBrainTelemetryOutcome = "completed" | "timed_out" | "errored"

export type DualBrainTelemetryBucket =
  | "<60s"
  | "60-120s"
  | "120-180s"
  | "180s-timeout"

export interface DualBrainDispatchTelemetry {
  event: "dual_brain_dispatch_telemetry"
  task_class: string
  route: DualBrainTelemetryRoute
  elapsed_bucket: DualBrainTelemetryBucket
  load: number
  retry: boolean
  outcome: DualBrainTelemetryOutcome
}

/** Bucket boundaries straddle the 180s integrator soft-cap. */
export function bucketElapsed(elapsedMs: number): DualBrainTelemetryBucket {
  if (elapsedMs < 60_000) return "<60s"
  if (elapsedMs < 120_000) return "60-120s"
  if (elapsedMs < 180_000) return "120-180s"
  return "180s-timeout"
}

/** Module-level in-flight counter — captured at dispatch start. */
let inflightDispatches = 0

/**
 * Run the full corpus-callosum flow end to end. Returns the final integrated
 * text plus a trace of the four hemisphere drafts for logging / debugging.
 *
 * Throws:
 *   - LeftHemisphereError  if pass-1 or pass-2 left fails (bubbled from client).
 *   - RightHemisphereError if pass-1 or pass-2 right fails (bubbled from client).
 *   - IntegrationError     if the integration call fails. The original error
 *                          is preserved via `cause`. No retry on timeout —
 *                          retrying with the same budget doesn't help a task
 *                          that genuinely needs more time; it just doubles
 *                          latency before the same failure.
 */
export async function corpusCallosum(
  deps: CorpusCallosumDeps,
  input: CorpusCallosumInput,
): Promise<BrainResult> {
  const {
    left,
    right,
    basePrompt,
    timeoutMs,
    logger,
    onEvent,
    routerEnabled,
    skillShim,
  } = deps
  const { userMsg, history } = input
  const retryFlag = input.retry === true

  // --- Dual-brain dispatch telemetry (additive) ----------------------------
  // Snapshot the in-flight count BEFORE incrementing so `load` reflects the
  // existing pressure this dispatch entered into. Default task_class is
  // "freeform" (legacy non-router path); router-mode dispatch parsing
  // overrides this further down.
  const dispatchStart = Date.now()
  const loadAtStart = inflightDispatches + 1
  inflightDispatches += 1
  let telemetryTaskClass = "freeform"
  let telemetryRoute: DualBrainTelemetryRoute = "dual-brain"
  let telemetryOutcome: DualBrainTelemetryOutcome = "errored"
  const emitDispatchTelemetry = (): void => {
    if (!logger) return
    const payload: DualBrainDispatchTelemetry = {
      event: "dual_brain_dispatch_telemetry",
      task_class: telemetryTaskClass,
      route: telemetryRoute,
      elapsed_bucket: bucketElapsed(Date.now() - dispatchStart),
      load: loadAtStart,
      retry: retryFlag,
      outcome: telemetryOutcome,
    }
    logger.info(payload, "dual-brain dispatch telemetry")
  }

  const emit = (eventName: string, payload?: CallosumEventPayload): void => {
    if (!onEvent) return
    try {
      onEvent(eventName, payload)
    } catch {
      // Swallow — UX callbacks must never break orchestrator flow.
    }
  }

  // W8.8.6 — build a phase-tagged stream handler for left.call. When onEvent
  // is absent (tests / no UX) we return undefined and left.call falls back to
  // the non-streaming spawner. Each forwarded event is wrapped in a
  // 'hemisphere_tool_use' callback so the responder can format + dedupe.
  const makeLeftStream = (
    phase: "pass1" | "pass2" | "integration",
  ): ((evt: unknown) => void) | undefined => {
    if (!onEvent) return undefined
    return (evt) => emit("hemisphere_tool_use", {
      hemisphere: "left",
      phase,
      streamEvent: evt,
    })
  }

  const start = Date.now()

  logger?.info(
    { event: "callosum_start", userMsgLength: userMsg.length },
    "corpus callosum start",
  )

  try {

  // --- Pass 1 ----------------------------------------------------------------
  const pass1PhaseStart = Date.now()
  let p1LeftResult: { content: string; durationMs: number }
  let p1RightResult: { content: string; durationMs: number }
  let leftToolsUsed: ToolEvidence[] | undefined
  let pass2Tools: ToolsCrossVisibility | undefined
  // W8-T13 — stable scope so callosum_pass2_ok can emit these for the card.
  let rightModeForCard: "skill" | "research" | undefined
  let rightSkillForCard: string | undefined

  if (routerEnabled) {
    // --- Wave 8 router path — SEQUENTIAL pass-1 --------------------------------
    logger?.info({ event: "router_plan_start" }, "router plan start")
    emit("router_plan_start")

    logger?.info({ event: "callosum_pass1_start" }, "pass 1 start")
    emit("callosum_pass1_start")

    const p1LeftPrompt = leftPlanningPrompt(
      basePrompt,
      history,
      userMsg,
      ALLOWED_SKILLS,
    )
    p1LeftResult = await left.call({
      system: p1LeftPrompt.system,
      user: p1LeftPrompt.user,
      timeoutMs,
      // Planner is a pure routing decision — no Bash, no MCP, no CLAUDE.md
      // auto-load. Heavy investigation belongs in the dispatched skill shim
      // (which keeps tools-on). Without this restriction, the planner can
      // wander on heavy prompts and hit the 240s ceiling. (v1.0.1, 2026-04-21;
      // re-confirmed 2026-04-23 after tools-on experiment hit 2/2 timeouts.)
      enableTools: false,
      onStreamEvent: makeLeftStream("pass1"),
    })

    // Parse left's dispatch + tools evidence.
    const parsed = parseDispatch(p1LeftResult.content)
    leftToolsUsed = parseLeftToolsEvidence(p1LeftResult.content)

    let effectiveDispatch: Dispatch | null = null
    let skillResult: SkillInvocationResult | undefined

    if (parsed.warning) {
      logger?.warn(
        { event: "dispatch_malformed", warning: parsed.warning },
        "dispatch parse failed — falling back to research mode",
      )
      emit("dispatch_malformed", { warning: parsed.warning })
    } else if (parsed.dispatch) {
      if (parsed.dispatch.mode === "skill") {
        const dispatchedSkill = parsed.dispatch.skill
        const duplicate = leftToolsUsed.some(
          (t) => t.name === dispatchedSkill,
        )
        if (duplicate) {
          logger?.warn(
            {
              event: "duplicate_skill_rejected",
              skill: dispatchedSkill,
            },
            "left already ran the dispatched skill — rejecting",
          )
          emit("duplicate_skill_rejected", { skill: dispatchedSkill })
          // Fall through to research mode.
        } else {
          effectiveDispatch = parsed.dispatch
          telemetryTaskClass = `skill:${dispatchedSkill}`
          logger?.info(
            { event: "dispatch_parsed", mode: "skill", skill: dispatchedSkill },
            "dispatch parsed (skill)",
          )
          emit("dispatch_parsed", { mode: "skill", skill: dispatchedSkill })
        }
      } else {
        effectiveDispatch = parsed.dispatch
        telemetryTaskClass = "research"
        logger?.info(
          {
            event: "dispatch_parsed",
            mode: "research",
            topicCount: parsed.dispatch.topics.length,
          },
          "dispatch parsed (research)",
        )
        emit("dispatch_parsed", {
          mode: "research",
          topicCount: parsed.dispatch.topics.length,
        })
      }
    }

    if (effectiveDispatch && effectiveDispatch.mode === "skill") {
      if (!skillShim) {
        logger?.warn(
          { event: "skill_shim_missing", skill: effectiveDispatch.skill },
          "skill dispatched but no shim injected — falling back to research",
        )
        effectiveDispatch = null
        emit("right_research_mode")
      } else {
        const skillDispatch = effectiveDispatch
        logger?.info(
          { event: "right_skill_invoke_start", skill: skillDispatch.skill },
          "right skill shim invoked",
        )
        skillResult = await skillShim.invoke(skillDispatch, {
          userMessage: userMsg,
          timeoutMs,
        })
        logger?.info(
          {
            event: "skill_shim_result",
            skill: skillDispatch.skill,
            ok: skillResult.ok,
            durationMs: skillResult.durationMs,
          },
          "skill shim result",
        )
        emit("right_skill_invoked", {
          skill: skillDispatch.skill,
          durationMs: skillResult.durationMs,
        })
      }
    } else {
      emit("right_research_mode")
    }

    const p1RightPrompt = buildRightPass1Prompt(
      basePrompt,
      history,
      userMsg,
      effectiveDispatch,
      skillResult,
    )
    p1RightResult = await right.call({
      system: p1RightPrompt.system,
      user: p1RightPrompt.user,
      timeoutMs,
    })

    // Build pass-2 cross-visibility summary.
    let rightSummary: ToolsUsedSummary
    if (skillResult) {
      rightSummary = {
        skill: {
          name: skillResult.skill,
          durationMs: skillResult.durationMs,
        },
      }
      rightModeForCard = "skill"
      rightSkillForCard = skillResult.skill
    } else {
      rightSummary = { researchMode: true }
      rightModeForCard = "research"
    }
    pass2Tools = {
      left: { tools: leftToolsUsed ?? [] },
      right: rightSummary,
    }
  } else {
    // --- Legacy path — parallel pass-1 ---------------------------------------
    logger?.info({ event: "callosum_pass1_start" }, "pass 1 start")
    emit("callosum_pass1_start")

    const p1LeftPrompt = leftAffordancePrompt(basePrompt, history, userMsg)
    const p1RightPrompt = rightAffordancePrompt(basePrompt, history, userMsg)

    ;[p1LeftResult, p1RightResult] = await Promise.all([
      left.call({
        system: p1LeftPrompt.system,
        user: p1LeftPrompt.user,
        timeoutMs,
        onStreamEvent: makeLeftStream("pass1"),
      }),
      right.call({ system: p1RightPrompt.system, user: p1RightPrompt.user, timeoutMs }),
    ])
  }

  const pass1WallMs = Date.now() - pass1PhaseStart

  logger?.info(
    {
      event: "callosum_pass1_ok",
      leftMs: p1LeftResult.durationMs,
      rightMs: p1RightResult.durationMs,
      pass1WallMs,
    },
    "pass 1 ok",
  )

  // --- Pass 2 — revision exchange (parallel) -------------------------------
  const pass2PhaseStart = Date.now()
  logger?.info({ event: "callosum_pass2_start" }, "pass 2 start")
  emit("callosum_pass2_start")

  const p2LeftPrompt = leftRevisionPrompt(
    basePrompt,
    history,
    userMsg,
    p1LeftResult.content, // my draft
    p1RightResult.content, // other draft
    pass2Tools,
  )
  const p2RightPrompt = rightRevisionPrompt(
    basePrompt,
    history,
    userMsg,
    p1RightResult.content, // my draft
    p1LeftResult.content, // other draft
    pass2Tools,
  )

  const [p2LeftResult, p2RightResult] = await Promise.all([
    left.call({
      system: p2LeftPrompt.system,
      user: p2LeftPrompt.user,
      timeoutMs,
      onStreamEvent: makeLeftStream("pass2"),
    }),
    right.call({ system: p2RightPrompt.system, user: p2RightPrompt.user, timeoutMs }),
  ])

  const pass2WallMs = Date.now() - pass2PhaseStart

  logger?.info(
    {
      event: "callosum_pass2_ok",
      leftMs: p2LeftResult.durationMs,
      rightMs: p2RightResult.durationMs,
      pass2WallMs,
    },
    "pass 2 ok",
  )

  // UX hook — ships pass-2 draft content out so the responder can render a
  // deliberation card before integration. Logger never receives content.
  emit("callosum_pass2_ok", {
    p2Left: p2LeftResult.content,
    p2Right: p2RightResult.content,
    leftMs: p2LeftResult.durationMs,
    rightMs: p2RightResult.durationMs,
    leftTools: leftToolsUsed,
    rightMode: rightModeForCard,
    rightSkill: rightSkillForCard,
  })

  // --- Integration — Claude only, single attempt --------------------------
  logger?.info({ event: "callosum_integration_start" }, "integration start")
  emit("callosum_integration_start")

  const intPrompt = routerEnabled
    ? integrationPromptWithSelfCheck(
        basePrompt,
        history,
        userMsg,
        p2LeftResult.content,
        p2RightResult.content,
      )
    : integrationPrompt(
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
      onStreamEvent: makeLeftStream("integration"),
    })
    integrationContent = first.content
    integrationCallDurationMs = first.durationMs
  } catch (err) {
    logger?.error(
      {
        event: "callosum_integration_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "integration failed",
    )
    // DIL 2026-05-26 #3 — right-only fallback. If the integration-stage left
    // call dies (timeout, spawn fail, non-zero exit), we already have a fully
    // formed pass-2 left draft sitting in p2LeftResult — it's left's revised
    // take on the merged view, just missing the formal integration polish.
    // Surface that with a caveat instead of throwing a hard error at the
    // user. Other error classes (IntegrationError, generic Error) still
    // propagate so we don't mask merge bugs.
    if (err instanceof LeftHemisphereError && p2LeftResult.content.trim().length > 0) {
      logger?.warn(
        {
          event: "integration_left_fallback",
          error: err.message,
          p2LeftLength: p2LeftResult.content.length,
        },
        "integration left failed — falling back to pass-2 left draft",
      )
      emit("integration_left_fallback", { durationMs: Date.now() - integrationStart })
      // Dual-brain timeout telemetry — fallback path engaged. Outcome stays
      // "timed_out" because the integrator-left call hit its budget; we still
      // deliver a useful result via the pass-2 left draft fallback.
      telemetryRoute = "integrator-left-fallback"
      telemetryOutcome = "timed_out"
      integrationContent = INTEGRATION_FALLBACK_CAVEAT + p2LeftResult.content
      integrationCallDurationMs = Date.now() - integrationStart
    } else {
      if (err instanceof IntegrationError) {
        throw err
      }
      throw new IntegrationError(
        `integration failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  // --- Wave 8 / T12 — bounded self-correction (router mode only) -----------
  if (routerEnabled) {
    const firstCheck = parseSelfCheck(integrationContent)
    if (firstCheck && !firstCheck.adequate && firstCheck.gaps.length > 0) {
      logger?.info(
        {
          event: "self_correction_retry_start",
          gapCount: firstCheck.gaps.length,
        },
        "self-correction retry start",
      )
      emit("self_correction_retry_start")

      const retryPrompt = integrationRetryPrompt(
        basePrompt,
        history,
        userMsg,
        integrationContent,
        firstCheck.gaps,
      )
      try {
        const retry = await left.call({
          system: retryPrompt.system,
          user: retryPrompt.user,
          timeoutMs,
          onStreamEvent: makeLeftStream("integration"),
        })
        const retryCheck = parseSelfCheck(retry.content)
        if (retryCheck && !retryCheck.adequate && retryCheck.gaps.length > 0) {
          // Still inadequate — use retry's content with caveat.
          integrationContent =
            SELF_CORRECTION_CAVEAT + stripSelfCheck(retry.content)
        } else {
          integrationContent = retry.content
        }
      } catch (retryErr) {
        logger?.warn(
          {
            event: "self_correction_retry_failed",
            error:
              retryErr instanceof Error
                ? retryErr.message
                : String(retryErr),
          },
          "self-correction retry threw — falling back to first attempt",
        )
        // Retry threw — fall back to first attempt with caveat.
        integrationContent =
          SELF_CORRECTION_CAVEAT + stripSelfCheck(integrationContent)
      }
    }
    // Always strip any residual <self-check> block in router mode (adequate
    // cases, malformed blocks, missing blocks all land here).
    if (!integrationContent.startsWith(SELF_CORRECTION_CAVEAT)) {
      integrationContent = stripSelfCheck(integrationContent)
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

  // Dual-brain timeout telemetry — happy path. `telemetryRoute` may have been
  // flipped to "integrator-left-fallback" in the integration catch; if so we
  // keep that label and the "timed_out" outcome rather than overwriting them.
  if (telemetryRoute !== "integrator-left-fallback") {
    telemetryOutcome = "completed"
  }

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
      pass1WallMs,
      pass2WallMs,
      leftToolsUsed,
    },
  }
  // Note: integrationCallDurationMs is intentionally unused in the returned
  // trace — the spec measures integration wall time via Date.now() deltas,
  // which captures retry overhead. The individual call duration is available
  // for future extension if needed.
  void integrationCallDurationMs

  } catch (err) {
    // Dual-brain telemetry — any thrown error (LeftHemisphereError pre-
    // integration, RightHemisphereError, IntegrationError, generic) lands here
    // and tags the dispatch as errored before propagating untouched.
    telemetryRoute = "dual-brain-errored"
    telemetryOutcome = "errored"
    throw err
  } finally {
    inflightDispatches = Math.max(0, inflightDispatches - 1)
    emitDispatchTelemetry()
  }
}
