import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
process.env.FRANK_ROUND_EVIDENCE_DIR = '/tmp/claude-1000/-home-joevoldemort--openclaw-workspace/bc4ac5e1-0b40-415f-8516-bdbacf823c50/scratchpad/rounds-test'
import { RaceGate, askHarness, attestRound, sha256, isJunkAnswer, REVIEW_SYSTEM, shouldDeliverReview, askJevJudge, isJevVerdict, formatJevLine, type Review, type JevVerdict } from '../bridge/harness-race.js'

describe('RaceGate', () => {
  it('first claimant wins, second learns it is second, record carries hashes', () => {
    const g = new RaceGate('m1', 'chat1', 'hello there')
    expect(g.record.inboundHash).toBe(sha256('hello there'))
    expect(g.record.inboundChars).toBe(11)
    expect(g.claimFirst('harness')).toBe(true)
    expect(g.claimFirst('jarvis')).toBe(false)
    expect(g.winner).toBe('harness')
    expect(g.record.first).toBe('harness')
  })

  it('labels the harness answer by arrival order', () => {
    const a = { text: 'body', mode: 'deep-full', ms: 61_400 }
    expect(RaceGate.labelHarness(a, true)).toMatch(/^⚡ Frank · harness view \(deep-full, 61s\) — dual-brain answer to follow\n\nbody$/)
    expect(RaceGate.labelHarness(a, false)).toMatch(/^⚡ Frank · second view from the harness \(deep-full, 61s\)\n\nbody$/)
  })
})

describe('askHarness', () => {
  let server: http.Server | undefined
  afterEach(() => { server?.close(); server = undefined })

  it('posts history + question and returns text/mode/ms', async () => {
    let seen: unknown
    server = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        seen = JSON.parse(b)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '  answer  ' } }], _meta: { mode: 'medium' } }))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const out = await askHarness({ url: `http://127.0.0.1:${port}`, model: 'frank', timeoutMs: 5000 }, 'q?', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }])
    expect(out.text).toBe('answer')
    expect(out.mode).toBe('medium')
    expect(out.ms).toBeGreaterThanOrEqual(0)
    expect((seen as { model: string }).model).toBe('frank')
    expect((seen as { messages: unknown[] }).messages).toHaveLength(3)
  })

  it('rejects "[no response]" and near-empty answers as junk, keeps short real ones', async () => {
    expect(isJunkAnswer('[no response]')).toBe(true)
    expect(isJunkAnswer('')).toBe(true)
    expect(isJunkAnswer(' ... ')).toBe(true)
    expect(isJunkAnswer('[No Response] .')).toBe(true)
    expect(isJunkAnswer('Yep.')).toBe(false)
    expect(isJunkAnswer('All good here.')).toBe(false)
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '[no response]' } }], _meta: { mode: 'speech' } })) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    await expect(askHarness({ url: `http://127.0.0.1:${port}`, model: 'frank', timeoutMs: 5000 }, 'you good?', [])).rejects.toThrow(/junk content \(mode speech\)/)
  })

  it('carries the harness memory block from _meta when present', async () => {
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'status is fine' } }], _meta: { mode: 'speech', memory: '- gpu: quiet since reseat' } })) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const out = await askHarness({ url: `http://127.0.0.1:${port}`, model: 'frank', timeoutMs: 5000 }, 'q', [])
    expect(out.memory).toBe('- gpu: quiet since reseat')
  })

  it('rejects on empty content and on non-200', async () => {
    server = http.createServer((_req, res) => { res.statusCode = 500; res.end('boom') })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    await expect(askHarness({ url: `http://127.0.0.1:${port}`, model: 'frank', timeoutMs: 5000 }, 'q', [])).rejects.toThrow(/HTTP 500/)
  })
})

describe('attestRound', () => {
  it('is a no-op without a kernel url and never throws on network failure', async () => {
    const g = new RaceGate('m', 'c', 'x')
    expect(await attestRound({ url: 'http://127.0.0.1:1', model: 'frank', timeoutMs: 1 }, 'p', g.record, 'ok')).toBe(0)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    expect(await attestRound({ url: 'http://127.0.0.1:1', model: 'frank', timeoutMs: 1, ledgerKernelUrl: 'http://127.0.0.1:1', ledgerNode: 'voldemort' }, 'p', g.record, 'ok')).toBe(0)
    fetchSpy.mockRestore()
  })

  it('posts a PROCESS_RUN with hashes only', async () => {
    const g = new RaceGate('m', 'c', 'secret text')
    let body: unknown
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => { body = JSON.parse(String(init?.body)); return new Response('', { status: 202 }) })
    const status = await attestRound({ url: 'http://x', model: 'frank', timeoutMs: 1, ledgerKernelUrl: 'http://k', ledgerNode: 'voldemort' }, 'frank-telegram-round', g.record, 'ok')
    fetchSpy.mockRestore()
    expect(status).toBe(202)
    const b = body as { node: string; event_type: string; payload: Record<string, unknown> & { process: string; artifact_hash: string } }
    expect(b.node).toBe('voldemort')
    expect(b.event_type).toBe('PROCESS_RUN')
    expect(b.payload.process).toBe('frank-telegram-round')
    expect(JSON.stringify(b)).not.toContain('secret text')
    expect(b.payload.artifact_hash).toBe(sha256(JSON.stringify(g.record)))
    expect(Object.keys(b.payload).sort()).toEqual(['artifact_bytes', 'artifact_hash', 'duration_ms', 'node', 'outcome', 'process', 'started_at'])
  })
})

import { buildReviewPrompt, parseReview, formatCrossReview } from '../bridge/harness-race.js'

describe('cross-review helpers', () => {
  it('parses a clean review JSON', () => {
    const r = parseReview('harness', 'Sure. {"verdict":"other_better","agree":false,"issues":["wrong year"],"omissions":[],"conscience":"ok","note":"The other answer is more complete."}', 1234)
    expect(r.verdict).toBe('other_better'); expect(r.agree).toBe(false); expect(r.issues).toEqual(['wrong year']); expect(r.conscience).toBe('ok'); expect(r.ms).toBe(1234)
  })
  it('degrades to unparsed on garbage and keeps raw', () => {
    const r = parseReview('dual-brain', 'no json here', 5)
    expect(r.verdict).toBe('unparsed'); expect(r.raw).toBe('no json here')
  })
  it('truncates long answers in the prompt and keeps both sides', () => {
    const p = buildReviewPrompt('Q', 'a'.repeat(7000), 'b')
    expect(p).toContain('QUESTION:\nQ'); expect(p).toContain('[truncated]'); expect(p).toContain("=== THE OTHER BRAIN'S ANSWER ===\nb")
    expect(p).not.toContain('CONTEXT')
  })
  it('gives the reviewer the memory context each side was given, and tells it it has no tools', () => {
    const p = buildReviewPrompt('Q', 'mine', 'theirs', { other: '- atom: fact' , mine: '- my atom' })
    expect(p).toMatch(/=== MY ANSWER ===\nmine\n\n=== CONTEXT MY ANSWER WAS GIVEN \(treat as observed facts\) ===\n- my atom/)
    expect(p).toMatch(/=== THE OTHER BRAIN'S ANSWER ===\ntheirs\n\n=== CONTEXT THE OTHER BRAIN WAS GIVEN \(treat as observed facts\) ===\n- atom: fact/)
    expect(p).toContain('You have no tools')
    expect(REVIEW_SYSTEM).toMatch(/NO tools/); expect(REVIEW_SYSTEM).toMatch(/"unverified"/); expect(REVIEW_SYSTEM).toMatch(/NOT a conscience concern/)
  })
  it('puts the conscience digest in the prompt, parses principle slugs, and names them on a concern', () => {
    const p = buildReviewPrompt('Q', 'mine', 'theirs', { conscience: 'STANDING PRINCIPLES — x\n- gate-failopen: never fail closed' })
    expect(p).toMatch(/=== STANDING PRINCIPLES — x\n- gate-failopen: never fail closed\n\nReview the other brain/)
    expect(REVIEW_SYSTEM).toMatch(/conflict with one of the STANDING PRINCIPLES/); expect(REVIEW_SYSTEM).toMatch(/"principles"/)
    const r = parseReview('harness', '{"verdict":"mine_better","agree":false,"issues":[],"unverified":[],"omissions":[],"conscience":"concern","principles":["gate-failopen"],"note":"fails closed on error"}', 3)
    expect(r.principles).toEqual(['gate-failopen'])
    expect(formatCrossReview([r])).toContain('⚠️ conscience (principle: gate-failopen): fails closed on error')
  })
  it('parses the unverified list and shows it in the summary', () => {
    const r = parseReview('dual-brain', '{"verdict":"equal","agree":true,"issues":[],"unverified":["claims 3 services active"],"omissions":[],"conscience":"ok","note":"n"}', 2)
    expect(r.unverified).toEqual(['claims 3 services active'])
    expect(formatCrossReview([r])).toContain('1 unverified: claims 3 services active')
  })
  it('formats agreement, disagreement, and concern headers', () => {
    const base = { agree: true, issues: [], unverified: [], omissions: [], conscience: 'ok' as const, principles: [], note: 'fine', ms: 1 }
    expect(formatCrossReview([{ ...base, reviewer: 'harness', verdict: 'equal' }, { ...base, reviewer: 'dual-brain', verdict: 'equal' }])).toMatch(/^⚖️ Cross-review — the two brains agree/)
    expect(formatCrossReview([{ ...base, reviewer: 'harness', verdict: 'other_better', agree: false, issues: ['x'] }, { ...base, reviewer: 'dual-brain', verdict: 'mine_better' }])).toMatch(/disagree[\s\S]*prefers the dual-brain answer — 1 factual issue: x[\s\S]*prefers its own answer/)
    expect(formatCrossReview([{ ...base, reviewer: 'harness', verdict: 'equal', conscience: 'concern', note: 'overstates certainty' }])).toMatch(/^⚖️ Cross-review — CONCERN raised[\s\S]*⚠️ conscience: overstates certainty/)
  })
})

describe('shouldDeliverReview (FRANK_CROSS_REVIEW_DELIVERY)', () => {
  const r = (o: Partial<Review>): Review => ({ reviewer: 'harness', verdict: 'equal', agree: true, issues: [], unverified: [], omissions: [], conscience: 'ok', principles: [], note: '', ms: 1, ...o })
  it('flagged (default): skips when both agree cleanly, delivers on concern, issues, or disagreement', () => {
    expect(shouldDeliverReview([r({}), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: false, reason: 'agree' })
    expect(shouldDeliverReview([r({ conscience: 'concern' }), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: true, reason: 'concern' })
    expect(shouldDeliverReview([r({ issues: ['x'] }), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: true, reason: 'issues' })
    expect(shouldDeliverReview([r({ agree: false, verdict: 'mine_better' }), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: true, reason: 'disagree' })
    expect(shouldDeliverReview([r({ unverified: ['claims 3 services active'] }), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: false, reason: 'agree' })
    expect(shouldDeliverReview([r({ verdict: 'unparsed', agree: false }), r({ reviewer: 'dual-brain' })], 'flagged')).toEqual({ deliver: false, reason: 'unparsed' })
  })
  it('always / never override', () => {
    expect(shouldDeliverReview([r({}), r({ reviewer: 'dual-brain' })], 'always').deliver).toBe(true)
    expect(shouldDeliverReview([r({ conscience: 'concern' })], 'never').deliver).toBe(false)
  })
})


// 2026-09-18 — promise-only speech replies are junk (the "Let me pull what's out there" case).
import { isPromiseOnly as _isPromiseOnly, isJunkAnswer as _isJunkAnswer } from '../bridge/harness-race.js'
describe('isPromiseOnly / isJunkAnswer (2026-09-18)', () => {
  it('flags a bare promise with no content', () => {
    expect(_isPromiseOnly("Good — LSU vs. Ole Miss. Let me pull what's actually out there.")).toBe(true)
    expect(_isJunkAnswer("Sure, I'll look that up for you.")).toBe(true)
  })
  it('keeps real answers that happen to mention looking', () => {
    expect(_isPromiseOnly("Let me check the facts: LSU is favored by 3, kickoff 6:30 CDT on ABC, Kiffin returns to Oxford for the first time.")).toBe(false)
    expect(_isPromiseOnly("Load is 3.9, GPU 42°C, disk 73%.\nLet me know if you want more.")).toBe(false)
    expect(_isJunkAnswer('Kickoff is Saturday at 6:30 CDT on ABC.')).toBe(false)
  })
})

// 2026-09-22 — malformed reviewer JSON keeps its verdict.
import { parseReview as _parseReview } from '../bridge/harness-race.js'
describe('parseReview lenient fallback (2026-09-22)', () => {
  it('recovers verdict/agree/conscience from an unclosed array', () => {
    const r = _parseReview('dual-brain', '{"verdict":"other_better","agree":false,"issues":["a conflict","unverified":["x"', 10)
    expect(r.verdict).toBe('other_better'); expect(r.agree).toBe(false); expect(r.conscience).toBe('ok')
  })
  it('still parses well-formed JSON fully', () => {
    const r = _parseReview('harness', '{"verdict":"equal","agree":true,"issues":["i"],"conscience":"concern","note":"n"}', 5)
    expect(r.verdict).toBe('equal'); expect(r.issues).toEqual(['i']); expect(r.conscience).toBe('concern')
  })
})

// 2026-09-22 — execution evidence in the review prompt.
import { buildReviewPrompt as _brp, formatEvidence as _fe } from '../bridge/harness-race.js'
describe('review evidence (2026-09-22)', () => {
  it('shows executed steps for both sides and the evidence rule', () => {
    const p = _brp('q', 'mine', 'other', { mineEvidence: [], otherEvidence: [{ tool: 'ssh', input: 'uname -a', result: 'Darwin 8.11.0 PowerPC' }] })
    expect(p).toContain('WHAT MY SIDE ACTUALLY EXECUTED')
    expect(p).toContain('no tools were executed')
    expect(p).toContain('ssh uname -a → Darwin 8.11.0 PowerPC')
    expect(p).toContain('Evidence rule')
  })
  it('omits evidence blocks when unknown', () => {
    expect(_brp('q', 'a', 'b')).not.toContain('ACTUALLY EXECUTED')
    expect(_fe(undefined)).toContain('no tools')
  })
})

describe('hook 1 — Jev-Omni typed verdict', () => {
  let server: http.Server | undefined
  afterEach(() => { server?.close(); server = undefined })
  const rv = (o: Partial<Review>): Review => ({ reviewer: 'harness', verdict: 'equal', agree: true, issues: [], unverified: [], omissions: [], conscience: 'ok', principles: [], note: '', ms: 1, ...o })
  const jv = (p: number): JevVerdict => ({ pHarness: p, pJarvis: 1 - p, verdict: p > 0.5 ? 'harness' : 'jarvis', strong: p < 0.35 || p > 0.65, positionBias: -0.17, head: 'shipped', order1: 'h1', order2: 'h2', ms: 41000 })

  it('posts task + a(harness) + b(jarvis) to /judge and maps the averaged probability', async () => {
    let seen: unknown
    server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => {
        seen = JSON.parse(b); res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ p_a: 0.8219, p_b: 0.1781, verdict: 'A', position_bias: -0.1738, order1: 'fecb', order2: 'ba28', head: 'shipped' }))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const j = await askJevJudge({ url: 'x', model: 'frank', timeoutMs: 1, jevUrl: `http://127.0.0.1:${port}`, jevTimeoutMs: 5000 }, 'Is frank-brain healthy?', 'HARNESS ANSWER', 'JARVIS ANSWER')
    expect(seen).toEqual({ task: 'Is frank-brain healthy?', a: 'HARNESS ANSWER', b: 'JARVIS ANSWER' })
    expect(isJevVerdict(j)).toBe(true)
    if (isJevVerdict(j)) { expect(j.verdict).toBe('harness'); expect(j.strong).toBe(true); expect(j.pHarness).toBeCloseTo(0.8219); expect(j.order1).toBe('fecb'); expect(j.head).toBe('shipped') }
  })

  it('is fail-soft: disabled, unloaded model, HTTP error and unreachable service all become {error}', async () => {
    expect(await askJevJudge({ url: 'x', model: 'frank', timeoutMs: 1 }, 'q', 'a', 'b')).toEqual({ error: 'jev disabled', ms: 0 })
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'model not loaded; POST /load first' })) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const j = await askJevJudge({ url: 'x', model: 'frank', timeoutMs: 1, jevUrl: `http://127.0.0.1:${port}` }, 'q', 'a', 'b')
    expect(isJevVerdict(j)).toBe(false); expect((j as { error: string }).error).toMatch(/model not loaded/)
    server.close(); server = undefined
    const dead = await askJevJudge({ url: 'x', model: 'frank', timeoutMs: 1, jevUrl: `http://127.0.0.1:${port}`, jevTimeoutMs: 2000 }, 'q', 'a', 'b')
    expect(isJevVerdict(dead)).toBe(false)
  })

  it('formats the typed line and joins it to the cross-review summary', () => {
    expect(formatJevLine(jv(0.82))).toBe('• jev (typed, both orders): clearly prefers the harness answer — harness 82% / dual-brain 18%, position bias -0.17')
    expect(formatJevLine(jv(0.45))).toMatch(/slightly prefers the dual-brain answer — harness 45% \/ dual-brain 55%/)
    expect(formatJevLine({ error: 'jev HTTP 503', ms: 5 })).toBe('• jev (typed): unavailable — jev HTTP 503')
    expect(formatJevLine(null)).toBe('')
    const s = formatCrossReview([rv({}), rv({ reviewer: 'dual-brain' })], jv(0.82))
    expect(s).toMatch(/^⚖️ Cross-review — the two brains agree\n• harness reviewing dual-brain[\s\S]*\n• jev \(typed, both orders\): clearly prefers the harness answer/)
  })

  it('a strong typed verdict is a delivery reason; a mild one is not', () => {
    const agree = [rv({}), rv({ reviewer: 'dual-brain' })]
    expect(shouldDeliverReview(agree, 'flagged', jv(0.82))).toEqual({ deliver: true, reason: 'jev-strong' })
    expect(shouldDeliverReview(agree, 'flagged', jv(0.2))).toEqual({ deliver: true, reason: 'jev-strong' })
    expect(shouldDeliverReview(agree, 'flagged', jv(0.55))).toEqual({ deliver: false, reason: 'agree' })
    expect(shouldDeliverReview(agree, 'flagged', { error: 'down', ms: 1 })).toEqual({ deliver: false, reason: 'agree' })
    expect(shouldDeliverReview([rv({ conscience: 'concern' }), rv({ reviewer: 'dual-brain' })], 'flagged', jv(0.9)).reason).toBe('concern')
    expect(shouldDeliverReview(agree, 'never', jv(0.9)).deliver).toBe(false)
  })
})

