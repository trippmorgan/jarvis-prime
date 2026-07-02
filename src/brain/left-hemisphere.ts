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
}

const STDERR_TRUNCATE = 500;

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

  constructor(config: LeftHemisphereConfig) {
    this.claudePath = config.claudePath;
    this.model = config.model;
    this.workingDir = config.workingDir;
    this.logger = config.logger;
    this.runtimeResolver = config.runtimeResolver ?? (() => "openclaw");
    if (config.spawner) this.spawnerOverride = config.spawner;
    if (config.streamSpawner) this.streamSpawnerOverride = config.streamSpawner;
  }

  /**
   * Pick the spawner pair for the current runtime. Test overrides win — they
   * substitute for whichever runtime is selected, so corpus-callosum tests
   * don't need to know about the runtime split.
   */
  private resolveSpawners(): { spawner: Spawner; streamSpawner: StreamSpawner } {
    if (this.spawnerOverride && this.streamSpawnerOverride) {
      return { spawner: this.spawnerOverride, streamSpawner: this.streamSpawnerOverride };
    }
    const runtime = this.runtimeResolver();
    if (runtime === "openclaw") {
      return {
        spawner: this.spawnerOverride ?? (spawnOpenclawAgent as Spawner),
        streamSpawner: this.streamSpawnerOverride ?? (spawnOpenclawAgentStream as StreamSpawner),
      };
    }
    return {
      spawner: this.spawnerOverride ?? spawnClaude,
      streamSpawner: this.streamSpawnerOverride ?? spawnClaudeStream,
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

    this.logger?.info(
      {
        event: "left_hemisphere_call_start",
        hemisphere: "left",
        model: this.model,
        timeoutMs,
        enableTools: enableTools ?? true,
      },
      "left hemisphere call starting",
    );

    const { spawner, streamSpawner } = this.resolveSpawners();
    let result: SpawnResult;
    try {
      const spawnOpts = {
        claudePath: this.claudePath,
        model: this.model,
        timeoutMs,
        workingDir: this.workingDir,
        enableTools,
      };
      result = onStreamEvent
        ? await streamSpawner(prompt, { ...spawnOpts, onEvent: onStreamEvent })
        : await spawner(prompt, spawnOpts);
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
}
