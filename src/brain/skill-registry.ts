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
  "artcraft",
  "podcut",
] as const

/**
 * One-line hints rendered next to each skill name in the left planner prompt
 * (2026-10-12). The planner is a local model that only sees the names
 * otherwise; without these it never dispatched media or podcast work.
 */
export const SKILL_HINTS: Readonly<Record<AllowedSkill, string>> = Object.freeze({
  "jarvis-dev-methodology": "build, plan or change code with the GSD methodology",
  "research-methodology": "structured research with sources and evidence",
  artcraft:
    "make media: cover art, posters, social cards, jingles, music beds, voice lines, promo clips (local models, sends to Telegram)",
  podcut:
    "podcast production: transcribe, cut, clean, master, add bed/cover/chapters, publish an episode from a recording",
})

export const ALLOWED_SKILLS: readonly AllowedSkill[] = Object.freeze([
  ...ALLOWED_SKILLS_RAW,
]) as readonly AllowedSkill[]

export type AllowedSkill = (typeof ALLOWED_SKILLS_RAW)[number]

export function isAllowedSkill(name: string): name is AllowedSkill {
  return (ALLOWED_SKILLS_RAW as readonly string[]).includes(name)
}

/**
 * Skills live in the openclaw workspace of whichever box runs jarvis-prime.
 * WORKSPACE_DIR comes from the service .env (Voldemort:
 * /home/joevoldemort/.openclaw/workspace); the historical Prime default stays
 * as the fallback so existing tests and the Prime deployment are unchanged.
 */
const SKILLS_DIR = `${process.env.WORKSPACE_DIR || "/home/tripp/.openclaw/workspace"}/skills`

const SKILL_MD_PATHS: Record<AllowedSkill, string> = {
  "jarvis-dev-methodology": `${SKILLS_DIR}/jarvis-dev-methodology/SKILL.md`,
  "research-methodology": `${SKILLS_DIR}/research-methodology/SKILL.md`,
  artcraft: `${SKILLS_DIR}/artcraft/SKILL.md`,
  podcut: `${SKILLS_DIR}/podcut/SKILL.md`,
}

/**
 * Absolute path to the SKILL.md file for a given allowed skill. The shim
 * (W8-T8) loads this to bootstrap the skill-runner subprocess.
 */
export function skillMdPath(skill: AllowedSkill): string {
  return SKILL_MD_PATHS[skill]
}
