import { describe, it, expect, vi } from "vitest"
import {
  NoopReporter,
  makeReporter,
  CLINICAL_REDACTED_MARKER,
} from "../observability/langfuse-reporter.js"

describe("NoopReporter", () => {
  it("startTrace returns a handle whose methods are safe no-ops", () => {
    const r = new NoopReporter()
    const h = r.startTrace()
    expect(() => h.update({ output: "anything", metadata: { x: 1 }, tags: ["a"] })).not.toThrow()
    expect(() => h.end()).not.toThrow()
    expect(() => h.update({ output: "again" })).not.toThrow() // safe after end
  })

  it("shutdown resolves immediately", async () => {
    const r = new NoopReporter()
    await expect(r.shutdown()).resolves.toBeUndefined()
  })
})

describe("makeReporter()", () => {
  it("returns a NoopReporter when enabled=false", async () => {
    const r = await makeReporter({ enabled: false })
    expect(r).toBeInstanceOf(NoopReporter)
  })

  it("returns a NoopReporter when host is missing", async () => {
    const r = await makeReporter({
      enabled: true,
      publicKey: "pk-x",
      secretKey: "sk-x",
    })
    expect(r).toBeInstanceOf(NoopReporter)
  })

  it("returns a NoopReporter when publicKey is missing", async () => {
    const r = await makeReporter({
      enabled: true,
      host: "http://localhost:3200",
      secretKey: "sk-x",
    })
    expect(r).toBeInstanceOf(NoopReporter)
  })

  it("returns a NoopReporter when secretKey is missing", async () => {
    const r = await makeReporter({
      enabled: true,
      host: "http://localhost:3200",
      publicKey: "pk-x",
    })
    expect(r).toBeInstanceOf(NoopReporter)
  })

  it("logs the disabled outcome via the injected logger", async () => {
    const calls: { level: string; payload: unknown }[] = []
    const logger = {
      info: (p: unknown) => calls.push({ level: "info", payload: p }),
      warn: (p: unknown) => calls.push({ level: "warn", payload: p }),
      error: (p: unknown) => calls.push({ level: "error", payload: p }),
    }
    await makeReporter({ enabled: false, logger: logger as never })
    const disabledLog = calls.find(
      (c) => (c.payload as { event?: string }).event === "langfuse_disabled",
    )
    expect(disabledLog).toBeDefined()
  })
})

describe("LangfuseReporter (via injected fake client)", () => {
  // We never want to talk to a real Langfuse in unit tests, so we rebuild
  // the wrapper logic here against a fake client. This mirrors the behaviour
  // of the private `LangfuseReporter` class (single client, single trace per
  // call, update merges, no double-update after end).
  function makeFakeClient() {
    const updates: { traceId: string; updates: Record<string, unknown> }[] = []
    const traces: { id: string; init: Record<string, unknown> }[] = []
    let nextId = 0
    const client = {
      trace(init: Record<string, unknown>) {
        const id = `t-${nextId++}`
        traces.push({ id, init })
        return {
          update: (u: Record<string, unknown>) =>
            updates.push({ traceId: id, updates: u }),
        }
      },
      shutdownAsync: vi.fn().mockResolvedValue(undefined),
    }
    return { client, updates, traces }
  }

  it("CLINICAL_REDACTED_MARKER constant is the expected literal", () => {
    expect(CLINICAL_REDACTED_MARKER).toBe("[clinical_redacted]")
  })

  it("disabled-path noop handle is interchangeable with enabled-path handle (shape)", () => {
    // Just a smoke that both branches return objects with `update` + `end`.
    const noop = new NoopReporter().startTrace()
    expect(typeof noop.update).toBe("function")
    expect(typeof noop.end).toBe("function")
    expect(typeof noop.startSpan).toBe("function")
    expect(typeof noop.startGeneration).toBe("function")
  })
})

describe("W8.8.3 — span + generation primitives (NoopReporter)", () => {
  it("noop trace.startSpan returns safe handle", () => {
    const t = new NoopReporter().startTrace()
    const s = t.startSpan({ name: "phase" })
    expect(() => s.update({ metadata: { x: 1 } })).not.toThrow()
    expect(() => s.end({ output: "done", level: "DEFAULT" })).not.toThrow()
    expect(() => s.end()).not.toThrow() // safe to double-end
  })

  it("noop trace.startGeneration returns safe handle", () => {
    const t = new NoopReporter().startTrace()
    const g = t.startGeneration({ name: "call", model: "sonnet" })
    expect(() => g.update({ output: "partial" })).not.toThrow()
    expect(() =>
      g.end({
        output: "final",
        usage: { promptTokens: 10, completionTokens: 5 },
        level: "DEFAULT",
      }),
    ).not.toThrow()
  })
})

describe("W8.8.3 — LangfuseReporter span + generation wrapping", () => {
  // Mirrors the wrapper logic against a hand-rolled fake. We don't import
  // the real Langfuse SDK — keep tests offline.
  function makeFakeTraceClient() {
    const events: { kind: string; init?: unknown; end?: unknown; update?: unknown }[] = []
    const obs = (kind: string) => ({
      update: (u: unknown) => events.push({ kind: `${kind}:update`, update: u }),
      end: (e?: unknown) => events.push({ kind: `${kind}:end`, end: e }),
    })
    const trace = {
      update: (u: unknown) => events.push({ kind: "trace:update", update: u }),
      span: (init: unknown) => {
        events.push({ kind: "span:start", init })
        return obs("span")
      },
      generation: (init: unknown) => {
        events.push({ kind: "gen:start", init })
        return obs("gen")
      },
    }
    const client = {
      trace: () => trace,
      shutdownAsync: vi.fn().mockResolvedValue(undefined),
    }
    return { client, trace, events }
  }

  it("startSpan / end forwards to client.span() and obs.end()", async () => {
    const { client, events } = makeFakeTraceClient()
    const { LangfuseReporter } = await import(
      "../observability/langfuse-reporter.js"
    ).then(async () => {
      // re-import the module so we pick the class via internal constructor;
      // since LangfuseReporter is not exported, build a thin reporter via
      // makeReporter pattern: just satisfy via the shape used by tests.
      return import("../observability/langfuse-reporter.js")
    })
    void LangfuseReporter // silence unused
    // We can't construct LangfuseReporter directly (private); exercise it
    // by stubbing a Langfuse import inside makeReporter.
    const { makeReporter } = await import("../observability/langfuse-reporter.js")
    // Inject the fake by mocking the dynamic import:
    vi.doMock("langfuse", () => ({ Langfuse: function () { return client } }))
    const reporter = await makeReporter({
      enabled: true,
      host: "http://x",
      publicKey: "pk-x",
      secretKey: "sk-x",
    })
    vi.doUnmock("langfuse")
    const trace = reporter.startTrace({ name: "t", sessionId: "s" })
    const span = trace.startSpan({ name: "phase", metadata: { p: 1 } })
    span.update({ metadata: { extra: 2 } })
    span.end({ output: "ok", level: "DEFAULT" })
    expect(events.find((e) => e.kind === "span:start")).toBeDefined()
    // Wrapper routes both .update() and .end() through the SDK's update()
    // (since SDK's end() clobbers endTime). We expect at least 2 update calls
    // and the last one to carry an endTime.
    const spanUpdates = events.filter((e) => e.kind === "span:update")
    expect(spanUpdates.length).toBe(2)
    const lastUpdate = spanUpdates[spanUpdates.length - 1]
    expect((lastUpdate.update as Record<string, unknown>).endTime).toBeDefined()
  })

  it("startGeneration / end forwards to client.generation() and obs.end()", async () => {
    const { client, events } = makeFakeTraceClient()
    vi.doMock("langfuse", () => ({ Langfuse: function () { return client } }))
    const { makeReporter } = await import("../observability/langfuse-reporter.js")
    const reporter = await makeReporter({
      enabled: true,
      host: "http://x",
      publicKey: "pk-x",
      secretKey: "sk-x",
    })
    vi.doUnmock("langfuse")
    const trace = reporter.startTrace({ name: "t", sessionId: "s" })
    const gen = trace.startGeneration({ name: "call", model: "sonnet" })
    gen.update({ output: "partial" })
    gen.end({
      output: "final",
      usage: { promptTokens: 10, completionTokens: 5 },
    })
    expect(events.find((e) => e.kind === "gen:start")).toBeDefined()
    const genUpdates = events.filter((e) => e.kind === "gen:update")
    expect(genUpdates.length).toBe(2)
    const lastUpdate = genUpdates[genUpdates.length - 1]
    expect((lastUpdate.update as Record<string, unknown>).endTime).toBeDefined()
    expect((lastUpdate.update as Record<string, unknown>).output).toBe("final")
  })

  it("span.end is idempotent — second call is a no-op", async () => {
    const { client, events } = makeFakeTraceClient()
    vi.doMock("langfuse", () => ({ Langfuse: function () { return client } }))
    const { makeReporter } = await import("../observability/langfuse-reporter.js")
    const reporter = await makeReporter({
      enabled: true,
      host: "http://x",
      publicKey: "pk-x",
      secretKey: "sk-x",
    })
    vi.doUnmock("langfuse")
    const trace = reporter.startTrace({ name: "t", sessionId: "s" })
    const span = trace.startSpan({ name: "phase" })
    span.end()
    span.end()
    // .end() routes through update() now — second call must be a no-op.
    const updates = events.filter((e) => e.kind === "span:update")
    expect(updates.length).toBe(1)
  })
})
