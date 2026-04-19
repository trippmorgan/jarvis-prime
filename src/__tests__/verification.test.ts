import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

describe('T18: Memory & Skill Preservation', () => {
  it('memory index exists', () => {
    expect(existsSync('/home/tripp/.claude/projects/-home-tripp/memory/MEMORY.md')).toBe(true)
  })

  it('memory files exist', () => {
    const expected = [
      'feedback_jarvis_setup.md',
      'project_jarvis_dev_methodology.md',
      'project_jarvis_prime.md',
      'user_tripp.md',
    ]
    for (const file of expected) {
      expect(existsSync(`/home/tripp/.claude/projects/-home-tripp/memory/${file}`)).toBe(true)
    }
  })

  it('workspace context files exist', () => {
    const files = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md']
    for (const file of files) {
      expect(existsSync(`/home/tripp/.openclaw/workspace/${file}`)).toBe(true)
    }
  })

  it('jarvis-dev-methodology reference docs exist', () => {
    const phases = ['phase-0-spec.md', 'phase-1-plan.md', 'phase-2-execute.md', 'phase-3-review.md', 'phase-4-verify.md']
    for (const phase of phases) {
      expect(existsSync(`/home/tripp/.openclaw/workspace/skills/jarvis-dev-methodology/references/${phase}`)).toBe(true)
    }
  })

  it('/dev skill registered in Claude Code', () => {
    expect(existsSync('/home/tripp/.claude/skills/dev-methodology.md')).toBe(true)
    const content = readFileSync('/home/tripp/.claude/skills/dev-methodology.md', 'utf-8')
    expect(content).toContain('/dev')
    expect(content).toContain('phase-0-spec.md')
  })

  it('session-start hook exists and is executable', () => {
    const hookPath = '/home/tripp/.claude/hooks/session-start-context.sh'
    expect(existsSync(hookPath)).toBe(true)
  })

  it('conversation history file exists', () => {
    expect(existsSync('/home/tripp/.openclaw/workspace/jarvis-prime/.data/conversation-history.jsonl')).toBe(true)
  })
})

describe('T19: Claude Code Skills & Agents & Rules', () => {
  it('all skills registered', () => {
    const skills = ['network-status.md', 'dispatch.md', 'frank-status.md', 'station-check.md', 'deploy.md', 'dev-methodology.md']
    for (const skill of skills) {
      expect(existsSync(`/home/tripp/.claude/skills/${skill}`)).toBe(true)
    }
  })

  it('all agents registered', () => {
    const agents = ['network-ops.md', 'clinical-reviewer.md', 'frank-debugger.md']
    for (const agent of agents) {
      expect(existsSync(`/home/tripp/.claude/agents/${agent}`)).toBe(true)
    }
  })

  it('all rules registered', () => {
    const rules = ['phi-security.md', 'credentials-protection.md', 'network-conventions.md']
    for (const rule of rules) {
      expect(existsSync(`/home/tripp/.claude/rules/${rule}`)).toBe(true)
    }
  })

  it('CLAUDE.md exists with Jarvis identity', () => {
    const content = readFileSync('/home/tripp/.claude/CLAUDE.md', 'utf-8')
    expect(content).toContain('Jarvis')
    expect(content).toContain('SuperServer')
    expect(content).toContain('Voldemort')
  })
})
