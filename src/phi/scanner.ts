const CLINICAL_CONTEXT =
  /\b(patient|diagnosis|procedure|allergic|prescribed|admitted|discharged|medication|treatment|clinical|hospital|surgeon|surgery|operative|intraoperative|chart|encounter|icd[\s-]?10)\b/i

const MRN_PATTERN = /\bMRN\s*[:#]/i
const DOB_PATTERN = /\bDOB\s*:/i
const DATE_OF_BIRTH = /\bdate of birth\b/i
const NAME_INTRO = /\b(?:patient|pt)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/
const CLINICAL_NOTE =
  /\b(patient underwent|incision made|procedure performed|post[\s-]?operative|pre[\s-]?operative|intraoperatively|the patient was|patient tolerated)\b/i
const EMR_KEYWORDS =
  /\b(athena|operative note|encounter\s*#|encounter number|chart note|problem list|allergy list)\b/i

export interface PhiScanResult {
  blocked: boolean
  reasons: string[]
}

export function scanText(text: string): PhiScanResult {
  const reasons: string[] = []

  if (MRN_PATTERN.test(text)) reasons.push('mrn_detected')
  if (DOB_PATTERN.test(text) || DATE_OF_BIRTH.test(text)) reasons.push('dob_detected')
  if (NAME_INTRO.test(text)) reasons.push('patient_name_detected')
  if (CLINICAL_NOTE.test(text)) reasons.push('clinical_note_detected')
  if (EMR_KEYWORDS.test(text)) reasons.push('emr_context_detected')

  // Date + clinical context combo
  const hasDate = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/.test(text)
  if (hasDate && CLINICAL_CONTEXT.test(text)) reasons.push('date_in_clinical_context')

  return { blocked: reasons.length > 0, reasons }
}
