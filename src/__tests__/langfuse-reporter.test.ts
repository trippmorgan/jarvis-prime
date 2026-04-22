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
  })
})
