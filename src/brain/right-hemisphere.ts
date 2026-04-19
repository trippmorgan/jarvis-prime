import type { HemisphereClient } from "./types.js"
import { RightHemisphereError } from "./types.js"

/**
 * Lightweight logger interface — structurally compatible with Fastify's pino
 * logger, but narrowed so tests can pass plain objects without needing the
 * full FastifyBaseLogger surface.
 */
export interface RightHemisphereLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface RightHemisphereConfig {
  /** Base URL of the OpenClaw gateway (no trailing slash and no path). */
  gatewayUrl: string
  /** Bearer token for Authorization header. */
  gatewayToken: string
  /** Model string to pass as `model` in the request body. */
  model: string
  /** Optional structured logger. */
  logger?: RightHemisphereLogger
}

/** Shape of the OpenAI-compatible chat completion response we actually consume. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string
      content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const MAX_ERROR_BODY = 500

/**
 * Right hemisphere client — calls GPT via the OpenClaw gateway's
 * OpenAI-compatible /v1/chat/completions endpoint. Never logs the user or
 * system content nor the response content (potential PHI-adjacent info).
 */
export class RightHemisphereClient implements HemisphereClient {
  private readonly gatewayUrl: string
  private readonly gatewayToken: string
  private readonly model: string
  private readonly log?: RightHemisphereLogger

  constructor(config: RightHemisphereConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, "")
    this.gatewayToken = config.gatewayToken
    this.model = config.model
    this.log = config.logger
  }

  async call(input: {
    system: string
    user: string
    timeoutMs: number
  }): Promise<{ content: string; durationMs: number }> {
    const { system, user, timeoutMs } = input
    const url = `${this.gatewayUrl}/v1/chat/completions`

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    const start = Date.now()
    this.log?.info(
      { event: "right_hemisphere_call_start", model: this.model, timeoutMs },
      "right hemisphere call starting",
    )

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.gatewayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutHandle)
      const durationMs = Date.now() - start
      if (isAbortError(err)) {
        this.log?.warn(
          { event: "right_hemisphere_timeout", durationMs, timeoutMs },
          "right hemisphere timed out",
        )
        throw new RightHemisphereError(
          `right hemisphere timed out after ${timeoutMs}ms`,
          err,
        )
      }
      const message = err instanceof Error ? err.message : String(err)
      this.log?.error(
        { event: "right_hemisphere_network_error", durationMs, errorMessage: message },
        "right hemisphere network error",
      )
      throw new RightHemisphereError(
        `right hemisphere network error: ${message}`,
        err,
      )
    }

    clearTimeout(timeoutHandle)
    const durationMs = Date.now() - start

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "")
      const truncated =
        rawBody.length > MAX_ERROR_BODY
          ? `${rawBody.slice(0, MAX_ERROR_BODY)}…[truncated]`
          : rawBody
      this.log?.error(
        {
          event: "right_hemisphere_http_error",
          durationMs,
          status: response.status,
        },
        "right hemisphere returned non-2xx",
      )
      throw new RightHemisphereError(
        `right hemisphere returned HTTP ${response.status}: ${truncated}`,
      )
    }

    let parsed: ChatCompletionResponse
    try {
      parsed = (await response.json()) as ChatCompletionResponse
    } catch (err) {
      this.log?.error(
        { event: "right_hemisphere_parse_error", durationMs },
        "right hemisphere response was not valid JSON",
      )
      throw new RightHemisphereError("malformed response: invalid JSON", err)
    }

    const content = parsed?.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      this.log?.error(
        { event: "right_hemisphere_malformed", durationMs },
        "right hemisphere response missing choices[0].message.content",
      )
      throw new RightHemisphereError("malformed response: missing choices[0].message.content")
    }

    this.log?.info(
      {
        event: "right_hemisphere_call_ok",
        durationMs,
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
        totalTokens: parsed.usage?.total_tokens,
      },
      "right hemisphere call ok",
    )

    return { content, durationMs }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  return name === "AbortError"
}
