/**
 * labels.ts — label collection for a Frank-specific Jev head (2026-09-26, per Tripp:
 * "start collecting labels for a frank head").
 *
 * Legacy self-review consensus and user corrections are weak or potentially unblinded labels.
 * They are not independent gold labels. No minimum sample count or improvement is established.
 * Independent, blind human declarations live separately in shadow-review.ts and are exported
 * only with reviewer provenance and scenario-family groups. Never auto-promote legacy labels.
 *
 * Records hold answer text (mortal, private) — they live next to the round evidence, not in git.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Review, ReviewRecord, JevResult } from './harness-race.js'
import { isJevVerdict } from './harness-race.js'

export const VERDICT_OPTIONS = ['harness', 'jarvis', 'equal', 'abstain'] as const
export type VerdictLabel = (typeof VERDICT_OPTIONS)[number]

export interface RoundLabelRecord {
  type: 'round'
  ts: string
  messageId: string
  chatId: string
  questionType: 'verdict'
  question: string           // the typed question a head would be asked
  task: string               // Tripp's message
  a: string                  // harness answer (RESPONSE A in the Jev state)
  b: string                  // dual-brain answer (RESPONSE B)
  aHash: string
  bHash: string
  inboundHash: string
  options: readonly VerdictLabel[]
  labels: { reviewer_harness: VerdictLabel; reviewer_dual: VerdictLabel; consensus: VerdictLabel }
  jev: { pHarness: number; strong: boolean; head: string } | null   // comparison only, not a label
  evidence: { harness: number; jarvis: number }
  conscienceHash: string | null
  firstDelivered: 'harness' | 'jarvis' | null
  source: 'live' | 'backfill'
}

export interface HumanLabelRecord {
  type: 'human'
  ts: string
  messageId: string
  chatId: string
  questionType: 'verdict'
  label: VerdictLabel
  note: string
  by: string
}

export const labelDir = (): string => process.env.FRANK_LABEL_DIR ?? join(homedir(), '.config', 'lifecoin', 'labels')
export const labelFile = (): string => join(labelDir(), 'frank-verdict.jsonl')

/** A reviewer's verdict, mapped to which ANSWER it prefers. */
export function reviewerLabel(r: Review): VerdictLabel {
  if (r.verdict === 'unparsed') return 'abstain'
  if (r.verdict === 'equal') return 'equal'
  const mine = r.reviewer === 'harness' ? 'harness' : 'jarvis'
  const other = r.reviewer === 'harness' ? 'jarvis' : 'harness'
  return r.verdict === 'mine_better' ? mine : other
}

/** Two reviewers agree → that label; both even → equal; otherwise abstain (a conflict is not a label). */
export function consensusLabel(a: VerdictLabel, b: VerdictLabel): VerdictLabel {
  if (a === 'abstain' || b === 'abstain') return 'abstain'
  return a === b ? a : 'abstain'
}

export function buildRoundLabel(input: {
  record: ReviewRecord
  chatId: string
  task: string
  harnessText: string
  jarvisText: string
  firstDelivered: 'harness' | 'jarvis' | null
  jev?: JevResult | null
  source?: 'live' | 'backfill'
}): RoundLabelRecord {
  const rh = input.record.reviews.find((r) => r.reviewer === 'harness')
  const rd = input.record.reviews.find((r) => r.reviewer === 'dual-brain')
  const lh = rh ? reviewerLabel(rh) : 'abstain'
  const ld = rd ? reviewerLabel(rd) : 'abstain'
  const jev = input.jev ?? input.record.jev
  return {
    type: 'round', ts: new Date().toISOString(), messageId: input.record.messageId, chatId: input.chatId,
    questionType: 'verdict', question: 'Which response better accomplishes the task?', task: input.task,
    a: input.harnessText, b: input.jarvisText, aHash: input.record.harnessHash, bHash: input.record.jarvisHash, inboundHash: input.record.inboundHash,
    options: VERDICT_OPTIONS,
    labels: { reviewer_harness: lh, reviewer_dual: ld, consensus: consensusLabel(lh, ld) },
    jev: isJevVerdict(jev) ? { pHarness: jev.pHarness, strong: jev.strong, head: jev.head } : null,
    evidence: { harness: input.record.evidence?.harness?.length ?? 0, jarvis: input.record.evidence?.jarvis?.length ?? 0 },
    conscienceHash: input.record.conscience?.snapshotHash ?? null,
    firstDelivered: input.firstDelivered,
    source: input.source ?? 'live',
  }
}

/** Append one record. Never throws. Returns false if the write failed. */
export function appendLabel(rec: RoundLabelRecord | HumanLabelRecord): boolean {
  try {
    mkdirSync(labelDir(), { recursive: true })
    appendFileSync(labelFile(), JSON.stringify(rec) + '\n')
    return true
  } catch { return false }
}

/** `/label harness|jarvis|both|neither|skip [note]`, `/label status`. null = not a label command. */
export type LabelCommand = { kind: 'status' } | { kind: 'label'; label: VerdictLabel; note: string }
export function matchLabelCommand(text: string): LabelCommand | null {
  const m = text.trim().match(/^\/label(?:@\w+)?(?:\s+(.*))?$/is)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (!rest || /^(status|help)$/i.test(rest)) return { kind: 'status' }
  const w = rest.match(/^(\S+)\s*([\s\S]*)$/)!
  const word = w[1].toLowerCase(), note = w[2].trim()
  const map: Record<string, VerdictLabel> = {
    harness: 'harness', first: 'harness', h: 'harness', a: 'harness',
    jarvis: 'jarvis', dual: 'jarvis', 'dual-brain': 'jarvis', second: 'jarvis', j: 'jarvis', b: 'jarvis',
    both: 'equal', equal: 'equal', tie: 'equal', same: 'equal',
    neither: 'abstain', none: 'abstain', skip: 'abstain', abstain: 'abstain', unclear: 'abstain',
  }
  const label = map[word]
  if (!label) return { kind: 'status' }
  return { kind: 'label', label, note }
}

/** Latest `round` record for a chat (scans the file; fine at this scale). */
export function latestRoundForChat(chatId: string): RoundLabelRecord | null {
  try {
    if (!existsSync(labelFile())) return null
    const lines = readFileSync(labelFile(), 'utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]) as RoundLabelRecord; if (r.type === 'round' && r.chatId === chatId) return r } catch { /* skip */ }
    }
  } catch { /* fall through */ }
  return null
}

export interface LabelStats { rounds: number; human: number; consensus: Record<string, number>; humanLabels: Record<string, number>; jevAgreesWithHuman: { n: number; agree: number } }
export function labelStats(): LabelStats {
  const st: LabelStats = { rounds: 0, human: 0, consensus: {}, humanLabels: {}, jevAgreesWithHuman: { n: 0, agree: 0 } }
  try {
    if (!existsSync(labelFile())) return st
    const rounds = new Map<string, RoundLabelRecord>()
    const lines = readFileSync(labelFile(), 'utf8').split('\n').filter(Boolean)
    for (const l of lines) {
      let r: RoundLabelRecord | HumanLabelRecord
      try { r = JSON.parse(l) } catch { continue }
      if (r.type === 'round') { st.rounds++; st.consensus[r.labels.consensus] = (st.consensus[r.labels.consensus] ?? 0) + 1; rounds.set(r.messageId, r) }
      else if (r.type === 'human') {
        st.human++; st.humanLabels[r.label] = (st.humanLabels[r.label] ?? 0) + 1
        const round = rounds.get(r.messageId)
        if (round?.jev && (r.label === 'harness' || r.label === 'jarvis')) { st.jevAgreesWithHuman.n++; if ((round.jev.pHarness > 0.5 ? 'harness' : 'jarvis') === r.label) st.jevAgreesWithHuman.agree++ }
      }
    }
  } catch { /* partial */ }
  return st
}

export function formatLabelStatus(st: LabelStats, last: RoundLabelRecord | null): string {
  const c = Object.entries(st.consensus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const h = Object.entries(st.humanLabels).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const j = st.jevAgreesWithHuman.n ? ` · Jev agrees with you ${st.jevAgreesWithHuman.agree}/${st.jevAgreesWithHuman.n}` : ''
  const lastLine = last ? `\nLast round here: "${last.task.slice(0, 60)}${last.task.length > 60 ? '…' : ''}" — reviewers ${last.labels.reviewer_harness}/${last.labels.reviewer_dual}, Jev ${last.jev ? Math.round(last.jev.pHarness * 100) + '% harness' : 'n/a'}` : ''
  return `🏷️ Frank-head labels (verdict): ${st.rounds} rounds, ${st.human} yours (${h}); reviewer consensus: ${c}${j}. Legacy labels are not independently blinded.${lastLine}\nReply /label harness | jarvis | both | neither [note] to label the last round.`
}
