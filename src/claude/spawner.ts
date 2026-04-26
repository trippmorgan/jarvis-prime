import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnResult } from "./types.js";

const DEFAULTS = {
  claudePath: "/home/tripp/.local/bin/claude",
  model: "sonnet",
  timeoutMs: 120_000,
} as const;

/**
 * Spawn the Claude CLI with a prompt piped via stdin.
 *
 * Runs: claude --print --model <model> --dangerously-skip-permissions
 * Captures stdout (result), stderr (diagnostics), enforces timeout.
 */
export async function spawnClaude(
  prompt: string,
  opts?: SpawnOptions,
): Promise<SpawnResult> {
  const claudePath = opts?.claudePath ?? DEFAULTS.claudePath;
  const model = opts?.model ?? DEFAULTS.model;
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
  const workingDir = opts?.workingDir ?? process.cwd();
  const enableTools = opts?.enableTools ?? true;
  const enableSlashCommands = opts?.enableSlashCommands ?? true;

  const args = [
    "--print",
    "--model", model,
    "--dangerously-skip-permissions",
  ];
  if (!enableTools) {
    args.push("--tools", "");
  }
  if (!enableSlashCommands) {
    args.push("--disable-slash-commands");
  }

  const start = performance.now();

  return new Promise<SpawnResult>((resolve) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(claudePath, args, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Pipe the prompt via stdin, then close it
    child.stdin.write(prompt);
    child.stdin.end();

    // Enforce timeout
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);

      resolve({
        output: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
        durationMs,
        timedOut,
      });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);

      resolve({
        output: "",
        stderr: err.message,
        exitCode: 1,
        durationMs,
        timedOut: false,
      });
    });
  });
}
