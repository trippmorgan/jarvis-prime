import { describe, it, expect, vi } from "vitest"
import {
  corpusCallosum,
  type CorpusCallosumDeps,
  type CorpusCallosumInput,
} from "../brain/corpus-callosum.js"
import {
  IntegrationError,
  LeftHemisphereError,
  RightHemisphereError,
  type HemisphereClient,
  type HistoryEntry,
} from "../brain/types.js"

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
