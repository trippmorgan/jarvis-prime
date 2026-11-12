/**
 * In-memory mode state for the /deep toggle.
 *
 * Single-brain (default): every message routes to the active left runtime alone
 *   with tools on.
 * Dual-brain: the corpus-callosum orchestrator runs (left + right hemisphere)
 *   when classification + tier-0 don't already short-circuit to single-brain.
 *
 * Frank (Voldemort) defaults the left runtime to `openclaw` so the local
 * qwen3:30b-a3b model fronts the brain with full tool surface via the openclaw
 * CLI. `/deep claude` flips to the Anthropic CLI fallback for ad-hoc
 * experiments; `/deep openclaw` flips back.
 *
 * State resets to its construction-time defaults on every restart by design —
 * you should never wake up surprised about which brain or runtime is active.
 */

export type Mode = 'single' | 'dual'
export type LeftRuntime = 'openclaw' | 'claude'

export class ModeState {
  private mode: Mode
  private leftRuntime: LeftRuntime

  constructor(initial: Mode = 'single', leftRuntime: LeftRuntime = 'openclaw') {
    this.mode = initial
    this.leftRuntime = leftRuntime
  }

  get current(): Mode {
    return this.mode
  }

  get currentLeftRuntime(): LeftRuntime {
    return this.leftRuntime
  }

  toggle(): Mode {
    this.mode = this.mode === 'single' ? 'dual' : 'single'
    return this.mode
  }

  setLeftRuntime(runtime: LeftRuntime): LeftRuntime {
    this.leftRuntime = runtime
    return this.leftRuntime
  }
}
