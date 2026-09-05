import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationHistory } from './history.js'
import { conscienceBlock } from './conscience.js'
import { dailyBriefBlock } from './daily-brief.js'
import { recallMemory } from './memory-recall.js'

const DEFAULT_SKILLS_DIR = '/home/tripp/.claude/skills'

export interface PromptBuilderConfig {
  /** Display name of this node (e.g. "Jarvis Prime", "Argus", "DJ Jarvis"). */
  nodeName?: string
  /** Telegram bot username this node serves (without @). */
  botUsername?: string
  /** Override the skills directory (used by tests; defaults to ~/.claude/skills). */
  skillsDir?: string
}

interface SkillEntry {
  command: string
  description: string
  body: string
}

const SKILL_BODY_MAX_CHARS = 1500

export class PromptBuilder {
  private skills: SkillEntry[] = []
  private readonly history: ConversationHistory
  private readonly nodeName: string
  private readonly botUsername: string
  private readonly skillsDir: string

  constructor(history: ConversationHistory, config: PromptBuilderConfig = {}) {
    this.history = history
    this.nodeName = config.nodeName ?? 'Jarvis Prime'
    this.botUsername = config.botUsername ?? 'trippassistant_bot'
    this.skillsDir = config.skillsDir ?? DEFAULT_SKILLS_DIR
    this.loadSkills()
  }

  async build(
    userMessage: string,
    options: {
      includeConversation?: boolean
      /**
       * Daily-session continuity. 'fresh' = first turn of today's session:
       * full static context + the daily start brief. 'resumed' = later turn
       * of the same CLI session: the session already carries the static
       * context and every prior tool result, so only the per-turn blocks
       * (memory recall, current message) are sent. Omit for the legacy
       * stateless prompt (dual-brain affordance builders, tests).
       */
      sessionMode?: 'fresh' | 'resumed'
      /** Date string for the daily brief header (defaults to today, NY time). */
      briefDate?: string
      /** Spawned with the tool surface off (fast lane) — the context must not promise a shell. */
      toolsOff?: boolean
    } = {},
  ): Promise<string> {
    const parts: string[] = []
    const resumed = options.sessionMode === 'resumed'

    if (!resumed) {
      parts.push(this.getSystemContext(options.toolsOff === true))

      // Conscience: the Φ-selected, chain-attested working memory — always in
      // the prompt, single- and dual-brain alike (both build through here).
      // Fail-soft: absent snapshot → empty string, prompt unchanged.
      const conscience = conscienceBlock()
      if (conscience) parts.push(conscience)

      // First turn of a daily session: inject the network's self-knowledge
      // (Φ-promoted memories, ledger status, recent DIL findings) once, to
      // live in the session for the rest of the day.
      if (options.sessionMode === 'fresh') {
        const brief = dailyBriefBlock(options.briefDate ?? new Date().toISOString().slice(0, 10))
        if (brief) parts.push(brief)
      }
    }

    const triggered = this.detectTriggeredCommands(userMessage)
    if (!resumed || triggered.size > 0) {
      const skillBlock = this.renderSkillBlock(triggered)
      if (skillBlock) parts.push(skillBlock)
    }

    // Memory check — consult jarvis-OS shared memory + active projects so Prime
    // (single AND dual brain, which both build through here) reuses existing
    // work instead of duplicating it. Fail-soft: returns '' if the kernel is
    // unreachable, so this never blocks or breaks a reply. Runs on EVERY turn
    // (including resumed) because it is query-specific.
    const memoryBlock = await recallMemory(userMessage)
    if (memoryBlock) parts.push(memoryBlock)

    // Single-brain receives one self-contained prompt, so include prior turns
    // and the current message here. Dual-brain affordance builders add those in
    // their user message instead; omitting them from the shared base prevents
    // the Telegram turn from being repeated across both system and user input.
    // Resumed sessions saw their own turns already — history would duplicate
    // them — but replies delivered outside this session (dual-brain turns,
    // scheduled briefings) are still surfaced via a compact recent-history
    // block with a dedupe note.
    if (options.includeConversation !== false) {
      const historyBlock = this.history.formatForPrompt(resumed ? 4 : 10, userMessage)
      if (historyBlock) {
        parts.push(
          resumed
            ? `${historyBlock}\n(Recent turns above may include ones you already saw in this session — the current message below is authoritative.)`
            : historyBlock,
        )
      }
      parts.push(`## Current message from Tripp\n${userMessage}`)
    }

    return parts.join('\n\n')
  }

  private getSystemContext(toolsOff = false): string {
    const head = `## Context
You are ${this.nodeName}, responding to Tripp via Telegram (@${this.botUsername}).`
    if (toolsOff) {
      return `${head}
This is the quick-reply lane: no shell, SSH, file, or network tools are attached this
turn — ignore any connector tools (Calendar, Drive) you may see; they are not the
Jarvis network. Answer from context in 1-3 short paragraphs. If the request needs
commands run, logs read, or anything executed, say so in one line and tell Tripp to
phrase it as an action ("check ...", "run ...", "queue it") — that spawns a
background task with the full tool set. Do not describe yourself as broken or
crippled; this lane is tool-less by design.`
    }
    return `${head}
Match depth to the ask. Quick or conversational messages get 1-3 short paragraphs.
Analysis, debugging, and introspection questions deserve real work: investigate with
your tools first — read the files, check the logs, run the commands — and take the
minutes you need (progress streams to Tripp while you work). Then answer with
substance: plain paragraphs and short lists render best in Telegram; skip headers.
You have full SSH access to the Jarvis network. Execute commands directly when asked — don't just describe what you would do.`
  }

  private loadSkills(): void {
    if (!existsSync(this.skillsDir)) return

    const files = readdirSync(this.skillsDir).filter(f => f.endsWith('.md'))
    if (files.length === 0) return

    const entries: SkillEntry[] = []
    for (const file of files) {
      try {
        const content = readFileSync(join(this.skillsDir, file), 'utf-8')
        const nameMatch = content.match(/^command:\s*(.+)$/m)
        const descMatch = content.match(/^description:\s*(.+)$/m)
        const command = nameMatch?.[1] ?? `/${file.replace('.md', '')}`
        const description = descMatch?.[1] ?? ''

        const bodyStart = content.indexOf('---', content.indexOf('---') + 3)
        const body = bodyStart > 0 ? content.slice(bodyStart + 3).trim() : ''

        entries.push({ command, description, body })
      } catch {
        // skip unreadable files
      }
    }

    this.skills = entries
  }

  // Match `/<command>` as a whole token — must NOT match a path like
  // `/usr/bin/network-status`. Case-insensitive per SPEC Q2.
  private detectTriggeredCommands(userMessage: string): Set<string> {
    const triggered = new Set<string>()
    if (!userMessage) return triggered
    const msg = userMessage.toLowerCase()
    for (const skill of this.skills) {
      const cmd = skill.command.toLowerCase()
      if (!cmd.startsWith('/')) continue
      const re = new RegExp(`(^|\\s)${escapeRegExp(cmd)}(?![\\w:-])`, 'i')
      if (re.test(msg)) triggered.add(skill.command)
    }
    return triggered
  }

  private renderSkillBlock(triggered: Set<string>): string {
    if (this.skills.length === 0) return ''

    const lines: string[] = []
    lines.push('## Available skills')
    lines.push('When Tripp sends a message starting with /, match it to a skill below. The full instructions for a skill appear when that skill is invoked; otherwise only its one-line summary is shown here. Trigger a skill by typing `/<command>` (case-insensitive).')
    lines.push('These are NOT Claude Code slash commands — execute them by running the bash commands described in each skill.')
    lines.push('You can still propose a skill proactively when the request matches (e.g. "check the network" → /network-status); ask Tripp to confirm with the slash command if it would help.')
    lines.push('')

    for (const skill of this.skills) {
      const header = skill.description
        ? `### ${skill.command} — ${skill.description}`
        : `### ${skill.command}`
      lines.push(header)
      if (triggered.has(skill.command) && skill.body) {
        const truncated = skill.body.length > SKILL_BODY_MAX_CHARS
          ? skill.body.slice(0, SKILL_BODY_MAX_CHARS) + '\n...(truncated)'
          : skill.body
        lines.push(truncated)
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
