/**
 * harness-race.ts — "two Franks, one receiver" (2026-09-16, per Tripp).
 *
 * jarvis-prime is the single Telegram receiver. For every natural message it
 * fans out to a second brain — the Gibson harness on :30100 (full-integration
 * DEEP by default) — in parallel with its own dual-brain / single-brain path.
 * Whichever answer lands first is delivered first; the other follows, labeled,
 * so Tripp sees both views and the disagreement between them.
 *
 * Every round is chained on the jarvis ledger (kernel POST /api/ledger/attest,
 * PROCESS_RUN, hashes only — never content) so the history of what each brain
 * said, in what order, and how long it took is tamper-evident. The critique
 * pass (each brain reviewing the other) builds on the same round record.
 *
 * All of this is fail-soft: a harness error or a ledger error never blocks or
 * alters the primary answer.
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HistoryEntry } from '../context/history.js'
import type { ConscienceCitation } from './conscience.js'

export interface HarnessRaceConfig {
  url: string            // e.g. http://127.0.0.1:30100
  model: string          // lane by model id: "frank" (auto-route, full DEEP) | "frank-chat" | "frank-deep"
  timeoutMs: number
  ledgerKernelUrl?: string   // e.g. http://100.80.111.84:3000 ; empty = no chaining
  ledgerNode?: string        // node slug registered on the kernel (voldemort)
  kernelToken?: string       // bearer for kernel reads (the conscience); empty = reviewers judge without it
  jevUrl?: string            // Jev-Omni typed-decision service (jev_service.py, default :30110); empty = no typed verdict
  jevTimeoutMs?: number      // CPU-resident Jev answers a both-orders judge in ~30 s; GPU in 0.2 s
  jevRouting?: boolean       // Hold candidates and route one selected answer into delivery.
  jevDeliveryGate?: boolean  // Judge after generators finish; skip the GPU service's bridge-idle wait.
  jevRouteTimeoutMs?: number
  jevCandidateWaitMs?: number
  jevRouteMargin?: number
}

export interface HarnessAnswer {
  text: string
  mode: string           // harness _meta.mode: speech | medium | deep-full | deep-wide | tool-exec | ...
  ms: number
  memory?: string        // network-memory atoms the harness was given for this answer (_meta.memory), if any
  evidence?: ToolEvidence[] // tools the harness actually ran for this answer (_meta.evidence), if any
}

/**
 * 2026-09-17: the harness speech tier delivered a literal "[no response]" to Telegram (15:27).
 * An answer is junk when nothing but that token, whitespace and punctuation is left.
 */
/** 2026-09-22: one executed tool step — what ran, with what input, and a short snippet of what came back. */
export interface ToolEvidence { tool: string; input: string; result: string; status?: string }

/** Render executed steps for a reviewer; empty list → explicit "no tools" line (that is evidence too). */
export function formatEvidence(ev: ToolEvidence[] | null | undefined): string {
  if (!ev || ev.length === 0) return '(no tools were executed — this answer came from the model and its context only)'
  return ev.slice(-15).map((e, i) => `${i + 1}. ${e.tool}${e.status && e.status !== 'ok' ? ` [${e.status}]` : ''} ${e.input.slice(0, 160)} → ${e.result.slice(0, 200)}`).join('\n')
}

export function isJunkAnswer(text: string): boolean {
  const t = String(text ?? '')
  if (t.replace(/\[no response\]/gi, '').replace(/[\s\p{P}\p{S}]+/gu, '').length < 2) return true
  return isPromiseOnly(t)
}

/**
 * 2026-09-18: the speech tier delivered "Good — LSU vs. Ole Miss. Let me pull what's actually out there."
 * (63 chars) as the harness view. A short single-line reply whose only content is an announcement of
 * work it cannot do is not an answer. Multi-line or long replies are never treated as promises.
 */
const PROMISE_RE = /\b(?:let me|i(?:'ll| will|'m going to| am going to)|gonna|hang on|one (?:sec|moment)|give me a (?:sec|second|minute|moment))\b[^.!?\n]{0,40}?\b(?:pull|search|look|check|find|dig|research|fetch|grab|get|see|run|query|scan|gather)\b/i
export function isPromiseOnly(text: string): boolean {
  const t = String(text ?? '').trim()
  if (t.length > 240 || t.includes('\n')) return false
  const m = t.match(PROMISE_RE)
  if (!m || m.index === undefined) return false
  // Substantive content = enough words AFTER the announced verb ("…pull what's out there." has 4).
  const after = t.slice(m.index + m[0].length).trim()
  return after.split(/\s+/).filter(Boolean).length < 8
}

export interface RoundRecord {
  messageId: string
  chatId: string
  startedAt: string
  inboundHash: string
  inboundChars: number
  jarvis?: { hash: string; chars: number; ms: number; path?: string; outcome?: string }
  harness?: { hash: string; chars: number; ms: number; mode: string } | { error: string; ms: number }
  first?: 'jarvis' | 'harness'
  // 2026-10-10 — Jev front-end route decision (bridge/jev-front.ts); hashed into the round evidence like the rest.
  route?: import('./jev-front.js').JevRouteRecord
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** POST to the harness with node:http (global fetch aborts >300 s on headers). */
export function askHarness(cfg: HarnessRaceConfig, question: string, history: HistoryEntry[]): Promise<HarnessAnswer> {
  const start = Date.now()
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ]
  const body = JSON.stringify({ model: cfg.model, messages, stream: false })
  return new Promise((resolve, reject) => {
    const u = new URL('/v1/chat/completions', cfg.url)
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: cfg.timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`harness HTTP ${res.statusCode}: ${buf.slice(0, 160)}`))
          try {
            const d = JSON.parse(buf)
            const text = String(d.choices?.[0]?.message?.content ?? '').trim()
            const mode = String(d._meta?.mode ?? 'unknown')
            if (isJunkAnswer(text)) return reject(new Error(`harness returned empty/junk content (mode ${mode}): ${JSON.stringify(text.slice(0, 40))}`))
            // 2026-09-18 22:28: "Task escalated after 13 attempts… recorded for jarvis-dispatch" reached Telegram as the
            // harness view. An escalation notice is a harness-internal outcome, not an answer for Tripp.
            if (mode === 'frank-escalated' || /^Task escalated after \d+ attempts/i.test(text)) return reject(new Error(`harness escalated without an answer (mode ${mode})`))
            const memory = typeof d._meta?.memory === 'string' && d._meta.memory.trim() ? d._meta.memory : undefined
            const evidence = Array.isArray(d._meta?.evidence)
              ? (d._meta.evidence as Array<Record<string, unknown>>).map((e) => ({ tool: String(e.tool ?? '?'), input: String(e.args ?? ''), result: String(e.result ?? ''), status: String(e.status ?? '') }))
              : undefined
            resolve({ text, mode, ms: Date.now() - start, memory, evidence })
          } catch (e) {
            reject(new Error(`harness bad JSON: ${buf.slice(0, 120)}`))
          }
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error(`harness timeout after ${cfg.timeoutMs} ms`)) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Where the canonical round records live (mortal content; the chain holds only their hashes). */
export const roundEvidenceDir = (): string => process.env.FRANK_ROUND_EVIDENCE_DIR ?? join(homedir(), '.config', 'lifecoin', 'rounds')

/**
 * Chain one PROCESS_RUN on the jarvis ledger. The lifecoin PROCESS_RUN schema is
 * strict (process, node, outcome, exit_code?, started_at, duration_ms,
 * artifact_hash?, artifact_bytes?, observed_at) — anything else is rejected at
 * append time. So the round record is written to ROUND_EVIDENCE_DIR and only
 * its sha256 rides on-chain as artifact_hash. Never throws.
 */
export async function attestRound(cfg: HarnessRaceConfig, process: string, record: RoundRecord, outcome: 'ok' | 'failed' | 'partial', artifact?: string): Promise<number> {
  if (!cfg.ledgerKernelUrl || !cfg.ledgerNode) return 0
  // `artifact` (e.g. the cross-review record) replaces the round record as the evidence that is written and hashed.
  const canon = artifact ?? JSON.stringify(record)
  try {
    const dir = roundEvidenceDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${record.messageId}.${process}.json`), canon + '\n')
  } catch { /* evidence file is best-effort */ }
  const payload = {
    process,
    node: cfg.ledgerNode,
    outcome,
    started_at: record.startedAt,
    duration_ms: Math.max(record.jarvis?.ms ?? 0, (record.harness as { ms?: number } | undefined)?.ms ?? 0),
    artifact_hash: sha256(canon),
    artifact_bytes: Buffer.byteLength(canon),
  }
  try {
    const res = await fetch(`${cfg.ledgerKernelUrl}/api/ledger/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ node: cfg.ledgerNode, event_type: 'PROCESS_RUN', payload }),
      signal: AbortSignal.timeout(8000),
    })
    return res.status
  } catch {
    return 0
  }
}

/**
 * Per-message race state. `claimFirst` is the only synchronisation point:
 * the first brain to call it wins "first"; the second learns it is second.
 */
export class RaceGate {
  readonly record: RoundRecord
  readonly inboundText: string
  jarvisText: string | null = null
  harnessText: string | null = null
  harnessMemory: string | null = null
  harnessEvidence: ToolEvidence[] | null = null
  jarvisEvidence: ToolEvidence[] | null = null
  reviewStarted = false
  routing = false
  selectionComplete = false
  routingResult?: JevResult
  readonly harnessDone: Promise<void>
  private resolveHarness!: () => void
  private first: 'jarvis' | 'harness' | null = null

  constructor(messageId: string, chatId: string, inboundText: string) {
    this.harnessDone = new Promise(resolve => { this.resolveHarness = resolve })
    this.inboundText = inboundText
    this.record = {
      messageId, chatId,
      startedAt: new Date().toISOString(),
      inboundHash: sha256(inboundText),
      inboundChars: inboundText.length,
    }
  }

  claimFirst(who: 'jarvis' | 'harness'): boolean {
    if (this.first === null) { this.first = who; this.record.first = who; return true }
    return false
  }

  get winner(): 'jarvis' | 'harness' | null { return this.first }
  completeHarness(): void { this.resolveHarness() }

  /** Label the harness answer for Telegram delivery, depending on arrival order. */
  static labelHarness(answer: HarnessAnswer, wasFirst: boolean): string {
    const secs = Math.round(answer.ms / 1000)
    const head = wasFirst
      ? `⚡ Frank · harness view (${answer.mode}, ${secs}s) — dual-brain answer to follow`
      : `⚡ Frank · second view from the harness (${answer.mode}, ${secs}s)`
    return `${head}\n\n${answer.text}`
  }
}


// ── Cross-review: each brain reviews the other's answer ───────────────────────

export interface Review {
  reviewer: 'harness' | 'dual-brain'
  verdict: 'other_better' | 'mine_better' | 'equal' | 'unparsed'
  agree: boolean
  issues: string[]        // claims in the OTHER answer that contradict the question, context, or itself
  unverified: string[]    // claims in the OTHER answer the reviewer cannot check (NOT evidence of fabrication)
  omissions: string[]     // things the OTHER answer missed
  conscience: 'ok' | 'concern'
  principles: string[]    // slugs of STANDING PRINCIPLES the OTHER answer conflicts with (from the attested conscience)
  note: string            // one sentence
  ms: number
  raw?: string
}

export interface ReviewRecord {
  messageId: string
  inboundHash: string
  jarvisHash: string
  harnessHash: string
  reviews: Review[]
  startedAt: string
  /** The chain-attested conscience snapshot the reviewers were given (null = kernel unavailable). */
  conscience?: ConscienceCitation | null
  /** 2026-09-22: what each side executed (hashed on-chain with the rest of the record). */
  evidence?: { harness: ToolEvidence[] | null; jarvis: ToolEvidence[] | null }
  /** 2026-09-26 hook 1: the Jev-Omni typed verdict (advisory only; hashes identify evidence, not correctness). */
  jev?: JevResult | null
}

// ── Hook 1: Jev-Omni typed verdict ────────────────────────────────────────────
// Both-order scores are advisory evidence. Hashes identify the local inference records;
// they do not guarantee calibration, correctness, or exact replay across runtimes.
// The delivery gate can use these scores for answer selection. They do not establish Phi or ledger quality.

export interface JevVerdict {
  pHarness: number          // averaged both orders
  pJarvis: number
  verdict: 'harness' | 'jarvis' | 'tie'
  strong: boolean           // p < 0.35 or p > 0.65; routing has a separate both-order policy.
  positionBias: number      // service's (P(A|order1)+P(A|order2))/2 − 0.5
  head: string
  order1: string            // decision hashes from the service's decisions.jsonl
  order2: string
  ms: number
}
export type JevResult = JevVerdict | { error: string; ms: number }

export function isJevVerdict(j: JevResult | null | undefined): j is JevVerdict {
  return !!j && typeof (j as JevVerdict).pHarness === 'number'
}

export const JEV_STRONG_LOW = 0.35
export const JEV_STRONG_HIGH = 0.65

/** POST /judge on the Jev service. Never throws: an unreachable or unloaded service is an `{error}` result. */
export async function askJevJudge(cfg: HarnessRaceConfig, task: string, harnessAnswer: string, jarvisAnswer: string, fetchImpl: typeof fetch = fetch): Promise<JevResult> {
  const start = Date.now()
  if (!cfg.jevUrl) return { error: 'jev disabled', ms: 0 }
  const clip = (t: string, n = 6000) => (t.length > n ? t.slice(0, n) + '\n…[truncated]' : t)
  try {
    const res = await fetchImpl(`${cfg.jevUrl.replace(/\/$/, '')}/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: clip(task, 3000), a: clip(harnessAnswer), b: clip(jarvisAnswer), head: 'shipped', ...(cfg.jevDeliveryGate ? { delivery_gate: true } : {}) }),
      signal: AbortSignal.timeout(cfg.jevTimeoutMs ?? 240_000),
    })
    const ms = Date.now() - start
    if (!res.ok) return { error: `jev HTTP ${res.status}`, ms }
    const d = await res.json() as { ok?: boolean; error?: string; p_a?: number; p_b?: number; verdict?: string; position_bias?: number; head?: string; order1?: string; order2?: string }
    if (d.ok === false || typeof d.p_a !== 'number') return { error: String(d.error ?? 'jev bad response'), ms }
    const validP = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
    if (d.head !== 'shipped' || !validP(d.p_a) || !validP(d.p_b) || Math.abs(d.p_a + d.p_b - 1) > 1e-5 || typeof d.position_bias !== 'number' || !Number.isFinite(d.position_bias) || Math.abs(d.position_bias) > .5 || !d.order1 || !d.order2) return { error: 'jev invalid probabilities, provenance, or non-shipped head', ms }
    const p = d.p_a
    return {
      pHarness: p, pJarvis: typeof d.p_b === 'number' ? d.p_b : 1 - p,
      verdict: p === 0.5 ? 'tie' : p > 0.5 ? 'harness' : 'jarvis',
      strong: p < JEV_STRONG_LOW || p > JEV_STRONG_HIGH,
      positionBias: typeof d.position_bias === 'number' ? d.position_bias : 0,
      head: String(d.head ?? 'shipped'), order1: String(d.order1 ?? ''), order2: String(d.order2 ?? ''), ms,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ms: Date.now() - start }
  }
}

/** One Telegram line for the typed verdict. */
export function formatJevLine(j: JevResult | null | undefined): string {
  if (!j) return ''
  if (!isJevVerdict(j)) return `• jev (typed): unavailable — ${j.error}`
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const who = j.verdict === 'harness' ? 'harness' : 'dual-brain'
  const bias = Math.abs(j.positionBias) >= 0.1 ? `, position bias ${j.positionBias > 0 ? '+' : ''}${j.positionBias.toFixed(2)}` : ''
  return `• jev (typed, both orders): ${j.strong ? 'clearly ' : 'slightly '}prefers the ${who} answer — harness ${pct(j.pHarness)} / dual-brain ${pct(j.pJarvis)}${bias}`
}

export const REVIEW_SYSTEM = `You are one of two brains that answered the same question. Review the OTHER brain's answer against your own.

What you can and cannot do:
- You have NO tools. You cannot run commands, read files, query services, or check the system. You are reading text only.
- Judge only what the two answers CLAIM and any context block provided below. Never state that you checked, ran, observed, or confirmed anything.
- A claim you cannot check goes in "unverified", not "issues". "Fabricated" is only for a claim that contradicts the question, the provided context, or the answer's own text.
- Facts from a provided context block count as observed. An answer that uses them is not confabulating.

Verdict: which answer serves the user better, on substance. Be specific and brief. Do not flatter either answer.

Conscience: "concern" ONLY if an answer could cause harm, leak private data, act beyond what the user asked, deceive the user about what was actually done, or conflict with one of the STANDING PRINCIPLES below (the network's chain-attested conscience) or walk into a listed RECENT FINDING. When a principle is involved, put its slug in "principles". Disagreement, omissions, or unverifiable claims are NOT a conscience concern. If no principles block is provided, judge conscience on harm/leak/overreach/deception alone.

Respond with ONLY a JSON object:
{"verdict":"other_better"|"mine_better"|"equal","agree":true|false,"issues":["<claim in the OTHER answer that is contradicted, and by what>",...],"unverified":["<claim in the OTHER answer you cannot check>",...],"omissions":["<what the OTHER answer missed>",...],"conscience":"ok"|"concern","principles":["<slug of a standing principle the OTHER answer conflicts with>",...],"note":"<one sentence>"}`

export interface ReviewContext {
  mine?: string        // memory/context block MY answer was given
  other?: string       // memory/context block the OTHER answer was given
  conscience?: string  // formatConscienceDigest() of the attested conscience in force
  mineEvidence?: ToolEvidence[] | null   // tools MY side executed (null = unknown, [] = none)
  otherEvidence?: ToolEvidence[] | null  // tools the OTHER side executed
}

export function buildReviewPrompt(question: string, mine: string, other: string, ctx: ReviewContext = {}): string {
  const clip = (t: string, n = 6000) => (t.length > n ? t.slice(0, n) + '\n…[truncated]' : t)
  const mineCtx = ctx.mine?.trim() ? `\n\n=== CONTEXT MY ANSWER WAS GIVEN (treat as observed facts) ===\n${clip(ctx.mine, 2000)}` : ''
  const otherCtx = ctx.other?.trim() ? `\n\n=== CONTEXT THE OTHER BRAIN WAS GIVEN (treat as observed facts) ===\n${clip(ctx.other, 2000)}` : ''
  const conscience = ctx.conscience?.trim() ? `\n\n=== ${clip(ctx.conscience, 4000)}` : ''
  // 2026-09-22: execution evidence. A claim backed by a listed tool result counts as OBSERVED, not
  // unverified; a system/web fact asserted by a side that executed nothing is the one to doubt.
  const mineEv = ctx.mineEvidence !== undefined ? `\n\n=== WHAT MY SIDE ACTUALLY EXECUTED ===\n${formatEvidence(ctx.mineEvidence)}` : ''
  const otherEv = ctx.otherEvidence !== undefined ? `\n\n=== WHAT THE OTHER SIDE ACTUALLY EXECUTED ===\n${formatEvidence(ctx.otherEvidence)}` : ''
  const evRule = mineEv || otherEv ? `\n\nEvidence rule: a claim that matches an executed tool result above is OBSERVED — do not call it unverified or confabulated. A live-system or web fact asserted by a side that executed nothing is unverified. When the two answers conflict, prefer the side whose executed steps support its claim.` : ''
  return `QUESTION:\n${clip(question, 3000)}\n\n=== MY ANSWER ===\n${clip(mine)}${mineCtx}${mineEv}\n\n=== THE OTHER BRAIN'S ANSWER ===\n${clip(other)}${otherCtx}${otherEv}${conscience}${evRule}\n\nReview the other brain's answer. You have no tools yourself; judge the text against the evidence shown. JSON only.`
}

export function parseReview(reviewer: Review['reviewer'], text: string, ms: number): Review {
  const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
  if (!m) return lenientReview(reviewer, text, ms)
  try {
    const j = JSON.parse(m[0]) as Partial<Review> & { verdict?: string; conscience?: string }
    const verdict = (['other_better', 'mine_better', 'equal'] as const).find((v) => v === j.verdict) ?? 'unparsed'
    const list = (x: unknown) => (Array.isArray(x) ? x.map((s) => String(s)).slice(0, 5) : [])
    return {
      reviewer, verdict, agree: Boolean(j.agree), issues: list(j.issues), unverified: list(j.unverified), omissions: list(j.omissions),
      conscience: j.conscience === 'concern' ? 'concern' : 'ok', principles: list((j as { principles?: unknown }).principles), note: String(j.note ?? '').slice(0, 300), ms,
    }
  } catch {
    return lenientReview(reviewer, text, ms)
  }
}

/**
 * 2026-09-22: a reviewer emitted `"issues":["…","unverified":[…` (unclosed array, truncated) and the whole
 * verdict was lost as 'unparsed'. Recover the scalar fields by pattern; lists stay empty; raw is kept.
 */
function lenientReview(reviewer: Review['reviewer'], text: string, ms: number): Review {
  const pick = (k: string) => text.match(new RegExp(`"${k}"\\s*:\\s*"?([a-z_]+)"?`, 'i'))?.[1]
  const verdict = (['other_better', 'mine_better', 'equal'] as const).find((v) => v === pick('verdict')) ?? 'unparsed'
  const note = text.match(/"note"\s*:\s*"([^"]{0,300})/)?.[1] ?? text.slice(0, 200)
  return {
    reviewer, verdict, agree: pick('agree') === 'true', issues: [], unverified: [], omissions: [],
    conscience: pick('conscience') === 'concern' ? 'concern' : 'ok', principles: [], note, ms, raw: text.slice(0, 2000),
  }
}

/** One compact Telegram message summarising both reviews. */
export function formatCrossReview(reviews: Review[], jev?: JevResult | null): string {
  const name = (r: Review['reviewer']) => (r === 'harness' ? 'harness' : 'dual-brain')
  const other = (r: Review['reviewer']) => (r === 'harness' ? 'dual-brain' : 'harness')
  const lines = reviews.map((r) => {
    const v = r.verdict === 'other_better' ? `prefers the ${other(r.reviewer)} answer` : r.verdict === 'mine_better' ? 'prefers its own answer' : r.verdict === 'equal' ? 'calls it even' : 'gave no verdict'
    const flags = [
      r.issues.length ? `${r.issues.length} factual issue${r.issues.length > 1 ? 's' : ''}: ${r.issues[0]}` : '',
      r.unverified.length ? `${r.unverified.length} unverified: ${r.unverified[0]}` : '',
      r.omissions.length ? `${r.omissions.length} omission${r.omissions.length > 1 ? 's' : ''}: ${r.omissions[0]}` : '',
      r.conscience === 'concern' ? `⚠️ conscience${r.principles.length ? ` (principle: ${r.principles.join(', ')})` : ''}: ${r.note}` : '',
    ].filter(Boolean)
    return `• ${name(r.reviewer)} reviewing ${other(r.reviewer)}: ${v}${flags.length ? ' — ' + flags.join('; ') : r.note ? ' — ' + r.note : ''}`
  })
  const bothAgree = reviews.length === 2 && reviews.every((r) => r.agree)
  const concern = reviews.some((r) => r.conscience === 'concern')
  const head = concern ? '⚖️ Cross-review — CONCERN raised' : bothAgree ? '⚖️ Cross-review — the two brains agree' : '⚖️ Cross-review — the two brains disagree'
  // Jev is advisory shadow data, never user-facing review content.
  return `${head}\n${lines.join('\n')}`
}

/**
 * Whether the cross-review summary goes to Telegram this round. Mode from
 * FRANK_CROSS_REVIEW_DELIVERY: "flagged" (default) delivers only when the two brains
 * disagree, either finds issues, or a conscience concern is raised; "always" every
 * round; "never" chain-only. The review is chained and written to evidence regardless.
 */
export function shouldDeliverReview(reviews: Review[], mode: string = process.env.FRANK_CROSS_REVIEW_DELIVERY ?? 'flagged', jev?: JevResult | null): { deliver: boolean; reason: string } {
  const m = mode.trim().toLowerCase()
  if (m === 'always') return { deliver: true, reason: 'always' }
  if (m === 'never') return { deliver: false, reason: 'never' }
  if (reviews.some((r) => r.conscience === 'concern')) return { deliver: true, reason: 'concern' }
  if (reviews.some((r) => r.issues.length > 0)) return { deliver: true, reason: 'issues' }
  if (reviews.some((r) => r.verdict === 'unparsed')) return { deliver: false, reason: 'unparsed' }
  if (reviews.length === 2 && reviews.every((r) => r.agree)) return { deliver: false, reason: 'agree' }
  return { deliver: true, reason: 'disagree' }
}

