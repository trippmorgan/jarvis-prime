import type { Dispatch, ToolEvidence } from "./dispatch-types.js"

/** A single entry in the shared conversation history — mirrors jarvis-prime history.ts schema. */
export interface HistoryEntry {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

/** A single draft produced by one hemisphere in one pass. */
export interface HemisphereDraft {
  /** The hemisphere that produced this draft. */
  hemisphere: "left" | "right"
  /** Which pass of the corpus callosum this draft came from. */
  pass: 1 | 2
  /** The text content of the draft. */
  content: string
  /** Wall-clock duration of the LLM call in ms. */
  durationMs: number
}

/**
 * The return shape of a hemisphere `call`. The base fields (`content`,
 * `durationMs`) are required for Waves 1–7 backward-compat; Wave 8 adds
 * optional `dispatch` + `toolsUsed` for the router path.
 */
export interface HemisphereCallResult {
  content: string
  durationMs: number
  /**
   * Parsed dispatch block when the hemisphere emitted one (left pass-1,
   * router mode). `null` means a block was attempted but parse failed;
   * `undefined` means the hemisphere was not asked to plan.
   */
  dispatch?: Dispatch | null
  /**
   * Tools or skills invoked during the call (on the hemisphere's behalf
   * by the bridge). Surfaces into pass-2 cross-visibility + the card UX.
   */
  toolsUsed?: ToolEvidence[]
}

/** Abstract interface for calling a hemisphere. Both left (Claude) and right (GPT via OpenClaw gateway) implement this. */
export interface HemisphereClient {
  /** Call the hemisphere with a system prompt + user message. Returns the draft text. */
  call(input: {
    system: string
    user: string
    timeoutMs: number
  }): Promise<HemisphereCallResult>
}

/** The full trace of one corpus-callosum message processing — used for logging. */
export interface CallosumTrace {
  p1Left: HemisphereDraft
  p1Right: HemisphereDraft
  p2Left: HemisphereDraft
  p2Right: HemisphereDraft
  integrationMs: number
  totalMs: number
  /** Tools used by the left hemisphere during its pass-1 (router mode only). */
  leftToolsUsed?: ToolEvidence[]
  /** Tools used by the right hemisphere during its pass-1 (router mode only). */
  rightToolsUsed?: ToolEvidence[]
}

/** The final result of corpus-callosum processing. */
export interface BrainResult {
  /** The final integrated response to send back to Tripp. */
  finalText: string
  /** Full trace for logging and debugging. Not persisted to conversation history. */
  trace: CallosumTrace
}

/** Error types so the processor can distinguish and surface appropriately. */
export class LeftHemisphereError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "LeftHemisphereError" }
}
export class RightHemisphereError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "RightHemisphereError" }
}
export class IntegrationError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "IntegrationError" }
}
