// W17 T8 tests — classifyIntent

import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../../orchestrator/classify.js'

describe('classifyIntent', () => {
  it('treats plain conversation as chat', () => {
    expect(classifyIntent('what is the weather like')).toBe('chat')
    expect(classifyIntent('how are you doing today')).toBe('chat')
    expect(classifyIntent('thanks!')).toBe('chat')
  })

  it('detects status / health questions', () => {
    expect(classifyIntent('all nodes status')).toBe('status')
    expect(classifyIntent("what's running")).toBe('status')
    expect(classifyIntent('health check please')).toBe('status')
    expect(classifyIntent('nodes status')).toBe('status')
  })

  it('detects clinical queries (PHI path)', () => {
    expect(classifyIntent('pull up my patient schedule')).toBe('query')
    expect(classifyIntent('morning report')).toBe('query')
    expect(classifyIntent("today's cases")).toBe('query')
    expect(classifyIntent('OR schedule')).toBe('query')
  })

  it('detects workflow / imperative orders', () => {
    expect(classifyIntent('frank restart ollama')).toBe('workflow')
    expect(classifyIntent('restart playoutone on dj-jarvis')).toBe('workflow')
    expect(classifyIntent("let's work on the athena chrome debugging tool")).toBe('workflow')
    expect(classifyIntent('debug chrome-cdp')).toBe('workflow')
    expect(classifyIntent('inspect mcp')).toBe('workflow')
  })

  it('returns chat for empty / whitespace', () => {
    expect(classifyIntent('')).toBe('chat')
    expect(classifyIntent('   ')).toBe('chat')
  })
})
