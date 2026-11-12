import { describe, it, expect } from 'vitest'
import { ToolEvidenceCollector } from '../bridge/tool-evidence.js'
describe('observed tool evidence', () => {
  it('pairs actual call IDs and preserves failed result status', () => {
    const c = new ToolEvidenceCollector()
    c.capture({ message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'check' } }] } } as any)
    c.capture({ message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ text: 'not found' }], is_error: true }] } } as any)
    expect(c.evidence).toEqual([{ tool: 'Bash', input: '{"command":"check"}', result: 'not found', status: 'error' }])
  })
  it('supports the actual OpenClaw synthesized result shape without fabricating evidence', () => {
    const c = new ToolEvidenceCollector()
    c.capture({ type: 'user', message: { content: [{ type: 'tool_result', name: 'exec', input: { command: 'check' }, text: 'observed output' }] } })
    expect(c.evidence[0]).toMatchObject({ tool: 'exec', result: 'observed output', status: 'observed' })
    expect(new ToolEvidenceCollector().evidence).toEqual([])
  })
})
