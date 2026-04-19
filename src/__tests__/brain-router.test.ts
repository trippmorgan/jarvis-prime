import { describe, it, expect } from 'vitest'
import { classifyMessage } from '../brain/router.js'

describe('classifyMessage', () => {
  describe('slash commands', () => {
    const knownCommands = [
      'toggle',
      'network-status',
      'frank-status',
      'station-check',
      'deploy',
      'dispatch',
      'dev',
    ]

    for (const cmd of knownCommands) {
      it(`classifies /${cmd} as slash`, () => {
        expect(classifyMessage({ text: `/${cmd}` })).toEqual({ kind: 'slash' })
      })

      it(`classifies /${cmd} with arguments as slash`, () => {
        expect(classifyMessage({ text: `/${cmd} some arg here` })).toEqual({
          kind: 'slash',
        })
      })
    }

    it('classifies /toggle with leading whitespace as slash', () => {
      expect(classifyMessage({ text: '   /toggle' })).toEqual({ kind: 'slash' })
    })

    it('classifies /toggle with tab leading whitespace as slash', () => {
      expect(classifyMessage({ text: '\t/toggle status' })).toEqual({
        kind: 'slash',
      })
    })
  })

  describe('unknown slash', () => {
    it('classifies /foo as natural (unknown skill)', () => {
      expect(classifyMessage({ text: '/foo' })).toEqual({ kind: 'natural' })
    })

    it('classifies /unknown-command as natural', () => {
      expect(classifyMessage({ text: '/unknown-command arg' })).toEqual({
        kind: 'natural',
      })
    })

    it('classifies "/ toggle" (space after slash) as natural', () => {
      expect(classifyMessage({ text: '/ toggle' })).toEqual({ kind: 'natural' })
    })

    it('classifies bare "/" as natural', () => {
      expect(classifyMessage({ text: '/' })).toEqual({ kind: 'natural' })
    })
  })

  describe('clinical override', () => {
    it('classifies as clinical when clinicalOverride is true', () => {
      expect(
        classifyMessage({ text: 'anything here', clinicalOverride: true }),
      ).toEqual({ kind: 'clinical' })
    })

    it('classifies as clinical even with slash text when override is true', () => {
      expect(
        classifyMessage({ text: '/toggle', clinicalOverride: true }),
      ).toEqual({ kind: 'clinical' })
    })

    it('classifies as clinical on empty text when override is true', () => {
      expect(classifyMessage({ text: '', clinicalOverride: true })).toEqual({
        kind: 'clinical',
      })
    })

    it('treats clinicalOverride: false as non-clinical', () => {
      expect(
        classifyMessage({ text: 'hello there', clinicalOverride: false }),
      ).toEqual({ kind: 'natural' })
    })
  })

  describe('natural', () => {
    it('classifies empty string as natural', () => {
      expect(classifyMessage({ text: '' })).toEqual({ kind: 'natural' })
    })

    it('classifies whitespace-only as natural', () => {
      expect(classifyMessage({ text: '   \t\n  ' })).toEqual({
        kind: 'natural',
      })
    })

    it('classifies a regular sentence as natural', () => {
      expect(
        classifyMessage({ text: 'What do you think of this idea?' }),
      ).toEqual({ kind: 'natural' })
    })

    it('classifies text that mentions slash-like content mid-sentence as natural', () => {
      expect(
        classifyMessage({ text: 'I was thinking about /toggle behavior' }),
      ).toEqual({ kind: 'natural' })
    })
  })

  describe('userId parameter', () => {
    it('accepts optional userId without affecting classification', () => {
      expect(
        classifyMessage({ text: '/toggle', userId: '12345' }),
      ).toEqual({ kind: 'slash' })
      expect(
        classifyMessage({ text: 'hello', userId: '12345' }),
      ).toEqual({ kind: 'natural' })
    })
  })
})
