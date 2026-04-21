import { describe, it, expect, vi } from "vitest"
import {
  corpusCallosum,
  type CorpusCallosumDeps,
  type CorpusCallosumInput,
  type SkillShim,
} from "../brain/corpus-callosum.js"
import {
  IntegrationError,
  LeftHemisphereError,
  RightHemisphereError,
  type HemisphereClient,
  type HistoryEntry,
} from "../brain/types.js"
import type { SkillInvocationResult } from "../brain/right-brain-skill-shim.js"

type CallArg = { system: string; user: string; timeoutMs: number }

/**
 * FakeClient — records every invocation and returns canned responses. Each
 * call pops the next response off the queue. Responses may be values
 * (resolved) or errors (rejected).
 */
interface CannedResponse {
  content?: string
  durationMs?: number
  error?: Error
}

function makeFakeClient(responses: CannedResponse[]): HemisphereClient & {
  calls: CallArg[]
  remaining(): number
} {
  const calls: CallArg[] = []
  const queue = [...responses]
  return {
    calls,
    remaining: () => queue.length,
    async call(input) {
      calls.push({
        system: input.system,
        user: input.user,
        timeoutMs: input.timeoutMs,
      })
      const next = queue.shift()
      if (!next) throw new Error(`FakeClient: no response queued for call #${calls.length}`)
      if (next.error) throw next.error
      return {
        content: next.content ?? "",
        durationMs: next.durationMs ?? 0,
      }
    },
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const BASE_PROMPT = "You are Jarvis Prime."
const USER_MSG = "What's the move?"
const HISTORY: HistoryEntry[] = [
  { role: "user", content: "hello", timestamp: 1 },
  { role: "assistant", content: "hi Tripp", timestamp: 2 },
]

function buildDeps(
  left: HemisphereClient,
  right: HemisphereClient,
  overrides: Partial<CorpusCallosumDeps> = {},
): CorpusCallosumDeps {
  return {
    left,
    right,
    basePrompt: BASE_PROMPT,
    timeoutMs: 1000,
    logger: overrides.logger ?? makeLogger(),
    ...overrides,
  }
}

const HAPPY_INPUT: CorpusCallosumInput = { userMsg: USER_MSG, history: HISTORY }

describe("corpusCallosum — happy path", () => {
  it("fires 5 calls in correct order: left x3, right x2", async () => {
    const left = makeFakeClient([
      { content: "L1 draft", durationMs: 10 },
      { content: "L2 revised", durationMs: 11 },
      { content: "integrated final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "R1 draft", durationMs: 20 },
      { content: "R2 revised", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    const result = await corpusCallosum(deps, HAPPY_INPUT)

    expect(left.calls).toHaveLength(3)
    expect(right.calls).toHaveLength(2)
    expect(result.finalText).toBe("integrated final")
  })

  it("pass-2 left system prompt includes the right hemisphere's pass-1 content", async () => {
    const left = makeFakeClient([
      { content: "LEFT_P1_CONTENT", durationMs: 10 },
      { content: "LEFT_P2_CONTENT", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "RIGHT_P1_CONTENT", durationMs: 20 },
      { content: "RIGHT_P2_CONTENT", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await corpusCallosum(deps, HAPPY_INPUT)

    const leftP2System = left.calls[1].system
    expect(leftP2System).toContain("RIGHT_P1_CONTENT")
    expect(leftP2System).toContain("LEFT_P1_CONTENT")
  })

  it("pass-2 right system prompt includes the left hemisphere's pass-1 content", async () => {
    const left = makeFakeClient([
      { content: "LEFT_P1_CONTENT", durationMs: 10 },
      { content: "LEFT_P2_CONTENT", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "RIGHT_P1_CONTENT", durationMs: 20 },
      { content: "RIGHT_P2_CONTENT", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await corpusCallosum(deps, HAPPY_INPUT)

    const rightP2System = right.calls[1].system
    expect(rightP2System).toContain("LEFT_P1_CONTENT")
    expect(rightP2System).toContain("RIGHT_P1_CONTENT")
  })

  it("integration prompt includes BOTH pass-2 drafts", async () => {
    const left = makeFakeClient([
      { content: "LEFT_P1_CONTENT", durationMs: 10 },
      { content: "LEFT_P2_CONTENT_X", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "RIGHT_P1_CONTENT", durationMs: 20 },
      { content: "RIGHT_P2_CONTENT_Y", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await corpusCallosum(deps, HAPPY_INPUT)

    const integrationCall = left.calls[2]
    const combined = `${integrationCall.system}\n${integrationCall.user}`
    expect(combined).toContain("LEFT_P2_CONTENT_X")
    expect(combined).toContain("RIGHT_P2_CONTENT_Y")
  })

  it("finalText equals the trimmed integration call content", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { content: "   trimmed final   \n", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    const result = await corpusCallosum(deps, HAPPY_INPUT)
    expect(result.finalText).toBe("trimmed final")
  })

  it("trace contains all four drafts plus integrationMs and totalMs", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    const { trace } = await corpusCallosum(deps, HAPPY_INPUT)

    expect(trace.p1Left).toEqual({
      hemisphere: "left",
      pass: 1,
      content: "L1",
      durationMs: 10,
    })
    expect(trace.p1Right).toEqual({
      hemisphere: "right",
      pass: 1,
      content: "R1",
      durationMs: 20,
    })
    expect(trace.p2Left).toEqual({
      hemisphere: "left",
      pass: 2,
      content: "L2",
      durationMs: 11,
    })
    expect(trace.p2Right).toEqual({
      hemisphere: "right",
      pass: 2,
      content: "R2",
      durationMs: 21,
    })
    expect(typeof trace.integrationMs).toBe("number")
    expect(typeof trace.totalMs).toBe("number")
    expect(trace.totalMs).toBeGreaterThanOrEqual(0)
  })

  it("does not throw when no logger is provided", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const deps: CorpusCallosumDeps = {
      left,
      right,
      basePrompt: BASE_PROMPT,
      timeoutMs: 1000,
      // no logger
    }

    const result = await corpusCallosum(deps, HAPPY_INPUT)
    expect(result.finalText).toBe("final")
  })
})

describe("corpusCallosum — error paths", () => {
  it("pass-1 left failure bubbles as LeftHemisphereError and aborts orchestration", async () => {
    const left = makeFakeClient([
      { error: new LeftHemisphereError("left spawn blew up") },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      // second response shouldn't be consumed
      { content: "R2", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await expect(corpusCallosum(deps, HAPPY_INPUT)).rejects.toBeInstanceOf(
      LeftHemisphereError,
    )

    // left integration + p2 never called
    expect(left.calls.length).toBe(1)
    // right p2 never called (only p1 fired before rejection aborted)
    expect(right.calls.length).toBeLessThanOrEqual(1)
  })

  it("pass-1 right failure bubbles as RightHemisphereError and aborts orchestration", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      // p2 + integration shouldn't be consumed
      { content: "L2", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { error: new RightHemisphereError("right network error") },
    ])
    const deps = buildDeps(left, right)

    await expect(corpusCallosum(deps, HAPPY_INPUT)).rejects.toBeInstanceOf(
      RightHemisphereError,
    )

    expect(right.calls.length).toBe(1)
    // left's p2 and integration never happened
    expect(left.calls.length).toBeLessThanOrEqual(1)
  })

  it("pass-2 left failure bubbles as LeftHemisphereError", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { error: new LeftHemisphereError("left p2 failed") },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await expect(corpusCallosum(deps, HAPPY_INPUT)).rejects.toBeInstanceOf(
      LeftHemisphereError,
    )

    // integration never called
    expect(left.calls.length).toBe(2)
  })

  it("pass-2 right failure bubbles as RightHemisphereError", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { content: "final", durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { error: new RightHemisphereError("right p2 failed") },
    ])
    const deps = buildDeps(left, right)

    await expect(corpusCallosum(deps, HAPPY_INPUT)).rejects.toBeInstanceOf(
      RightHemisphereError,
    )

    // integration never called
    expect(left.calls.length).toBeLessThanOrEqual(2)
  })

  it("integration fails once then succeeds on retry", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { error: new LeftHemisphereError("transient integration fail") },
      { content: "final after retry", durationMs: 13 },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const logger = makeLogger()
    const deps = buildDeps(left, right, { logger })

    const result = await corpusCallosum(deps, HAPPY_INPUT)

    expect(result.finalText).toBe("final after retry")
    // 2 integration attempts + p1 + p2 = 4 total
    expect(left.calls).toHaveLength(4)

    const retryEvent = (logger.warn.mock.calls as Array<Array<unknown>>).find(
      (args) => {
        const arg0 = args[0] as { event?: string } | undefined
        return arg0?.event === "callosum_integration_retry"
      },
    )
    expect(retryEvent).toBeTruthy()
  })

  it("integration fails twice → IntegrationError thrown", async () => {
    const left = makeFakeClient([
      { content: "L1", durationMs: 10 },
      { content: "L2", durationMs: 11 },
      { error: new LeftHemisphereError("first integration fail") },
      { error: new LeftHemisphereError("second integration fail") },
    ])
    const right = makeFakeClient([
      { content: "R1", durationMs: 20 },
      { content: "R2", durationMs: 21 },
    ])
    const deps = buildDeps(left, right)

    await expect(corpusCallosum(deps, HAPPY_INPUT)).rejects.toBeInstanceOf(
      IntegrationError,
    )
  })
})

describe("corpusCallosum — logging hygiene", () => {
  it("logger calls do not leak user message or draft content", async () => {
    const secretUserMsg = "SECRET_USER_MSG_ZZZ"
    const secretDraft = "CONFIDENTIAL_DRAFT_QQQ"
    const left = makeFakeClient([
      { content: secretDraft, durationMs: 10 },
      { content: secretDraft, durationMs: 11 },
      { content: secretDraft, durationMs: 12 },
    ])
    const right = makeFakeClient([
      { content: secretDraft, durationMs: 20 },
      { content: secretDraft, durationMs: 21 },
    ])
    const logger = makeLogger()
    const deps = buildDeps(left, right, { logger })

    await corpusCallosum(deps, { userMsg: secretUserMsg, history: [] })

    const allCalls = [
      ...(logger.info.mock.calls as Array<Array<unknown>>),
      ...(logger.warn.mock.calls as Array<Array<unknown>>),
      ...(logger.error.mock.calls as Array<Array<unknown>>),
    ]
    for (const args of allCalls) {
      const serialized = JSON.stringify(args)
      expect(serialized).not.toContain(secretUserMsg)
      expect(serialized).not.toContain(secretDraft)
    }
  })
})

// -----------------------------------------------------------------------------
// Wave 8 — router path (W8-T10)
// -----------------------------------------------------------------------------

type CapturedInvoke = {
  dispatch: { mode: "skill"; skill: string; instruction: string }
  opts: { userMessage: string; timeoutMs?: number }
}

function makeFakeSkillShim(
  result: SkillInvocationResult,
): SkillShim & { invokes: CapturedInvoke[] } {
  const invokes: CapturedInvoke[] = []
  return {
    invokes,
    async invoke(dispatch, opts) {
      invokes.push({
        dispatch: {
          mode: dispatch.mode,
          skill: dispatch.skill,
          instruction: dispatch.instruction,
        },
        opts: { userMessage: opts.userMessage, timeoutMs: opts.timeoutMs },
      })
      return result
    },
  }
}

const RESEARCH_DISPATCH_BLOCK =
  '<dispatch>{"mode":"research","topics":["recent logs","Argus uptime"]}</dispatch>'
const SKILL_DISPATCH_BLOCK =
  '<dispatch>{"mode":"skill","skill":"jarvis-dev-methodology","instruction":"plan Wave 9"}</dispatch>'

const EMPTY_TOOLS_BLOCK = "<tools>[]</tools>"

function buildLeftRouterContent(opts: {
  dispatchBlock: string
  body?: string
  toolsBlock?: string
}) {
  return `${opts.dispatchBlock}\n\n${opts.body ?? "left draft body"}\n\n${opts.toolsBlock ?? EMPTY_TOOLS_BLOCK}`
}

const HAPPY_SKILL_RESULT: SkillInvocationResult = {
  skill: "jarvis-dev-methodology",
  durationMs: 4100,
  output: "skill evidence output: phased plan",
  ok: true,
}

describe("corpusCallosum — Wave 8 router path (W8-T10)", () => {
  describe("backward compat", () => {
    it("uses the legacy flow when routerEnabled is absent", async () => {
      const left = makeFakeClient([
        { content: "L1 legacy", durationMs: 10 },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1 legacy", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right) // no routerEnabled

      await corpusCallosum(deps, HAPPY_INPUT)

      // Legacy left pass-1 prompt does not contain the planning dispatcher block.
      expect(left.calls[0].system).not.toContain("<dispatch>")
      expect(left.calls[0].system).not.toContain("dispatcher/router")
    })

    it("uses the legacy flow when routerEnabled is explicitly false", async () => {
      const left = makeFakeClient([
        { content: "L1", durationMs: 10 },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: false })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(left.calls[0].system).not.toContain("dispatcher/router")
    })
  })

  describe("router mode — research dispatch", () => {
    it("emits router_plan_start before pass-1 when routerEnabled", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const events: string[] = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        onEvent: (e) => events.push(e),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(events[0]).toBe("router_plan_start")
      expect(events).toContain("callosum_pass1_start")
    })

    it("sends the left planning prompt (dispatcher/router framing)", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(left.calls[0].system).toContain("dispatcher/router")
      expect(left.calls[0].system).toContain("<dispatch>")
      expect(left.calls[0].system).toContain("jarvis-dev-methodology")
    })

    it("routes right via rightResearchModePrompt when dispatch is research", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1 research", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const rightP1System = right.calls[0].system
      expect(rightP1System).toMatch(/MEMORY\.md|workspace memory/)
      expect(rightP1System).toContain("recent logs")
      expect(rightP1System).toContain("Argus uptime")
      expect(rightP1System).not.toContain("<skill-evidence>")
      expect(shim.invokes).toHaveLength(0)
    })

    it("emits right_research_mode when dispatch is research", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const events: string[] = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        onEvent: (e) => events.push(e),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(events).toContain("right_research_mode")
      expect(events).not.toContain("right_skill_invoked")
    })
  })

  describe("router mode — skill dispatch", () => {
    it("invokes skillShim with the parsed skill and user message", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1 skill-informed", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(shim.invokes).toHaveLength(1)
      expect(shim.invokes[0].dispatch).toEqual({
        mode: "skill",
        skill: "jarvis-dev-methodology",
        instruction: "plan Wave 9",
      })
      expect(shim.invokes[0].opts.userMessage).toBe(USER_MSG)
    })

    it("flows skill output into right's pass-1 as skill-evidence", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const rightP1System = right.calls[0].system
      expect(rightP1System).toContain("<skill-evidence")
      expect(rightP1System).toContain("skill evidence output: phased plan")
      expect(rightP1System).toContain("jarvis-dev-methodology")
    })

    it("emits right_skill_invoked with skill name + durationMs", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const capturedEvents: Array<{ name: string; payload: unknown }> = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
        onEvent: (name, payload) =>
          capturedEvents.push({ name, payload }),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const invoked = capturedEvents.find((e) => e.name === "right_skill_invoked")
      expect(invoked).toBeTruthy()
      const payload = invoked!.payload as { skill: string; durationMs: number }
      expect(payload.skill).toBe("jarvis-dev-methodology")
      expect(payload.durationMs).toBe(4100)
    })

    it("falls back to research mode when skillShim result ok=false", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim({
        skill: "jarvis-dev-methodology",
        durationMs: 500,
        output: "",
        ok: false,
        failureReason: "skill runner timed out",
      })
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const rightP1System = right.calls[0].system
      // Failure path uses the <skill-failure> block per right-prompts.ts
      expect(rightP1System).toContain("skill-failure")
      expect(rightP1System).toContain("timed out")
    })
  })

  describe("router mode — fallback paths", () => {
    it("falls back to research mode when dispatch is missing", async () => {
      const left = makeFakeClient([
        { content: "no dispatch in here " + EMPTY_TOOLS_BLOCK, durationMs: 10 },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const events: Array<{ name: string; payload: unknown }> = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
        onEvent: (name, payload) => events.push({ name, payload }),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(right.calls[0].system).toMatch(/MEMORY\.md|workspace memory/)
      expect(shim.invokes).toHaveLength(0)
      expect(events.find((e) => e.name === "dispatch_malformed")).toBeTruthy()
      expect(events.find((e) => e.name === "right_research_mode")).toBeTruthy()
    })

    it("falls back to research mode when dispatch JSON is malformed", async () => {
      const left = makeFakeClient([
        {
          content:
            "<dispatch>not-json</dispatch>\n\nbody\n\n" + EMPTY_TOOLS_BLOCK,
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const events: Array<{ name: string; payload: unknown }> = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
        onEvent: (name, payload) => events.push({ name, payload }),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(shim.invokes).toHaveLength(0)
      const malformed = events.find((e) => e.name === "dispatch_malformed")
      expect(malformed).toBeTruthy()
      const payload = malformed!.payload as { warning: string }
      expect(payload.warning).toBe("malformed_json")
    })

    it("falls back to research mode when dispatch uses unknown skill", async () => {
      const left = makeFakeClient([
        {
          content:
            '<dispatch>{"mode":"skill","skill":"not-a-real-skill","instruction":"x"}</dispatch>\n\nbody\n\n' +
            EMPTY_TOOLS_BLOCK,
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const events: Array<{ name: string; payload: unknown }> = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
        onEvent: (name, payload) => events.push({ name, payload }),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(shim.invokes).toHaveLength(0)
      const malformed = events.find((e) => e.name === "dispatch_malformed")
      expect(malformed).toBeTruthy()
      expect((malformed!.payload as { warning: string }).warning).toBe(
        "unknown_skill",
      )
    })
  })

  describe("router mode — duplicate-skill rejection", () => {
    it("rejects skill dispatch when left's <tools> contains the dispatched skill", async () => {
      const dupeTools =
        '<tools>[{"name":"jarvis-dev-methodology","durationMs":3000}]</tools>'
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
            toolsBlock: dupeTools,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const events: Array<{ name: string; payload: unknown }> = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
        onEvent: (name, payload) => events.push({ name, payload }),
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(shim.invokes).toHaveLength(0)
      const rejected = events.find(
        (e) => e.name === "duplicate_skill_rejected",
      )
      expect(rejected).toBeTruthy()
      expect((rejected!.payload as { skill: string }).skill).toBe(
        "jarvis-dev-methodology",
      )
      // After rejection, right should run in research mode.
      expect(right.calls[0].system).toMatch(/MEMORY\.md|workspace memory/)
    })

    it("does NOT reject when left's <tools> has an unrelated tool name", async () => {
      const benignTools = '<tools>[{"name":"Bash","durationMs":1000}]</tools>'
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
            toolsBlock: benignTools,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      expect(shim.invokes).toHaveLength(1) // not rejected, shim did fire
    })
  })

  describe("router mode — pass-2 tool-evidence cross-visibility (W8-T11)", () => {
    it("left pass-2 prompt includes the skill right invoked", async () => {
      const leftToolsBlock =
        '<tools>[{"name":"Bash","durationMs":800}]</tools>'
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
            toolsBlock: leftToolsBlock,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const leftP2System = left.calls[1].system
      expect(leftP2System).toContain("Tool use summary (pass-1):")
      expect(leftP2System).toContain("Left ran: Bash (0.8s)")
      expect(leftP2System).toContain("Right ran: jarvis-dev-methodology (4.1s)")
    })

    it("right pass-2 prompt includes the same tool summary", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: SKILL_DISPATCH_BLOCK,
            toolsBlock:
              '<tools>[{"name":"Read","durationMs":200}]</tools>',
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        skillShim: shim,
      })

      await corpusCallosum(deps, HAPPY_INPUT)

      const rightP2System = right.calls[1].system
      expect(rightP2System).toContain("Tool use summary (pass-1):")
      expect(rightP2System).toContain("Left ran: Read (0.2s)")
      expect(rightP2System).toContain(
        "Right ran: jarvis-dev-methodology (4.1s)",
      )
    })

    it("research mode shows '(research mode, no tools)' for right", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      await corpusCallosum(deps, HAPPY_INPUT)

      const leftP2System = left.calls[1].system
      expect(leftP2System).toContain("Right ran: (research mode, no tools)")
    })

    it("legacy path (routerEnabled=false) does NOT include tool summary", async () => {
      const left = makeFakeClient([
        { content: "L1", durationMs: 10 },
        { content: "L2", durationMs: 11 },
        { content: "final", durationMs: 12 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right) // legacy

      await corpusCallosum(deps, HAPPY_INPUT)

      const leftP2System = left.calls[1].system
      const rightP2System = right.calls[1].system
      expect(leftP2System).not.toContain("Tool use summary")
      expect(rightP2System).not.toContain("Tool use summary")
    })
  })

  describe("router mode — integration self-check + bounded retry (W8-T12)", () => {
    const SELF_CHECK_OK =
      '<self-check>{"adequate":true,"gaps":[]}</self-check>'
    const SELF_CHECK_GAP =
      '<self-check>{"adequate":false,"gaps":["need Argus uptime","no Frank context"]}</self-check>'

    function routerHappyLeft(integrationContent: string) {
      return makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: integrationContent, durationMs: 12 },
      ])
    }

    it("asks Claude for a <self-check> block in the integration prompt", async () => {
      const left = routerHappyLeft(
        `final answer\n\n${SELF_CHECK_OK}`,
      )
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      await corpusCallosum(deps, HAPPY_INPUT)

      const integrationCall = left.calls[2]
      expect(integrationCall.system).toContain("<self-check>")
    })

    it("adequate=true: returns cleaned content, strips the self-check block, no retry", async () => {
      const left = routerHappyLeft(
        `final answer\n\n${SELF_CHECK_OK}`,
      )
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      expect(result.finalText).toBe("final answer")
      expect(result.finalText).not.toContain("<self-check>")
      expect(left.calls).toHaveLength(3) // no retry
    })

    it("adequate=false: emits self_correction_retry_start and retries once", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: `first pass\n\n${SELF_CHECK_GAP}`, durationMs: 12 },
        { content: `second pass\n\n${SELF_CHECK_OK}`, durationMs: 13 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const events: string[] = []
      const deps = buildDeps(left, right, {
        routerEnabled: true,
        onEvent: (e) => events.push(e),
      })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      expect(events).toContain("self_correction_retry_start")
      expect(left.calls).toHaveLength(4) // retry fired
      expect(result.finalText).toBe("second pass")
    })

    it("retry prompt includes the listed gaps", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: `first pass\n\n${SELF_CHECK_GAP}`, durationMs: 12 },
        { content: `second pass\n\n${SELF_CHECK_OK}`, durationMs: 13 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      await corpusCallosum(deps, HAPPY_INPUT)

      const retryCall = left.calls[3]
      expect(retryCall.user).toContain("need Argus uptime")
      expect(retryCall.user).toContain("no Frank context")
    })

    it("exhausted (retry still inadequate): prepends ⚠️ caveat to stripped content", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: `first pass\n\n${SELF_CHECK_GAP}`, durationMs: 12 },
        { content: `still gappy\n\n${SELF_CHECK_GAP}`, durationMs: 13 },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      expect(result.finalText.startsWith("⚠️")).toBe(true)
      expect(result.finalText).toContain("Best-effort")
      expect(result.finalText).toContain("still gappy")
      expect(result.finalText).not.toContain("<self-check>")
    })

    it("missing self-check: treats as adequate, no retry, no caveat", async () => {
      const left = routerHappyLeft("clean answer with no self-check block")
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      expect(result.finalText).toBe("clean answer with no self-check block")
      expect(result.finalText.startsWith("⚠️")).toBe(false)
      expect(left.calls).toHaveLength(3) // no retry
    })

    it("malformed self-check: treats as adequate, no retry", async () => {
      const left = routerHappyLeft(
        "answer\n\n<self-check>not-json-at-all</self-check>",
      )
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      // Malformed block is still stripped (it looks like a self-check block).
      expect(result.finalText).not.toContain("<self-check>")
      expect(result.finalText.startsWith("⚠️")).toBe(false)
      expect(left.calls).toHaveLength(3) // no retry
    })

    it("legacy path (routerEnabled=false) does NOT run self-check or retry", async () => {
      const left = makeFakeClient([
        { content: "L1", durationMs: 10 },
        { content: "L2", durationMs: 11 },
        {
          content: `final\n\n${SELF_CHECK_GAP}`,
          durationMs: 12,
        },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right) // legacy

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      // Legacy returns raw integration content; does NOT strip self-check
      // block (Claude wouldn't have emitted one in legacy prompt anyway).
      expect(left.calls).toHaveLength(3) // no retry
      expect(result.finalText).toContain("final")
    })

    it("self-correction retry throws: falls back to first attempt with caveat", async () => {
      const left = makeFakeClient([
        {
          content: buildLeftRouterContent({
            dispatchBlock: RESEARCH_DISPATCH_BLOCK,
          }),
          durationMs: 10,
        },
        { content: "L2", durationMs: 11 },
        { content: `first pass\n\n${SELF_CHECK_GAP}`, durationMs: 12 },
        { error: new LeftHemisphereError("retry network error") },
      ])
      const right = makeFakeClient([
        { content: "R1", durationMs: 20 },
        { content: "R2", durationMs: 21 },
      ])
      const deps = buildDeps(left, right, { routerEnabled: true })

      const result = await corpusCallosum(deps, HAPPY_INPUT)

      expect(result.finalText.startsWith("⚠️")).toBe(true)
      expect(result.finalText).toContain("first pass")
      expect(result.finalText).not.toContain("<self-check>")
    })
  })
})
