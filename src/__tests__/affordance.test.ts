import { describe, it, expect } from 'vitest'
import {
  leftAffordancePrompt,
  rightAffordancePrompt,
  leftRevisionPrompt,
  rightRevisionPrompt,
  type HistoryEntry,
} from '../brain/affordance.js'

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
