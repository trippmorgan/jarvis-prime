export interface SpawnOptions {
  /** Path to the claude CLI binary */
  claudePath?: string;
  /** Model to use (e.g. "sonnet", "opus") */
  model?: string;
  /** Timeout in milliseconds — process killed if exceeded */
  timeoutMs?: number;
  /** Working directory for the spawned process */
  workingDir?: string;
  /**
   * Enable the spawned Claude's full tool surface (Bash, Read, Edit, etc.).
   * Default: true — every spawn gets tools. Pass `enableTools: false` only
   * for a pure-reasoning spawn that must not touch the filesystem or shell.
   */
  enableTools?: boolean;
  /**
   * Allow the spawned Claude to resolve `/skill` references from the prompt.
   * Default: true. Pass `enableSlashCommands: false` only to forbid a spawn
   * from invoking slash commands.
   */
  enableSlashCommands?: boolean;
  /**
   * Daily-session continuity. When set with `resumeSession: false` the CLI
   * creates the session under this UUID (`--session-id`); with
   * `resumeSession: true` it continues it (`--resume`), carrying the whole
   * day's conversation and tool context forward. Omit for a stateless spawn.
   */
  sessionId?: string;
  resumeSession?: boolean;
  /** With resumeSession: continue from that session's history under a NEW id (`--fork-session`). Jobs use this so a background worker never writes into the daily session another turn may be resuming. */
  forkSession?: boolean;
  /** Abort → SIGTERM the child (SIGKILL 5 s later); result carries aborted:true. */
  signal?: AbortSignal;
}

export interface SpawnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface SpawnResult {
  /** Captured stdout from the claude process */
  output: string;
  /** Captured stderr for diagnostics */
  stderr: string;
  /** Process exit code (null coerced to 1 if killed) */
  exitCode: number;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** True if the process was killed due to timeout */
  timedOut: boolean;
  /** True when the caller's AbortSignal stopped the run (2026-09-04 jobs). */
  aborted?: boolean;
  /** Token usage from the CLI's final `result` event, when present. */
  usage?: SpawnUsage;
  /** Total cost in USD as reported by the CLI (covers cache + standard pricing). */
  costUsd?: number;
  /** Canonical model name resolved by the CLI (e.g. "claude-sonnet-4-6"). */
  modelResolved?: string;
}
