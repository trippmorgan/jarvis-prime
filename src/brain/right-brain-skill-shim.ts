import { readFile } from "node:fs/promises"
import { spawnClaude } from "../claude/spawner.js"
import type { SpawnOptions, SpawnResult } from "../claude/types.js"
import type { SkillDispatch } from "./dispatch-types.js"
import { skillMdPath, type AllowedSkill } from "./skill-registry.js"

/**
 * Wave 8 right-brain skill shim (RESEARCH-W8 Path B).
 *
 * When Claude (left, dispatcher) routes a skill to the right hemisphere, the
 * orchestrator invokes this shim — NOT the right-brain agent. This keeps the
 * W7 file allowlist untouched: jarvis-prime loads SKILL.md from the main
 * workspace, builds a prompt, and spawns a Claude CLI subprocess to execute
 * the skill's methodology on the dispatched instruction. The output is fed
 * back into right's pass-1 prompt as `<skill-evidence>` context.
 *
 * Right does not "use" the tool directly — right receives the tool's output
 * from jarvis-prime and drafts informed by it. This is the gated expansion
 * of right's surface Tripp asked for.
 */

export type Spawner = (
  prompt: string,
  opts: SpawnOptions,
) => Promise<SpawnResult>

export type SkillMdLoader = (skill: AllowedSkill) => Promise<string>

export interface RightBrainSkillShimLogger {
  info: (o: unknown, m?: string) => void
  warn: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

export interface RightBrainSkillShimConfig {
  /** Injectable spawner for tests. Default: real spawnClaude. */
  spawner?: Spawner
  /** Injectable SKILL.md loader. Default: fs.readFile(skillMdPath(skill)). */
  loader?: SkillMdLoader
  /** Claude CLI binary path. */
  claudePath?: string
  /** Claude model for skill runs. Default: "sonnet". */
  model?: string
  /** Default timeout if caller does not provide one. Default: 120_000 ms. */
  defaultTimeoutMs?: number
  /** Output truncation ceiling in bytes. Default: 16_000. */
  maxOutputChars?: number
  /** Optional structured logger. */
  logger?: RightBrainSkillShimLogger
}

export interface InvokeOptions {
  /** The user's original Telegram message (context for the skill run). */
  userMessage: string
  /** Per-call timeout override (ms). Falls back to defaultTimeoutMs. */
  timeoutMs?: number
}

export interface SkillInvocationResult {
  skill: AllowedSkill
  durationMs: number
  output: string
  ok: boolean
  failureReason?: string
}

const DEFAULT_CLAUDE_PATH = "/home/tripp/.local/bin/claude"
const DEFAULT_MODEL = "sonnet"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 16_000

const defaultLoader: SkillMdLoader = async (skill) => {
  return readFile(skillMdPath(skill), "utf8")
}

/**
 * Redact common credential patterns from skill output before it flows into
 * right's pass-1 prompt. Belt-and-suspenders — the right-brain agent also
 * never sees raw bridge env, but skill runs have full workspace access.
 */
const SECRET_PATTERNS: RegExp[] = [
  /OPENCLAW_GATEWAY_TOKEN\s*=\s*\S+/g,
  /TELEGRAM_BOT_TOKEN\s*=\s*\S+/g,
  /ANTHROPIC_API_KEY\s*=\s*\S+/g,
  /OPENAI_API_KEY\s*=\s*\S+/g,
  /(?:^|\s)sk-[A-Za-z0-9_-]{20,}/g,
  /(?:^|\s)AIza[A-Za-z0-9_-]{35,}/g,
]

function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const keyPart = match.split("=")[0]
      return keyPart ? `${keyPart}=[redacted]` : "[redacted]"
    })
  }
  return out
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n…[truncated]"
}

function buildSkillPrompt(
  skillMd: string,
  dispatch: SkillDispatch,
  userMessage: string,
): string {
  return [
    "# Skill methodology",
    "",
    skillMd,
    "",
    "---",
    "",
    "# Dispatched instruction",
    "",
    dispatch.instruction,
    "",
    "---",
    "",
    "# Original user message (context)",
    "",
    userMessage,
    "",
    "---",
    "",
    "Execute the skill methodology above against the dispatched instruction.",
    "Produce a concise outcome suitable as evidence for a dual-brain deliberation",
    "— what you investigated, what you concluded, and any concrete next actions.",
    "Keep output under 2000 words. No filler.",
  ].join("\n")
}

export class RightBrainSkillShim {
  private readonly spawner: Spawner
  private readonly loader: SkillMdLoader
  private readonly claudePath: string
  private readonly model: string
  private readonly defaultTimeoutMs: number
  private readonly maxOutputChars: number
  private readonly logger?: RightBrainSkillShimLogger

  constructor(config: RightBrainSkillShimConfig = {}) {
    this.spawner = config.spawner ?? spawnClaude
    this.loader = config.loader ?? defaultLoader
    this.claudePath = config.claudePath ?? DEFAULT_CLAUDE_PATH
    this.model = config.model ?? DEFAULT_MODEL
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT
    this.logger = config.logger
  }

  async invoke(
    dispatch: SkillDispatch,
    opts: InvokeOptions,
  ): Promise<SkillInvocationResult> {
    const start = Date.now()
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs

    this.logger?.info(
      {
        event: "skill_shim_invoke_start",
        skill: dispatch.skill,
        timeoutMs,
      },
      "skill shim invocation starting",
    )

    let skillMd: string
    try {
      skillMd = await this.loader(dispatch.skill)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger?.error(
        { event: "skill_shim_load_error", skill: dispatch.skill },
        "SKILL.md load failed",
      )
      return {
        skill: dispatch.skill,
        durationMs: Date.now() - start,
        output: "",
        ok: false,
        failureReason: `SKILL.md load failed: ${message}`,
      }
    }

    const prompt = buildSkillPrompt(skillMd, dispatch, opts.userMessage)

    let result: SpawnResult
    try {
      result = await this.spawner(prompt, {
        claudePath: this.claudePath,
        model: this.model,
        timeoutMs,
        enableTools: true,
        enableSlashCommands: true,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger?.error(
        {
          event: "skill_shim_spawn_error",
          skill: dispatch.skill,
          error: message,
        },
        "skill shim spawn threw",
      )
      return {
        skill: dispatch.skill,
        durationMs: Date.now() - start,
        output: "",
        ok: false,
        failureReason: message,
      }
    }

    const durationMs = Date.now() - start

    if (result.timedOut) {
      this.logger?.warn(
        { event: "skill_shim_timeout", skill: dispatch.skill, durationMs },
        "skill shim timed out",
      )
      return {
        skill: dispatch.skill,
        durationMs,
        output: "",
        ok: false,
        failureReason: `skill runner timed out after ${timeoutMs}ms`,
      }
    }

    if (result.exitCode !== 0) {
      this.logger?.error(
        {
          event: "skill_shim_exit_error",
          skill: dispatch.skill,
          exitCode: result.exitCode,
          durationMs,
        },
        "skill shim exited non-zero",
      )
      return {
        skill: dispatch.skill,
        durationMs,
        output: "",
        ok: false,
        failureReason: `skill runner exit code ${result.exitCode}`,
      }
    }

    const redacted = redact(result.output ?? "")
    const bounded = truncateOutput(redacted, this.maxOutputChars)

    this.logger?.info(
      {
        event: "skill_shim_invoke_ok",
        skill: dispatch.skill,
        durationMs,
        outputLength: bounded.length,
      },
      "skill shim invocation ok",
    )

    return {
      skill: dispatch.skill,
      durationMs,
      output: bounded,
      ok: true,
    }
  }
}
