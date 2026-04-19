import { describe, it, expect } from 'vitest'
import { scanText } from '../phi/scanner.js'

describe('scanText', () => {
  it('blocks MRN patterns', () => {
    expect(scanText('MRN: 123456').blocked).toBe(true)
    expect(scanText('MRN #789012').blocked).toBe(true)
  })

  it('blocks DOB patterns', () => {
    expect(scanText('DOB: 01/15/1960').blocked).toBe(true)
    expect(scanText('date of birth is listed').blocked).toBe(true)
  })

  it('blocks patient name patterns', () => {
    expect(scanText('patient John Smith was admitted').blocked).toBe(true)
    expect(scanText('pt Jane Doe prescribed').blocked).toBe(true)
  })

  it('blocks clinical note language', () => {
    expect(scanText('patient underwent carotid endarterectomy').blocked).toBe(true)
    expect(scanText('incision made in the left groin').blocked).toBe(true)
  })

  it('blocks EMR context', () => {
    expect(scanText('check the operative note').blocked).toBe(true)
    expect(scanText('athena encounter details').blocked).toBe(true)
  })

  it('allows normal messages', () => {
    expect(scanText('What is the weather today?').blocked).toBe(false)
    expect(scanText('Check Frank GPU temps').blocked).toBe(false)
    expect(scanText('Deploy jarvis-prime to superserver').blocked).toBe(false)
  })

  it('allows clinical terms without patient context', () => {
    expect(scanText('What ICD-10 code is used for diabetes?').blocked).toBe(false)
    expect(scanText('Search PubMed for carotid stenting outcomes').blocked).toBe(false)
  })

  it('returns specific reasons', () => {
    const result = scanText('MRN: 123456, DOB: 01/15/1960')
    expect(result.blocked).toBe(true)
    expect(result.reasons).toContain('mrn_detected')
    expect(result.reasons).toContain('dob_detected')
  })
})
