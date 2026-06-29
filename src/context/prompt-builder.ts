import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationHistory } from './history.js'
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

  async build(userMessage: string): Promise<string> {
    const parts: string[] = []

    parts.push(this.getSystemContext())

    const triggered = this.detectTriggeredCommands(userMessage)
    const skillBlock = this.renderSkillBlock(triggered)
    if (skillBlock) parts.push(skillBlock)

    // Memory check — consult jarvis-OS shared memory + active projects so Prime
    // (single AND dual brain, which both build through here) reuses existing
    // work instead of duplicating it. Fail-soft: returns '' if the kernel is
    // unreachable, so this never blocks or breaks a reply.
    const memoryBlock = await recallMemory(userMessage)
    if (memoryBlock) parts.push(memoryBlock)

    const historyBlock = this.history.formatForPrompt(10)
    if (historyBlock) parts.push(historyBlock)

    parts.push(`## Current message from Tripp\n${userMessage}`)

    return parts.join('\n\n')
  }

  private getSystemContext(): string {
    return `## Context
You are ${this.nodeName}, responding to Tripp via Telegram (@${this.botUsername}).
Keep responses concise — this is Telegram, not a terminal. Aim for 1-3 short paragraphs max unless the task demands more.
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
