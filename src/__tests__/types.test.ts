import { describe, it, expectTypeOf, expect } from "vitest"
import type {
  HemisphereCallResult,
  HemisphereDraft,
  CallosumTrace,
  BrainResult,
} from "../brain/types.js"
import type { Dispatch, ToolEvidence } from "../brain/dispatch-types.js"

describe("HemisphereCallResult (W8-T7)", () => {
  it("accepts minimal {content, durationMs} — backward-compat with Waves 1–7", () => {
    const r: HemisphereCallResult = { content: "draft", durationMs: 100 }
    expect(r.content).toBe("draft")
  })

  it("accepts optional dispatch + toolsUsed when present", () => {
    const dispatch: Dispatch = {
      mode: "skill",
      skill: "jarvis-dev-methodology",
      instruction: "x",
    }
    const toolsUsed: ToolEvidence[] = [
      { name: "jarvis-dev-methodology", durationMs: 4100 },
    ]
    const r: HemisphereCallResult = {
      content: "draft",
      durationMs: 100,
      dispatch,
      toolsUsed,
    }
    expect(r.dispatch).toEqual(dispatch)
    expect(r.toolsUsed).toEqual(toolsUsed)
  })

  it("dispatch field may be null (parser returned null + warning)", () => {
    const r: HemisphereCallResult = {
      content: "draft",
      durationMs: 100,
      dispatch: null,
    }
    expect(r.dispatch).toBeNull()
  })

  it("type-checks: dispatch is optionally null|Dispatch|undefined", () => {
    expectTypeOf<HemisphereCallResult["dispatch"]>().toEqualTypeOf<
      Dispatch | null | undefined
    >()
  })

  it("type-checks: toolsUsed is optionally ToolEvidence[]|undefined", () => {
    expectTypeOf<HemisphereCallResult["toolsUsed"]>().toEqualTypeOf<
      ToolEvidence[] | undefined
    >()
  })
})

describe("CallosumTrace (W8-T7)", () => {
  it("extends with per-hemisphere toolsUsed (optional)", () => {
    const draft: HemisphereDraft = {
      hemisphere: "left",
      pass: 1,
      content: "x",
      durationMs: 10,
    }
    const trace: CallosumTrace = {
      p1Left: draft,
      p1Right: { ...draft, hemisphere: "right" },
      p2Left: { ...draft, pass: 2 },
      p2Right: { ...draft, hemisphere: "right", pass: 2 },
      integrationMs: 1,
      totalMs: 2,
      leftToolsUsed: [{ name: "Bash", durationMs: 500 }],
      rightToolsUsed: [{ name: "jarvis-dev-methodology", durationMs: 4100 }],
    }
    expect(trace.leftToolsUsed?.[0].name).toBe("Bash")
    expect(trace.rightToolsUsed?.[0].name).toBe("jarvis-dev-methodology")
  })

  it("accepts a trace without toolsUsed fields (backward-compat)", () => {
    const draft: HemisphereDraft = {
      hemisphere: "left",
      pass: 1,
      content: "x",
      durationMs: 10,
    }
    const trace: CallosumTrace = {
      p1Left: draft,
      p1Right: { ...draft, hemisphere: "right" },
      p2Left: { ...draft, pass: 2 },
      p2Right: { ...draft, hemisphere: "right", pass: 2 },
      integrationMs: 1,
      totalMs: 2,
    }
    expect(trace.leftToolsUsed).toBeUndefined()
    expect(trace.rightToolsUsed).toBeUndefined()
  })
})

describe("BrainResult (W8-T7)", () => {
  it("still only requires finalText + trace — no breaking change", () => {
    const draft: HemisphereDraft = {
      hemisphere: "left",
      pass: 1,
      content: "x",
      durationMs: 10,
    }
    const r: BrainResult = {
      finalText: "answer",
      trace: {
        p1Left: draft,
        p1Right: { ...draft, hemisphere: "right" },
        p2Left: { ...draft, pass: 2 },
        p2Right: { ...draft, hemisphere: "right", pass: 2 },
        integrationMs: 1,
        totalMs: 2,
      },
    }
    expect(r.finalText).toBe("answer")
  })
})
