/**
 * Pure mappers from Claude CLI stream-json events to human-readable status
 * lines for the Telegram bubble. Returns null when an event has no UX value
 * (system init, hooks, rate-limit telemetry, etc.).
 *
 * Tool-name → emoji + brief input rendering. Inputs are truncated to keep
 * Telegram edits short; PHI-adjacent paths under the clinical archive are
 * scrubbed at this layer too.
 */

const TOOL_EMOJIS: Readonly<Record<string, string>> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '🔧',
  Grep: '🔍',
  Glob: '📂',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '🤖',
  TodoWrite: '✅',
  NotebookEdit: '📓',
  AskUserQuestion: '❓',
  Skill: '🛠️',
}

const MAX_INPUT_CHARS = 80
const CLINICAL_ROOT = '/home/tripp/Documents/claude-team/clinical-archive'

/** Minimal subset of the stream-json event shape we read from. */
export interface StreamEvent {
  type?: string
  subtype?: string
  message?: {
    content?: Array<{
      type?: string
      name?: string
      input?: Record<string, unknown>
      text?: string
    }>
  }
  result?: string
}

export interface StreamFormatterOptions {
  /** When true, scrub paths under the clinical archive before display. */
  redactClinicalPaths?: boolean
}

/**
 * Format a single stream event into a status string. Returns null when the
 * event has no user-facing value.
 */
export function formatStreamEvent(
  event: StreamEvent,
  opts: StreamFormatterOptions = {},
): string | null {
  if (event.type !== 'assistant') return null
  const blocks = event.message?.content ?? []
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.name) {
      return formatToolUse(block.name, block.input ?? {}, opts)
    }
  }
  return null
}

function formatToolUse(
  name: string,
  input: Record<string, unknown>,
  opts: StreamFormatterOptions,
): string {
  const emoji = TOOL_EMOJIS[name] ?? '⚙️'
  const detail = renderToolInput(name, input, opts)
  if (detail) return `${emoji} ${name}: ${detail}`
  return `${emoji} ${name}`
}

function renderToolInput(
  name: string,
  input: Record<string, unknown>,
  opts: StreamFormatterOptions,
): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = strField(input, 'file_path') ?? strField(input, 'notebook_path')
      return path ? scrub(path, opts) : ''
    }
    case 'Bash': {
      const cmd = strField(input, 'command')
      return cmd ? truncate(cmd) : ''
    }
    case 'Grep':
    case 'Glob': {
      const pat = strField(input, 'pattern') ?? strField(input, 'query')
      return pat ? truncate(pat) : ''
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = strField(input, 'url') ?? strField(input, 'query')
      return target ? truncate(target) : ''
    }
    case 'Task': {
      const desc = strField(input, 'description') ?? strField(input, 'subagent_type')
      return desc ? truncate(desc) : ''
    }
    case 'Skill': {
      return strField(input, 'skill') ?? ''
    }
    case 'TodoWrite': {
      // Surface first in-progress todo (if any) so back-to-back TodoWrite
      // edits look distinct: "✅ TodoWrite: investigating logs" vs the bare
      // tool name.
      const todos = input.todos
      if (Array.isArray(todos)) {
        const active = todos.find(
          (t) =>
            typeof t === 'object' &&
            t !== null &&
            (t as { status?: unknown }).status === 'in_progress',
        )
        if (active && typeof (active as { activeForm?: unknown }).activeForm === 'string') {
          return truncate((active as { activeForm: string }).activeForm)
        }
        return `${todos.length} item${todos.length === 1 ? '' : 's'}`
      }
      return ''
    }
    default:
      return ''
  }
}

function strField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' ? v : undefined
}

function truncate(s: string): string {
  const single = s.replace(/\s+/g, ' ').trim()
  if (single.length <= MAX_INPUT_CHARS) return single
  return single.slice(0, MAX_INPUT_CHARS - 1) + '…'
}

function scrub(path: string, opts: StreamFormatterOptions): string {
  if (opts.redactClinicalPaths && path.startsWith(CLINICAL_ROOT)) {
    return '<clinical-archive>'
  }
  return truncate(path)
}
