import type { HemisphereClient } from './types.js'
import {
  RightBrainTransportError,
  RightBrainModelError,
} from './right-brain-agent.js'

/**
 * W7-T8 — wraps the primary (agent) right-hemisphere client with a one-shot
 * fallback to the legacy chat-completions client.
 *
 * Behavior:
 *   - Primary throws RightBrainTransportError → log fallback event, call
 *     backup exactly once, return backup's result.
 *   - Primary throws RightBrainModelError → propagate; do NOT fall back.
 *     (The upstream bug is the model, not the transport — retrying on a
 *     different client would mask the real defect.)
 *   - Primary throws anything else → propagate (orchestrator already knows
 *     how to surface generic RightHemisphereError via existing Wave-5 path).
 *   - Primary returns successfully → propagate; backup never called.
 *
 * Only transport failures trigger fallback because ModelError means the
 * agent's workspace/prompt caused the issue — swapping to chat-completions
 * wouldn't fix it and would hide the defect.
 */
export interface FallbackRightClientLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface FallbackRightClientConfig {
  primary: HemisphereClient
  backup: HemisphereClient
  logger?: FallbackRightClientLogger
}

export class FallbackRightClient implements HemisphereClient {
  private readonly primary: HemisphereClient
  private readonly backup: HemisphereClient
  private readonly log?: FallbackRightClientLogger

  constructor(config: FallbackRightClientConfig) {
    this.primary = config.primary
    this.backup = config.backup
    this.log = config.logger
  }

  async call(input: {
    system: string
    user: string
    timeoutMs: number
  }): Promise<{ content: string; durationMs: number }> {
    try {
      return await this.primary.call(input)
    } catch (err) {
      if (err instanceof RightBrainTransportError) {
        this.log?.warn(
          {
            event: 'right_brain_agent_fallback',
            reason: err.message,
          },
          'right-brain agent transport error — falling back to chat-completions',
        )
        return this.backup.call(input)
      }
      if (err instanceof RightBrainModelError) {
        this.log?.error(
          {
            event: 'right_brain_agent_model_error_no_fallback',
            reason: err.message,
          },
          'right-brain agent model error — not falling back',
        )
      }
      throw err
    }
  }
}
