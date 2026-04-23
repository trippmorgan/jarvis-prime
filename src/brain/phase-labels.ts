/**
 * Phase labels for orchestrator events.
 *
 * Maps orchestrator telemetry events to user-facing phase labels used to edit
 * the initial ack message. Most events are quiet (return null); only a small
 * set of "start" events flip the label.
 *
 * Design: the natural dual-brain path exposes *transparent* labels that reveal
 * the dual-brain machinery (Drafting → Revising → Integrating). The other
 * classification kinds (slash, clinical, killswitch) use a single *opaque*
 * "Thinking…" label to hide single-brain complexity.
 */

export type OrchestratorKind =
  | 'natural'
  | 'slash'
  | 'clinical'
  | 'killswitch'
  | 'tier0_quick'
  | 'short_msg_fast_lane'

export const INITIAL_ACK_LABEL = 'Thinking…'

const NATURAL_LABELS: Record<string, string> = {
  router_plan_start: 'Planning…',
  callosum_pass1_start: 'Drafting…',
  callosum_pass2_start: 'Revising…',
  callosum_integration_start: 'Integrating…',
  self_correction_retry_start: 'Re-planning…',
}

const SINGLE_BRAIN_LABELS: Record<string, string> = {
  single_brain_call_start: 'Thinking…',
}

/**
 * Returns the user-facing phase label for an orchestrator event, or null
 * if this event should not trigger a message edit (most events are quiet).
 *
 * Natural dual-brain uses **transparent** labels that reveal the dual-brain
 * machinery. Slash/clinical/killswitch use a single **opaque** "Thinking…"
 * label to hide complexity.
 */
export function phaseLabelForEvent(
  event: string,
  kind: OrchestratorKind
): string | null {
  if (kind === 'natural') {
    return NATURAL_LABELS[event] ?? null
  }

  // slash | clinical | killswitch → single-brain path
  return SINGLE_BRAIN_LABELS[event] ?? null
}
