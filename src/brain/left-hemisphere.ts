import { spawnClaude } from "../claude/spawner.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import { LeftHemisphereError, type HemisphereClient } from "./types.js";

export type Spawner = (prompt: string, opts: SpawnOptions) => Promise<SpawnResult>;

export interface LeftHemisphereLogger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

export interface LeftHemisphereConfig {
  claudePath: string;
  model: string;
  logger?: LeftHemisphereLogger;
  /** Injectable for testing. Defaults to the real spawnClaude. */
  spawner?: Spawner;
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
  private readonly logger?: LeftHemisphereLogger;
  private readonly spawner: Spawner;

  constructor(config: LeftHemisphereConfig) {
    this.claudePath = config.claudePath;
    this.model = config.model;
    this.logger = config.logger;
    this.spawner = config.spawner ?? spawnClaude;
  }

  async call(input: {
    system: string;
    user: string;
    timeoutMs: number;
    enableTools?: boolean;
  }): Promise<{ content: string; durationMs: number }> {
    const { system, user, timeoutMs, enableTools } = input;
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
      result = await this.spawner(prompt, {
        claudePath: this.claudePath,
        model: this.model,
        timeoutMs,
        workingDir: process.cwd(),
        enableTools,
      });
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
