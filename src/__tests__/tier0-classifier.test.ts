import { describe, it, expect } from "vitest"
import { Tier0Classifier } from "../brain/tier0-classifier.js"
import type { Tier0Route } from "../brain/tier0-seeds.js"

/**
 * Deterministic fake encoder + injected minimal seeds. Test texts encode to
 * an orthogonal 4-D basis (one axis per route) and unmatched strings fall
 * onto a weak near-origin vector with cos ≈ 0.1 against every basis — well
 * under the 0.65 default threshold, so "no route" cases are unambiguous.
 */
const TEST_SEEDS: { route: Tier0Route; text: string }[] = [
  { route: "quick_q", text: "alpha one" },
  { route: "quick_q", text: "alpha two" },
  { route: "tool_call", text: "bravo one" },
  { route: "tool_call", text: "bravo two" },
  { route: "dispatch", text: "charlie one" },
  { route: "dispatch", text: "charlie two" },
  { route: "deep_review", text: "delta one" },
  { route: "deep_review", text: "delta two" },
]

function makeFakeEncoder() {
  // One orthogonal axis per route letter; anything else → weak vector.
  const BASIS: Record<string, [number, number, number, number]> = {
    A: [1, 0, 0, 0], // alpha → quick_q
    B: [0, 1, 0, 0], // bravo → tool_call
    C: [0, 0, 1, 0], // charlie → dispatch
    D: [0, 0, 0, 1], // delta → deep_review
  }
  const encode = async (
    text: string,
    _opts: { pooling: "mean"; normalize: boolean },
  ): Promise<{ data: Float32Array }> => {
    const first = text.trim().toUpperCase().charAt(0)
    const basis = BASIS[first]
    if (basis) return { data: new Float32Array(basis) }
    // Weak, near-origin vector — dot against any basis = 0.1 (< 0.65).
    return { data: new Float32Array([0.1, 0.1, 0.1, 0.1]) }
  }
  return async () => encode
}

describe("Tier0Classifier (fake encoder, hermetic)", () => {
  const seeds = TEST_SEEDS

  it("routes 'alpha three' → quick_q with confidence 1.0", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("alpha three")
    expect(r.route).toBe("quick_q")
    expect(r.confidence).toBeCloseTo(1, 5)
    expect(r.topRoute).toBe("quick_q")
  })

  it("routes 'bravo something' → tool_call", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("bravo check frank")
    expect(r.route).toBe("tool_call")
  })

  it("routes 'charlie ship it' → dispatch", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("charlie ship it")
    expect(r.route).toBe("dispatch")
  })

  it("routes 'delta ponder' → deep_review", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("delta ponder tradeoffs")
    expect(r.route).toBe("deep_review")
  })

  it("returns route=null when no seed clears the threshold", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("zed zed zed")
    expect(r.route).toBeNull()
    expect(r.confidence).toBe(0)
    expect(r.reason).toBe("below_threshold")
  })

  it("returns route=null with reason=empty_input on whitespace", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("   ")
    expect(r.route).toBeNull()
    expect(r.reason).toBe("empty_input")
  })

  it("honours a stricter custom threshold", async () => {
    const c = new Tier0Classifier({
      encoderFactory: makeFakeEncoder(),
      seeds,
      threshold: 0.99,
    })
    // 'alpha three' cos=1.0 → still clears 0.99.
    const r1 = await c.classify("alpha three")
    expect(r1.route).toBe("quick_q")
    // 'zed' weak vec → cos 0.1 → below 0.99.
    const r2 = await c.classify("zed")
    expect(r2.route).toBeNull()
  })

  it("never throws when encoder factory fails — returns route=null", async () => {
    const brokenFactory = async () => {
      throw new Error("load failed")
    }
    const c = new Tier0Classifier({
      encoderFactory: brokenFactory as never,
      seeds,
    })
    const r = await c.classify("alpha three")
    expect(r.route).toBeNull()
    expect(r.reason).toBe("init_failed")
  })

  it("sticky init-failure short-circuits subsequent calls", async () => {
    let attempts = 0
    const brokenFactory = async () => {
      attempts++
      throw new Error("boom")
    }
    const c = new Tier0Classifier({
      encoderFactory: brokenFactory as never,
      seeds,
    })
    const r1 = await c.classify("alpha three")
    const r2 = await c.classify("alpha three")
    expect(r1.reason).toBe("init_failed")
    expect(r2.reason).toBe("init_failed")
    expect(attempts).toBe(1)
  })

  it("isReady() flips to true after first successful classify", async () => {
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    expect(c.isReady()).toBe(false)
    await c.classify("alpha three")
    expect(c.isReady()).toBe(true)
  })

  it("records topCosine and topRoute even when below threshold", async () => {
    const c = new Tier0Classifier({
      encoderFactory: makeFakeEncoder(),
      seeds,
      threshold: 0.99,
    })
    const r = await c.classify("zed")
    expect(r.route).toBeNull()
    expect(r.topCosine).toBeGreaterThan(0)
    expect(r.topCosine).toBeLessThan(0.5)
    // topRoute will be whichever route the first iteration hit — any of the
    // four is fine; just assert it's recorded (not null).
    expect(r.topRoute).not.toBeNull()
  })

  it("scans every seed and picks the best match", async () => {
    // With two quick_q seeds, confidence still resolves to 1.0 (not 0.5).
    const c = new Tier0Classifier({ encoderFactory: makeFakeEncoder(), seeds })
    const r = await c.classify("alpha other text")
    expect(r.route).toBe("quick_q")
    expect(r.confidence).toBeCloseTo(1, 5)
  })

  it("uses default seed corpus when none injected (dry init path)", async () => {
    // Smoke that the default-seeds path compiles + does not throw when given
    // a hermetic encoder. We force all seeds to hit the weak vector by
    // returning a uniform encoder — every classify() will drop below threshold.
    const weakEncoder = async (
      _text: string,
      _opts: { pooling: "mean"; normalize: boolean },
    ): Promise<{ data: Float32Array }> => ({
      data: new Float32Array([0.1, 0.1, 0.1, 0.1]),
    })
    const c = new Tier0Classifier({
      encoderFactory: async () => weakEncoder,
    })
    const r = await c.classify("anything at all")
    expect(r.route).toBeNull()
    expect(c.isReady()).toBe(true)
  })
})
