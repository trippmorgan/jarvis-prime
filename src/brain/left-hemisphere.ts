import { spawnClaude } from "../claude/spawner.js";
import { spawnClaudeStream } from "../claude/spawner-stream.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import type { StreamEvent } from "../claude/stream-formatter.js";
import { LeftHemisphereError, type HemisphereClient } from "./types.js";

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
  /** Bridge working directory — passed as cwd to every Claude spawn. */
  workingDir: string;
  logger?: LeftHemisphereLogger;
  /** Injectable for testing. Defaults to the real spawnClaude. */
  spawner?: Spawner;
  /** Injectable streaming variant for testing. Defaults to spawnClaudeStream. */
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
  private readonly spawner: Spawner;
  private readonly streamSpawner: StreamSpawner;

  constructor(config: LeftHemisphereConfig) {
    this.claudePath = config.claudePath;
    this.model = config.model;
    this.workingDir = config.workingDir;
    this.logger = config.logger;
    this.spawner = config.spawner ?? spawnClaude;
    this.streamSpawner = config.streamSpawner ?? spawnClaudeStream;
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
        ? await this.streamSpawner(prompt, { ...spawnOpts, onEvent: onStreamEvent })
        : await this.spawner(prompt, spawnOpts);
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
