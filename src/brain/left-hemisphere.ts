import { spawnClaude } from "../claude/spawner.js";
import { spawnClaudeStream } from "../claude/spawner-stream.js";
import { spawnOpenclawAgent } from "../openclaw/spawner.js";
import { spawnOpenclawAgentStream } from "../openclaw/spawner-stream.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import type { StreamEvent } from "../claude/stream-formatter.js";
import { LeftHemisphereError, type HemisphereClient } from "./types.js";
import type { LeftRuntime } from "../bridge/mode-state.js";

export type Spawner = (prompt: string, opts: SpawnOptions) => Promise<SpawnResult>;
/** W8.8.6 — streaming variant. Optional; left.call routes here when caller supplies onStreamEvent. */
export type StreamSpawner = (
  prompt: string,
  opts: SpawnOptions & { onEvent?: (event: StreamEvent) => void },
) => Promise<SpawnResult>;

export interface LeftHemisphereLogger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

export interface LeftHemisphereConfig {
  claudePath: string;
  model: string;
  /** Bridge working directory — passed as cwd to every left-brain spawn. */
  workingDir: string;
  logger?: LeftHemisphereLogger;
  /**
   * Per-call resolver for which left runtime to use ('openclaw' | 'claude').
   * Defaults to a constant 'openclaw' resolver — local GLM with full tools
   * via the native openclaw spawner. Wired through the processor so
   * /deep claude / /deep openclaw flip mid-session without rebuilding
   * the client.
   */
  runtimeResolver?: () => LeftRuntime;
  /** Injectable for testing. Overrides the runtime-aware spawner. */
  spawner?: Spawner;
  /** Injectable streaming variant for testing. Overrides the runtime-aware streamer. */
  streamSpawner?: StreamSpawner;
  /**
   * W3-T8 — Claude CLI model names tried in order when the native GLM left
   * (runtime 'openclaw') fails: thrown spawn, timeout, non-zero exit, or
   * empty output. Default ["fable", "sonnet"]. The manual 'claude' runtime
   * never chains — it is the explicit operator choice.
   */
  fallbackModels?: string[];
}

const STDERR_TRUNCATE = 500;
const DEFAULT_FALLBACK_MODELS = ["fable", "sonnet"];

/**
 * Wraps the existing spawnClaude() CLI path behind the HemisphereClient
 * interface so the corpus callosum can call Claude (left) and GPT (right)
 * symmetrically. If prompt-caching needs force a swap to @anthropic-ai/sdk
 * later, the change is entirely internal to this file.
 */
export class LeftHemisphereClient implements HemisphereClient {
  private readonly claudePath: string;
  private readonly model: string;
  private readonly workingDir: string;
  private readonly logger?: LeftHemisphereLogger;
  private readonly runtimeResolver: () => LeftRuntime;
  private readonly spawnerOverride?: Spawner;
  private readonly streamSpawnerOverride?: StreamSpawner;
  private readonly fallbackModels: string[];

  constructor(config: LeftHemisphereConfig) {
    this.claudePath = config.claudePath;
    this.model = config.model;
    this.workingDir = config.workingDir;
    this.logger = config.logger;
    this.runtimeResolver = config.runtimeResolver ?? (() => "openclaw");
    if (config.spawner) this.spawnerOverride = config.spawner;
    if (config.streamSpawner) this.streamSpawnerOverride = config.streamSpawner;
    this.fallbackModels = config.fallbackModels ?? DEFAULT_FALLBACK_MODELS;
  }

  /**
   * Pick the spawner pair for the current runtime. Test overrides win — they
   * substitute for whichever runtime is selected, so corpus-callosum tests
   * don't need to know about the runtime split.
   *
   * `runtime` is null when both overrides bypass the resolver entirely —
   * the fallback chain (openclaw-only) is skipped in that case, preserving
   * pre-W3-T8 behavior for fully-injected test clients.
   */
  private resolveSpawners(): {
    spawner: Spawner;
    streamSpawner: StreamSpawner;
    runtime: LeftRuntime | null;
  } {
    if (this.spawnerOverride && this.streamSpawnerOverride) {
      return {
        spawner: this.spawnerOverride,
        streamSpawner: this.streamSpawnerOverride,
        runtime: null,
      };
    }
    const runtime = this.runtimeResolver();
    if (runtime === "openclaw") {
      return {
        spawner: this.spawnerOverride ?? (spawnOpenclawAgent as Spawner),
        streamSpawner: this.streamSpawnerOverride ?? (spawnOpenclawAgentStream as StreamSpawner),
        runtime,
      };
    }
    return {
      spawner: this.spawnerOverride ?? spawnClaude,
      streamSpawner: this.streamSpawnerOverride ?? spawnClaudeStream,
      runtime,
    };
  }

  async call(input: {
    system: string;
    user: string;
    timeoutMs: number;
    enableTools?: boolean;
    /** W8.8.6 — when present, routes through streaming spawner so the caller can pipe tool-use / thinking events to UX. */
    onStreamEvent?: (event: StreamEvent) => void;
  }): Promise<{ content: string; durationMs: number }> {
    const { system, user, timeoutMs, enableTools, onStreamEvent } = input;
    const prompt = `${system}\n\n${user}`;
    const start = Date.now();

    const { spawner, streamSpawner, runtime } = this.resolveSpawners();

    // Log the EFFECTIVE model for the resolved runtime — `this.model` is the
    // Claude CLI model and reporting it while the native GLM runtime serves
    // the call makes 401/latency triage actively misleading.
    this.logger?.info(
      {
        event: "left_hemisphere_call_start",
        hemisphere: "left",
        runtime: runtime ?? "override",
        model: runtime === "openclaw" ? (process.env.LEFT_MODEL ?? "glm-5.2") : this.model,
        timeoutMs,
        enableTools: enableTools ?? true,
      },
      "left hemisphere call starting",
    );

    // One attempt against a given spawner pair with a given model; every other
    // spawn parameter (claudePath, workingDir, timeoutMs, tools, streaming)
    // is identical between the primary and any fallback attempt.
    const runAttempt = (s: Spawner, ss: StreamSpawner, model: string): Promise<SpawnResult> => {
      const spawnOpts = {
        claudePath: this.claudePath,
        model,
        timeoutMs,
        workingDir: this.workingDir,
        enableTools,
      };
      return onStreamEvent
        ? ss(prompt, { ...spawnOpts, onEvent: onStreamEvent })
        : s(prompt, spawnOpts);
    };

    // W3-T8 — native GLM left (runtime 'openclaw') gets the automatic
    // fallback chain GLM → fallbackModels via the Claude CLI. The manual
    // 'claude' runtime (and fully-overridden test clients) keep the legacy
    // single-attempt semantics below.
    if (runtime === "openclaw") {
      return this.callWithFallbackChain(runAttempt, { spawner, streamSpawner }, start);
    }

    let result: SpawnResult;
    try {
      result = await runAttempt(spawner, streamSpawner, this.model);
    } catch (err) {
      const durationMs = Date.now() - start;
      this.logger?.error(
        {
          event: "left_hemisphere_spawn_error",
          hemisphere: "left",
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        },
        "left hemisphere spawn threw",
      );
      throw new LeftHemisphereError(
        `left hemisphere spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const durationMs = Date.now() - start;

    if (result.timedOut) {
      this.logger?.warn(
        {
          event: "left_hemisphere_timeout",
          hemisphere: "left",
          durationMs,
          timeoutMs,
        },
        "left hemisphere timed out",
      );
      throw new LeftHemisphereError(
        `left hemisphere timed out after ${timeoutMs}ms`,
      );
    }

    if (result.exitCode !== 0) {
      const excerpt = (result.stderr ?? "").slice(0, STDERR_TRUNCATE);
      this.logger?.error(
        {
          event: "left_hemisphere_exit_error",
          hemisphere: "left",
          durationMs,
          exitCode: result.exitCode,
          stderrLength: (result.stderr ?? "").length,
        },
        "left hemisphere exited non-zero",
      );
      throw new LeftHemisphereError(
        `left hemisphere exit code ${result.exitCode}: ${excerpt}`,
      );
    }

    const content = (result.output ?? "").trim();

    this.logger?.info(
      {
        event: "left_hemisphere_call_success",
        hemisphere: "left",
        durationMs,
        outputLength: content.length,
      },
      "left hemisphere call succeeded",
    );

    return { content, durationMs };
  }

  /**
   * W3-T8 — GLM → Claude fallback chain for the native left runtime.
   *
   * Attempt 1 is the resolved openclaw (GLM) pair; each subsequent attempt
   * re-runs the SAME prompt through the Claude CLI pair with the fallback
   * model name. Failure of an attempt = thrown spawn, timedOut, non-zero
   * exit, or empty/whitespace output — a GLM/Ollama-Cloud outage must never
   * be delivered as fake success or die silently. First success wins.
   * Total attempts ≤ 1 + fallbackModels.length; the primary model is never
   * retried. All-fail throws LeftHemisphereError naming the chain, which the
   * orchestrator catch turns into dual_brain_fallback_single as before.
   */
  private async callWithFallbackChain(
    runAttempt: (s: Spawner, ss: StreamSpawner, model: string) => Promise<SpawnResult>,
    primary: { spawner: Spawner; streamSpawner: StreamSpawner },
    start: number,
  ): Promise<{ content: string; durationMs: number }> {
    const fallbackModels = this.fallbackModels
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== this.model);
    const plan = [
      { model: this.model, spawner: primary.spawner, streamSpawner: primary.streamSpawner },
      ...fallbackModels.map((model) => ({
        model,
        // Fallbacks always go through the Claude CLI pair, resolved the same
        // way overrides work so injected test spawners stay in charge.
        spawner: this.spawnerOverride ?? (spawnClaude as Spawner),
        streamSpawner: this.streamSpawnerOverride ?? (spawnClaudeStream as StreamSpawner),
      })),
    ];

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]!;
      let result: SpawnResult | undefined;
      let thrown: string | undefined;
      try {
        result = await runAttempt(step.spawner, step.streamSpawner, step.model);
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }

      const content = (result?.output ?? "").trim();
      const succeeded =
        result !== undefined && !result.timedOut && result.exitCode === 0 && content.length > 0;
      if (succeeded) {
        const durationMs = Date.now() - start;
        if (i > 0) {
          this.logger?.info(
            {
              event: "left_glm_fallback_recovered",
              hemisphere: "left",
              model: step.model,
              attempt: i + 1,
              durationMs,
            },
            "left hemisphere recovered via fallback model",
          );
        }
        this.logger?.info(
          {
            event: "left_hemisphere_call_success",
            hemisphere: "left",
            durationMs,
            outputLength: content.length,
          },
          "left hemisphere call succeeded",
        );
        return { content, durationMs };
      }

      this.logger?.warn(
        {
          event: "left_glm_fallback",
          hemisphere: "left",
          attempt: i + 1,
          model: step.model,
          exitCode: result?.exitCode ?? null,
          timedOut: result?.timedOut ?? false,
          stderr: (thrown ?? result?.stderr ?? "").slice(0, STDERR_TRUNCATE),
          remainingFallbacks: plan.length - i - 1,
        },
        "left hemisphere attempt failed — trying fallback chain",
      );
    }

    const durationMs = Date.now() - start;
    this.logger?.error(
      {
        event: "left_glm_fallback_exhausted",
        hemisphere: "left",
        durationMs,
        models: plan.map((p) => p.model),
      },
      "left hemisphere fallback chain exhausted",
    );
    throw new LeftHemisphereError(
      fallbackModels.length > 0
        ? `left hemisphere failed: ${this.model} + fallbacks ${fallbackModels.join(", ")} all failed`
        : `left hemisphere failed: ${this.model} failed and no fallback models are configured`,
    );
  }
}
