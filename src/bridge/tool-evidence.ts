import type { StreamEvent } from '../claude/stream-formatter.js'
import type { ToolEvidence } from './harness-race.js'

/** Pairs observed results with their actual calls; missing evidence stays explicit. */
// 2026-10-20: the reviewer was history-blind (last 8 steps, 240-char results) and reported things the
// LEFT had already verified as unverified. Keep the whole turn: 120 steps, 400-char inputs, 1500-char results.
export const EVIDENCE_MAX_STEPS = 120
export const EVIDENCE_INPUT_CHARS = 400
export const EVIDENCE_RESULT_CHARS = 1500

export class ToolEvidenceCollector {
  private calls = new Map<string, { tool: string; input: string }>()
  readonly evidence: ToolEvidence[] = []
  capture(event: StreamEvent): void {
    const blocks = event.message?.content as Array<Record<string, unknown>> | undefined
    for (const b of blocks ?? []) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        this.calls.set(b.id, { tool: String(b.name ?? '?'), input: JSON.stringify(b.input ?? {}).slice(0, EVIDENCE_INPUT_CHARS) })
        if (this.calls.size > 80) this.calls.delete(this.calls.keys().next().value!)
      } else if (b.type === 'tool_result') {
        const call = this.calls.get(String(b.tool_use_id ?? '')) ?? (typeof b.name === 'string' ? { tool: b.name, input: JSON.stringify(b.input ?? {}).slice(0, EVIDENCE_INPUT_CHARS) } : undefined)
        const result = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => typeof c === 'object' && c !== null ? String(c.text ?? '') : '').join('\n') : String(b.text ?? '')
        this.evidence.push({ tool: call?.tool ?? 'unmatched-tool-result', input: call?.input ?? '', result: result.slice(0, EVIDENCE_RESULT_CHARS), status: b.is_error ? 'error' : 'observed' })
        this.calls.delete(String(b.tool_use_id ?? ''))
        if (this.evidence.length > EVIDENCE_MAX_STEPS) this.evidence.shift()
      }
    }
  }
}
