// W21 tests — X-post + morning-show codified as orchestrated processes.

import { describe, it, expect } from 'vitest'
import {
  classifyIntent,
  buildPlan,
  composeFinalReply,
  renderResult,
  COMMAND_TIER,
} from '../../orchestrator/index.js'
import type { ExecEvent } from '../../orchestrator/types.js'

describe('W21 classify — Process A (X post)', () => {
  it('general tweet/x-post phrasings promote to workflow', () => {
    expect(classifyIntent('draft a tweet about the new morning show')).toBe('workflow')
    expect(classifyIntent('post to X about tonight set')).toBe('workflow')
    expect(classifyIntent('tweet about the station relaunch')).toBe('workflow')
    expect(classifyIntent('make an x post')).toBe('workflow')
    expect(classifyIntent('publish to twitter')).toBe('workflow')
  })
  it('WPFQ-specific phrasing still works', () => {
    expect(classifyIntent('post the now playing track to X for wpfq')).toBe('workflow')
  })
  it('casual mentions of twitter stay chat', () => {
    expect(classifyIntent('did you see that twitter thread yesterday')).toBe('chat')
    expect(classifyIntent('twitter is down again huh')).toBe('chat')
  })
})

describe('W21 classify — Process B (morning show)', () => {
  it('production phrasings promote to workflow', () => {
    expect(classifyIntent('build the morning show')).toBe('workflow')
    expect(classifyIntent('produce monday morning show')).toBe('workflow')
    expect(classifyIntent('designed and published the morning show')).toBe('workflow')
    expect(classifyIntent('morning show status')).toBe('workflow')
    expect(classifyIntent('preview the morning-show for 2026-05-18')).toBe('workflow')
  })
  it('does NOT collide with W19b morning briefing', () => {
    expect(classifyIntent('morning briefing')).toBe('workflow') // still W19b workflow
    expect(classifyIntent('morning check')).toBe('workflow')
    // distinct intents — both workflow class, different plan templates
  })
})

describe('W21 plan — Process A', () => {
  it('general tweet → 2-step social-draft(T1) → social-post(T3)', () => {
    const p = buildPlan('draft a tweet about the morning show launch', 'workflow')
    expect(p.steps.length).toBe(2)
    expect(p.steps[0].command_type).toBe('social-draft')
    expect(p.steps[0].args.dry_run).toBe(true)
    expect(p.steps[1].command_type).toBe('social-post')
    expect(p.steps[1].args.dry_run).toBe(false)
    expect(COMMAND_TIER['social-draft']).toBe(1)
    expect(COMMAND_TIER['social-post']).toBe(3)
  })
  it('extracts a free-text topic after "about"', () => {
    const p = buildPlan('tweet about the station relaunch party', 'workflow')
    expect(String(p.steps[0].args.topic)).toContain('station relaunch party')
  })
})

describe('W21 plan — Process B', () => {
  it('morning show → 2-step build(T1) → publish(T3) on prime', () => {
    const p = buildPlan('build the morning show', 'workflow')
    expect(p.steps.length).toBe(2)
    expect(p.steps[0].target).toBe('prime')
    expect(p.steps[0].command_type).toBe('morning-show-build')
    expect(p.steps[1].command_type).toBe('morning-show-publish')
    expect(COMMAND_TIER['morning-show-build']).toBe(1)
    expect(COMMAND_TIER['morning-show-publish']).toBe(3)
  })
  it('captures an explicit date token', () => {
    const p = buildPlan('produce the morning show 2026-05-18', 'workflow')
    expect(p.steps[0].args.date).toBe('2026-05-18')
  })
  it('defaults date to "next" when unspecified', () => {
    const p = buildPlan('build the morning show', 'workflow')
    expect(p.steps[0].args.date).toBe('next')
  })
})

describe('W21 confirm-gate UX — the draft/preview is shown at the T3 gate', () => {
  const draftText = '🎵 Now spinning: Black — Pearl Jam. Independent radio. #WPFQ'
  const events: ExecEvent[] = [
    { kind: 'plan_formed', total_steps: 2 },
    { kind: 'step_dispatched', step: { target: 'prime', command_type: 'social-draft', args: {} }, step_number: 1, total_steps: 2 },
    {
      kind: 'step_complete',
      step: { target: 'prime', command_type: 'social-draft', args: {} },
      step_number: 1,
      total_steps: 2,
      result: { command_type: 'social-draft', platform: 'x', dry_run: true, post_text: draftText, char_count: draftText.length },
    },
    {
      kind: 'awaiting_confirm',
      step: { target: 'prime', command_type: 'social-post', args: {} },
      step_number: 2,
      total_steps: 2,
      required_phrase: 'CONFIRM POST',
    },
  ]

  it('renders the actual draft text before the confirm prompt (not a bare phrase ask)', () => {
    const out = composeFinalReply({ summary: 'Drafting a WPFQ X post.' }, events, 'workflow')
    expect(out).toContain(draftText)
    expect(out).toContain('CONFIRM POST')
    expect(out).toContain('awaiting confirmation')
    // The old behavior was just "reply with phrase" with no artifact —
    // assert the draft body is present, i.e. the gate is reviewable.
    expect(out.indexOf(draftText)).toBeLessThan(out.indexOf('CONFIRM POST'))
  })
})

describe('W21 renderResult — morning-show snapshot', () => {
  it('renders stage table + previews + deploy summary', () => {
    const buildCtx = {
      command_type: 'morning-show-build',
      stage: 'build',
      mode: 'plan',
      show_date: '2026-05-18',
      hours: 'all',
      pipeline: [
        { stage: 'research', script: 'research-date.sh', exists: true },
        { stage: 'render', script: 'render-voice.sh', exists: false },
      ],
      previews: ['FULL-VOICE-PREVIEW-2026-05-18.mp3'],
    }
    const r = renderResult(buildCtx)
    expect(r).toContain('morning-show build')
    expect(r).toContain('2026-05-18')
    expect(r).toContain('research-date.sh')
    expect(r).toContain('FULL-VOICE-PREVIEW-2026-05-18.mp3')
  })
  it('publish snapshot surfaces guardrails + asset count', () => {
    const r = renderResult({
      command_type: 'morning-show-publish',
      stage: 'publish',
      mode: 'plan',
      show_date: '2026-05-18',
      asset_count: 19,
      guardrails: ['AutoImporter flow only — never direct INSERT/UPDATE Playlists'],
      pipeline: [],
    })
    expect(r).toContain('morning-show publish')
    expect(r).toContain('19 deploy assets')
    expect(r).toContain('AutoImporter flow only')
  })
})
