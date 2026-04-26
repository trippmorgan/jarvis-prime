import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Writable, Readable } from "node:stream";

// Mock child_process before importing spawner
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawnClaude } from "../claude/spawner.js";
import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

/** Build a fake ChildProcess with controllable stdout/stderr/stdin */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdout = new EventEmitter() as Readable;
  const stderr = new EventEmitter() as Readable;
  const stdin = {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as Writable;

  child.stdout = stdout as ChildProcess["stdout"];
  child.stderr = stderr as ChildProcess["stderr"];
  child.stdin = stdin as ChildProcess["stdin"];
  child.kill = vi.fn();
  child.pid = 12345;

  return { child: child as unknown as ChildProcess, stdout, stderr, stdin };
}

describe("spawnClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("returns output from a successful invocation", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("say hello");

    // Simulate claude responding
    stdout.emit("data", Buffer.from("Hello!"));
    child.emit("close", 0);

    const result = await resultPromise;

    expect(result.output).toBe("Hello!");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify spawn was called with correct args — tools and slash commands
    // are ON by default; no strip flags appear in argv.
    expect(mockSpawn).toHaveBeenCalledWith(
      "/home/tripp/.local/bin/claude",
      [
        "--print",
        "--model", "sonnet",
        "--dangerously-skip-permissions",
      ],
      expect.objectContaining({
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    // Verify prompt was piped via stdin
    expect(child.stdin!.write).toHaveBeenCalledWith("say hello");
    expect(child.stdin!.end).toHaveBeenCalled();
  });

  it("sets timedOut=true when timeout exceeded", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("think deeply about the universe", {
      timeoutMs: 50,
    });

    // Advance past timeout
    vi.advanceTimersByTime(60);

    // The kill should have been called
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Simulate the process closing after being killed
    child.emit("close", null);

    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("captures non-zero exit code on bad invocation", async () => {
    const { child, stderr: stderrStream } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("anything");

    stderrStream.emit("data", Buffer.from("Error: invalid model"));
    child.emit("close", 2);

    const result = await resultPromise;

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("Error: invalid model");
    expect(result.output).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("handles spawn error (e.g. binary not found)", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("hello", {
      claudePath: "/nonexistent/claude",
    });

    child.emit("error", new Error("spawn ENOENT"));

    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("spawn ENOENT");
    expect(result.output).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("respects custom options", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("test", {
      claudePath: "/custom/claude",
      model: "opus",
      workingDir: "/tmp/test",
    });

    child.emit("close", 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/claude",
      [
        "--print",
        "--model", "opus",
        "--dangerously-skip-permissions",
      ],
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
  });

  it("adds --tools \"\" and --disable-slash-commands only when explicitly disabled", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("pure reasoning only", {
      enableTools: false,
      enableSlashCommands: false,
    });

    child.emit("close", 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "/home/tripp/.local/bin/claude",
      [
        "--print",
        "--model", "sonnet",
        "--dangerously-skip-permissions",
        "--tools", "",
        "--disable-slash-commands",
      ],
      expect.any(Object),
    );
  });

  it("strips only tools when enableTools=false and enableSlashCommands is left default", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = spawnClaude("no shell, slashes ok", {
      enableTools: false,
    });

    child.emit("close", 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "/home/tripp/.local/bin/claude",
      [
        "--print",
        "--model", "sonnet",
        "--dangerously-skip-permissions",
        "--tools", "",
      ],
      expect.any(Object),
    );
  });
});
