import type { HemisphereClient } from './types.js'
import { RightHemisphereClient } from './right-hemisphere.js'
import { RightBrainAgentClient } from './right-brain-agent.js'
import { FallbackRightClient } from './fallback-right-client.js'
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
  /**
   * W7-T8 — when true, transport failures from the agent client are
   * retried once via the legacy chat-completions client (wrapped by
   * FallbackRightClient). Only consulted when the agent path is enabled.
   */
  rightBrainAgentFallback?: boolean
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
  const legacy = new RightHemisphereClient({
    gatewayUrl: input.gatewayUrl,
    gatewayToken: input.gatewayToken,
    model: input.rightModel,
    logger: input.logger,
  })
  if (!input.rightBrainAgentEnabled) {
    return legacy
  }
  const agent = new RightBrainAgentClient({
    sessionId: deriveRightBrainSessionId(input.chatId),
    logger: input.logger,
  })
  if (input.rightBrainAgentFallback === false) {
    return agent
  }
  return new FallbackRightClient({
    primary: agent,
    backup: legacy,
    logger: input.logger,
  })
}
