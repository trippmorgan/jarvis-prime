/**
 * Wave 8 dispatch-block parser.
 *
 * Claude (left hemisphere) emits `<dispatch>{json}</dispatch>` in its pass-1
 * output. This module extracts that block and validates its shape against
 * `Dispatch`. Unknown skills are reported as `unknown_skill` — the orchestrator
 * (not this parser) is responsible for the research-mode fallback.
 *
 * All failure modes return `{dispatch: null, warning: <reason>}`; the happy
 * path returns `{dispatch}` with no warning.
 */

import type { Dispatch, ToolEvidence } from "./dispatch-types.js"
import { isAllowedSkill } from "./skill-registry.js"

export type ParseWarning =
  | "missing"
  | "malformed_json"
  | "unknown_skill"

export interface ParseResult {
  dispatch: Dispatch | null
  warning?: ParseWarning
}

const DISPATCH_RE = /<dispatch>([\s\S]*?)<\/dispatch>/

export function parseDispatch(passOneOutput: string): ParseResult {
  const match = passOneOutput.match(DISPATCH_RE)
  if (!match) return { dispatch: null, warning: "missing" }

  const body = match[1].trim()
  if (body === "") return { dispatch: null, warning: "malformed_json" }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return { dispatch: null, warning: "malformed_json" }
  }

  if (!isRecord(raw)) return { dispatch: null, warning: "malformed_json" }

  const mode = raw.mode
  if (mode === "skill") {
    const skill = raw.skill
    const instruction = raw.instruction
    if (typeof skill !== "string" || typeof instruction !== "string") {
      return { dispatch: null, warning: "malformed_json" }
    }
    if (!isAllowedSkill(skill)) {
      return { dispatch: null, warning: "unknown_skill" }
    }
    return { dispatch: { mode: "skill", skill, instruction } }
  }

  if (mode === "research") {
    const topics = raw.topics
    if (!Array.isArray(topics) || topics.some((t) => typeof t !== "string")) {
      return { dispatch: null, warning: "malformed_json" }
    }
    return { dispatch: { mode: "research", topics: topics as string[] } }
  }

  return { dispatch: null, warning: "malformed_json" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const TOOLS_RE = /<tools>([\s\S]*?)<\/tools>/

/**
 * Parse the `<tools>[...]</tools>` evidence block from a left pass-1 draft.
 * Returns the list of tools the left hemisphere claims to have run. Any
 * failure mode (missing block, malformed JSON, non-array, wrong shape) yields
 * an empty array — the orchestrator treats "no tools" and "unparseable" the
 * same way for duplicate-rejection purposes.
 */
export function parseLeftToolsEvidence(passOneOutput: string): ToolEvidence[] {
  const match = passOneOutput.match(TOOLS_RE)
  if (!match) return []

  const body = match[1].trim()
  if (body === "") return []

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }

  if (!Array.isArray(raw)) return []

  const out: ToolEvidence[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = item.name
    const durationMs = item.durationMs
    if (typeof name !== "string" || typeof durationMs !== "number") continue
    out.push({ name, durationMs })
  }
  return out
}
