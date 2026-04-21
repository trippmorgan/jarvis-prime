import { describe, it, expect } from "vitest"
import {
  parseDispatch,
  parseLeftToolsEvidence,
} from "../brain/dispatch-parser.js"

describe("parseDispatch — absent block (W8-T5)", () => {
  it("returns {dispatch: null, warning: 'missing'} when no dispatch block present", () => {
    const out = parseDispatch("Here is a draft without any dispatch block.")
    expect(out.dispatch).toBeNull()
    expect(out.warning).toBe("missing")
  })

  it("returns 'missing' on empty string", () => {
    expect(parseDispatch("").warning).toBe("missing")
  })

  it("returns 'missing' when tag is malformed (no closing)", () => {
    expect(parseDispatch("<dispatch>{}").warning).toBe("missing")
  })
})

describe("parseDispatch — malformed JSON (W8-T5)", () => {
  it("returns {dispatch: null, warning: 'malformed_json'} when JSON is invalid", () => {
    const out = parseDispatch("pre <dispatch>{not valid json</dispatch> post")
    expect(out.dispatch).toBeNull()
    expect(out.warning).toBe("malformed_json")
  })

  it("returns 'malformed_json' for empty block", () => {
    expect(parseDispatch("<dispatch></dispatch>").warning).toBe(
      "malformed_json",
    )
  })
})

describe("parseDispatch — schema violations (W8-T5)", () => {
  it("returns 'malformed_json' when mode is missing", () => {
    expect(
      parseDispatch('<dispatch>{"skill":"jarvis-dev-methodology"}</dispatch>')
        .warning,
    ).toBe("malformed_json")
  })

  it("returns 'malformed_json' when mode is 'skill' but skill field missing", () => {
    expect(
      parseDispatch(
        '<dispatch>{"mode":"skill","instruction":"do it"}</dispatch>',
      ).warning,
    ).toBe("malformed_json")
  })

  it("returns 'malformed_json' when mode is 'skill' but instruction missing", () => {
    expect(
      parseDispatch(
        '<dispatch>{"mode":"skill","skill":"jarvis-dev-methodology"}</dispatch>',
      ).warning,
    ).toBe("malformed_json")
  })

  it("returns 'malformed_json' when mode is 'research' but topics is not an array", () => {
    expect(
      parseDispatch(
        '<dispatch>{"mode":"research","topics":"just a string"}</dispatch>',
      ).warning,
    ).toBe("malformed_json")
  })

  it("returns 'malformed_json' for unknown mode", () => {
    expect(
      parseDispatch('<dispatch>{"mode":"telepathy"}</dispatch>').warning,
    ).toBe("malformed_json")
  })
})

describe("parseDispatch — unknown skill (W8-T5)", () => {
  it("returns 'unknown_skill' warning for skill not in allowlist", () => {
    const out = parseDispatch(
      '<dispatch>{"mode":"skill","skill":"pretend-tool","instruction":"x"}</dispatch>',
    )
    expect(out.dispatch).toBeNull()
    expect(out.warning).toBe("unknown_skill")
  })

  it("rejects the placeholder name 'jarv-dev' (not the real skill name)", () => {
    const out = parseDispatch(
      '<dispatch>{"mode":"skill","skill":"jarv-dev","instruction":"x"}</dispatch>',
    )
    expect(out.warning).toBe("unknown_skill")
  })
})

describe("parseDispatch — valid dispatches (W8-T5)", () => {
  it("round-trips a valid skill dispatch", () => {
    const out = parseDispatch(
      '<dispatch>{"mode":"skill","skill":"jarvis-dev-methodology","instruction":"plan Wave 9"}</dispatch>',
    )
    expect(out.warning).toBeUndefined()
    expect(out.dispatch).toEqual({
      mode: "skill",
      skill: "jarvis-dev-methodology",
      instruction: "plan Wave 9",
    })
  })

  it("round-trips a valid research dispatch", () => {
    const out = parseDispatch(
      '<dispatch>{"mode":"research","topics":["incident history","memory"]}</dispatch>',
    )
    expect(out.warning).toBeUndefined()
    expect(out.dispatch).toEqual({
      mode: "research",
      topics: ["incident history", "memory"],
    })
  })

  it("round-trips a research dispatch with empty topics", () => {
    const out = parseDispatch(
      '<dispatch>{"mode":"research","topics":[]}</dispatch>',
    )
    expect(out.dispatch).toEqual({ mode: "research", topics: [] })
  })

  it("extracts a dispatch block embedded in surrounding draft text", () => {
    const content = [
      "Here is my plan analysis.",
      "",
      '<dispatch>{"mode":"skill","skill":"research-methodology","instruction":"find prior Argus incidents"}</dispatch>',
      "",
      "Draft body continues…",
    ].join("\n")
    const out = parseDispatch(content)
    expect(out.dispatch).toEqual({
      mode: "skill",
      skill: "research-methodology",
      instruction: "find prior Argus incidents",
    })
  })

  it("uses the FIRST dispatch block when multiple are present (defensive)", () => {
    const content =
      '<dispatch>{"mode":"research","topics":["first"]}</dispatch>' +
      '<dispatch>{"mode":"skill","skill":"jarvis-dev-methodology","instruction":"second"}</dispatch>'
    const out = parseDispatch(content)
    expect(out.dispatch).toEqual({ mode: "research", topics: ["first"] })
  })
})

describe("parseLeftToolsEvidence (W8-T10)", () => {
  it("returns [] when no <tools> block present", () => {
    expect(parseLeftToolsEvidence("a draft with no tools block")).toEqual([])
  })

  it("returns [] for empty block", () => {
    expect(parseLeftToolsEvidence("<tools></tools>")).toEqual([])
  })

  it("returns [] when body is not JSON", () => {
    expect(parseLeftToolsEvidence("<tools>not json</tools>")).toEqual([])
  })

  it("returns [] when body is not an array", () => {
    expect(parseLeftToolsEvidence('<tools>{"name":"x","durationMs":1}</tools>')).toEqual([])
  })

  it("returns [] when array is empty", () => {
    expect(parseLeftToolsEvidence("<tools>[]</tools>")).toEqual([])
  })

  it("parses a single well-formed entry", () => {
    const out = parseLeftToolsEvidence(
      '<tools>[{"name":"Bash","durationMs":1200}]</tools>',
    )
    expect(out).toEqual([{ name: "Bash", durationMs: 1200 }])
  })

  it("parses multiple entries", () => {
    const out = parseLeftToolsEvidence(
      '<tools>[{"name":"Bash","durationMs":1},{"name":"Read","durationMs":2}]</tools>',
    )
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe("Bash")
    expect(out[1].name).toBe("Read")
  })

  it("skips malformed entries but keeps valid ones", () => {
    const out = parseLeftToolsEvidence(
      '<tools>[{"name":"Bash","durationMs":1},{"broken":true},{"name":"Read","durationMs":2}]</tools>',
    )
    expect(out).toEqual([
      { name: "Bash", durationMs: 1 },
      { name: "Read", durationMs: 2 },
    ])
  })
})
