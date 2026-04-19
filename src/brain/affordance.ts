/**
 * Affordance prompt templates for the Gibsonian dual-brain.
 *
 * The same sensory input (user message + history) is framed differently for
 * each hemisphere so that the affordance invites the respective cognitive
 * style. Left = structural/logical. Right = holistic/creative/pattern-based.
 *
 * Pure functions — no network calls, no side effects.
 */

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface HemispherePrompt {
  system: string
  user: string
}

const LEFT_AFFORDANCE_SUFFIX =
  'You are the left hemisphere of a dual-brain. Focus on logical structure, sequential dependencies, precise definitions, constraints, and causal chains. Produce a grounded, structurally rigorous draft.'

const RIGHT_AFFORDANCE_SUFFIX =
  'You are the right hemisphere of a dual-brain. Claude is the left hemisphere and final integrator. Focus on patterns, holistic connections, creative alternatives, and action-possibilities (affordances). Produce a draft that surfaces what the left hemisphere might miss.'

const REVISION_TEMPLATE = `Here is the other hemisphere's pass-1 draft:

<draft>
{OTHER_DRAFT}
</draft>

Revise your own pass-1 draft, preserving your cognitive style. Keep what still holds. Drop what no longer does. The corpus callosum converges on invariants through your direct pickup of each other's work — not through explicit extraction.

Your pass-1 draft was:

<my-draft>
{MY_DRAFT}
</my-draft>`

function formatHistoryLines(history: HistoryEntry[]): string {
  // Match the format used by src/context/history.ts formatForPrompt:
  // user -> "Tripp: ...", assistant -> "Jarvis: ...".
  return history
    .map((entry) => {
      const label = entry.role === 'user' ? 'Tripp' : 'Jarvis'
      return `${label}: ${entry.content}`
    })
    .join('\n')
}

function buildUserMessage(history: HistoryEntry[], userMsg: string): string {
  const historyBlock = formatHistoryLines(history)
  const current = `Tripp: ${userMsg}`
  if (!historyBlock) return current
  return `${historyBlock}\n\n${current}`
}

function buildSystem(basePrompt: string, suffix: string): string {
  return `${basePrompt}\n\n${suffix}`
}

function buildRevisionSystem(
  basePrompt: string,
  affordanceSuffix: string,
  myDraft: string,
  otherDraft: string,
): string {
  const revision = REVISION_TEMPLATE.replace('{OTHER_DRAFT}', otherDraft).replace(
    '{MY_DRAFT}',
    myDraft,
  )
  return `${basePrompt}\n\n${affordanceSuffix}\n\n${revision}`
}

/**
 * Pass 1 — left hemisphere (Claude) drafts independently with the left
 * affordance framing appended to the base prompt.
 */
export function leftAffordancePrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
): HemispherePrompt {
  return {
    system: buildSystem(basePrompt, LEFT_AFFORDANCE_SUFFIX),
    user: buildUserMessage(history, userMsg),
  }
}

/**
 * Pass 1 — right hemisphere (gpt-5.4 codex) drafts independently with the
 * right affordance framing appended to the base prompt.
 */
export function rightAffordancePrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
): HemispherePrompt {
  return {
    system: buildSystem(basePrompt, RIGHT_AFFORDANCE_SUFFIX),
    user: buildUserMessage(history, userMsg),
  }
}

/**
 * Pass 2 — left hemisphere revises after seeing the right hemisphere's
 * pass-1 draft. Retains the left affordance framing.
 */
export function leftRevisionPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  myDraft: string,
  otherDraft: string,
): HemispherePrompt {
  return {
    system: buildRevisionSystem(basePrompt, LEFT_AFFORDANCE_SUFFIX, myDraft, otherDraft),
    user: buildUserMessage(history, userMsg),
  }
}

/**
 * Pass 2 — right hemisphere revises after seeing the left hemisphere's
 * pass-1 draft. Retains the right affordance framing.
 */
export function rightRevisionPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  myDraft: string,
  otherDraft: string,
): HemispherePrompt {
  return {
    system: buildRevisionSystem(basePrompt, RIGHT_AFFORDANCE_SUFFIX, myDraft, otherDraft),
    user: buildUserMessage(history, userMsg),
  }
}
