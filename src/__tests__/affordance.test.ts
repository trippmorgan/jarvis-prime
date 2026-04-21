import { describe, it, expect } from 'vitest'
import {
  leftAffordancePrompt,
  rightAffordancePrompt,
  leftRevisionPrompt,
  rightRevisionPrompt,
  leftPlanningPrompt,
  formatToolsUsedLine,
  type HistoryEntry,
} from '../brain/affordance.js'
import { ALLOWED_SKILLS } from '../brain/skill-registry.js'

const LEFT_SUFFIX =
  'You are the left hemisphere of a dual-brain. Focus on logical structure, sequential dependencies, precise definitions, constraints, and causal chains. Produce a grounded, structurally rigorous draft.'

const RIGHT_SUFFIX =
  'You are the right hemisphere of a dual-brain. Claude is the left hemisphere and final integrator. Focus on patterns, holistic connections, creative alternatives, and action-possibilities (affordances). Produce a draft that surfaces what the left hemisphere might miss.'

const BASE_PROMPT = '## Context\nYou are Jarvis Prime.'
const USER_MSG = 'What do you think of integrated information theory?'
const HISTORY: HistoryEntry[] = [
  { role: 'user', content: 'Hey Jarvis.', timestamp: 1 },
  { role: 'assistant', content: 'Yes Tripp?', timestamp: 2 },
]

describe('leftAffordancePrompt', () => {
  it('returns a system/user pair', () => {
    const out = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(typeof out.system).toBe('string')
    expect(typeof out.user).toBe('string')
  })

  it('system contains the base prompt and the left affordance suffix', () => {
    const out = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.system).toContain(BASE_PROMPT)
    expect(out.system).toContain(LEFT_SUFFIX)
  })

  it('separates base prompt from suffix with two newlines', () => {
    const out = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.system).toBe(`${BASE_PROMPT}\n\n${LEFT_SUFFIX}`)
  })

  it('user message includes history (Tripp/Jarvis labels) and current user message', () => {
    const out = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.user).toContain('Tripp: Hey Jarvis.')
    expect(out.user).toContain('Jarvis: Yes Tripp?')
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })

  it('handles empty history gracefully', () => {
    const out = leftAffordancePrompt(BASE_PROMPT, [], USER_MSG)
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })
})

describe('rightAffordancePrompt', () => {
  it('returns a system/user pair', () => {
    const out = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(typeof out.system).toBe('string')
    expect(typeof out.user).toBe('string')
  })

  it('system contains the base prompt and the right affordance suffix', () => {
    const out = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.system).toContain(BASE_PROMPT)
    expect(out.system).toContain(RIGHT_SUFFIX)
  })

  it('separates base prompt from suffix with two newlines', () => {
    const out = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.system).toBe(`${BASE_PROMPT}\n\n${RIGHT_SUFFIX}`)
  })

  it('user message includes history and current user message', () => {
    const out = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(out.user).toContain('Tripp: Hey Jarvis.')
    expect(out.user).toContain('Jarvis: Yes Tripp?')
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })
})

describe('left vs right differ', () => {
  it('the two hemispheres use different affordance suffixes', () => {
    const left = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    const right = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(left.system).not.toBe(right.system)
    expect(left.system).not.toContain(RIGHT_SUFFIX)
    expect(right.system).not.toContain(LEFT_SUFFIX)
  })

  it('the user message is identical for both hemispheres given the same inputs', () => {
    const left = leftAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    const right = rightAffordancePrompt(BASE_PROMPT, HISTORY, USER_MSG)
    expect(left.user).toBe(right.user)
  })
})

describe('leftRevisionPrompt', () => {
  const myDraft = 'My pass-1 structural draft.'
  const otherDraft = 'The other hemisphere saw patterns.'

  it('returns a system/user pair', () => {
    const out = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(typeof out.system).toBe('string')
    expect(typeof out.user).toBe('string')
  })

  it('system retains the left affordance suffix', () => {
    const out = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).toContain(LEFT_SUFFIX)
    expect(out.system).toContain(BASE_PROMPT)
  })

  it('system contains both my-draft and other-draft content substituted', () => {
    const out = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).toContain(myDraft)
    expect(out.system).toContain(otherDraft)
  })

  it('system does not leave literal placeholder tokens behind', () => {
    const out = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).not.toContain('{MY_DRAFT}')
    expect(out.system).not.toContain('{OTHER_DRAFT}')
  })

  it('user message includes history and current user message', () => {
    const out = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })
})

describe('rightRevisionPrompt', () => {
  const myDraft = 'My pass-1 holistic draft.'
  const otherDraft = 'The other hemisphere was structural.'

  it('returns a system/user pair', () => {
    const out = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(typeof out.system).toBe('string')
    expect(typeof out.user).toBe('string')
  })

  it('system retains the right affordance suffix', () => {
    const out = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).toContain(RIGHT_SUFFIX)
    expect(out.system).toContain(BASE_PROMPT)
  })

  it('system contains both my-draft and other-draft content substituted', () => {
    const out = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).toContain(myDraft)
    expect(out.system).toContain(otherDraft)
  })

  it('system does not leave literal placeholder tokens behind', () => {
    const out = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.system).not.toContain('{MY_DRAFT}')
    expect(out.system).not.toContain('{OTHER_DRAFT}')
  })

  it('user message includes current user message', () => {
    const out = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraft, otherDraft)
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })
})

describe('revision prompts share the same revision wording across hemispheres', () => {
  const myDraftL = 'Left p1 draft text.'
  const otherDraftL = 'Right p1 draft text.'

  it('both revision prompts contain the shared corpus-callosum revision instruction', () => {
    const left = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, myDraftL, otherDraftL)
    const right = rightRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, otherDraftL, myDraftL)
    const sharedPhrase =
      'The corpus callosum converges on invariants through your direct pickup of each other\'s work'
    expect(left.system).toContain(sharedPhrase)
    expect(right.system).toContain(sharedPhrase)
  })

  it('left revision sees its own draft as MY_DRAFT and right draft as OTHER_DRAFT', () => {
    const left = leftRevisionPrompt(BASE_PROMPT, HISTORY, USER_MSG, 'LEFTSIDE', 'RIGHTSIDE')
    const myIdx = left.system.indexOf('<my-draft>')
    const otherIdx = left.system.indexOf('<draft>')
    expect(myIdx).toBeGreaterThan(-1)
    expect(otherIdx).toBeGreaterThan(-1)
    // LEFTSIDE should appear inside the my-draft block
    const myBlock = left.system.slice(myIdx)
    expect(myBlock).toContain('LEFTSIDE')
    // RIGHTSIDE should appear inside the other-draft block
    const otherBlock = left.system.slice(otherIdx, myIdx)
    expect(otherBlock).toContain('RIGHTSIDE')
  })
})

describe('leftPlanningPrompt (W8-T6)', () => {
  it('returns a system/user pair', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(typeof out.system).toBe('string')
    expect(typeof out.user).toBe('string')
  })

  it('system includes the base prompt', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system).toContain(BASE_PROMPT)
  })

  it('preserves the existing left affordance framing', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system).toContain(LEFT_SUFFIX)
  })

  it('instructs Claude it is the dispatcher/router', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system.toLowerCase()).toContain('dispatcher')
  })

  it('names the <dispatch> block format explicitly', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system).toContain('<dispatch>')
    expect(out.system).toContain('</dispatch>')
  })

  it('names the <tools> evidence block', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system).toContain('<tools>')
    expect(out.system).toContain('</tools>')
  })

  it('interpolates the allowed skill list so Claude does not invent skills', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    for (const skill of ALLOWED_SKILLS) {
      expect(out.system).toContain(skill)
    }
  })

  it('accepts a custom allowed-skill list (decoupled from module default)', () => {
    const custom = ['jarvis-dev-methodology'] as const
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, custom)
    expect(out.system).toContain('jarvis-dev-methodology')
    expect(out.system).not.toContain('research-methodology')
  })

  it('user contains history and the current user message', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.user).toContain('Tripp: Hey Jarvis.')
    expect(out.user).toContain('Jarvis: Yes Tripp?')
    expect(out.user).toContain(`Tripp: ${USER_MSG}`)
  })

  it('describes the two valid dispatch modes (skill and research)', () => {
    const out = leftPlanningPrompt(BASE_PROMPT, HISTORY, USER_MSG, ALLOWED_SKILLS)
    expect(out.system.toLowerCase()).toContain('skill')
    expect(out.system.toLowerCase()).toContain('research')
  })
})

describe('formatToolsUsedLine (W8-T11)', () => {
  it('returns "(no tools)" for undefined summary', () => {
    expect(formatToolsUsedLine('Left', undefined)).toBe('Left ran: (no tools)')
  })

  it('returns "(no tools)" for empty tool array', () => {
    expect(formatToolsUsedLine('Right', { tools: [] })).toBe(
      'Right ran: (no tools)',
    )
  })

  it('formats a single tool with seconds rounded to 1 decimal', () => {
    expect(
      formatToolsUsedLine('Left', {
        tools: [{ name: 'Bash', durationMs: 1200 }],
      }),
    ).toBe('Left ran: Bash (1.2s)')
  })

  it('formats multiple tools comma-separated', () => {
    expect(
      formatToolsUsedLine('Left', {
        tools: [
          { name: 'Bash', durationMs: 1200 },
          { name: 'Read', durationMs: 500 },
        ],
      }),
    ).toBe('Left ran: Bash (1.2s), Read (0.5s)')
  })

  it('formats a skill invocation', () => {
    expect(
      formatToolsUsedLine('Right', {
        skill: { name: 'jarvis-dev-methodology', durationMs: 4100 },
      }),
    ).toBe('Right ran: jarvis-dev-methodology (4.1s)')
  })

  it('formats "(research mode)" when explicit research-mode flag set', () => {
    expect(formatToolsUsedLine('Right', { researchMode: true })).toBe(
      'Right ran: (research mode, no tools)',
    )
  })

  it('rounds sub-second durations correctly', () => {
    expect(
      formatToolsUsedLine('Left', {
        tools: [{ name: 'X', durationMs: 50 }],
      }),
    ).toBe('Left ran: X (0.1s)')
    expect(
      formatToolsUsedLine('Left', {
        tools: [{ name: 'X', durationMs: 0 }],
      }),
    ).toBe('Left ran: X (0.0s)')
  })
})

describe('leftRevisionPrompt — tool-evidence block (W8-T11)', () => {
  it('omits the tool summary block when toolsSummary is absent (backward compat)', () => {
    const out = leftRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY',
      'OTHER',
    )
    expect(out.system).not.toContain('Tool use summary')
  })

  it('includes both hemispheres tool lines when toolsSummary provided', () => {
    const out = leftRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY',
      'OTHER',
      {
        left: { tools: [{ name: 'Bash', durationMs: 1200 }] },
        right: {
          skill: { name: 'jarvis-dev-methodology', durationMs: 4100 },
        },
      },
    )
    expect(out.system).toContain('Tool use summary (pass-1):')
    expect(out.system).toContain('Left ran: Bash (1.2s)')
    expect(out.system).toContain('Right ran: jarvis-dev-methodology (4.1s)')
  })

  it('still contains OTHER and MY draft content', () => {
    const out = leftRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY_DRAFT_123',
      'OTHER_DRAFT_456',
      {
        left: undefined,
        right: { researchMode: true },
      },
    )
    expect(out.system).toContain('MY_DRAFT_123')
    expect(out.system).toContain('OTHER_DRAFT_456')
    expect(out.system).toContain('Right ran: (research mode, no tools)')
    expect(out.system).toContain('Left ran: (no tools)')
  })
})

describe('rightRevisionPrompt — tool-evidence block (W8-T11)', () => {
  it('omits the tool summary block when toolsSummary is absent', () => {
    const out = rightRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY',
      'OTHER',
    )
    expect(out.system).not.toContain('Tool use summary')
  })

  it('includes both hemispheres tool lines when toolsSummary provided', () => {
    const out = rightRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY',
      'OTHER',
      {
        left: { tools: [{ name: 'Bash', durationMs: 500 }] },
        right: {
          skill: { name: 'research-methodology', durationMs: 2000 },
        },
      },
    )
    expect(out.system).toContain('Tool use summary (pass-1):')
    expect(out.system).toContain('Left ran: Bash (0.5s)')
    expect(out.system).toContain('Right ran: research-methodology (2.0s)')
  })

  it('preserves right-hemisphere affordance framing when tools added', () => {
    const out = rightRevisionPrompt(
      BASE_PROMPT,
      HISTORY,
      USER_MSG,
      'MY',
      'OTHER',
      { right: { researchMode: true } },
    )
    expect(out.system).toContain(RIGHT_SUFFIX)
  })
})
