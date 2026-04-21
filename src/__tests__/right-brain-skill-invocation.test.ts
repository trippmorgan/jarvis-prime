import { describe, it, expect, vi } from "vitest"
import {
  RightBrainSkillShim,
  type SkillMdLoader,
  type Spawner,
} from "../brain/right-brain-skill-shim.js"
import type { SkillDispatch } from "../brain/dispatch-types.js"

const SKILL_MD = "# SKILL: jarvis-dev-methodology\n\nDo phased planning."

const buildShim = (opts: {
  spawner?: Spawner
  loader?: SkillMdLoader
  timeoutMs?: number
} = {}) =>
  new RightBrainSkillShim({
    spawner:
      opts.spawner ??
      vi.fn(async () => ({
        output: "skill output — phased plan drafted",
        stderr: "",
        exitCode: 0,
        durationMs: 4100,
        timedOut: false,
      })),
    loader: opts.loader ?? vi.fn(async () => SKILL_MD),
    defaultTimeoutMs: opts.timeoutMs,
  })

const dispatch = (instruction = "plan Wave 9"): SkillDispatch => ({
  mode: "skill",
  skill: "jarvis-dev-methodology",
  instruction,
})

describe("RightBrainSkillShim — happy path (W8-T8)", () => {
  it("spawns Claude CLI with SKILL.md + instruction + user message", async () => {
    const spawner = vi.fn(async () => ({
      output: "skill output",
      stderr: "",
      exitCode: 0,
      durationMs: 4100,
      timedOut: false,
    }))
    const shim = buildShim({ spawner })
    const result = await shim.invoke(dispatch("plan it"), {
      userMessage: "help me with Wave 9",
    })

    expect(result.ok).toBe(true)
    expect(result.skill).toBe("jarvis-dev-methodology")
    expect(result.output).toBe("skill output")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(spawner).toHaveBeenCalledOnce()
    const prompt = spawner.mock.calls[0][0]
    expect(prompt).toContain(SKILL_MD)
    expect(prompt).toContain("plan it")
    expect(prompt).toContain("help me with Wave 9")
  })

  it("truncates output larger than 16 KB", async () => {
    const huge = "x".repeat(20_000)
    const shim = buildShim({
      spawner: vi.fn(async () => ({
        output: huge,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      })),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(16_500)
    expect(result.output).toContain("[truncated]")
  })

  it("loads SKILL.md from the skill-registry path", async () => {
    const loader = vi.fn(async () => SKILL_MD)
    const shim = buildShim({ loader })
    await shim.invoke(dispatch(), { userMessage: "m" })
    expect(loader).toHaveBeenCalledWith("jarvis-dev-methodology")
  })

  it("passes defaultTimeoutMs to the spawner when opts.timeoutMs absent", async () => {
    const spawner = vi.fn(async () => ({
      output: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
    }))
    const shim = buildShim({ spawner, timeoutMs: 77_777 })
    await shim.invoke(dispatch(), { userMessage: "m" })
    const spawnOpts = spawner.mock.calls[0][1]
    expect(spawnOpts.timeoutMs).toBe(77_777)
  })

  it("respects per-call timeoutMs override", async () => {
    const spawner = vi.fn(async () => ({
      output: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
    }))
    const shim = buildShim({ spawner, timeoutMs: 10_000 })
    await shim.invoke(dispatch(), { userMessage: "m", timeoutMs: 42 })
    expect(spawner.mock.calls[0][1].timeoutMs).toBe(42)
  })
})

describe("RightBrainSkillShim — failure modes (W8-T8)", () => {
  it("returns ok=false when spawner times out", async () => {
    const shim = buildShim({
      spawner: vi.fn(async () => ({
        output: "",
        stderr: "",
        exitCode: 1,
        durationMs: 120_000,
        timedOut: true,
      })),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/timed out|timeout/i)
    expect(result.output).toBe("")
  })

  it("returns ok=false when spawner exits non-zero", async () => {
    const shim = buildShim({
      spawner: vi.fn(async () => ({
        output: "",
        stderr: "boom",
        exitCode: 2,
        durationMs: 500,
        timedOut: false,
      })),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toMatch(/exit/i)
  })

  it("returns ok=false when spawner throws", async () => {
    const shim = buildShim({
      spawner: vi.fn(async () => {
        throw new Error("ENOENT claude")
      }),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toContain("ENOENT claude")
  })

  it("returns ok=false when SKILL.md loader throws", async () => {
    const shim = buildShim({
      loader: vi.fn(async () => {
        throw new Error("no such file")
      }),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(false)
    expect(result.failureReason).toContain("no such file")
  })

  it("redacts secrets heuristically from output (OPENCLAW_GATEWAY_TOKEN etc.)", async () => {
    const shim = buildShim({
      spawner: vi.fn(async () => ({
        output:
          "result here. OPENCLAW_GATEWAY_TOKEN=abcd1234 leaked this.",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      })),
    })
    const result = await shim.invoke(dispatch(), { userMessage: "m" })
    expect(result.ok).toBe(true)
    expect(result.output).not.toContain("abcd1234")
    expect(result.output).toContain("[redacted]")
  })
})
