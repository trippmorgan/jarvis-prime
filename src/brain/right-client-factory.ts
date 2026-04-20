import type { HemisphereClient } from './types.js'
import { RightHemisphereClient } from './right-hemisphere.js'
import { RightBrainAgentClient } from './right-brain-agent.js'
import { deriveRightBrainSessionId } from './sessionId.js'

/**
 * W7-T7 — selects which right-hemisphere client to use for a given turn.
 *
 * When `rightBrainAgentEnabled` is false, returns the existing
 * RightHemisphereClient (chat-completions via gateway) — the Wave 5/6
 * path, byte-for-byte unchanged.
 *
 * When true, returns a RightBrainAgentClient scoped to a deterministic
 * per-chat session id (derived from chatId) so the OpenClaw agent
 * accrues memory across that chat's turns.
 *
 * The fallback wrapper (W7-T8) wraps the result of this factory.
 */
export interface RightClientFactoryInput {
  rightBrainAgentEnabled: boolean
  chatId: string
  /** Gateway URL for the legacy chat-completions client. */
  gatewayUrl: string
  gatewayToken: string
  rightModel: string
  /** Optional logger propagated to whichever client is chosen. */
  logger?: {
    info: (obj: unknown, msg?: string) => void
    warn: (obj: unknown, msg?: string) => void
    error: (obj: unknown, msg?: string) => void
  }
}

export function makeRightClient(input: RightClientFactoryInput): HemisphereClient {
  if (input.rightBrainAgentEnabled) {
    return new RightBrainAgentClient({
      sessionId: deriveRightBrainSessionId(input.chatId),
      logger: input.logger,
    })
  }
  return new RightHemisphereClient({
    gatewayUrl: input.gatewayUrl,
    gatewayToken: input.gatewayToken,
    model: input.rightModel,
    logger: input.logger,
  })
}
