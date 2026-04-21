import { describe, it, expect } from 'vitest'
import {
  phaseLabelForEvent,
  INITIAL_ACK_LABEL,
} from '../brain/phase-labels.js'

describe('phaseLabelForEvent', () => {
  describe('natural dual-brain path (transparent labels)', () => {
    it('maps callosum_pass1_start → Drafting…', () => {
      expect(phaseLabelForEvent('callosum_pass1_start', 'natural')).toBe(
        'Drafting…'
      )
    })

    it('maps callosum_pass2_start → Revising…', () => {
      expect(phaseLabelForEvent('callosum_pass2_start', 'natural')).toBe(
        'Revising…'
      )
    })

    it('maps callosum_integration_start → Integrating…', () => {
      expect(phaseLabelForEvent('callosum_integration_start', 'natural')).toBe(
        'Integrating…'
      )
    })

    it('returns null for non-mapped natural event (callosum_done)', () => {
      expect(phaseLabelForEvent('callosum_done', 'natural')).toBeNull()
    })

    it('returns null for other quiet natural events (callosum_start)', () => {
      expect(phaseLabelForEvent('callosum_start', 'natural')).toBeNull()
    })

    it('returns null for natural + single_brain_call_start (wrong path)', () => {
      expect(phaseLabelForEvent('single_brain_call_start', 'natural')).toBeNull()
    })
  })

  describe('single-brain paths (opaque "Thinking…" label)', () => {
    it('maps slash + single_brain_call_start → Thinking…', () => {
      expect(phaseLabelForEvent('single_brain_call_start', 'slash')).toBe(
        'Thinking…'
      )
    })

    it('maps clinical + single_brain_call_start → Thinking…', () => {
      expect(phaseLabelForEvent('single_brain_call_start', 'clinical')).toBe(
        'Thinking…'
      )
    })

    it('maps killswitch + single_brain_call_start → Thinking…', () => {
      expect(phaseLabelForEvent('single_brain_call_start', 'killswitch')).toBe(
        'Thinking…'
      )
    })

    it('returns null for slash + callosum_pass1_start (no transparent labels for slash)', () => {
      expect(phaseLabelForEvent('callosum_pass1_start', 'slash')).toBeNull()
    })

    it('returns null for clinical + callosum_pass2_start', () => {
      expect(phaseLabelForEvent('callosum_pass2_start', 'clinical')).toBeNull()
    })

    it('returns null for killswitch + callosum_integration_start', () => {
      expect(
        phaseLabelForEvent('callosum_integration_start', 'killswitch')
      ).toBeNull()
    })

    it('returns null for slash + single_brain_call_end (only start is mapped)', () => {
      expect(phaseLabelForEvent('single_brain_call_end', 'slash')).toBeNull()
    })
  })

  describe('Wave 8 router events (W8-T4)', () => {
    it('maps natural + router_plan_start → Planning…', () => {
      expect(phaseLabelForEvent('router_plan_start', 'natural')).toBe(
        'Planning…'
      )
    })

    it('maps natural + self_correction_retry_start → Re-planning…', () => {
      expect(phaseLabelForEvent('self_correction_retry_start', 'natural')).toBe(
        'Re-planning…'
      )
    })

    it('returns null for slash + router_plan_start (router is natural-only)', () => {
      expect(phaseLabelForEvent('router_plan_start', 'slash')).toBeNull()
    })

    it('returns null for clinical + self_correction_retry_start', () => {
      expect(
        phaseLabelForEvent('self_correction_retry_start', 'clinical')
      ).toBeNull()
    })
  })

  describe('unknown events', () => {
    it('returns null for a completely unknown event on natural', () => {
      expect(phaseLabelForEvent('bogus_event', 'natural')).toBeNull()
    })

    it('returns null for empty string event', () => {
      expect(phaseLabelForEvent('', 'natural')).toBeNull()
    })
  })
})

describe('INITIAL_ACK_LABEL', () => {
  it('equals "Thinking…"', () => {
    expect(INITIAL_ACK_LABEL).toBe('Thinking…')
  })
})
