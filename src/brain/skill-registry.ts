/**
 * Wave 8 skill allowlist. The orchestrator rejects any dispatch naming a
 * skill not in this tuple — research-mode fallback is emitted instead, and
 * `dispatch_malformed` is logged.
 *
 * Decided in RESEARCH-W8.md (Path B — in-bridge shim): jarvis-prime is the
 * sole dispatch boundary, so this registry is the single source of truth.
 */

const ALLOWED_SKILLS_RAW = [
  "jarvis-dev-methodology",
  "research-methodology",
] as const

export const ALLOWED_SKILLS: readonly AllowedSkill[] = Object.freeze([
  ...ALLOWED_SKILLS_RAW,
]) as readonly AllowedSkill[]

export type AllowedSkill = (typeof ALLOWED_SKILLS_RAW)[number]

export function isAllowedSkill(name: string): name is AllowedSkill {
  return (ALLOWED_SKILLS_RAW as readonly string[]).includes(name)
}

const SKILL_MD_PATHS: Record<AllowedSkill, string> = {
  "jarvis-dev-methodology":
    "/home/tripp/.openclaw/workspace/skills/jarvis-dev-methodology/SKILL.md",
  "research-methodology":
    "/home/tripp/.openclaw/workspace/skills/research-methodology/SKILL.md",
}

/**
 * Absolute path to the SKILL.md file for a given allowed skill. The shim
 * (W8-T8) loads this to bootstrap the skill-runner subprocess.
 */
export function skillMdPath(skill: AllowedSkill): string {
  return SKILL_MD_PATHS[skill]
}
