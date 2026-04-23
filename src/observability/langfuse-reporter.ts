/**
 * Wave 8.8 — Langfuse trace reporter wrapper.
 *
 * The processor speaks to a `Reporter` interface, never to the Langfuse SDK
 * directly. This keeps the hot path un-coupled from the observability vendor:
 * when `LANGFUSE_ENABLED=false` (default), a `NoopReporter` satisfies the
 * interface with zero overhead and zero network I/O.
 *
 * W8.8.3 extended the surface with per-trace `startSpan` / `startGeneration`
 * primitives so the processor can attach per-phase spans (tier-0 classify,
 * pass-1, pass-2, integration) and per-hemisphere generations (model,
 * latency, prompt/output with clinical redaction). Spans/generations may be
 * created retroactively with explicit `startTime` / `endTime` because the
 * orchestrator emits per-pass `_ok` events with durations rather than
 * brackets — the processor reconstructs the start as `endTime - durationMs`
 * to keep the orchestrator surface PHI-free.
 *
 * PHI policy — clinical-override inputs/outputs are replaced with the
 * constant `CLINICAL_REDACTED_MARKER`. Metadata (durations, path, routes,
 * model names) is always captured. See PHI-SECURITY-EDICT.md.
 */
import type { FastifyBaseLogger } from "fastify"
// Langfuse SDK is imported dynamically inside `makeReporter` so the
// `langfuse` package never loads when the feature is disabled, keeping the
// no-op path free of ESM + network-client initialisation.

export const CLINICAL_REDACTED_MARKER = "[clinical_redacted]"

/** Severity tag passed to Langfuse for span/generation outcomes. */
export type ObservationLevel = "DEFAULT" | "DEBUG" | "WARNING" | "ERROR"

/** Token-usage shape for `GenerationHandle.end`. Mirrors Langfuse's `Usage`. */
export interface UsageInfo {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface SpanStartInput {
  name: string
  input?: unknown
  metadata?: Record<string, unknown>
  /** ISO date string or Date — for retroactive spans created on `_ok` events. */
  startTime?: Date
}

export interface SpanEndInput {
  output?: unknown
  metadata?: Record<string, unknown>
  level?: ObservationLevel
  statusMessage?: string
  endTime?: Date
}

export interface SpanHandle {
  update(updates: { metadata?: Record<string, unknown>; output?: unknown }): void
  end(input?: SpanEndInput): void
}

export interface GenerationStartInput {
  name: string
  model?: string
  modelParameters?: Record<string, unknown>
  input?: unknown
  metadata?: Record<string, unknown>
  startTime?: Date
  /** ISO date marking when the first token streamed back; usually omitted. */
  completionStartTime?: Date
}

export interface GenerationEndInput {
  output?: unknown
  metadata?: Record<string, unknown>
  usage?: UsageInfo
  level?: ObservationLevel
  statusMessage?: string
  endTime?: Date
}

export interface GenerationHandle {
  update(updates: {
    metadata?: Record<string, unknown>
    output?: unknown
    usage?: UsageInfo
  }): void
  end(input?: GenerationEndInput): void
}

/** Handle returned by `Reporter.startTrace`; every call MUST end with `.end()`. */
export interface TraceHandle {
  /** Merge metadata/tags/output into the root trace. Safe to call multiple times. */
  update(updates: {
    output?: string | Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  }): void
  /** Open a child span (a phase, e.g. `tier0_classify`, `dual_brain`). */
  startSpan(input: SpanStartInput): SpanHandle
  /** Open a child generation (one LLM call, e.g. `pass1_left`). */
  startGeneration(input: GenerationStartInput): GenerationHandle
  /**
   * Finalise the trace. With the Langfuse SDK this just queues a flush —
   * the client batches sends. Safe to call more than once (subsequent calls
   * no-op).
   */
  end(): void
}

export interface Reporter {
  startTrace(input: {
    name: string
    sessionId: string
    userId?: string
    input?: string | Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  }): TraceHandle
  /** Drain in-flight traces; call on graceful shutdown. */
  shutdown(): Promise<void>
}

/** No-op handles — returned by NoopReporter and as fallbacks on SDK errors. */
const NOOP_SPAN: SpanHandle = {
  update: () => {},
  end: () => {},
}
const NOOP_GENERATION: GenerationHandle = {
  update: () => {},
  end: () => {},
}
const NOOP_TRACE: TraceHandle = {
  update: () => {},
  startSpan: () => NOOP_SPAN,
  startGeneration: () => NOOP_GENERATION,
  end: () => {},
}

export class NoopReporter implements Reporter {
  startTrace(): TraceHandle {
    return NOOP_TRACE
  }
  async shutdown(): Promise<void> {}
}

export interface MakeReporterOptions {
  enabled: boolean
  host?: string
  publicKey?: string
  secretKey?: string
  flushAt?: number
  flushIntervalMs?: number
  logger?: FastifyBaseLogger
}

/**
 * Construct the appropriate reporter for the current config. Returns a
 * `NoopReporter` whenever the feature is disabled, the required credentials
 * are missing, or the SDK fails to load — the bridge never blocks on
 * observability.
 */
export async function makeReporter(
  opts: MakeReporterOptions,
): Promise<Reporter> {
  const { enabled, host, publicKey, secretKey, flushAt, flushIntervalMs, logger } = opts
  if (!enabled || !host || !publicKey || !secretKey) {
    logger?.info(
      {
        event: "langfuse_disabled",
        enabled,
        hasHost: Boolean(host),
        hasPublicKey: Boolean(publicKey),
        hasSecretKey: Boolean(secretKey),
      },
      "langfuse reporter disabled (noop)",
    )
    return new NoopReporter()
  }
  try {
    const { Langfuse } = await import("langfuse")
    const client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: host,
      flushAt: flushAt ?? 10,
      flushInterval: flushIntervalMs ?? 5_000,
    })
    logger?.info(
      {
        event: "langfuse_enabled",
        host,
        flushAt: flushAt ?? 10,
        flushIntervalMs: flushIntervalMs ?? 5_000,
      },
      "langfuse reporter enabled",
    )
    return new LangfuseReporter(client, logger)
  } catch (err) {
    logger?.warn(
      {
        event: "langfuse_load_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "langfuse SDK failed to load — falling back to noop reporter",
    )
    return new NoopReporter()
  }
}

/**
 * Minimal surface of the Langfuse SDK we consume. Typed locally so the rest
 * of the module typechecks without `langfuse` in the dep graph during tests.
 */
interface LangfuseClientLike {
  trace(input: {
    name: string
    sessionId?: string
    userId?: string
    input?: unknown
    metadata?: Record<string, unknown>
    tags?: string[]
  }): LangfuseTraceLike
  shutdownAsync(): Promise<void>
}
interface LangfuseObservationLike {
  update(updates: Record<string, unknown>): void
  /**
   * Note: SDK's `end(body)` always overrides `endTime` to `new Date()` after
   * spreading the body, which clobbers explicit `endTime` values. The wrapper
   * routes `end()` calls through `update()` with `endTime` set so retroactive
   * spans/generations honour our supplied timestamps.
   */
  end(updates?: Record<string, unknown>): void
}
interface LangfuseTraceLike {
  update(updates: {
    output?: unknown
    metadata?: Record<string, unknown>
    tags?: string[]
  }): void
  span(input: Record<string, unknown>): LangfuseObservationLike
  generation(input: Record<string, unknown>): LangfuseObservationLike
}

class LangfuseReporter implements Reporter {
  private ended = new WeakSet<LangfuseTraceLike>()

  constructor(
    private readonly client: LangfuseClientLike,
    private readonly logger?: FastifyBaseLogger,
  ) {}

  startTrace(input: {
    name: string
    sessionId: string
    userId?: string
    input?: string | Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  }): TraceHandle {
    let trace: LangfuseTraceLike
    try {
      trace = this.client.trace({
        name: input.name,
        sessionId: input.sessionId,
        userId: input.userId,
        input: input.input,
        metadata: input.metadata,
        tags: input.tags,
      })
    } catch (err) {
      this.logger?.warn(
        {
          event: "langfuse_trace_start_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "langfuse trace start failed — returning noop handle",
      )
      return NOOP_TRACE
    }

    const wrapObservation = (
      kind: "span" | "generation",
      obs: LangfuseObservationLike,
    ): SpanHandle & GenerationHandle => {
      let closed = false
      return {
        update: (updates) => {
          if (closed) return
          try {
            obs.update(updates)
          } catch (err) {
            this.logger?.warn(
              {
                event: `langfuse_${kind}_update_failed`,
                error: err instanceof Error ? err.message : String(err),
              },
              `langfuse ${kind} update failed — ignoring`,
            )
          }
        },
        end: (endInput) => {
          if (closed) return
          closed = true
          try {
            // Route through update() so callers can supply a specific endTime
            // (retroactive spans/generations). The SDK's `end()` always sets
            // `endTime: new Date()` last, which clobbers our value. Default
            // to now when the caller didn't specify, mirroring `end()`'s
            // behaviour for the common live-bracket case.
            const body: Record<string, unknown> = {
              ...(endInput as Record<string, unknown> | undefined),
            }
            if (body.endTime === undefined) body.endTime = new Date()
            obs.update(body)
          } catch (err) {
            this.logger?.warn(
              {
                event: `langfuse_${kind}_end_failed`,
                error: err instanceof Error ? err.message : String(err),
              },
              `langfuse ${kind} end failed — ignoring`,
            )
          }
        },
      }
    }

    return {
      update: (updates) => {
        if (this.ended.has(trace)) return
        try {
          trace.update(updates)
        } catch (err) {
          this.logger?.warn(
            {
              event: "langfuse_trace_update_failed",
              error: err instanceof Error ? err.message : String(err),
            },
            "langfuse trace update failed — ignoring",
          )
        }
      },
      startSpan: (spanInput) => {
        try {
          const obs = trace.span(spanInput as unknown as Record<string, unknown>)
          return wrapObservation("span", obs)
        } catch (err) {
          this.logger?.warn(
            {
              event: "langfuse_span_start_failed",
              error: err instanceof Error ? err.message : String(err),
            },
            "langfuse span start failed — returning noop",
          )
          return NOOP_SPAN
        }
      },
      startGeneration: (genInput) => {
        try {
          const obs = trace.generation(
            genInput as unknown as Record<string, unknown>,
          )
          return wrapObservation("generation", obs)
        } catch (err) {
          this.logger?.warn(
            {
              event: "langfuse_generation_start_failed",
              error: err instanceof Error ? err.message : String(err),
            },
            "langfuse generation start failed — returning noop",
          )
          return NOOP_GENERATION
        }
      },
      end: () => {
        this.ended.add(trace)
        // Langfuse client batches flushes — no explicit end call needed.
      },
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.shutdownAsync()
    } catch (err) {
      this.logger?.warn(
        {
          event: "langfuse_shutdown_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "langfuse shutdown failed — ignoring",
      )
    }
  }
}
