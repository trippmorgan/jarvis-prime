// W17 — Orchestrator type contracts.
//
// Prime is the user of jarvis-os. Tripp talks to Prime in Telegram;
// Prime decides which lieutenants to employ, dispatches commands via
// the W16 envelope bus, monitors results, reports back.
//
// All of these types are consumed by:
//   classify.ts (IntentClass)
//   plan.ts     (Plan, PlanStep)
//   execute.ts  (ExecEvent, OrchestrationResult)
//   index.ts    (orchestrate entrypoint)

export type IntentClass = 'chat' | 'query' | 'workflow' | 'status'

export type CommandTarget =
  | 'prime'
  | 'frank'
  | 'scalpel'
  | 'argus'
  | 'dj-jarvis'
  | 'openclaw'
  | string // raw agent_id is also valid

export interface PlanStep {
  target: CommandTarget
  command_type: string
  args: Record<string, unknown>
  /** Optional human description shown in activity timeline + Telegram. */
  description?: string
}

export interface Plan {
  class: IntentClass
  steps: PlanStep[]
  /** Human-readable headline; rendered first in the Telegram reply. */
  summary: string
}

export type ExecEventKind =
  | 'plan_formed'
  | 'step_dispatched'
  | 'step_complete'
  | 'step_failed'
  | 'awaiting_confirm'
  | 'orchestration_done'

export interface ExecEvent {
  kind: ExecEventKind
  step?: PlanStep
  step_number?: number
  total_steps?: number
  envelope_id?: string
  required_phrase?: string
  result?: unknown
  reason?: string
}

export interface OrchestrationResult {
  class: IntentClass
  session_id?: string
  events: ExecEvent[]
  final_reply: string
  completed: boolean
}

export interface TelegramMessage {
  text: string
  chat_id: string
  from?: string
  thread_id?: string
}
