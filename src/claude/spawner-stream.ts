import { spawn } from 'node:child_process'
import type { SpawnOptions, SpawnResult, SpawnUsage } from './types.js'
import type { StreamEvent } from './stream-formatter.js'

const DEFAULTS = {
  claudePath: '/home/tripp/.local/bin/claude',
  model: 'sonnet',
  timeoutMs: 300_000,
} as const

export interface StreamSpawnCallbacks {
  /**
   * Called for every stream event the CLI emits. Throws are swallowed —
   * UX callbacks must never break the spawn lifecycle.
   */
  onEvent?: (event: StreamEvent) => void
}

/**
 * Spawn the Claude CLI in stream-json mode. Same surface as spawnClaude but
 * yields per-event callbacks while the process runs. The final assembled
 * answer is taken from the `result` event when present, falling back to
 * concatenated `text` blocks if the result event is missing (network
 * truncation / SIGKILL).
 *
 * Runs: claude --print --output-format stream-json --verbose --model X
 *       --dangerously-skip-permissions
 */
export async function spawnClaudeStream(
  prompt: string,
  opts: SpawnOptions & StreamSpawnCallbacks = {},
): Promise<SpawnResult> {
  const claudePath = opts.claudePath ?? DEFAULTS.claudePath
  const model = opts.model ?? DEFAULTS.model
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const workingDir = opts.workingDir ?? process.cwd()
  const enableTools = opts.enableTools ?? true
  const enableSlashCommands = opts.enableSlashCommands ?? true
  const onEvent = opts.onEvent

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--dangerously-skip-permissions',
  ]
  if (opts.sessionId) {
    args.push(opts.resumeSession ? '--resume' : '--session-id', opts.sessionId)
  }
  if (!enableTools) args.push('--tools', '')
  if (!enableSlashCommands) args.push('--disable-slash-commands')

  const start = performance.now()

  return new Promise<SpawnResult>((resolve) => {
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdoutBuf = ''
    let resultText = ''
    let usage: SpawnUsage | undefined
    let costUsd: number | undefined
    let modelResolved: string | undefined
    const textBlocks: string[] = []
    const stderrChunks: Buffer[] = []

    const child = spawn(claudePath, args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    child.stdin.write(prompt)
    child.stdin.end()

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        let evt: StreamEvent | null = null
        try {
          evt = JSON.parse(trimmed) as StreamEvent
        } catch {
          continue
        }
        if (!evt) continue

        // Capture canonical final text + opportunistic text fallback.
        if (evt.type === 'result') {
          if (typeof evt.result === 'string') {
            resultText = evt.result
          }
          // Token usage + cost arrive on the final result event. Both are
          // optional — older CLI versions or aborted runs may omit them.
          const u = (evt as unknown as { usage?: Record<string, number> }).usage
          if (u && typeof u === 'object') {
            usage = {
              inputTokens: Number(u.input_tokens) || 0,
              outputTokens: Number(u.output_tokens) || 0,
              cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
              cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
            }
          }
          const c = (evt as unknown as { total_cost_usd?: number }).total_cost_usd
          if (typeof c === 'number') costUsd = c
          // Take the first key in modelUsage as the canonical resolved model
          // (e.g. "claude-sonnet-4-6" when the CLI was invoked with --model sonnet).
          const mu = (evt as unknown as { modelUsage?: Record<string, unknown> }).modelUsage
          if (mu && typeof mu === 'object') {
            const keys = Object.keys(mu)
            if (keys.length > 0) modelResolved = keys[0]
          }
        } else if (evt.type === 'assistant') {
          for (const block of evt.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textBlocks.push(block.text)
            }
          }
        }

        if (onEvent) {
          try {
            onEvent(evt)
          } catch {
            // Swallow — UX callback failures must not break the spawn.
          }
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const durationMs = Math.round(performance.now() - start)
      const output = resultText || textBlocks.join('\n')
      resolve({
        output,
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
        durationMs,
        timedOut,
        usage,
        costUsd,
        modelResolved,
      })
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      const durationMs = Math.round(performance.now() - start)
      resolve({
        output: '',
        stderr: err.message,
        exitCode: 1,
        durationMs,
        timedOut: false,
      })
    })
  })
}
