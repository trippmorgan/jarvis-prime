/**
 * Wave 8 right-hemisphere pass-1 prompt builders.
 *
 * Two modes:
 *   - skill mode: the orchestrator already ran a dispatched skill via the
 *     shim (RESEARCH-W8 Path B). Its output is injected as <skill-evidence>;
 *     right drafts a pass-1 informed by that evidence.
 *   - research mode: no external skill; right drafts from workspace memory
 *     (MEMORY.md, prior logs, incident notes), optionally focused by topic
 *     hints from the dispatch.
 *
 * `buildRightPass1Prompt` is the dispatcher the orchestrator calls — it
 * picks the mode based on the parsed dispatch + skill-run outcome.
 *
 * Pure functions; no side effects.
 */

import type { HistoryEntry, HemispherePrompt } from "./affordance.js"
import type {
  Dispatch,
  ResearchDispatch,
  SkillDispatch,
} from "./dispatch-types.js"
import type { SkillInvocationResult } from "./right-brain-skill-shim.js"

const RIGHT_AFFORDANCE_SUFFIX =
  "You are the right hemisphere of a dual-brain. Claude is the left hemisphere and final integrator. Focus on patterns, holistic connections, creative alternatives, and action-possibilities (affordances). Produce a draft that surfaces what the left hemisphere might miss."

const SKILL_MODE_SUFFIX = [
  "Left (Claude) dispatched a skill to be run on your behalf. You did not run",
  "the skill directly — your left-hand colleague (the bridge shim) executed",
  "it and returned evidence. Treat the <skill-evidence> block as work product",
  "you should integrate into your pass-1 draft. Preserve your right-hemisphere",
  "framing: look for patterns, holistic connections, affordances that the",
  "skill run might have missed.",
].join(" ")

const RESEARCH_MODE_SUFFIX = [
  "Draft a pass-1 informed by workspace memory: MEMORY.md, prior logs,",
  "incident notes, and your shared conversation history. Surface patterns and",
  "connections the left hemisphere might miss. You have no external tools this",
  "turn — rely on memory and framing.",
].join(" ")

function formatHistoryLines(history: HistoryEntry[]): string {
  return history
    .map((entry) => {
      const label = entry.role === "user" ? "Tripp" : "Jarvis"
      return `${label}: ${entry.content}`
    })
    .join("\n")
}

function buildUserMessage(history: HistoryEntry[], userMsg: string): string {
  const historyBlock = formatHistoryLines(history)
  const current = `Tripp: ${userMsg}`
  return historyBlock ? `${historyBlock}\n\n${current}` : current
}

function renderSkillEvidence(
  dispatch: SkillDispatch,
  result: SkillInvocationResult,
): string {
  if (!result.ok) {
    return [
      `<skill-failure skill="${dispatch.skill}">`,
      `The skill run failed: ${result.failureReason ?? "unknown reason"}.`,
      "Draft without the skill's evidence — note the failure in your pass-1.",
      "</skill-failure>",
    ].join("\n")
  }
  return [
    `<skill-evidence skill="${dispatch.skill}" durationMs="${result.durationMs}">`,
    `Dispatched instruction: ${dispatch.instruction}`,
    "",
    result.output,
    "</skill-evidence>",
  ].join("\n")
}

function renderTopics(dispatch: ResearchDispatch | undefined): string {
  if (!dispatch || dispatch.topics.length === 0) return ""
  const lines = dispatch.topics.map((t) => `  - ${t}`).join("\n")
  return `\n\n<topics>\n${lines}\n</topics>`
}

export function rightSkillModePrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  dispatch: SkillDispatch,
  skillResult: SkillInvocationResult,
): HemispherePrompt {
  const evidence = renderSkillEvidence(dispatch, skillResult)
  const system = [
    basePrompt,
    "",
    RIGHT_AFFORDANCE_SUFFIX,
    "",
    SKILL_MODE_SUFFIX,
    "",
    evidence,
  ].join("\n")
  return {
    system,
    user: buildUserMessage(history, userMsg),
  }
}

export function rightResearchModePrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  dispatch?: ResearchDispatch,
): HemispherePrompt {
  const topics = renderTopics(dispatch)
  const system = `${basePrompt}\n\n${RIGHT_AFFORDANCE_SUFFIX}\n\n${RESEARCH_MODE_SUFFIX}${topics}`
  return {
    system,
    user: buildUserMessage(history, userMsg),
  }
}

/**
 * Dispatcher — picks skill-mode vs research-mode based on the parsed dispatch
 * and whether a skill result is available. Any malformed state falls back to
 * research mode (the safe default).
 */
export function buildRightPass1Prompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  dispatch: Dispatch | null,
  skillResult?: SkillInvocationResult,
): HemispherePrompt {
  if (dispatch && dispatch.mode === "skill" && skillResult) {
    return rightSkillModePrompt(
      basePrompt,
      history,
      userMsg,
      dispatch,
      skillResult,
    )
  }
  if (dispatch && dispatch.mode === "research") {
    return rightResearchModePrompt(basePrompt, history, userMsg, dispatch)
  }
  return rightResearchModePrompt(basePrompt, history, userMsg)
}
