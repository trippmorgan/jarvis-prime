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

  it('AVSO v1 — detects Athena navigation verbs as query (not chat)', () => {
    expect(classifyIntent('open the calendar')).toBe('query')
    expect(classifyIntent('go to the schedule')).toBe('query')
    expect(classifyIntent("navigate to today's appointments")).toBe('query')
    expect(classifyIntent('pull up the appointment book')).toBe('query')
    expect(classifyIntent('open athena dashboard')).toBe('query')
    expect(classifyIntent("take me to today's schedule")).toBe('query')
  })

  it('AVSO v1 — does NOT capture nav decoys (stay chat) or break export', () => {
    expect(classifyIntent('schedule a meeting for me')).toBe('chat')
    expect(classifyIntent('open the door')).toBe('chat')
    expect(classifyIntent('go to bed')).toBe('chat')
    expect(classifyIntent('show me my OR schedule')).toBe('query')
    expect(classifyIntent("today's cases")).toBe('query')
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

  // W17.2 — Frank workspace / experiments. These were the regression cases
  // behind the "Left hemisphere timed out after 600000ms" production bug:
  // the orchestrator fell to `chat` and burned 10 minutes spawning Claude.
  it('Frank experiment requests classify as workflow', () => {
    expect(classifyIntent('show me frank experiments')).toBe('workflow')
    expect(classifyIntent('list frank experiments')).toBe('workflow')
    expect(classifyIntent('utilizing Frank: read franks workspace experiments')).toBe('workflow')
    expect(classifyIntent('read frank experiment 2026-03-08-05-04-54')).toBe('workflow')
  })

  it('reverse word order ("experiments on frank") still classifies as workflow', () => {
    expect(classifyIntent('experiments on frank')).toBe('workflow')
    expect(classifyIntent('list experiments in voldemort workspace')).toBe('workflow')
  })

  it('station / radio queries classify as query', () => {
    expect(classifyIntent("what's playing")).toBe('query')
    expect(classifyIntent('now playing')).toBe('query')
    expect(classifyIntent('current song')).toBe('query')
    expect(classifyIntent('check the station')).toBe('query')
    expect(classifyIntent('station check')).toBe('query')
    expect(classifyIntent('station status')).toBe('query')
    expect(classifyIntent('wpfq health check')).toBe('query') // note: wpfq+health matches station rule before generic health-check
    expect(classifyIntent('dpl coverage')).toBe('query')
    expect(classifyIntent('play history')).toBe('query')
    expect(classifyIntent('upcoming songs')).toBe('query')
    expect(classifyIntent('station logs')).toBe('query')
    expect(classifyIntent('check what\'s playing on the radio')).toBe('query')
  })
})
