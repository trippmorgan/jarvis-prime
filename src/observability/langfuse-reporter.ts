/**
 * Wave 8.8 — Langfuse trace reporter wrapper.
 *
 * The processor speaks to a `Reporter` interface, never to the Langfuse SDK
 * directly. This keeps the hot path un-coupled from the observability vendor:
 * when `LANGFUSE_ENABLED=false` (default), a `NoopReporter` satisfies the
 * interface with zero overhead and zero network I/O.
 *
 * Scope for this wave is minimal — one root trace per inbound Telegram turn.
 * Per-hemisphere generations and per-phase spans land in a follow-up
 * (W8.8.3+); the trace already captures path, outcome, tier-0 metadata, and
 * final text, which is enough for the A/B latency measurement Wave 8.9 needs.
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

/** Handle returned by `Reporter.startTrace`; every call MUST end with `.end()`. */
export interface TraceHandle {
  /** Merge metadata/tags/output into the root trace. Safe to call multiple times. */
  update(updates: {
    output?: string | Record<string, unknown>
    metadata?: Record<string, unknown>
    tags?: string[]
  }): void
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

export class NoopReporter implements Reporter {
  startTrace(): TraceHandle {
    return {
      update: () => {},
      end: () => {},
    }
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
 * Minimal surface of the Langfuse SDK client we consume. Typed here rather
 * than imported so the rest of the module can typecheck without the
 * `langfuse` package in the dependency graph during testing.
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
interface LangfuseTraceLike {
  update(updates: {
    output?: unknown
    metadata?: Record<string, unknown>
    tags?: string[]
  }): void
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
      return new NoopReporter().startTrace()
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
