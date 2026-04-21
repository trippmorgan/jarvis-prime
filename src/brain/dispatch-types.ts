/**
 * Wave 8 dispatch protocol types.
 *
 * Claude (left hemisphere) emits a `<dispatch>{json}</dispatch>` block on its
 * pass-1 output. The orchestrator parses that block into a Dispatch, routes
 * the right hemisphere into skill-mode or research-mode accordingly, and
 * enforces the ALLOWED_SKILLS allowlist before any skill runs.
 */

import type { AllowedSkill } from "./skill-registry.js"

export type DispatchMode = "skill" | "research"

/**
 * Right hemisphere runs a dispatched skill. The shim (W8-T8) invokes the
 * skill via jarvis-prime — right never executes `exec` directly — and the
 * skill's output flows into right's pass-1 prompt as evidence context.
 */
export interface SkillDispatch {
  mode: "skill"
  skill: AllowedSkill
  /** Free-form instruction Claude wants the skill to follow. */
  instruction: string
}

/**
 * Right hemisphere runs in research mode — no external skill invocation,
 * it drafts from workspace memory (MEMORY.md, prior logs) framed by the
 * optional topic list.
 */
export interface ResearchDispatch {
  mode: "research"
  /** Optional topic hints to focus right's research framing. */
  topics: string[]
}

export type Dispatch = SkillDispatch | ResearchDispatch

/**
 * One tool/skill invocation recorded for pass-2 cross-visibility (W8-T11)
 * and card rendering (W8-T13). Keep small — prompts interpolate this.
 */
export interface ToolEvidence {
  name: string
  durationMs: number
}
