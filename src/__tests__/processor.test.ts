import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor, splitMessage } from '../bridge/processor.js'

vi.mock('../claude/spawner.js', () => ({
  spawnClaude: vi.fn(),
}))

import { spawnClaude } from '../claude/spawner.js'

describe('MessageProcessor', () => {
  let deliverMock: ReturnType<typeof vi.fn>
  let processor: MessageProcessor

  beforeEach(() => {
    vi.clearAllMocks()
    deliverMock = vi.fn().mockResolvedValue(undefined)
    const tmpDir = mkdtempSync(join(tmpdir(), 'jp-test-'))
    processor = new MessageProcessor(
      { claudePath: '/usr/bin/claude', claudeModel: 'sonnet', claudeTimeoutMs: 120_000, historyPath: join(tmpDir, 'history.jsonl') },
      deliverMock,
      Fastify({ logger: false }).log,
    )
  })

  it('submits message and processes via Claude', async () => {
    vi.mocked(spawnClaude).mockResolvedValue({
      output: 'Hello!', stderr: '', exitCode: 0, durationMs: 500, timedOut: false,
    })

    const result = processor.submit('123', 'Hi', 'user1')
    expect(result.blocked).toBe(false)
    expect(result.position).toBe(1)

    await new Promise((r) => setTimeout(r, 100))
    expect(deliverMock).toHaveBeenCalledWith('123', 'Hello!')
  })

  it('blocks PHI without calling Claude', async () => {
    const result = processor.submit('123', 'patient John Smith was admitted', 'user1')
    expect(result.blocked).toBe(true)
    expect(result.reasons).toContain('patient_name_detected')
    expect(spawnClaude).not.toHaveBeenCalled()
  })

  it('reports queue position correctly', () => {
    // The processor uses submit() which is sync — test the return values
    vi.mocked(spawnClaude).mockImplementation(() =>
      new Promise((r) => setTimeout(() => r({
        output: 'done', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      }), 5000)) // Long enough that the first never finishes during test
    )

    const r1 = processor.submit('123', 'first', 'user1')
    expect(r1.blocked).toBe(false)
    expect(r1.position).toBe(1)

    // Queue length check
    expect(processor.isProcessing()).toBe(true)
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits at newline boundaries', () => {
    const text = 'line1\nline2\nline3'
    const chunks = splitMessage(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('hard splits when no newlines', () => {
    const text = 'a'.repeat(200)
    const chunks = splitMessage(text, 100)
    expect(chunks).toEqual(['a'.repeat(100), 'a'.repeat(100)])
  })
})
