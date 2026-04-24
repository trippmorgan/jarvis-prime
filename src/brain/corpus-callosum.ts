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
    }
  | undefined

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

  const emit = (eventName: string, payload?: CallosumEventPayload): void => {
    if (!onEvent) return
    try {
      onEvent(eventName, payload)
    } catch {
      // Swallow — UX callbacks must never break orchestrator flow.
    }
  }

  const start = Date.now()

  logger?.info(
    { event: "callosum_start", userMsgLength: userMsg.length },
    "corpus callosum start",
  )

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
          logger?.info(
            { event: "dispatch_parsed", mode: "skill", skill: dispatchedSkill },
            "dispatch parsed (skill)",
          )
          emit("dispatch_parsed", { mode: "skill", skill: dispatchedSkill })
        }
      } else {
        effectiveDispatch = parsed.dispatch
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
      left.call({ system: p1LeftPrompt.system, user: p1LeftPrompt.user, timeoutMs }),
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
    left.call({ system: p2LeftPrompt.system, user: p2LeftPrompt.user, timeoutMs }),
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

  // --- Integration — Claude only, with one-shot retry ----------------------
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
}
