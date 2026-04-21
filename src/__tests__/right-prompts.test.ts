import { describe, it, expect } from "vitest"
import {
  rightSkillModePrompt,
  rightResearchModePrompt,
  buildRightPass1Prompt,
} from "../brain/right-prompts.js"
import type {
  ResearchDispatch,
  SkillDispatch,
} from "../brain/dispatch-types.js"
import type { SkillInvocationResult } from "../brain/right-brain-skill-shim.js"
import type { HistoryEntry } from "../brain/affordance.js"

const BASE = "## Jarvis\nYou are Jarvis Prime."
const USER_MSG = "How should we approach Wave 9?"
const HISTORY: HistoryEntry[] = [
  { role: "user", content: "Hi.", timestamp: 1 },
  { role: "assistant", content: "Hello.", timestamp: 2 },
]

const skillDispatch: SkillDispatch = {
  mode: "skill",
  skill: "jarvis-dev-methodology",
  instruction: "draft a Wave 9 plan",
}

const skillResult: SkillInvocationResult = {
  skill: "jarvis-dev-methodology",
  durationMs: 4100,
  output: "Plan: phase 0 spec → phase 1 plan → phase 2 execute…",
  ok: true,
}

describe("rightSkillModePrompt (W8-T9)", () => {
  it("returns a system/user pair", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(typeof out.system).toBe("string")
    expect(typeof out.user).toBe("string")
  })

  it("preserves the right-hemisphere affordance framing", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.system).toContain("right hemisphere")
    expect(out.system).toContain(BASE)
  })

  it("includes the dispatched skill name and instruction", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.system).toContain("jarvis-dev-methodology")
    expect(out.system).toContain("draft a Wave 9 plan")
  })

  it("embeds the skill-run output inside a <skill-evidence> block", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.system).toContain("<skill-evidence>")
    expect(out.system).toContain("</skill-evidence>")
    expect(out.system).toContain(skillResult.output)
  })

  it("states the shim, not right, ran the skill", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.system.toLowerCase()).toMatch(/you did not run|colleague|on your behalf/)
  })

  it("surfaces failure markers when the skill run failed", () => {
    const failed: SkillInvocationResult = {
      skill: "jarvis-dev-methodology",
      durationMs: 120_000,
      output: "",
      ok: false,
      failureReason: "skill runner timed out after 120000ms",
    }
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      failed,
    )
    expect(out.system).toContain("skill-failure")
    expect(out.system).toContain("timed out")
  })

  it("user contains history and the current user message", () => {
    const out = rightSkillModePrompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.user).toContain("Tripp: Hi.")
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })
})

describe("rightResearchModePrompt (W8-T9)", () => {
  it("returns a system/user pair", () => {
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG)
    expect(typeof out.system).toBe("string")
    expect(typeof out.user).toBe("string")
  })

  it("preserves the right-hemisphere affordance framing", () => {
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG)
    expect(out.system).toContain("right hemisphere")
    expect(out.system).toContain(BASE)
  })

  it("mentions workspace-memory research (MEMORY.md, prior logs)", () => {
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG)
    expect(out.system).toMatch(/MEMORY\.md|workspace memory/i)
  })

  it("interpolates topic hints when provided", () => {
    const dispatch: ResearchDispatch = {
      mode: "research",
      topics: ["Argus uptime history", "elder node"],
    }
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG, dispatch)
    expect(out.system).toContain("Argus uptime history")
    expect(out.system).toContain("elder node")
  })

  it("omits the topic block when no dispatch passed", () => {
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG)
    expect(out.system).not.toContain("<topics>")
  })

  it("omits the topic block when topics array is empty", () => {
    const dispatch: ResearchDispatch = { mode: "research", topics: [] }
    const out = rightResearchModePrompt(BASE, HISTORY, USER_MSG, dispatch)
    expect(out.system).not.toContain("<topics>")
  })
})

describe("buildRightPass1Prompt (W8-T9)", () => {
  it("routes to skill mode when dispatch is a SkillDispatch and skillResult is provided", () => {
    const out = buildRightPass1Prompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      skillResult,
    )
    expect(out.system).toContain("<skill-evidence>")
    expect(out.system).toContain("jarvis-dev-methodology")
  })

  it("routes to research mode for a ResearchDispatch", () => {
    const dispatch: ResearchDispatch = {
      mode: "research",
      topics: ["memory"],
    }
    const out = buildRightPass1Prompt(BASE, HISTORY, USER_MSG, dispatch)
    expect(out.system).not.toContain("<skill-evidence>")
    expect(out.system).toContain("memory")
  })

  it("falls back to research mode when dispatch is null (parser failure)", () => {
    const out = buildRightPass1Prompt(BASE, HISTORY, USER_MSG, null)
    expect(out.system).not.toContain("<skill-evidence>")
    expect(out.system).toMatch(/MEMORY\.md|workspace memory/i)
  })

  it("falls back to research mode when dispatch is skill but skillResult is missing", () => {
    const out = buildRightPass1Prompt(
      BASE,
      HISTORY,
      USER_MSG,
      skillDispatch,
      // no skillResult
    )
    expect(out.system).not.toContain("<skill-evidence>")
  })
})
