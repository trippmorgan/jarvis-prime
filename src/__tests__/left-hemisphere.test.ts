import { describe, it, expect, vi } from "vitest";
import { LeftHemisphereClient, type LeftHemisphereConfig } from "../brain/left-hemisphere.js";
import { LeftHemisphereError } from "../brain/types.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";

type Spawner = (prompt: string, opts: SpawnOptions) => Promise<SpawnResult>;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildClient(overrides: Partial<LeftHemisphereConfig> = {}) {
  const logger = overrides.logger ?? makeLogger();
  const spawner =
    overrides.spawner ??
    (vi.fn().mockResolvedValue({
      output: "hello",
      stderr: "",
      exitCode: 0,
      durationMs: 42,
      timedOut: false,
    }) as unknown as Spawner);

  const config: LeftHemisphereConfig = {
    claudePath: overrides.claudePath ?? "/home/tripp/.local/bin/claude",
    model: overrides.model ?? "sonnet",
    logger,
    spawner,
    ...overrides,
  };
  return {
    client: new LeftHemisphereClient(config),
    logger,
    spawner,
  };
}

describe("LeftHemisphereClient", () => {
  it("returns trimmed stdout as content and reports durationMs", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "  Hello!  \n",
      stderr: "",
      exitCode: 0,
      durationMs: 25,
      timedOut: false,
    });
    const { client } = buildClient({ spawner: spawner as unknown as Spawner });

    const result = await client.call({
      system: "sys",
      user: "usr",
      timeoutMs: 1000,
    });

    expect(result.content).toBe("Hello!");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes a concatenated system + user prompt to the spawner", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    });
    const { client } = buildClient({ spawner: spawner as unknown as Spawner });

    await client.call({
      system: "SYSTEM-TEXT",
      user: "USER-TEXT",
      timeoutMs: 500,
    });

    expect(spawner).toHaveBeenCalledTimes(1);
    const [prompt] = spawner.mock.calls[0]!;
    expect(prompt).toBe("SYSTEM-TEXT\n\nUSER-TEXT");
  });

  it("passes configured claudePath, model, timeoutMs into spawner opts", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    });
    const { client } = buildClient({
      claudePath: "/custom/claude",
      model: "opus",
      spawner: spawner as unknown as Spawner,
    });

    await client.call({ system: "s", user: "u", timeoutMs: 12345 });

    const [, opts] = spawner.mock.calls[0]!;
    expect(opts.claudePath).toBe("/custom/claude");
    expect(opts.model).toBe("opus");
    expect(opts.timeoutMs).toBe(12345);
  });

  it("throws LeftHemisphereError on timeout and warns the logger", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "",
      stderr: "",
      exitCode: 1,
      durationMs: 500,
      timedOut: true,
    });
    const logger = makeLogger();
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
    });

    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 500 }),
    ).rejects.toMatchObject({
      name: "LeftHemisphereError",
      message: expect.stringMatching(/timed out/i),
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("throws LeftHemisphereError on non-zero exitCode and logs error", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "",
      stderr: "boom: something went wrong",
      exitCode: 2,
      durationMs: 10,
      timedOut: false,
    });
    const logger = makeLogger();
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
    });

    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      name: "LeftHemisphereError",
      message: expect.stringContaining("2"),
    });

    const rejection = await client
      .call({ system: "s", user: "u", timeoutMs: 1000 })
      .catch((e) => e as Error);
    expect(rejection).toBeInstanceOf(LeftHemisphereError);
    expect(rejection.message).toContain("boom: something went wrong");

    expect(logger.error).toHaveBeenCalled();
  });

  it("truncates stderr longer than 500 chars in the error message", async () => {
    const longStderr = "x".repeat(1500);
    const spawner = vi.fn().mockResolvedValue({
      output: "",
      stderr: longStderr,
      exitCode: 1,
      durationMs: 10,
      timedOut: false,
    });
    const { client } = buildClient({ spawner: spawner as unknown as Spawner });

    const err = (await client
      .call({ system: "s", user: "u", timeoutMs: 1000 })
      .catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(LeftHemisphereError);
    // The excerpt portion of the message is bounded to 500 chars of the stderr
    // (plus the surrounding code/prefix text). Ensure the full 1500 did not land.
    expect(err.message.length).toBeLessThan(longStderr.length);
    // And ensure it does contain a recognizable chunk from the start of stderr
    expect(err.message).toContain("x".repeat(100));
  });

  it("logs info on start and on success including durationMs", async () => {
    const spawner = vi.fn().mockResolvedValue({
      output: "answer",
      stderr: "",
      exitCode: 0,
      durationMs: 7,
      timedOut: false,
    });
    const logger = makeLogger();
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
    });

    await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(logger.info).toHaveBeenCalled();
    // At least one info call must include a durationMs field
    const hadDuration = logger.info.mock.calls.some((args) => {
      const payload = args[0];
      return (
        payload &&
        typeof payload === "object" &&
        "durationMs" in (payload as Record<string, unknown>)
      );
    });
    expect(hadDuration).toBe(true);
  });

  it("never passes system or user text to the logger", async () => {
    const secretSystem = "SYSTEM-SECRET-ALPHA-QWERTY";
    const secretUser = "USER-SECRET-BETA-QWERTY";

    const spawner = vi.fn().mockResolvedValue({
      output: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    });
    const logger = makeLogger();
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
    });

    await client.call({
      system: secretSystem,
      user: secretUser,
      timeoutMs: 1000,
    });

    const allLogCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain(secretSystem);
    expect(serialized).not.toContain(secretUser);
  });

  it("never passes stdout content to the logger", async () => {
    const secretOutput = "OUTPUT-SECRET-GAMMA-QWERTY";
    const spawner = vi.fn().mockResolvedValue({
      output: secretOutput,
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    });
    const logger = makeLogger();
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
    });

    await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    const allLogCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain(secretOutput);
  });
});
