import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewerLabel, consensusLabel, buildRoundLabel, appendLabel, matchLabelCommand, latestRoundForChat, labelStats, formatLabelStatus, labelFile } from '../bridge/labels.js'
import type { Review, ReviewRecord } from '../bridge/harness-race.js'

const rv = (o: Partial<Review>): Review => ({ reviewer: 'harness', verdict: 'equal', agree: true, issues: [], unverified: [], omissions: [], conscience: 'ok', principles: [], note: '', ms: 1, ...o })
const rec = (reviews: Review[], jev?: ReviewRecord['jev']): ReviewRecord => ({ messageId: 'm1', inboundHash: 'ih', jarvisHash: 'jh', harnessHash: 'hh', reviews, startedAt: 't', conscience: { snapshotHash: 'cs', attested: true, generatedAt: 'g' }, evidence: { harness: [{ tool: 'bash', input: 'ls', result: 'x' }], jarvis: null }, jev })

describe('Frank-head label collection', () => {
  beforeEach(() => { process.env.FRANK_LABEL_DIR = mkdtempSync(join(tmpdir(), 'frank-labels-')) })

  it('maps each reviewer verdict to the answer it prefers, and consensus abstains on conflict', () => {
    expect(reviewerLabel(rv({ reviewer: 'harness', verdict: 'other_better' }))).toBe('jarvis')
    expect(reviewerLabel(rv({ reviewer: 'harness', verdict: 'mine_better' }))).toBe('harness')
    expect(reviewerLabel(rv({ reviewer: 'dual-brain', verdict: 'other_better' }))).toBe('harness')
    expect(reviewerLabel(rv({ reviewer: 'dual-brain', verdict: 'mine_better' }))).toBe('jarvis')
    expect(reviewerLabel(rv({ verdict: 'unparsed' }))).toBe('abstain')
    expect(consensusLabel('harness', 'harness')).toBe('harness')
    expect(consensusLabel('equal', 'equal')).toBe('equal')
    expect(consensusLabel('harness', 'jarvis')).toBe('abstain')
    expect(consensusLabel('harness', 'abstain')).toBe('abstain')
  })

  it('builds a round record with texts, weak labels, Jev for comparison, and appends it', () => {
    const r = buildRoundLabel({ record: rec([rv({ reviewer: 'harness', verdict: 'other_better' }), rv({ reviewer: 'dual-brain', verdict: 'mine_better' })], { pHarness: 0.88, pJarvis: 0.12, verdict: 'harness', strong: true, positionBias: 0, head: 'shipped', order1: '', order2: '', ms: 1 }), chatId: 'c1', task: 'is jev up?', harnessText: 'A', jarvisText: 'B', firstDelivered: 'harness' })
    expect(r.labels).toEqual({ reviewer_harness: 'jarvis', reviewer_dual: 'jarvis', consensus: 'jarvis' })
    expect(r.jev).toEqual({ pHarness: 0.88, strong: true, head: 'shipped' })
    expect(r.evidence).toEqual({ harness: 1, jarvis: 0 }); expect(r.conscienceHash).toBe('cs'); expect(r.a).toBe('A'); expect(r.b).toBe('B')
    expect(appendLabel(r)).toBe(true)
    expect(readFileSync(labelFile(), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(latestRoundForChat('c1')?.messageId).toBe('m1'); expect(latestRoundForChat('other')).toBeNull()
  })

  it('parses /label commands with synonyms, notes and status', () => {
    expect(matchLabelCommand('hello')).toBeNull()
    expect(matchLabelCommand('/label')).toEqual({ kind: 'status' })
    expect(matchLabelCommand('/label status')).toEqual({ kind: 'status' })
    expect(matchLabelCommand('/label harness')).toEqual({ kind: 'label', label: 'harness', note: '' })
    expect(matchLabelCommand('/label@FrankBot second it actually checked')).toEqual({ kind: 'label', label: 'jarvis', note: 'it actually checked' })
    expect(matchLabelCommand('/label both')).toEqual({ kind: 'label', label: 'equal', note: '' })
    expect(matchLabelCommand('/label neither')).toEqual({ kind: 'label', label: 'abstain', note: '' })
    expect(matchLabelCommand('/label banana')).toEqual({ kind: 'status' })
  })

  it('stats count rounds, human labels and Jev agreement with the human', () => {
    const r = buildRoundLabel({ record: rec([rv({}), rv({ reviewer: 'dual-brain' })], { pHarness: 0.88, pJarvis: 0.12, verdict: 'harness', strong: true, positionBias: 0, head: 'shipped', order1: '', order2: '', ms: 1 }), chatId: 'c1', task: 'q', harnessText: 'A', jarvisText: 'B', firstDelivered: null })
    appendLabel(r)
    appendLabel({ type: 'human', ts: 't', messageId: 'm1', chatId: 'c1', questionType: 'verdict', label: 'jarvis', note: '', by: 'tripp' })
    const st = labelStats()
    expect(st.rounds).toBe(1); expect(st.human).toBe(1); expect(st.consensus).toEqual({ equal: 1 }); expect(st.humanLabels).toEqual({ jarvis: 1 })
    expect(st.jevAgreesWithHuman).toEqual({ n: 1, agree: 0 })
    expect(formatLabelStatus(st, r)).toMatch(/1 rounds, 1 yours \(jarvis 1\); reviewer consensus: equal 1 · Jev agrees with you 0\/1\. Target ≥250 per type\.\nLast round here: "q" — reviewers equal\/equal, Jev 88% harness/)
  })
})
