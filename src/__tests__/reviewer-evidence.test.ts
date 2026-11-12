import { describe, it, expect } from 'vitest'
import { reviewerEvidence, candidateEvidence } from '../bridge/jev-acceptance.js'
import { ToolEvidenceCollector, EVIDENCE_RESULT_CHARS } from '../bridge/tool-evidence.js'
import type { TurnCandidate } from '../bridge/jev-turn.js'

const step = (i: number, result = `out${i}`) => ({ tool: 'Bash', input: `{"command":"cmd${i}"}`, result, status: 'observed' as const })
const cand = (n: number): TurnCandidate => ({ text: 'a', source: 'primary', evidence: Array.from({ length: n }, (_, i) => step(i)) })

describe('reviewer evidence window (2026-10-20)', () => {
  it('shows the whole turn in order, so an early check is still visible to the reviewer', () => {
    const text = reviewerEvidence(cand(30))
    expect(text).toMatch(/^EXECUTION EVIDENCE: 30 tool step\(s\) this turn, in order\./)
    expect(text).toContain('1. Bash [observed] {"command":"cmd0"}\nout0')
    expect(text).toContain('30. Bash [observed] {"command":"cmd29"}\nout29')
    expect(text).toMatch(/OBSERVED, even if it appears early/)
    // the old window only kept the last 8 steps
    expect(candidateEvidence(cand(30))).not.toContain('cmd0')
  })
  it('keeps long results for recent steps and compact ones for older steps', () => {
    const c: TurnCandidate = { text: 'a', source: 'primary', evidence: [step(0, 'A'.repeat(1000)), ...Array.from({ length: 24 }, (_, i) => step(i + 1, 'B'.repeat(1000)))] }
    const text = reviewerEvidence(c, { fullSteps: 24, resultChars: 1200, compactResultChars: 100 })
    expect(text).toContain('1. Bash [observed] {"command":"cmd0"}\n' + 'A'.repeat(100) + '\n')
    expect(text).toContain('B'.repeat(1000))
  })
  it('drops the oldest compact lines first under the total budget and says so', () => {
    const text = reviewerEvidence(cand(60), { fullSteps: 5, totalChars: 900 })
    expect(text).toMatch(/oldest omitted for length/)
    expect(text).toContain('60. Bash')
    expect(text).not.toContain('\n1. Bash')
    expect(text.length).toBeLessThan(1200)
  })
  it('the collector now keeps long results and 120 steps', () => {
    const c = new ToolEvidenceCollector()
    for (let i = 0; i < 130; i++) c.capture({ type: 'user', message: { content: [{ type: 'tool_result', name: 'exec', input: { command: `c${i}` }, text: 'x'.repeat(2000) }] } })
    expect(c.evidence).toHaveLength(120)
    expect(c.evidence[0].input).toContain('c10')
    expect(c.evidence[0].result).toHaveLength(EVIDENCE_RESULT_CHARS)
  })
  it('says plainly when nothing ran', () => {
    expect(reviewerEvidence(cand(0))).toMatch(/No execution evidence was captured/)
  })
})
