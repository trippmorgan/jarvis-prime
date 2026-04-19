export interface SpawnOptions {
  /** Path to the claude CLI binary */
  claudePath?: string;
  /** Model to use (e.g. "sonnet", "opus") */
  model?: string;
  /** Timeout in milliseconds — process killed if exceeded */
  timeoutMs?: number;
  /** Working directory for the spawned process */
  workingDir?: string;
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
