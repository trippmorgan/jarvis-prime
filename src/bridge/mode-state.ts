/**
 * In-memory mode state for the /deep toggle.
 *
 * Single-brain (default): every message routes to Claude alone with tools on.
 * Dual-brain: the corpus-callosum orchestrator runs (Claude left + Codex right)
 *   when classification + tier-0 don't already short-circuit to single-brain.
 *
 * State resets to 'single' on every Prime startup by design — you should never
 * wake up surprised in dual-brain mode after a restart. Toggle via /deep.
 */

export type Mode = 'single' | 'dual'

export class ModeState {
  private mode: Mode

  constructor(initial: Mode = 'single') {
    this.mode = initial
  }

  get current(): Mode {
    return this.mode
  }

  toggle(): Mode {
    this.mode = this.mode === 'single' ? 'dual' : 'single'
    return this.mode
  }
}
