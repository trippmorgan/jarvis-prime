import { describe, it, expect } from 'vitest'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { RightBrainAgentClient } from '../brain/right-brain-agent.js'
import { deriveRightBrainSessionId } from '../brain/sessionId.js'

/**
 * W7-T10 — live continuity integration test (AC7.3).
 *
 * Plant a fact ("purple elephant") in turn 1, ask for recall in turn 2 using
 * the same deterministic session id. Proves the OpenClaw agent retains
 * per-chat context across calls when --session-id is stable.
 *
 * Gated behind `RIGHT_BRAIN_LIVE=1` — skipped by default (including in CI)
 * because it shells out to the real `openclaw` CLI and its gateway.
 *
 * Run locally with:
 *     RIGHT_BRAIN_LIVE=1 npx vitest run src/__tests__/right-brain-continuity
 */

const LIVE = process.env.RIGHT_BRAIN_LIVE === '1'
const testFn = LIVE ? it : it.skip

const execFileP = promisify(execFileCb) as unknown as (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>

/**
 * Inside a vitest worker, `VITEST=true` and `NODE_ENV=test` leak into every
 * child process. The openclaw CLI sees NODE_ENV=test on its gateway client
 * and returns an empty stdout. Production never sets those vars, so we
 * scrub them here rather than in RightBrainAgentClient itself.
 */
function scrubbedExec(
  bin: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number },
) {
  const env = { ...process.env }
  delete env.VITEST
  delete env.VITEST_POOL_ID
  delete env.VITEST_WORKER_ID
  env.NODE_ENV = 'production'
  return execFileP(bin, args, { ...opts, env })
}

describe('RightBrainAgentClient continuity (W7-T10, live)', () => {
  testFn(
    'recalls a fact planted in a prior turn when session-id is stable',
    async () => {
      const chatId = `w7-t10-continuity-${Date.now()}`
      const sessionId = deriveRightBrainSessionId(chatId)
      const client = new RightBrainAgentClient({ sessionId, execFile: scrubbedExec })

      const system =
        'You are the right hemisphere of a dual-brain system. Answer concisely.'

      const plant = await client.call({
        system,
        user: 'Please remember this for later: my favorite object is a purple elephant. Acknowledge briefly.',
        timeoutMs: 120_000,
      })
      expect(plant.content.length).toBeGreaterThan(0)

      const recall = await client.call({
        system,
        user: 'What was my favorite object?',
        timeoutMs: 120_000,
      })
      expect(recall.content.toLowerCase()).toContain('purple elephant')
    },
    240_000,
  )
})
