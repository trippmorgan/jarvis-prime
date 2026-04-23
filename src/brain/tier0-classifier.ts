/**
 * Tier-0 embedding-based intent classifier (Wave 8.7).
 *
 * Loads `Xenova/all-MiniLM-L6-v2` once via `@xenova/transformers`, encodes the
 * fixed seed corpus on first call, then classifies each new utterance by the
 * highest cosine similarity in any route bucket.
 *
 * Behavioural contract:
 *   - Pure I/O is local — model file is fetched once from Hugging Face on first
 *     call and cached under .data/xenova-cache. Subsequent runs are offline.
 *   - Never throws into the processor. On model load failure, classify() resolves
 *     to `{ route: null, ... }` and the caller falls through to existing logic.
 *   - L2-normalised embeddings → cosine = dot product. ~5–10ms per query after
 *     warm-up; ~2–3s one-time model load.
 */
import type { Tier0Route } from "./tier0-seeds.js"
import { TIER0_SEEDS_FLAT } from "./tier0-seeds.js"

export interface Tier0Logger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/** Result of one classification call. `route: null` means no bucket cleared the threshold. */
export interface Tier0Result {
  /** Winning route, or null when the top cosine fell below `threshold`. */
  route: Tier0Route | null
  /** Cosine to the nearest seed in the winning bucket. 0 when route is null and no embedding succeeded. */
  confidence: number
  /** Wall-clock duration of the classify() call in ms (encode + scoring). */
  latencyMs: number
  /** Top-1 cosine across ALL buckets — useful for telemetry even when below threshold. */
  topCosine: number
  /** Bucket of the top-1 cosine — even when below threshold (for logging only). */
  topRoute: Tier0Route | null
  /** Optional human-readable reason — populated on degraded paths. */
  reason?: string
}

/** Minimal slice of the @xenova/transformers feature-extraction pipeline output. */
interface FeatureExtractor {
  (input: string, opts: { pooling: "mean"; normalize: boolean }): Promise<{
    data: Float32Array | number[]
  }>
}

/** Adjustable knobs. */
export interface Tier0Config {
  /** Cosine threshold; below this, route resolves to null. Default 0.65. */
  threshold?: number
  /** Where to cache the ONNX model + tokenizer. Default `.data/xenova-cache`. */
  cacheDir?: string
  /** Optional structured logger. */
  logger?: Tier0Logger
  /** Override seed corpus (tests). */
  seeds?: readonly { route: Tier0Route; text: string }[]
  /**
   * Inject a custom encoder (tests). When absent, real
   * `@xenova/transformers` is loaded lazily on first classify().
   */
  encoderFactory?: () => Promise<FeatureExtractor>
}

// W8.7.1 — dropped from 0.65 → 0.50 after live observation that real chitchat
// ("good morning jarvis" cosine 0.595) was falling through to the 190-second
// dual-brain pipeline. Lower threshold catches more of the common case at the
// cost of occasional misroutes (which are forgiven — single-brain handles them
// fine, just without the deep deliberation).
const DEFAULT_THRESHOLD = 0.5
const DEFAULT_CACHE_DIR = "/home/tripp/.openclaw/workspace/jarvis-prime/.data/xenova-cache"
const MODEL_ID = "Xenova/all-MiniLM-L6-v2"

export class Tier0Classifier {
  private readonly threshold: number
  private readonly cacheDir: string
  private readonly logger?: Tier0Logger
  private readonly seeds: readonly { route: Tier0Route; text: string }[]
  private readonly encoderFactory: () => Promise<FeatureExtractor>

  /** Lazy-loaded — populated on first classify() call. */
  private encoder: FeatureExtractor | null = null
  private seedVectors: Float32Array[] | null = null
  private initPromise: Promise<void> | null = null
  /** Sticky failure flag — once init has failed once, future calls short-circuit. */
  private initFailed = false

  constructor(config: Tier0Config = {}) {
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD
    this.cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR
    this.logger = config.logger
    this.seeds = config.seeds ?? TIER0_SEEDS_FLAT
    this.encoderFactory = config.encoderFactory ?? defaultEncoderFactory(this.cacheDir)
  }

  /**
   * Classify one utterance. Never throws — on any failure returns
   * `{ route: null, reason }` so callers can safely fall through.
   */
  async classify(text: string): Promise<Tier0Result> {
    const start = Date.now()

    if (this.initFailed) {
      return {
        route: null,
        confidence: 0,
        latencyMs: Date.now() - start,
        topCosine: 0,
        topRoute: null,
        reason: "init_failed",
      }
    }

    try {
      await this.ensureReady()
    } catch (err) {
      this.initFailed = true
      this.logger?.warn(
        {
          event: "tier0_init_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "tier0 init failed — falling through to existing routing",
      )
      return {
        route: null,
        confidence: 0,
        latencyMs: Date.now() - start,
        topCosine: 0,
        topRoute: null,
        reason: "init_failed",
      }
    }

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return {
        route: null,
        confidence: 0,
        latencyMs: Date.now() - start,
        topCosine: 0,
        topRoute: null,
        reason: "empty_input",
      }
    }

    let queryVec: Float32Array
    try {
      const out = await this.encoder!(trimmed, { pooling: "mean", normalize: true })
      queryVec = toFloat32(out.data)
    } catch (err) {
      this.logger?.warn(
        {
          event: "tier0_encode_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "tier0 encode failed — falling through",
      )
      return {
        route: null,
        confidence: 0,
        latencyMs: Date.now() - start,
        topCosine: 0,
        topRoute: null,
        reason: "encode_failed",
      }
    }

    // Score all seeds; track best per route AND best overall.
    const bestByRoute: Partial<Record<Tier0Route, number>> = {}
    let topCosine = -Infinity
    let topRoute: Tier0Route | null = null
    const seedVectors = this.seedVectors!
    for (let i = 0; i < this.seeds.length; i++) {
      const cos = dot(queryVec, seedVectors[i])
      const route = this.seeds[i].route
      const prev = bestByRoute[route]
      if (prev === undefined || cos > prev) bestByRoute[route] = cos
      if (cos > topCosine) {
        topCosine = cos
        topRoute = route
      }
    }

    const winner: Tier0Route | null =
      topRoute !== null && topCosine >= this.threshold ? topRoute : null

    return {
      route: winner,
      confidence: winner !== null ? topCosine : 0,
      latencyMs: Date.now() - start,
      topCosine: topCosine === -Infinity ? 0 : topCosine,
      topRoute,
      reason: winner === null ? "below_threshold" : undefined,
    }
  }

  /** True once the encoder + seed vectors are loaded. Useful for tests. */
  isReady(): boolean {
    return this.encoder !== null && this.seedVectors !== null
  }

  /** Drives lazy init — coalesces concurrent callers. */
  private ensureReady(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    const t0 = Date.now()
    this.logger?.info({ event: "tier0_init_start", model: MODEL_ID }, "tier0 init start")
    const enc = await this.encoderFactory()
    this.encoder = enc
    const vectors: Float32Array[] = new Array(this.seeds.length)
    for (let i = 0; i < this.seeds.length; i++) {
      const out = await enc(this.seeds[i].text, { pooling: "mean", normalize: true })
      vectors[i] = toFloat32(out.data)
    }
    this.seedVectors = vectors
    this.logger?.info(
      {
        event: "tier0_init_ok",
        seedCount: this.seeds.length,
        durationMs: Date.now() - t0,
      },
      "tier0 init ok",
    )
  }
}

function defaultEncoderFactory(cacheDir: string): () => Promise<FeatureExtractor> {
  return async () => {
    // Dynamic import keeps @xenova/transformers (and its onnxruntime payload)
    // off the hot path until JARVIS_TIER0_ENABLED actually fires.
    const mod = await import("@xenova/transformers")
    mod.env.cacheDir = cacheDir
    mod.env.allowLocalModels = false
    const pipe = await mod.pipeline("feature-extraction", MODEL_ID)
    return pipe as unknown as FeatureExtractor
  }
}

/** Dot product on two same-length, L2-normalised vectors → cosine similarity. */
function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function toFloat32(data: Float32Array | number[]): Float32Array {
  return data instanceof Float32Array ? data : Float32Array.from(data)
}
