import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationHistory } from './history.js'

const SKILLS_DIR = '/home/tripp/.claude/skills'
const RULES_DIR = '/home/tripp/.claude/rules'

export class PromptBuilder {
  private skillSummary: string = ''
  private readonly history: ConversationHistory

  constructor(history: ConversationHistory) {
    this.history = history
    this.loadSkills()
  }

  build(userMessage: string): string {
    const parts: string[] = []

    parts.push(this.getSystemContext())

    const historyBlock = this.history.formatForPrompt(10)
    if (historyBlock) parts.push(historyBlock)

    parts.push(`## Current message from Tripp\n${userMessage}`)

    return parts.join('\n\n')
  }

  private getSystemContext(): string {
    return `## Context
You are Jarvis Prime, responding to Tripp via Telegram (@trippassistant_bot).
Keep responses concise — this is Telegram, not a terminal. Aim for 1-3 short paragraphs max unless the task demands more.
You have full SSH access to the Jarvis network. Execute commands directly when asked — don't just describe what you would do.

${this.skillSummary}`
  }

  private loadSkills(): void {
    if (!existsSync(SKILLS_DIR)) {
      this.skillSummary = ''
      return
    }

    const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))
    if (files.length === 0) {
      this.skillSummary = ''
      return
    }

    const skills: string[] = ['## Available skills']
    skills.push('When Tripp sends a message starting with /, match it to a skill below and follow its instructions.')
    skills.push('These are NOT Claude Code slash commands — they are Jarvis skills. Execute them by running the bash commands described in each skill.')
    skills.push('You can also trigger skills proactively when the request matches (e.g. "check the network" → /network-status).\n')

    for (const file of files) {
      try {
        const content = readFileSync(join(SKILLS_DIR, file), 'utf-8')
        const nameMatch = content.match(/^command:\s*(.+)$/m)
        const descMatch = content.match(/^description:\s*(.+)$/m)
        const command = nameMatch?.[1] ?? `/${file.replace('.md', '')}`
        const desc = descMatch?.[1] ?? ''

        // Extract the instructions (everything after the frontmatter)
        const bodyStart = content.indexOf('---', content.indexOf('---') + 3)
        const body = bodyStart > 0 ? content.slice(bodyStart + 3).trim() : ''

        skills.push(`### ${command}`)
        if (desc) skills.push(desc)
        if (body) {
          // Truncate skill body to keep prompt reasonable
          const truncated = body.length > 1500 ? body.slice(0, 1500) + '\n...(truncated)' : body
          skills.push(truncated)
        }
        skills.push('')
      } catch {
        // skip unreadable files
      }
    }

    this.skillSummary = skills.join('\n')
  }
}
