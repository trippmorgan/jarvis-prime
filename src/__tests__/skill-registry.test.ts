import { describe, it, expect } from "vitest"
import {
  ALLOWED_SKILLS,
  isAllowedSkill,
  skillMdPath,
  type AllowedSkill,
} from "../brain/skill-registry.js"

describe("skill-registry — ALLOWED_SKILLS (W8-T3)", () => {
  it("contains exactly the two Wave 8 skills", () => {
    expect(ALLOWED_SKILLS).toEqual([
      "jarvis-dev-methodology",
      "research-methodology",
    ])
  })

  it("is a readonly tuple (frozen at module load)", () => {
    expect(Object.isFrozen(ALLOWED_SKILLS)).toBe(true)
  })
})

describe("skill-registry — isAllowedSkill predicate (W8-T3)", () => {
  it("accepts jarvis-dev-methodology", () => {
    expect(isAllowedSkill("jarvis-dev-methodology")).toBe(true)
  })

  it("accepts research-methodology", () => {
    expect(isAllowedSkill("research-methodology")).toBe(true)
  })

  it("rejects unknown skill names", () => {
    expect(isAllowedSkill("coding-agent")).toBe(false)
    expect(isAllowedSkill("jarv-dev")).toBe(false)
    expect(isAllowedSkill("workspace-research")).toBe(false)
    expect(isAllowedSkill("")).toBe(false)
  })

  it("rejects case-mismatch", () => {
    expect(isAllowedSkill("Jarvis-Dev-Methodology")).toBe(false)
    expect(isAllowedSkill("JARVIS-DEV-METHODOLOGY")).toBe(false)
  })

  it("narrows type correctly", () => {
    const name: string = "jarvis-dev-methodology"
    if (isAllowedSkill(name)) {
      const narrowed: AllowedSkill = name
      expect(narrowed).toBe("jarvis-dev-methodology")
    } else {
      expect.fail("type guard should have narrowed")
    }
  })
})

describe("skill-registry — skillMdPath (W8-T3)", () => {
  it("returns the SKILL.md absolute path for jarvis-dev-methodology", () => {
    expect(skillMdPath("jarvis-dev-methodology")).toBe(
      "/home/tripp/.openclaw/workspace/skills/jarvis-dev-methodology/SKILL.md",
    )
  })

  it("returns the SKILL.md absolute path for research-methodology", () => {
    expect(skillMdPath("research-methodology")).toBe(
      "/home/tripp/.openclaw/workspace/skills/research-methodology/SKILL.md",
    )
  })
})
