import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RightHemisphereClient } from "../brain/right-hemisphere.js"
import { RightHemisphereError } from "../brain/types.js"

interface MockLogger {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

function makeLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeClient(logger?: MockLogger) {
  return new RightHemisphereClient({
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "test-token-abc",
    model: "gpt-5.4 codex",
    logger,
  })
}

function okResponse(content: string, extras?: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.4 codex",
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop", index: 0 }],
      ...(extras ?? {}),
    }),
    text: async () => "",
  }
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("not json")
    },
    text: async () => body,
  }
}

function loggerSawSubstring(logger: MockLogger, substring: string): boolean {
  const calls = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
  for (const call of calls) {
    for (const arg of call) {
      const serialized = typeof arg === "string" ? arg : JSON.stringify(arg)
      if (serialized.includes(substring)) return true
    }
  }
  return false
}

describe("RightHemisphereClient", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("returns content and durationMs on a successful call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("right-brain draft here"))
    vi.stubGlobal("fetch", fetchMock)

    const client = makeClient()
    const result = await client.call({
      system: "you are right hemisphere",
      user: "what is the meaning",
      timeoutMs: 5_000,
    })

    expect(result.content).toBe("right-brain draft here")
    expect(typeof result.durationMs).toBe("number")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("POSTs to the correct URL with Bearer token + JSON content-type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"))
    vi.stubGlobal("fetch", fetchMock)

    const client = makeClient()
    await client.call({ system: "s", user: "u", timeoutMs: 5_000 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:18789/v1/chat/completions")
    expect(init.method).toBe("POST")
    expect(init.headers["Authorization"]).toBe("Bearer test-token-abc")
    expect(init.headers["Content-Type"]).toBe("application/json")
  })

  it("sends correct body shape: model, system+user messages, stream:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"))
    vi.stubGlobal("fetch", fetchMock)

    const client = makeClient()
    await client.call({ system: "SYS-PROMPT", user: "USER-MSG", timeoutMs: 5_000 })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe("gpt-5.4 codex")
    expect(body.stream).toBe(false)
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS-PROMPT" })
    expect(body.messages[1]).toEqual({ role: "user", content: "USER-MSG" })
  })

  it("passes an AbortSignal on the fetch init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("ok"))
    vi.stubGlobal("fetch", fetchMock)

    const client = makeClient()
    await client.call({ system: "s", user: "u", timeoutMs: 5_000 })

    const init = fetchMock.mock.calls[0][1]
    expect(init.signal).toBeDefined()
    // AbortSignal in Node has aborted boolean
    expect(typeof init.signal.aborted).toBe("boolean")
  })

  it("throws RightHemisphereError on 401 with status in the message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401, "Unauthorized: bad token")))

    const client = makeClient()
    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      name: "RightHemisphereError",
    })
    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 5_000 }),
    ).rejects.toThrow(/401/)
  })

  it("throws RightHemisphereError on 500 with status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "internal error")))

    const client = makeClient()
    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 5_000 }),
    ).rejects.toThrow(/500/)
  })

  it("truncates long non-200 body text to 500 chars in the error message", async () => {
    const huge = "x".repeat(2_000)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(502, huge)))

    const client = makeClient()
    let thrown: unknown = null
    try {
      await makeClient().call({ system: "s", user: "u", timeoutMs: 5_000 })
    } catch (err) {
      thrown = err
    }
    // second attempt (first was inside the stub above, re-run to capture)
    try {
      await client.call({ system: "s", user: "u", timeoutMs: 5_000 })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RightHemisphereError)
    const msg = (thrown as Error).message
    // Should not contain the full 2000-char body.
    expect(msg.length).toBeLessThan(1_000)
  })

  it("throws RightHemisphereError('malformed response') when choices missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "x", object: "chat.completion", created: 1, model: "m" }),
        text: async () => "",
      }),
    )

    const client = makeClient()
    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      name: "RightHemisphereError",
      message: expect.stringContaining("malformed response"),
    })
  })

  it("throws RightHemisphereError('malformed response') when choices[0].message.content missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant" } }] }),
        text: async () => "",
      }),
    )

    const client = makeClient()
    await expect(
      client.call({ system: "s", user: "u", timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ message: expect.stringContaining("malformed response") })
  })

  it("times out via AbortController after timeoutMs", async () => {
    vi.useFakeTimers()

    // A fetch that rejects only when its signal aborts, mimicking real fetch semantics.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const logger = makeLogger()
    const client = makeClient(logger)
    const promise = client.call({ system: "s", user: "u", timeoutMs: 1_000 })

    // attach a rejection handler BEFORE advancing time so unhandled rejections do not flag
    const settled = promise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(1_100)

    const result = await settled
    expect(result).toBeInstanceOf(RightHemisphereError)
    expect((result as Error).message).toMatch(/timed out/i)
    expect((result as Error).message).toMatch(/1000/)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("wraps a network error into RightHemisphereError", async () => {
    const netErr = new Error("ECONNREFUSED")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(netErr))

    const logger = makeLogger()
    const client = makeClient(logger)
    let caught: unknown = null
    try {
      await client.call({ system: "s", user: "u", timeoutMs: 5_000 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RightHemisphereError)
    expect((caught as RightHemisphereError).cause).toBe(netErr)
    expect(logger.error).toHaveBeenCalled()
  })

  it("logs info on start and on success with durationMs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("pong", {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })))

    const logger = makeLogger()
    const client = makeClient(logger)
    await client.call({ system: "s", user: "u", timeoutMs: 5_000 })

    expect(logger.info).toHaveBeenCalledTimes(2)
    // The success log should include a durationMs field.
    const calls = logger.info.mock.calls
    const successArg = calls[1][0]
    expect(successArg).toMatchObject({ durationMs: expect.any(Number) })
  })

  it("never logs the user or system content (PHI safety)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse("response-content-secret")),
    )

    const logger = makeLogger()
    const client = makeClient(logger)
    const systemText = "sys-UNIQUE-TOKEN-SYS-12345"
    const userText = "usr-UNIQUE-TOKEN-USR-67890"
    await client.call({ system: systemText, user: userText, timeoutMs: 5_000 })

    expect(loggerSawSubstring(logger, systemText)).toBe(false)
    expect(loggerSawSubstring(logger, userText)).toBe(false)
    expect(loggerSawSubstring(logger, "response-content-secret")).toBe(false)
  })

  it("never logs user content on failure paths either", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")))

    const logger = makeLogger()
    const client = makeClient(logger)
    const userText = "private-phi-adjacent-text-ABC"
    await client
      .call({ system: "s", user: userText, timeoutMs: 5_000 })
      .catch(() => undefined)

    expect(loggerSawSubstring(logger, userText)).toBe(false)
  })

  it("works when no logger is provided (optional logger)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("ok")))

    const client = makeClient() // no logger
    const result = await client.call({ system: "s", user: "u", timeoutMs: 5_000 })
    expect(result.content).toBe("ok")
  })
})
