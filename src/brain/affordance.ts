/**
 * Affordance prompt templates for the Gibsonian dual-brain.
 *
 * The same sensory input (user message + history) is framed differently for
 * each hemisphere so that the affordance invites the respective cognitive
 * style. Left = structural/logical. Right = holistic/creative/pattern-based.
 *
 * Pure functions — no network calls, no side effects.
 */

import type { ToolEvidence } from './dispatch-types.js'

export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface HemispherePrompt {
  system: string
  user: string
}

/**
 * Wave 8 — summary of what one hemisphere did during pass-1.
 *
 *  - `{ tools: [...] }` — raw tool list (left pass-1 only: Bash/Read/SSH/agents/etc).
 *  - `{ skill: {...} }` — the right hemisphere invoked a skill (via the shim).
 *  - `{ researchMode: true }` — the right hemisphere drafted from workspace memory with no tools.
 *  - `undefined` — unknown or not yet tracked; renders as "(no tools)".
 */
export type ToolsUsedSummary =
  | { tools: ToolEvidence[] }
  | { skill: { name: string; durationMs: number } }
  | { researchMode: true }
  | undefined

export interface ToolsCrossVisibility {
  left?: ToolsUsedSummary
  right?: ToolsUsedSummary
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1) + 's'
}

/**
 * Render one line of the "Tool use summary (pass-1)" block. Public so the
 * orchestrator can reuse the same formatter across pass-2 prompts AND the
 * post-hoc UX card (W8-T13).
 */
export function formatToolsUsedLine(
  label: 'Left' | 'Right',
  summary: ToolsUsedSummary,
): string {
  if (summary === undefined) {
    return `${label} ran: (no tools)`
  }
  if ('researchMode' in summary) {
    return `${label} ran: (research mode, no tools)`
  }
  if ('skill' in summary) {
    return `${label} ran: ${summary.skill.name} (${formatSeconds(summary.skill.durationMs)})`
  }
  if (summary.tools.length === 0) {
    return `${label} ran: (no tools)`
  }
  const items = summary.tools
    .map((t) => `${t.name} (${formatSeconds(t.durationMs)})`)
    .join(', ')
  return `${label} ran: ${items}`
}

function formatToolsBlock(tools: ToolsCrossVisibility): string {
  return [
    'Tool use summary (pass-1):',
    formatToolsUsedLine('Left', tools.left),
    formatToolsUsedLine('Right', tools.right),
  ].join('\n')
}

const LEFT_AFFORDANCE_SUFFIX =
  'You are the left hemisphere of a dual-brain. Focus on logical structure, sequential dependencies, precise definitions, constraints, and causal chains. Produce a grounded, structurally rigorous draft.'

const PLANNING_INSTRUCTIONS_TEMPLATE = `You are also the dispatcher/router for this turn. Before your draft, decide whether this message needs external tools or skills. You have two dispatch modes:

1. **skill mode** — dispatch a single skill to the right hemisphere. Use this when the message benefits from a specialized methodology (e.g. building/planning code, running research). Available skills (use exactly these names, no others):
{ALLOWED_SKILLS}

2. **research mode** — the right hemisphere will draft from workspace memory (MEMORY.md, prior logs, incident notes) with an optional topic focus. Use this when no skill is warranted.

**Output format — required, in this order:**

1. A dispatch block, on its own line, at the top of your output:
   <dispatch>{"mode":"skill","skill":"<one of the allowed names>","instruction":"<what you want the right hemisphere's skill run to accomplish>"}</dispatch>
   OR
   <dispatch>{"mode":"research","topics":["<topic1>","<topic2>"]}</dispatch>

2. Your pass-1 draft body. Use your own tools (Bash, SSH, agents, file reads) as needed to ground the draft in real evidence. Keep your draft under 1500 chars unless necessary.

3. A tools evidence block listing the tools YOU used, on its own line, at the very end:
   <tools>[{"name":"<tool-name>","durationMs":<int>}]</tools>
   If you used no tools, emit:
   <tools>[]</tools>

**Rules:**
- Emit exactly one <dispatch> and one <tools> block.
- Never invent a skill name. If no listed skill fits, use research mode.
- Do not dispatch the same skill you plan to run yourself — choose division of labor.
- The user never sees the dispatch or tools blocks; they are machine-consumed.`

function formatAllowedSkills(skills: readonly string[]): string {
  return skills.map((name) => `   - ${name}`).join('\n')
}

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
  tools?: ToolsCrossVisibility,
): string {
  const revision = REVISION_TEMPLATE.replace('{OTHER_DRAFT}', otherDraft).replace(
    '{MY_DRAFT}',
    myDraft,
  )
  const toolsBlock = tools ? `\n\n${formatToolsBlock(tools)}` : ''
  return `${basePrompt}\n\n${affordanceSuffix}\n\n${revision}${toolsBlock}`
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
 * Pass 1 — left hemisphere (Claude) drafts WITH dispatcher/router framing.
 * Adds planning-mode instructions on top of the left affordance framing.
 * Used when `JARVIS_ROUTER_ENABLED=true`.
 */
export function leftPlanningPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  allowedSkills: readonly string[],
): HemispherePrompt {
  const planning = PLANNING_INSTRUCTIONS_TEMPLATE.replace(
    '{ALLOWED_SKILLS}',
    formatAllowedSkills(allowedSkills),
  )
  const system = `${basePrompt}\n\n${LEFT_AFFORDANCE_SUFFIX}\n\n${planning}`
  return {
    system,
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
 * pass-1 draft. Retains the left affordance framing. Optional Wave 8
 * `tools` argument adds a cross-visibility "Tool use summary (pass-1)"
 * block after the revision instructions.
 */
export function leftRevisionPrompt(
  basePrompt: string,
  history: HistoryEntry[],
  userMsg: string,
  myDraft: string,
  otherDraft: string,
  tools?: ToolsCrossVisibility,
): HemispherePrompt {
  return {
    system: buildRevisionSystem(
      basePrompt,
      LEFT_AFFORDANCE_SUFFIX,
      myDraft,
      otherDraft,
      tools,
    ),
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
  tools?: ToolsCrossVisibility,
): HemispherePrompt {
  return {
    system: buildRevisionSystem(
      basePrompt,
      RIGHT_AFFORDANCE_SUFFIX,
      myDraft,
      otherDraft,
      tools,
    ),
    user: buildUserMessage(history, userMsg),
  }
}
