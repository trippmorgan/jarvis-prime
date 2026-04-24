/**
 * Wave 8 Sub-wave 8.6 — W8-T15: router-mode end-to-end smoke test.
 *
 * Vertical slice: MessageProcessor → corpusCallosum (router mode) → injected
 * SkillShim → mocked HemisphereClients → mocked TelegramSendSurface.
 *
 * What's real: processor routing, corpusCallosum router flow (dispatch parse,
 * shim invoke, right prompt selection, pass-2, integration), responder
 * debounce + typing loop, phase-label mapping, deliberation card rendering.
 *
 * What's mocked:
 *   - Telegram Bot API boundary (sendMessageAndGetId / editMessageText /
 *     sendChatAction)
 *   - LLM leaves (HemisphereClient.call)
 *   - Skill shim (SkillShim stub — does NOT shell out to claude)
 *   - spawnClaude (slash-command path)
 *
 * Satisfies Wave-8 ACs:
 *   T15a: skill dispatch — left emits skill block, shim invoked, right gets
 *         skill-mode prompt, final answer posted as fresh bubble.
 *   T15b: research dispatch — left emits research block, no shim invoked,
 *         right gets research-mode prompt, final answer posted.
 *   T15c: malformed dispatch fallback — left emits no dispatch block, falls
 *         through to research mode, final answer still posted.
 *   T15d: router_plan_start fires before any dual-brain phase edit labels.
 *   T15e: duplicate-skill rejection — left's dispatch names the same skill
 *         that left already ran; shim is NOT invoked, falls to research mode.
 *   T15f: self-correction fires + succeeds — integration #1 emits inadequate
 *         self-check; orchestrator retries once; retry's body (no caveat)
 *         becomes the final answer; Re-planning… phase edit appears post-card.
 *   T15g: self-correction exhausted — both integration attempts inadequate;
 *         final answer carries the ⚠️ Best-effort caveat prefix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Fastify from "fastify"
import { MessageProcessor } from "../bridge/processor.js"
import { corpusCallosum } from "../brain/corpus-callosum.js"
import type { HemisphereClient } from "../brain/types.js"
import type { SkillShim } from "../brain/corpus-callosum.js"
import type { SkillDispatch } from "../brain/dispatch-types.js"
import type { SkillInvocationResult } from "../brain/right-brain-skill-shim.js"
import { SELF_CORRECTION_CAVEAT } from "../brain/integration.js"

vi.mock("../claude/spawner.js", () => ({
  spawnClaude: vi.fn(),
}))

// W8.8.6 — left-hemisphere routes to spawnClaudeStream when caller wires
// onStreamEvent (corpus-callosum sets it when onEvent is present).
vi.mock("../claude/spawner-stream.js", async () => {
  const { spawnClaude } = await import("../claude/spawner.js")
  return { spawnClaudeStream: spawnClaude }
})

import { spawnClaude } from "../claude/spawner.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallArg = { system: string; user: string; timeoutMs: number }

function makeFakeHemisphere(
  responses: Array<{ content: string; durationMs?: number }>,
): HemisphereClient & { calls: CallArg[] } {
  const calls: CallArg[] = []
  const queue = [...responses]
  return {
    calls,
    async call(input) {
      calls.push({
        system: input.system,
        user: input.user,
        timeoutMs: input.timeoutMs,
      })
      const next = queue.shift()
      if (!next)
        throw new Error(
          `FakeHemisphere: no response queued for call #${calls.length}`,
        )
      return { content: next.content, durationMs: next.durationMs ?? 1 }
    },
  }
}

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
    async invoke(dispatch: SkillDispatch, opts) {
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

function makeFakeSurface(opts?: { ackReturn?: number | null }) {
  const ackReturn = opts?.ackReturn === undefined ? 7777 : opts.ackReturn
  const sendMessageAndGetId = vi.fn().mockResolvedValue(ackReturn)
  const editMessageText = vi.fn().mockResolvedValue(true)
  const sendChatAction = vi.fn().mockResolvedValue(true)
  return { sendMessageAndGetId, editMessageText, sendChatAction }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const SKILL_DISPATCH_BLOCK =
  '<dispatch>{"mode":"skill","skill":"jarvis-dev-methodology","instruction":"plan Wave 9"}</dispatch>'
const RESEARCH_DISPATCH_BLOCK =
  '<dispatch>{"mode":"research","topics":["MEMORY.md","recent logs"]}</dispatch>'
const EMPTY_TOOLS_BLOCK = "<tools>[]</tools>"
const DUPE_TOOLS_BLOCK =
  '<tools>[{"name":"jarvis-dev-methodology","durationMs":3200}]</tools>'
const INADEQUATE_SELF_CHECK =
  '<self-check>{"adequate":false,"gaps":["missing evidence on Argus","no scope estimate"]}</self-check>'
const ADEQUATE_SELF_CHECK = '<self-check>{"adequate":true,"gaps":[]}</self-check>'

function leftSkillContent(body = "left analysis body"): string {
  return `${SKILL_DISPATCH_BLOCK}\n\n${body}\n\n${EMPTY_TOOLS_BLOCK}`
}
function leftResearchContent(body = "left analysis body"): string {
  return `${RESEARCH_DISPATCH_BLOCK}\n\n${body}\n\n${EMPTY_TOOLS_BLOCK}`
}
function leftMalformedContent(body = "left analysis without dispatch"): string {
  return `${body}\n\n${EMPTY_TOOLS_BLOCK}`
}
function leftDuplicateSkillContent(body = "left already ran it"): string {
  return `${SKILL_DISPATCH_BLOCK}\n\n${body}\n\n${DUPE_TOOLS_BLOCK}`
}
function integrationWithSelfCheck(body: string, selfCheck: string): string {
  return `${body}\n\n${selfCheck}`
}

const HAPPY_SKILL_RESULT: SkillInvocationResult = {
  skill: "jarvis-dev-methodology",
  durationMs: 4200,
  output: "phased plan evidence: Wave 9 tasks drafted",
  ok: true,
}

function makeRouterProcessor(opts: {
  left: HemisphereClient
  right: HemisphereClient
  skillShim?: SkillShim
  surface?: ReturnType<typeof makeFakeSurface>
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "jp-w8-router-e2e-"))
  const historyPath = join(tmpDir, "history.jsonl")
  const deliverMock = vi.fn().mockResolvedValue(undefined)
  const log = Fastify({ logger: false }).log

  const orchestrator = async (input: {
    userMsg: string
    history: any
    basePrompt: string
    onEvent?: (e: string) => void
  }) =>
    corpusCallosum(
      {
        left: opts.left,
        right: opts.right,
        basePrompt: input.basePrompt,
        timeoutMs: 5000,
        logger: log as any,
        onEvent: input.onEvent,
        routerEnabled: true,
        skillShim: opts.skillShim,
      },
      { userMsg: input.userMsg, history: input.history },
    )

  const processor = new MessageProcessor(
    {
      claudePath: "/usr/bin/claude",
      claudeModel: "sonnet",
      claudeTimeoutMs: 120_000,
      historyPath,
      corpusCallosumEnabled: true,
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token",
      rightModel: "gpt-5.4 codex",
      corpusCallosumTimeoutMs: 5000,
      evolvingMessageEnabled: true,
      telegramSurface: opts.surface,
      routerEnabled: true,
      skillShim: opts.skillShim,
      orchestrator,
      // W8.7.1 — short-message fast lane off in router E2Es so short test
      // messages reach the orchestrator under test.
      shortMessageFastLaneEnabled: false,
      // W8.8.6 — /deep gates dual-brain behind opt-in mode. Router E2E
      // exercises dual-brain orchestrator, so default to 'dual'.
      defaultMode: 'dual',
    },
    deliverMock,
    log,
  )

  return { processor, deliverMock, historyPath }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wave 8 router E2E (Sub-wave 8.6 — W8-T15)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("T15a: skill dispatch — shim invoked, right gets skill-mode prompt, final posted as fresh bubble", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      // pass-1: emits skill dispatch block
      { content: leftSkillContent(), durationMs: 100 },
      // pass-2: revised draft
      { content: "L2-SKILL-REVISED", durationMs: 80 },
      // integration pass
      { content: "SKILL-INTEGRATED-FINAL", durationMs: 60 },
    ])
    const right = makeFakeHemisphere([
      // pass-1: right with skill evidence
      { content: "R1-SKILL-EVIDENCE", durationMs: 90 },
      // pass-2: revised
      { content: "R2-SKILL-REVISED", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 7777 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit(
      "chat-W8A",
      "Please plan our next development wave",
      "user-W8A",
    )

    // Wait for fresh-bubble final answer.
    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "SKILL-INTEGRATED-FINAL",
        ),
      6000,
    )
    // Drain debounce.
    await new Promise((r) => setTimeout(r, 1100))

    // Ack + final answer = 2 sendMessageAndGetId calls.
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(2)
    expect(surface.sendMessageAndGetId.mock.calls[0]).toEqual([
      "chat-W8A",
      "Thinking…",
    ])
    expect(surface.sendMessageAndGetId.mock.calls[1]).toEqual([
      "chat-W8A",
      "SKILL-INTEGRATED-FINAL",
    ])

    // Shim was invoked exactly once with the right skill.
    expect(shim.invokes).toHaveLength(1)
    expect(shim.invokes[0].dispatch.skill).toBe("jarvis-dev-methodology")
    expect(shim.invokes[0].dispatch.instruction).toBe("plan Wave 9")
    expect(shim.invokes[0].opts.userMessage).toBe(
      "Please plan our next development wave",
    )

    // Right hemisphere's pass-1 prompt contains skill evidence.
    expect(right.calls[0].system).toContain("skill-evidence")

    // Orchestrator ran all 5 hemisphere calls.
    expect(left.calls).toHaveLength(3)
    expect(right.calls).toHaveLength(2)

    // Phase labels appeared during the evolving-ack edits.
    const editedTexts = surface.editMessageText.mock.calls.map(
      ([, , text]) => text as string,
    )
    const hasPhaseLabel = editedTexts.some(
      (t) =>
        t === "Drafting…" || t === "Revising…" || t === "Integrating…" || t === "Planning…",
    )
    expect(hasPhaseLabel).toBe(true)

    // Typing indicator fired.
    expect(surface.sendChatAction).toHaveBeenCalled()

    // Legacy deliver() never invoked.
    expect(deliverMock).not.toHaveBeenCalled()
    // spawnClaude never invoked.
    expect(spawnClaude).not.toHaveBeenCalled()
  }, 12_000)

  it("T15b: research dispatch — no shim invoked, right gets research-mode prompt, final posted", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      // pass-1: emits research dispatch block
      { content: leftResearchContent(), durationMs: 100 },
      { content: "L2-RESEARCH-REVISED", durationMs: 80 },
      { content: "RESEARCH-INTEGRATED-FINAL", durationMs: 60 },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-RESEARCH-WORKSPACE", durationMs: 90 },
      { content: "R2-RESEARCH-REVISED", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 8888 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit("chat-W8B", "What's the current state of Argus?", "user-W8B")

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "RESEARCH-INTEGRATED-FINAL",
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Final answer posted as fresh bubble.
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(2)
    expect(surface.sendMessageAndGetId.mock.calls[1]).toEqual([
      "chat-W8B",
      "RESEARCH-INTEGRATED-FINAL",
    ])

    // Shim was NOT invoked — research mode bypasses shim.
    expect(shim.invokes).toHaveLength(0)

    // Right hemisphere's pass-1 prompt contains research framing (workspace/memory reference).
    expect(right.calls[0].system).toContain("workspace")

    // All 5 hemisphere calls ran.
    expect(left.calls).toHaveLength(3)
    expect(right.calls).toHaveLength(2)

    // Legacy deliver() never invoked.
    expect(deliverMock).not.toHaveBeenCalled()
  }, 12_000)

  it("T15c: malformed dispatch fallback — no dispatch block, right falls through to research, final posted", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      // pass-1: no <dispatch> block → parser returns warning:'missing'
      { content: leftMalformedContent(), durationMs: 100 },
      { content: "L2-FALLBACK-REVISED", durationMs: 80 },
      { content: "FALLBACK-INTEGRATED-FINAL", durationMs: 60 },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-FALLBACK", durationMs: 90 },
      { content: "R2-FALLBACK", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 9999 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit(
      "chat-W8C",
      "How is the station holding up?",
      "user-W8C",
    )

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "FALLBACK-INTEGRATED-FINAL",
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Final answer still posted.
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(2)
    expect(surface.sendMessageAndGetId.mock.calls[1]).toEqual([
      "chat-W8C",
      "FALLBACK-INTEGRATED-FINAL",
    ])

    // Shim never invoked — dispatch was missing.
    expect(shim.invokes).toHaveLength(0)

    // All 5 hemisphere calls still ran (research path handles missing dispatch).
    expect(left.calls).toHaveLength(3)
    expect(right.calls).toHaveLength(2)

    expect(deliverMock).not.toHaveBeenCalled()
  }, 12_000)

  it("T15d: Planning… phase label appears before Drafting… in surface edit sequence", async () => {
    // router_plan_start → "Planning…" label (W8-T14) must precede the dual-brain
    // Drafting… / Revising… labels. Verified via surface edit sequence (event
    // ordering is covered at unit level in corpus-callosum.test.ts W8-T10).
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      { content: leftSkillContent(), durationMs: 100 },
      { content: "L2-ORDER-REVISED", durationMs: 80 },
      { content: "ORDER-FINAL", durationMs: 60 },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-ORDER", durationMs: 90 },
      { content: "R2-ORDER", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 1111 })

    const { processor } = makeRouterProcessor({ left, right, skillShim: shim, surface })

    processor.submit("chat-W8D", "Plan the next wave", "user-W8D")

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "ORDER-FINAL",
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    const editedTexts = surface.editMessageText.mock.calls.map(
      ([, , text]) => text as string,
    )

    // "Planning…" must appear (mapped from router_plan_start).
    const planningIdx = editedTexts.indexOf("Planning…")
    expect(planningIdx).toBeGreaterThanOrEqual(0)

    // "Planning…" must come before any Drafting… / Revising… label.
    const firstDraftIdx = editedTexts.findIndex(
      (t) => t === "Drafting…" || t === "Revising…",
    )
    if (firstDraftIdx >= 0) {
      expect(planningIdx).toBeLessThan(firstDraftIdx)
    }
  }, 12_000)

  it("T15e: duplicate-skill rejection — left already ran the dispatched skill, shim NOT invoked, falls to research", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      // pass-1: dispatch names jarvis-dev-methodology but <tools> also shows
      // left already ran jarvis-dev-methodology — orchestrator must reject.
      { content: leftDuplicateSkillContent(), durationMs: 100 },
      { content: "L2-DUPE-REVISED", durationMs: 80 },
      { content: "DUPE-INTEGRATED-FINAL", durationMs: 60 },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-RESEARCH-AFTER-DUPE", durationMs: 90 },
      { content: "R2-REVISED", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 2222 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit("chat-W8E", "Plan the next wave", "user-W8E")

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "DUPE-INTEGRATED-FINAL",
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Shim was NOT invoked — duplicate rejected, research-mode fallback.
    expect(shim.invokes).toHaveLength(0)

    // Right pass-1 prompt is research-mode framing (workspace memory), not
    // skill-evidence framing.
    expect(right.calls[0].system).toContain("workspace")
    expect(right.calls[0].system).not.toContain("skill-evidence")

    // Final answer still posts as fresh bubble.
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(2)
    expect(surface.sendMessageAndGetId.mock.calls[1]).toEqual([
      "chat-W8E",
      "DUPE-INTEGRATED-FINAL",
    ])

    // All 5 hemisphere calls still ran.
    expect(left.calls).toHaveLength(3)
    expect(right.calls).toHaveLength(2)
    expect(deliverMock).not.toHaveBeenCalled()
  }, 12_000)

  it("T15f: self-correction fires + succeeds — integration retry, no caveat, Re-planning… label appears", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      // pass-1 (research mode keeps the setup simple)
      { content: leftResearchContent(), durationMs: 100 },
      // pass-2
      { content: "L2-RETRY-SETUP", durationMs: 80 },
      // integration #1 — inadequate self-check, one gap
      {
        content: integrationWithSelfCheck(
          "FIRST-INTEGRATION-DRAFT",
          INADEQUATE_SELF_CHECK,
        ),
        durationMs: 60,
      },
      // integration retry — adequate self-check; orchestrator strips it off
      {
        content: integrationWithSelfCheck(
          "RETRY-SUCCESS-FINAL",
          ADEQUATE_SELF_CHECK,
        ),
        durationMs: 55,
      },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-RETRY", durationMs: 90 },
      { content: "R2-RETRY", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 3333 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit("chat-W8F", "Walk me through the current status", "user-W8F")

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === "RETRY-SUCCESS-FINAL",
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Retry fired — left got 4 calls (p1, p2, integ#1, retry).
    expect(left.calls).toHaveLength(4)
    expect(right.calls).toHaveLength(2)

    // Final answer is the retry body with <self-check> stripped; no caveat.
    const finalCall = surface.sendMessageAndGetId.mock.calls[1]
    expect(finalCall[0]).toBe("chat-W8F")
    const finalText = finalCall[1] as string
    expect(finalText).toBe("RETRY-SUCCESS-FINAL")
    expect(finalText).not.toContain("self-check")
    expect(finalText.startsWith(SELF_CORRECTION_CAVEAT)).toBe(false)

    // Re-planning… phase label appears in surface edits (post-card exception).
    const editedTexts = surface.editMessageText.mock.calls.map(
      ([, , text]) => text as string,
    )
    expect(editedTexts).toContain("Re-planning…")

    expect(deliverMock).not.toHaveBeenCalled()
  }, 12_000)

  it("T15g: self-correction exhausted — retry also inadequate, caveat prepended to final answer", async () => {
    const shim = makeFakeSkillShim(HAPPY_SKILL_RESULT)
    const left = makeFakeHemisphere([
      { content: leftResearchContent(), durationMs: 100 },
      { content: "L2-EXHAUST-SETUP", durationMs: 80 },
      // integration #1 — inadequate
      {
        content: integrationWithSelfCheck(
          "FIRST-DRAFT-INADEQUATE",
          INADEQUATE_SELF_CHECK,
        ),
        durationMs: 60,
      },
      // integration retry — STILL inadequate → caveat prepended
      {
        content: integrationWithSelfCheck(
          "RETRY-ALSO-INADEQUATE",
          INADEQUATE_SELF_CHECK,
        ),
        durationMs: 55,
      },
    ])
    const right = makeFakeHemisphere([
      { content: "R1-EXHAUST", durationMs: 90 },
      { content: "R2-EXHAUST", durationMs: 70 },
    ])
    const surface = makeFakeSurface({ ackReturn: 4444 })

    const { processor, deliverMock } = makeRouterProcessor({
      left,
      right,
      skillShim: shim,
      surface,
    })

    processor.submit("chat-W8G", "Give me the full picture", "user-W8G")

    const expectedFinal =
      SELF_CORRECTION_CAVEAT + "RETRY-ALSO-INADEQUATE"

    await waitFor(
      () =>
        surface.sendMessageAndGetId.mock.calls.some(
          ([, text]) => text === expectedFinal,
        ),
      6000,
    )
    await new Promise((r) => setTimeout(r, 1100))

    // Retry ran (left got 4 calls) but was also inadequate.
    expect(left.calls).toHaveLength(4)

    // Final answer starts with the caveat marker.
    const finalText = surface.sendMessageAndGetId.mock.calls[1][1] as string
    expect(finalText.startsWith(SELF_CORRECTION_CAVEAT)).toBe(true)
    expect(finalText).toContain("RETRY-ALSO-INADEQUATE")
    // <self-check> block is stripped even on the caveat path.
    expect(finalText).not.toContain("self-check")

    // Re-planning… still appears (retry did fire).
    const editedTexts = surface.editMessageText.mock.calls.map(
      ([, , text]) => text as string,
    )
    expect(editedTexts).toContain("Re-planning…")

    expect(deliverMock).not.toHaveBeenCalled()
  }, 12_000)
})
