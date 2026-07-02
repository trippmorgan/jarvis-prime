import { describe, it, expect, vi, beforeEach } from "vitest";
import { LeftHemisphereClient, type LeftHemisphereConfig } from "../brain/left-hemisphere.js";
import { LeftHemisphereError } from "../brain/types.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import { spawnClaude } from "../claude/spawner.js";
import { spawnClaudeStream } from "../claude/spawner-stream.js";
import { spawnOpenclawAgent } from "../openclaw/spawner.js";
import { spawnOpenclawAgentStream } from "../openclaw/spawner-stream.js";

vi.mock("../claude/spawner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude/spawner.js")>();
  return { ...actual, spawnClaude: vi.fn() };
});
vi.mock("../claude/spawner-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude/spawner-stream.js")>();
  return { ...actual, spawnClaudeStream: vi.fn() };
});
vi.mock("../openclaw/spawner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openclaw/spawner.js")>();
  return { ...actual, spawnOpenclawAgent: vi.fn() };
});
vi.mock("../openclaw/spawner-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openclaw/spawner-stream.js")>();
  return { ...actual, spawnOpenclawAgentStream: vi.fn() };
});

type Spawner = (prompt: string, opts: SpawnOptions) => Promise<SpawnResult>;

const okResult: SpawnResult = {
  output: "ok",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
};

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
    workingDir: overrides.workingDir ?? "/tmp",
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
    // Manual 'claude' runtime — the no-chain path (W3-T8: default 'openclaw'
    // runtime now falls back through Claude models instead of throwing here).
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      logger,
      runtimeResolver: () => "claude",
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
      runtimeResolver: () => "claude",
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
    const { client } = buildClient({
      spawner: spawner as unknown as Spawner,
      runtimeResolver: () => "claude",
    });

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

describe("LeftHemisphereClient runtime resolver", () => {
  beforeEach(() => {
    vi.mocked(spawnClaude).mockReset().mockResolvedValue({ ...okResult, output: "from-claude" });
    vi.mocked(spawnClaudeStream)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-claude-stream" });
    vi.mocked(spawnOpenclawAgent)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-openclaw" });
    vi.mocked(spawnOpenclawAgentStream)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-openclaw-stream" });
  });

  function bareClient(overrides: Partial<LeftHemisphereConfig> = {}) {
    return new LeftHemisphereClient({
      claudePath: "/home/tripp/.local/bin/claude",
      model: "sonnet",
      workingDir: "/tmp",
      ...overrides,
    });
  }

  it("defaults to the openclaw spawner when no resolver and no overrides are given", async () => {
    const client = bareClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-openclaw");
    expect(spawnOpenclawAgent).toHaveBeenCalledTimes(1);
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("routes to the openclaw stream spawner by default when onStreamEvent is supplied", async () => {
    const client = bareClient();

    const result = await client.call({
      system: "s",
      user: "u",
      timeoutMs: 1000,
      onStreamEvent: () => {},
    });

    expect(result.content).toBe("from-openclaw-stream");
    expect(spawnOpenclawAgentStream).toHaveBeenCalledTimes(1);
    expect(spawnOpenclawAgent).not.toHaveBeenCalled();
    expect(spawnClaudeStream).not.toHaveBeenCalled();
  });

  it("routes to the claude spawner pair when runtimeResolver returns 'claude'", async () => {
    const client = bareClient({ runtimeResolver: () => "claude" });

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });
    expect(result.content).toBe("from-claude");
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(spawnOpenclawAgent).not.toHaveBeenCalled();

    const streamed = await client.call({
      system: "s",
      user: "u",
      timeoutMs: 1000,
      onStreamEvent: () => {},
    });
    expect(streamed.content).toBe("from-claude-stream");
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1);
    expect(spawnOpenclawAgentStream).not.toHaveBeenCalled();
  });

  it("resolves the runtime on every call, so a flipped resolver changes spawners mid-session", async () => {
    let runtime: "openclaw" | "claude" = "openclaw";
    const client = bareClient({ runtimeResolver: () => runtime });

    const first = await client.call({ system: "s", user: "u", timeoutMs: 1000 });
    expect(first.content).toBe("from-openclaw");

    runtime = "claude";
    const second = await client.call({ system: "s", user: "u", timeoutMs: 1000 });
    expect(second.content).toBe("from-claude");
    expect(spawnOpenclawAgent).toHaveBeenCalledTimes(1);
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("bypasses the resolver entirely when both spawner and streamSpawner overrides are injected", async () => {
    const resolver = vi.fn(() => "claude" as const);
    const spawner = vi.fn().mockResolvedValue({ ...okResult, output: "from-override" });
    const streamSpawner = vi
      .fn()
      .mockResolvedValue({ ...okResult, output: "from-override-stream" });
    const client = bareClient({
      runtimeResolver: resolver,
      spawner: spawner as unknown as Spawner,
      streamSpawner: streamSpawner as unknown as LeftHemisphereConfig["streamSpawner"],
    });

    const plain = await client.call({ system: "s", user: "u", timeoutMs: 1000 });
    const streamed = await client.call({
      system: "s",
      user: "u",
      timeoutMs: 1000,
      onStreamEvent: () => {},
    });

    expect(plain.content).toBe("from-override");
    expect(streamed.content).toBe("from-override-stream");
    expect(resolver).not.toHaveBeenCalled();
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(spawnOpenclawAgent).not.toHaveBeenCalled();
    expect(spawnClaudeStream).not.toHaveBeenCalled();
    expect(spawnOpenclawAgentStream).not.toHaveBeenCalled();
  });

  it("respects a single spawner override within the resolved runtime", async () => {
    const resolver = vi.fn(() => "claude" as const);
    const spawner = vi.fn().mockResolvedValue({ ...okResult, output: "from-override" });
    const client = bareClient({
      runtimeResolver: resolver,
      spawner: spawner as unknown as Spawner,
    });

    const plain = await client.call({ system: "s", user: "u", timeoutMs: 1000 });
    expect(plain.content).toBe("from-override");
    expect(spawnClaude).not.toHaveBeenCalled();

    const streamed = await client.call({
      system: "s",
      user: "u",
      timeoutMs: 1000,
      onStreamEvent: () => {},
    });
    expect(streamed.content).toBe("from-claude-stream");
    expect(resolver).toHaveBeenCalled();
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1);
  });
});

describe("LeftHemisphereClient GLM fallback chain (W3-T8)", () => {
  const failResult: SpawnResult = {
    output: "",
    stderr: "glm boom",
    exitCode: 1,
    durationMs: 5,
    timedOut: false,
  };

  beforeEach(() => {
    vi.mocked(spawnClaude).mockReset().mockResolvedValue({ ...okResult, output: "from-claude" });
    vi.mocked(spawnClaudeStream)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-claude-stream" });
    vi.mocked(spawnOpenclawAgent)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-openclaw" });
    vi.mocked(spawnOpenclawAgentStream)
      .mockReset()
      .mockResolvedValue({ ...okResult, output: "from-openclaw-stream" });
  });

  function chainClient(overrides: Partial<LeftHemisphereConfig> = {}) {
    const logger = makeLogger();
    const client = new LeftHemisphereClient({
      claudePath: "/home/tripp/.local/bin/claude",
      model: "glm-5.2",
      workingDir: "/tmp",
      logger,
      ...overrides,
    });
    return { client, logger };
  }

  function loggedEvents(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map(
      (args) => (args[0] as { event?: string } | undefined)?.event ?? "",
    );
  }

  it("GLM failure (exitCode 1) falls back to claude model 'fable' and returns its result", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue(failResult);
    const { client, logger } = chainClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-claude");
    expect(spawnOpenclawAgent).toHaveBeenCalledTimes(1);
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(spawnClaude).mock.calls[0]!;
    expect(opts.model).toBe("fable");
    expect(opts.claudePath).toBe("/home/tripp/.local/bin/claude");
    expect(opts.workingDir).toBe("/tmp");
    expect(opts.timeoutMs).toBe(1000);

    expect(loggedEvents(logger.warn)).toContain("left_glm_fallback");
    expect(loggedEvents(logger.info)).toContain("left_glm_fallback_recovered");
    const recovered = logger.info.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "left_glm_fallback_recovered",
    );
    expect((recovered![0] as { model?: string }).model).toBe("fable");
  });

  it("GLM + fable fail, sonnet succeeds — claude spawner saw ['fable','sonnet'] in order", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue(failResult);
    vi.mocked(spawnClaude)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce({ ...okResult, output: "from-sonnet" });
    const { client, logger } = chainClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-sonnet");
    expect(spawnClaude).toHaveBeenCalledTimes(2);
    const models = vi.mocked(spawnClaude).mock.calls.map(([, opts]) => opts.model);
    expect(models).toEqual(["fable", "sonnet"]);
    expect(loggedEvents(logger.warn).filter((e) => e === "left_glm_fallback")).toHaveLength(2);
    expect(loggedEvents(logger.info)).toContain("left_glm_fallback_recovered");
  });

  it("GLM + fable + sonnet all fail → LeftHemisphereError naming the chain, exhausted logged", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue(failResult);
    vi.mocked(spawnClaude).mockResolvedValue(failResult);
    const { client, logger } = chainClient();

    const err = (await client
      .call({ system: "s", user: "u", timeoutMs: 1000 })
      .catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(LeftHemisphereError);
    expect(err.message).toContain("glm-5.2");
    expect(err.message).toContain("fable");
    expect(err.message).toContain("sonnet");
    expect(spawnClaude).toHaveBeenCalledTimes(2); // total attempts = 1 + 2, capped
    expect(loggedEvents(logger.error)).toContain("left_glm_fallback_exhausted");
  });

  it("GLM success never touches the claude spawner (hot path unchanged)", async () => {
    const { client, logger } = chainClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-openclaw");
    expect(spawnClaude).not.toHaveBeenCalled();
    expect(spawnClaudeStream).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(loggedEvents(logger.info)).toContain("left_hemisphere_call_success");
  });

  it("manual 'claude' runtime failure throws immediately — no chain, openclaw spawner never called", async () => {
    vi.mocked(spawnClaude).mockResolvedValue(failResult);
    const { client, logger } = chainClient({ runtimeResolver: () => "claude" });

    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(LeftHemisphereError);

    expect(spawnClaude).toHaveBeenCalledTimes(1); // primary only — never retried
    expect(spawnOpenclawAgent).not.toHaveBeenCalled();
    expect(loggedEvents(logger.warn)).not.toContain("left_glm_fallback");
    expect(loggedEvents(logger.error)).not.toContain("left_glm_fallback_exhausted");
  });

  it("empty-output GLM result (exitCode 0, output '') counts as failure and chains", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue({ ...okResult, output: "   \n" });
    const { client, logger } = chainClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-claude");
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(loggedEvents(logger.warn)).toContain("left_glm_fallback");
  });

  it("a thrown GLM spawner error also chains instead of throwing", async () => {
    vi.mocked(spawnOpenclawAgent).mockRejectedValue(new Error("ollama cloud unreachable"));
    const { client } = chainClient();

    const result = await client.call({ system: "s", user: "u", timeoutMs: 1000 });

    expect(result.content).toBe("from-claude");
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("respects custom fallbackModels ['claude-fable-5']", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue(failResult);
    vi.mocked(spawnClaude).mockResolvedValue(failResult);
    const { client } = chainClient({ fallbackModels: ["claude-fable-5"] });

    const err = (await client
      .call({ system: "s", user: "u", timeoutMs: 1000 })
      .catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(LeftHemisphereError);
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnClaude).mock.calls[0]![1].model).toBe("claude-fable-5");
    expect(err.message).toContain("claude-fable-5");
  });

  it("never retries the same model — a fallback matching the primary model is skipped", async () => {
    vi.mocked(spawnOpenclawAgent).mockResolvedValue(failResult);
    vi.mocked(spawnClaude).mockResolvedValue(failResult);
    const { client } = chainClient({
      model: "sonnet",
      fallbackModels: ["fable", "sonnet"],
    });

    await client.call({ system: "s", user: "u", timeoutMs: 1000 }).catch(() => {});

    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnClaude).mock.calls[0]![1].model).toBe("fable");
  });

  it("streaming fallback: onStreamEvent flows into spawnClaudeStream on fallback attempts", async () => {
    vi.mocked(spawnOpenclawAgentStream).mockResolvedValue(failResult);
    const { client, logger } = chainClient();
    const onStreamEvent = vi.fn();

    const result = await client.call({
      system: "s",
      user: "u",
      timeoutMs: 1000,
      onStreamEvent,
    });

    expect(result.content).toBe("from-claude-stream");
    expect(spawnOpenclawAgentStream).toHaveBeenCalledTimes(1);
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1);
    expect(spawnClaude).not.toHaveBeenCalled();
    const [, streamOpts] = vi.mocked(spawnClaudeStream).mock.calls[0]! as [
      string,
      SpawnOptions & { onEvent?: unknown },
    ];
    expect(streamOpts.model).toBe("fable");
    expect(streamOpts.onEvent).toBe(onStreamEvent);
    expect(loggedEvents(logger.info)).toContain("left_glm_fallback_recovered");
  });
});
