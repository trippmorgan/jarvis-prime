import { describe, it, expect } from 'vitest'
import { formatStreamEvent } from '../claude/stream-formatter.js'

describe('formatStreamEvent', () => {
  it('returns null for system / non-assistant events', () => {
    expect(formatStreamEvent({ type: 'system' })).toBe(null)
    expect(formatStreamEvent({ type: 'result', result: 'hi' })).toBe(null)
    expect(formatStreamEvent({ type: 'rate_limit_event' })).toBe(null)
  })

  it('returns null for assistant text-only or thinking-only blocks', () => {
    expect(
      formatStreamEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ).toBe(null)
    expect(
      formatStreamEvent({
        type: 'assistant',
        message: { content: [{ type: 'thinking', text: 'pondering' }] },
      }),
    ).toBe(null)
  })

  it('formats Read tool_use with file_path', () => {
    const out = formatStreamEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } },
        ],
      },
    })
    expect(out).toBe('📖 Read: /etc/hosts')
  })

  it('formats Bash tool_use with command (truncated)', () => {
    const longCmd = 'ssh kitchenhub "calendar list --upcoming --limit 50"'
    const out = formatStreamEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: longCmd } }],
      },
    })
    expect(out).toBe(`🔧 Bash: ${longCmd}`)
  })

  it('truncates very long inputs with ellipsis', () => {
    const huge = 'x'.repeat(200)
    const out = formatStreamEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: huge } }],
      },
    })
    expect(out).toMatch(/^🔧 Bash: x{79}…$/)
  })

  it('uses default emoji for unknown tools', () => {
    const out = formatStreamEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'WeirdTool', input: {} }],
      },
    })
    expect(out).toBe('⚙️ WeirdTool')
  })

  it('redacts clinical-archive paths when redactClinicalPaths is set', () => {
    const out = formatStreamEvent(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: {
                file_path:
                  '/home/tripp/Documents/claude-team/clinical-archive/patient42.md',
              },
            },
          ],
        },
      },
      { redactClinicalPaths: true },
    )
    expect(out).toBe('📖 Read: <clinical-archive>')
  })
})
