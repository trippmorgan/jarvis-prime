import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import type { HemisphereClient } from "./types.js"
import { RightHemisphereError } from "./types.js"

/**
 * TransportError — the openclaw CLI never reached the gateway cleanly
 * (exec failure, timeout, malformed JSON response, gateway-agent call
 * fell back to embedded local execution). Caller may retry via fallback
 * client per RIGHT_BRAIN_AGENT_FALLBACK.
 */
export class RightBrainTransportError extends RightHemisphereError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = "RightBrainTransportError"
  }
}

/**
 * ModelError — the CLI and gateway worked end-to-end but the agent
 * returned a non-ok status or an unusable payload. Caller should NOT
 * retry; the issue is upstream of transport.
 */
export class RightBrainModelError extends RightHemisphereError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = "RightBrainModelError"
  }
}

export interface RightBrainAgentLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/** Signature matching Node's promisified execFile for DI in tests. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

export interface RightBrainAgentConfig {
  /** Agent name as registered with `openclaw agents add`. Default: "right-brain". */
  agentName?: string
  /**
   * Deterministic session id (derived from chatId via
   * deriveRightBrainSessionId). One session per chat.
   */
  sessionId: string
  /** Thinking level flag value. Default: "medium". */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high"
  /** Path to the openclaw CLI binary. Default: "openclaw" (PATH lookup). */
  openclawBin?: string
  /** Injected exec for testability. Default: promisified child_process.execFile. */
  execFile?: ExecFileFn
  /** Optional structured logger. */
  logger?: RightBrainAgentLogger
}

/** Shape of `openclaw agent --json` stdout we consume. */
interface AgentJsonResponse {
  status?: string
  runId?: string
  summary?: string
  result?: {
    payloads?: Array<{ text?: string }>
    meta?: {
      durationMs?: number
      agentMeta?: {
        sessionKey?: string
        sessionId?: string
      }
    }
  }
}

const DEFAULT_AGENT = "right-brain"
const DEFAULT_THINKING = "medium"
const DEFAULT_BIN = "openclaw"
const MAX_BUFFER = 10 * 1024 * 1024

/** Signature the CLI prints when its gateway call fails and it silently runs local/embedded. */
const EMBEDDED_FALLBACK_MARKER = "falling back to embedded"

const defaultExec: ExecFileFn = promisify(execFileCb) as unknown as ExecFileFn

/**
 * Right-brain agent client — invokes `openclaw agent` via child_process.execFile
 * against a persistent, per-chat session. Implements the same HemisphereClient
 * interface as RightHemisphereClient so the orchestrator can route to either
 * without changes.
 *
 * Never logs the system/user prompt or the response content (PHI-adjacent).
 */
export class RightBrainAgentClient implements HemisphereClient {
  private readonly agentName: string
  private readonly sessionId: string
  private readonly thinkingLevel: string
  private readonly openclawBin: string
  private readonly exec: ExecFileFn
  private readonly log?: RightBrainAgentLogger

  constructor(config: RightBrainAgentConfig) {
    this.agentName = config.agentName ?? DEFAULT_AGENT
    this.sessionId = config.sessionId
    this.thinkingLevel = config.thinkingLevel ?? DEFAULT_THINKING
    this.openclawBin = config.openclawBin ?? DEFAULT_BIN
    this.exec = config.execFile ?? defaultExec
    this.log = config.logger
  }

  async call(input: {
    system: string
    user: string
    timeoutMs: number
  }): Promise<{ content: string; durationMs: number }> {
    const { system, user, timeoutMs } = input
    const message = `${system}\n\n---\n\n${user}`
    const args = [
      "agent",
      "--agent",
      this.agentName,
      "--session-id",
      this.sessionId,
      "--message",
      message,
      "--json",
      "--thinking",
      this.thinkingLevel,
    ]

    const start = Date.now()
    this.log?.info(
      {
        event: "right_brain_agent_call_start",
        agent: this.agentName,
        sessionId: this.sessionId,
        thinking: this.thinkingLevel,
        timeoutMs,
      },
      "right-brain agent call starting",
    )

    let stdout: string
    let stderr: string
    try {
      const result = await this.exec(this.openclawBin, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      const durationMs = Date.now() - start
      const errMsg = err instanceof Error ? err.message : String(err)
      this.log?.error(
        { event: "right_brain_agent_exec_error", durationMs, errorMessage: errMsg },
        "right-brain agent exec failed",
      )
      throw new RightBrainTransportError(
        `right-brain agent exec failed: ${errMsg}`,
        err,
      )
    }

    if (stderr && stderr.includes(EMBEDDED_FALLBACK_MARKER)) {
      const durationMs = Date.now() - start
      this.log?.error(
        { event: "right_brain_agent_embedded_fallback", durationMs },
        "right-brain agent silently fell back to embedded; treating as transport failure",
      )
      throw new RightBrainTransportError(
        "right-brain agent gateway call failed and CLI fell back to embedded execution",
      )
    }

    let parsed: AgentJsonResponse
    try {
      parsed = JSON.parse(stdout) as AgentJsonResponse
    } catch (err) {
      const durationMs = Date.now() - start
      this.log?.error(
        { event: "right_brain_agent_parse_error", durationMs },
        "right-brain agent stdout was not valid JSON",
      )
      throw new RightBrainTransportError(
        "right-brain agent response was not valid JSON",
        err,
      )
    }

    if (parsed.status !== "ok") {
      const durationMs = Date.now() - start
      this.log?.error(
        {
          event: "right_brain_agent_model_error",
          durationMs,
          status: parsed.status,
          summary: parsed.summary,
        },
        "right-brain agent returned non-ok status",
      )
      throw new RightBrainModelError(
        `right-brain agent returned status=${parsed.status} summary=${parsed.summary ?? "?"}`,
      )
    }

    const text = parsed.result?.payloads?.[0]?.text
    if (typeof text !== "string" || text.length === 0) {
      const durationMs = Date.now() - start
      this.log?.error(
        { event: "right_brain_agent_malformed", durationMs },
        "right-brain agent response missing result.payloads[0].text",
      )
      throw new RightBrainModelError(
        "right-brain agent response missing result.payloads[0].text",
      )
    }

    const durationMs = Date.now() - start
    this.log?.info(
      {
        event: "right_brain_agent_call_ok",
        agent: this.agentName,
        sessionId: this.sessionId,
        durationMs,
        agentDurationMs: parsed.result?.meta?.durationMs,
      },
      "right-brain agent call ok",
    )

    return { content: text, durationMs }
  }
}
