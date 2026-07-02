/**
 * Tests for the Argus left-hemisphere openclaw spawner (port of Frank's).
 *
 * All network access is mocked via vi.stubGlobal("fetch", ...) — nothing here
 * ever hits Ollama (local or cloud). The one real side effect is the run_bash
 * tool loop executing `echo hi` via exec, which is deliberate: it proves the
 * loop actually runs commands instead of narrating them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  spawnOpenclawAgent,
  extractAnswer,
  messageText,
  looksLikeUnrunCommand,
} from "../openclaw/spawner.js";

const ENV_KEYS = [
  "LEFT_OLLAMA_URL",
  "LEFT_MODEL",
  "LEFT_API_KEY",
  "LEFT_TOOLS",
  "LEFT_USE_OPENCLAW_CLI",
  "OPENCLAW_GATEWAY_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

/** Build a minimal Response-like object (the code only reads ok/status/text). */
function fakeResponse(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function chatCompletion(message: Record<string, unknown>) {
  return fakeResponse({ choices: [{ message }] });
}

// ---------------------------------------------------------------------------
// extractAnswer
// ---------------------------------------------------------------------------

describe("extractAnswer", () => {
  it("picks the first non-warning payload", () => {
    const envelope = JSON.stringify({
      result: {
        payloads: [
          { text: "⚠️ delivery warning" },
          { text: "the real answer" },
          { text: "✉️ Message failed" },
        ],
      },
    });
    expect(extractAnswer(envelope)).toBe("the real answer");
  });

  it("falls back to the first payload even when it is a warning", () => {
    const envelope = JSON.stringify({
      result: {
        payloads: [{ text: "⚠️ Context overflow: prompt too large" }],
      },
    });
    expect(extractAnswer(envelope)).toBe("⚠️ Context overflow: prompt too large");
  });

  it("passes non-JSON output through trimmed", () => {
    expect(extractAnswer("  plain text output \n")).toBe("plain text output");
  });
});

// ---------------------------------------------------------------------------
// messageText — reasoning fallback + <think> stripping
// ---------------------------------------------------------------------------

describe("messageText", () => {
  it("uses reasoning when content is empty (Cloud GLM behavior)", () => {
    expect(messageText({ role: "assistant", content: "", reasoning: "from reasoning" })).toBe(
      "from reasoning",
    );
  });

  it("strips <think> blocks", () => {
    expect(
      messageText({
        role: "assistant",
        content: "<think>secret pondering</think>visible answer",
      }),
    ).toBe("visible answer");
  });
});

// ---------------------------------------------------------------------------
// looksLikeUnrunCommand
// ---------------------------------------------------------------------------

describe("looksLikeUnrunCommand", () => {
  it("detects a backticked ssh command as unrun", () => {
    expect(looksLikeUnrunCommand("Run `ssh argus-mini uptime` to check the node.")).toBe(true);
  });

  it("does not flag plain prose", () => {
    expect(looksLikeUnrunCommand("The Mac mini looks healthy and responsive today.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runLeftToolLoop via spawnOpenclawAgent (LEFT_TOOLS unset → tools default ON)
// ---------------------------------------------------------------------------

describe("spawnOpenclawAgent tool loop", () => {
  it("executes run_bash tool calls and returns the final answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        chatCompletion({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "run_bash", arguments: JSON.stringify({ command: "echo hi" }) },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        chatCompletion({ role: "assistant", content: "Done: the command printed hi." }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await spawnOpenclawAgent("run echo hi", { timeoutMs: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toBe("Done: the command printed hi.");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Prove run_bash ACTUALLY executed: the second request must carry a tool
    // message whose content is the real stdout of `echo hi`.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const toolMsg = secondBody.messages.find((m: { role?: string }) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe("hi");
    expect(toolMsg.tool_call_id).toBe("call_1");
  });

  it("surfaces HTTP 401 as exitCode 1 with 401 in stderr (never fake success)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse("unauthorized", 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await spawnOpenclawAgent("hello", { timeoutMs: 30_000 });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// Env / auth header handling
// ---------------------------------------------------------------------------

describe("auth header handling", () => {
  it("sends Authorization Bearer when LEFT_API_KEY is set", async () => {
    process.env.LEFT_API_KEY = "test-left-key";
    process.env.OPENCLAW_GATEWAY_TOKEN = "SENTINEL_GATEWAY_TOKEN_NEVER_SEND";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatCompletion({ role: "assistant", content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await spawnOpenclawAgent("hello", { timeoutMs: 30_000 });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-left-key");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "SENTINEL_GATEWAY_TOKEN_NEVER_SEND",
    );
  });

  it("sends NO Authorization header when LEFT_API_KEY is unset — never falls back to OPENCLAW_GATEWAY_TOKEN", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "SENTINEL_GATEWAY_TOKEN_NEVER_SEND";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatCompletion({ role: "assistant", content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await spawnOpenclawAgent("hello", { timeoutMs: 30_000 });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "SENTINEL_GATEWAY_TOKEN_NEVER_SEND",
    );
  });

  it("also never uses the gateway token on the legacy plain-chat path (LEFT_TOOLS=false)", async () => {
    process.env.LEFT_TOOLS = "false";
    process.env.OPENCLAW_GATEWAY_TOKEN = "SENTINEL_GATEWAY_TOKEN_NEVER_SEND";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatCompletion({ role: "assistant", content: "plain ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await spawnOpenclawAgent("hello", { timeoutMs: 30_000 });

    expect(result.output).toBe("plain ok");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "SENTINEL_GATEWAY_TOKEN_NEVER_SEND",
    );
  });
});
