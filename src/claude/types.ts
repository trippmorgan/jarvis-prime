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
   * Default: false — `--tools ""` is passed, so hemisphere calls used for
   * pure reasoning don't incur full-agent startup cost (CLAUDE.md auto-load,
   * MCP discovery) that caused the 240s left-hemisphere timeout.
   * Skill-shim callers must set this true to actually execute tools.
   */
  enableTools?: boolean;
  /**
   * Allow the spawned Claude to resolve `/skill` references from the prompt.
   * Default: false — `--disable-slash-commands` is passed.
   * Skill-shim callers may opt in if their methodology depends on chained skills.
   */
  enableSlashCommands?: boolean;
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
}
