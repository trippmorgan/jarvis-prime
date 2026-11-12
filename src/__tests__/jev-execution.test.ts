import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor } from '../bridge/processor.js'
import { askJevRoute, type JevRoute } from '../bridge/jev-front.js'
import { askJevAcceptance } from '../bridge/jev-acceptance.js'
import { askHarness, harnessAffordance } from '../bridge/harness-race.js'
import { evaluateShadow } from '../bridge/shadow-review.js'
import { spawnClaudeStream } from '../claude/spawner-stream.js'

const reviewer = vi.hoisted(() => ({ call: vi.fn(), config: vi.fn() }))
vi.mock('../claude/spawner-stream.js', () => ({ spawnClaudeStream: vi.fn() }))
vi.mock('../bridge/harness-race.js', async original => ({ ...await original<object>(), askHarness: vi.fn(), harnessAffordance: vi.fn(async () => null), attestRound: vi.fn(async () => 202) }))
vi.mock('../bridge/jev-front.js', async original => ({ ...await original<object>(), askJevRoute: vi.fn() }))
vi.mock('../bridge/jev-acceptance.js', async original => ({ ...await original<object>(), askJevAcceptance: vi.fn() }))
vi.mock('../bridge/shadow-review.js', () => ({ localService: vi.fn(() => true), collectShadow: vi.fn(),
  collectCase: vi.fn(input => ({ ...input, id: 'synthetic' })), evaluateShadow: vi.fn(), recordAnswerSelection: vi.fn() }))
vi.mock('../brain/right-hemisphere.js', () => ({ RightHemisphereClient: class {
  constructor(config: unknown) { reviewer.config(config) }
  call(input: unknown) { return reviewer.call(input) }
} }))

function setup(route: JevRoute, evolving = false, opts: { parallel?: boolean; executor?: 'left' | 'harness'; quickSkills?: string[]; settledSkills?: string[]; graceMs?: number; minElapsedMs?: number } = {}) {
  vi.mocked(askJevRoute).mockResolvedValue({ route, confidence: .9, p: { quick: .1, tools: .1, web: .1, deep: .7 }, ms: 1, hash: 'route', device: 'cuda' })
  const historyPath = join(mkdtempSync(join(tmpdir(), 'jev-plan-')), 'history.jsonl')
  const deliver = vi.fn(async () => {})
  const surface = { sendMessageAndGetId: vi.fn(async () => 42), editMessageText: vi.fn(async () => true), sendChatAction: vi.fn(async () => true) }
  const orchestrator = vi.fn(async () => ({ finalText: 'primary answer', trace: { totalMs: 1, integrationMs: 1 } } as any))
  const processor = new MessageProcessor({ claudePath: 'synthetic', claudeModel: 'synthetic', claudeTimeoutMs: 1000, workingDir: '/tmp', nodeName: 'test', botUsername: 'test', historyPath,
    corpusCallosumEnabled: true, defaultMode: opts.parallel ? 'single' : 'dual', defaultLeftRuntime: 'claude', orchestrator,
    shortMessageFastLaneEnabled: false, gatewayUrl: 'http://unused', gatewayToken: '', rightModel: 'test', corpusCallosumTimeoutMs: 1000,
    evolvingMessageEnabled: evolving, telegramSurface: surface,
    jevFront: { jevUrl: 'http://127.0.0.1:1', mode: 'all', device: 'gpu', timeoutMs: 100, strong: .6, strongByRoute: { quick: .8 }, parallel: !!opts.parallel },
    harnessRace: { url: 'http://unused', model: 'test', timeoutMs: 1000, jevUrl: 'http://127.0.0.1:1', jevRouting: true, jevExecutionPlans: true,
      jevCandidateWaitMs: 5, jevRouteTimeoutMs: 100, jevReviewTimeoutMs: 100, jevSelectionBudgetMs: 1000, jevToolsExecutor: opts.executor ?? 'left', jevQuickSkills: opts.quickSkills, jevSettledSkills: opts.settledSkills,
      ...(opts.graceMs !== undefined ? { jevCompetingPrimaryGraceMs: opts.graceMs, jevCompetingMinElapsedMs: opts.minElapsedMs ?? 0 } : {}) },
  }, deliver, Fastify({ logger: !!process.env.T_LOG }).log)
  return { processor, deliver, surface, orchestrator, historyPath }
}

describe('JEV execution plans through actual processor delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('FRANK_CROSS_REVIEW', '1')
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false })
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'test', ms: 1 })
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'deliver', pDeliver: .9, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    reviewer.call.mockResolvedValue({ content: JSON.stringify({ answer: 'reviewed answer', needs_execution: false, findings: [] }), durationMs: 1 })
    vi.mocked(evaluateShadow).mockImplementation(async (_cfg, _case, _dir, _fetch, cb) => {
      cb?.({ pHarness: .8, pJarvis: .2, positionBias: 0, head: 'shipped', order1: 'a', order2: 'b', verdict: 'harness', strong: true, ms: 1 }); return 'recorded'
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([false, true])('quick generates once, gates once, and delivers once; evolving=%s', async evolving => {
    const { processor, deliver, surface, orchestrator, historyPath } = setup('quick', evolving)
    expect((await processor.submitAndWait('test', 'synthetic question', 'test')).result).toBe('primary answer')
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1); expect(orchestrator).not.toHaveBeenCalled(); expect(askHarness).not.toHaveBeenCalled()
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled()
    if (evolving) expect(surface.editMessageText).toHaveBeenCalledWith('test', 42, 'primary answer')
    else expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['primary answer'])
  })
  it('tools: an accepted executor report is delivered with no reviewer generation (2026-10-29)', async () => {
    const { processor, deliver, orchestrator } = setup('tools')
    expect((await processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('primary answer')
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1); expect(orchestrator).not.toHaveBeenCalled(); expect(askHarness).not.toHaveBeenCalled()
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled(); expect(evaluateShadow).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
  })
  it('tools uses one executor and a reviewer carrying captured evidence with tools disabled', async () => {
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'review', pDeliver: .4, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    vi.mocked(spawnClaudeStream).mockImplementation(async (_prompt, opts) => {
      opts.onEvent?.({ type: 'user', message: { content: [{ type: 'tool_result', name: 'exec', input: { command: 'check' }, text: 'observed proof' }] } })
      return { output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }
    })
    const { processor, deliver, orchestrator, historyPath } = setup('tools')
    expect((await processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('reviewed answer')
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1); expect(orchestrator).not.toHaveBeenCalled(); expect(askHarness).not.toHaveBeenCalled()
    expect(reviewer.call).toHaveBeenCalledTimes(1); expect(reviewer.config).toHaveBeenCalledWith(expect.objectContaining({ disableTools: true }))
    expect(reviewer.call.mock.calls[0][0].user).toContain('observed proof')
    expect(vi.mocked(evaluateShadow).mock.calls[0][1].evidence.jarvis[0].result).toBe('observed proof')
    expect(deliver).toHaveBeenLastCalledWith('test', 'reviewed answer')
    expect(readFileSync(historyPath, 'utf8')).not.toContain('primary answer')
  })
  it('tools dispatched to the harness executor: harness answers, LEFT never runs, gate + history + delivery as usual (2026-10-31)', async () => {
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'frank-tool', ms: 1, evidence: [{ tool: 'exec', input: 'uptime', result: 'up 3 days', status: 'observed' }] })
    const { processor, deliver, orchestrator, historyPath } = setup('tools', false, { executor: 'harness' })
    expect((await processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('harness answer')
    expect(askHarness).toHaveBeenCalledTimes(1); expect(spawnClaudeStream).not.toHaveBeenCalled(); expect(orchestrator).not.toHaveBeenCalled()
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness answer')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['harness answer'])
  })
  it('harness executor: a review carries the harness evidence; a harness failure falls back to the LEFT loop', async () => {
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'review', pDeliver: .4, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'frank-tool', ms: 1, evidence: [{ tool: 'exec', input: 'uptime', result: 'harness proof', status: 'observed' }] })
    const a = setup('tools', false, { executor: 'harness' })
    expect((await a.processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('reviewed answer')
    expect(reviewer.call).toHaveBeenCalledTimes(1); expect(reviewer.call.mock.calls[0][0].user).toContain('harness proof'); expect(spawnClaudeStream).not.toHaveBeenCalled()
    vi.clearAllMocks()
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'deliver', pDeliver: .9, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false })
    vi.mocked(askHarness).mockRejectedValue(new Error('harness down'))
    const b = setup('tools', false, { executor: 'harness' })
    expect((await b.processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('primary answer')
    expect(askHarness).toHaveBeenCalledTimes(1); expect(spawnClaudeStream).toHaveBeenCalledTimes(1)
    expect(b.deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
    vi.clearAllMocks()
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'deliver', pDeliver: .9, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false })
    vi.mocked(askHarness).mockResolvedValue({ text: 'Task blocked: PHI content detected in request.', mode: 'frank-phi-blocked', ms: 1 })
    const c = setup('tools', false, { executor: 'harness' })
    expect((await c.processor.submitAndWait('test', 'synthetic tool task', 'test')).result).toBe('primary answer')
    expect(spawnClaudeStream).toHaveBeenCalledTimes(1); expect(c.deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
    expect(readFileSync(c.historyPath, 'utf8')).not.toContain('Task blocked')
  })
  it('quick plan affording a configured harness skill executes on the harness; the unverified preface is stripped (2026-10-31)', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('self_model')
    vi.mocked(askHarness).mockResolvedValue({ text: 'Execution observed; task completion has not been independently verified.\n\nharness self answer', mode: 'frank-tool', ms: 1, evidence: [] })
    const { processor, deliver, historyPath } = setup('quick', false, { executor: 'harness', quickSkills: ['self_model'] })
    expect((await processor.submitAndWait('test', 'what are you', 'test')).result).toBe('harness self answer')
    expect(harnessAffordance).toHaveBeenCalledTimes(1); expect(askHarness).toHaveBeenCalledTimes(1); expect(spawnClaudeStream).not.toHaveBeenCalled()
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness self answer')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['harness self answer'])
  })
  it('quick plan with no affording skill, or an unlisted one, stays on the LEFT; no probe without configured skills', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('weather')
    const a = setup('quick', false, { executor: 'harness', quickSkills: ['self_model'] })
    expect((await a.processor.submitAndWait('test', 'weather tomorrow', 'test')).result).toBe('primary answer')
    expect(harnessAffordance).toHaveBeenCalledTimes(1); expect(askHarness).not.toHaveBeenCalled(); expect(spawnClaudeStream).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false })
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'deliver', pDeliver: .9, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    const b = setup('quick', false, { executor: 'harness' })
    expect((await b.processor.submitAndWait('test', 'what are you', 'test')).result).toBe('primary answer')
    expect(harnessAffordance).not.toHaveBeenCalled(); expect(askHarness).not.toHaveBeenCalled()
  })
  it('competing: a slow LEFT past the grace → harness answer gated alone and delivered once; the LEFT result is discarded (2026-10-31)', async () => {
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'deep-full', ms: 1, evidence: [] })
    const { processor, deliver, historyPath, orchestrator } = setup('deep', false, { graceMs: 50, minElapsedMs: 0 })
    orchestrator.mockImplementation(() => new Promise(r => setTimeout(() => r({ finalText: 'late primary', trace: { totalMs: 400, integrationMs: 1 } } as any), 400)))
    const t0 = Date.now()
    const { result } = await processor.submitAndWait('test', 'synthetic analysis task', 'test')
    expect(result).toBe('harness answer'); expect(Date.now() - t0).toBeLessThan(350)   // the HTTP waiter resolved before the LEFT finished
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(evaluateShadow).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 500))                                           // let the LEFT finish
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness answer')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['harness answer'])
  })
  it('competing: a LEFT inside the grace still gets the pair judge', async () => {
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'deep-full', ms: 1, evidence: [] })
    const { processor, deliver } = setup('deep', false, { graceMs: 2_000, minElapsedMs: 0 })
    expect((await processor.submitAndWait('test', 'synthetic analysis task', 'test')).result).toBe('harness answer')
    expect(evaluateShadow).toHaveBeenCalledTimes(1); expect(askJevAcceptance).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness answer')
  })
  it('deep keeps competing candidates and avoids redundant cross-review', async () => {
    const { processor, orchestrator } = setup('deep')
    expect((await processor.submitAndWait('test', 'synthetic analysis task', 'test')).result).toBe('harness answer')
    expect(askHarness).toHaveBeenCalledTimes(1); expect(orchestrator).toHaveBeenCalledTimes(1)
    expect(reviewer.call).not.toHaveBeenCalled()
  })
  it('web is one executor with the search tool, not a second brain (2026-10-29)', async () => {
    const { processor, orchestrator } = setup('web')
    expect((await processor.submitAndWait('test', 'synthetic lookup task', 'test')).result).toBe('primary answer')
    expect(askHarness).not.toHaveBeenCalled(); expect(orchestrator).not.toHaveBeenCalled(); expect(spawnClaudeStream).toHaveBeenCalledTimes(1)
    expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled()
  })
  it('route-while-generating: quick decides on the CPU weights while the single brain answers', async () => {
    const { processor, deliver } = setup('quick', false, { parallel: true })
    let resolveRoute!: (r: unknown) => void
    vi.mocked(askJevRoute).mockImplementation(() => new Promise(resolve => { resolveRoute = resolve }) as any)
    const pending = processor.submitAndWait('test', 'synthetic question', 'test')
    await vi.waitFor(() => expect(askJevRoute).toHaveBeenCalledTimes(1))
    expect(vi.mocked(askJevRoute).mock.calls[0][0]).toMatchObject({ device: 'cpu', parallel: true })
    await vi.waitFor(() => expect(spawnClaudeStream).toHaveBeenCalledTimes(1))   // generation did not wait for the route
    resolveRoute({ route: 'quick', confidence: .9, p: { quick: .9, tools: .05, web: .03, deep: .02 }, ms: 1, hash: 'route', device: 'cpu' })
    expect((await pending).result).toBe('primary answer')
    expect(askHarness).not.toHaveBeenCalled(); expect(askJevAcceptance).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
  })
  it('route-while-generating: a quick route under its 0.8 gate stays on the tools plan', async () => {
    const { processor } = setup('quick', false, { parallel: true })
    vi.mocked(askJevRoute).mockResolvedValue({ route: 'quick', confidence: .7, p: { quick: .7, tools: .2, web: .05, deep: .05 }, ms: 1, hash: 'route', device: 'cpu' })
    expect((await processor.submitAndWait('test', 'synthetic question', 'test')).result).toBe('primary answer')
    expect(askHarness).not.toHaveBeenCalled(); expect(askJevAcceptance).toHaveBeenCalledTimes(1)
  })
  it('route-while-generating: deep attaches the harness competitor late and still judges the pair', async () => {
    const { processor, orchestrator } = setup('deep', false, { parallel: true })
    expect((await processor.submitAndWait('test', 'synthetic analysis task', 'test')).result).toBe('harness answer')
    expect(askHarness).toHaveBeenCalledTimes(1); expect(orchestrator).not.toHaveBeenCalled(); expect(spawnClaudeStream).toHaveBeenCalledTimes(1)
    expect(evaluateShadow).toHaveBeenCalledTimes(1); expect(reviewer.call).not.toHaveBeenCalled()
  })
  it('route-while-generating: a failed route still delivers through the tools gate', async () => {
    const { processor } = setup('quick', false, { parallel: true })
    vi.mocked(askJevRoute).mockRejectedValue(new Error('jev down'))
    expect((await processor.submitAndWait('test', 'synthetic question', 'test')).result).toBe('primary answer')
    expect(askHarness).not.toHaveBeenCalled(); expect(askJevAcceptance).toHaveBeenCalledTimes(1)
  })
  it('quick escalation remains a bounded tool-free review', async () => {
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'review', pDeliver: .4, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    const { processor } = setup('quick')
    expect((await processor.submitAndWait('test', 'synthetic question', 'test')).result).toBe('reviewed answer')
    expect(reviewer.call).toHaveBeenCalledTimes(1); expect(askHarness).not.toHaveBeenCalled(); expect(evaluateShadow).toHaveBeenCalledTimes(1)
  })
  it('review timeout returns one answer and ignores a late reviewer', async () => {
    vi.mocked(askJevAcceptance).mockResolvedValue({ action: 'review', pDeliver: .4, positionBias: 0, order1: 'a', order2: 'b', ms: 1 })
    let late!: (r: unknown) => void
    reviewer.call.mockImplementation(() => new Promise(resolve => { late = resolve }))
    const { processor, deliver } = setup('tools')
    expect((await processor.submitAndWait('test', 'synthetic task', 'test')).result).toBe('primary answer')
    late({ content: JSON.stringify({ answer: 'late reviewed answer', needs_execution: false }), durationMs: 200 })
    await Promise.resolve()
    expect(deliver).toHaveBeenLastCalledWith('test', 'primary answer')
    expect(evaluateShadow).not.toHaveBeenCalled()
  })

  const clean = { loop_finished: true, execution_observed: true, skill: 'system_status', referents: { checked: 3, unsupported: [], retried: false }, pickup: { required: [], missing: [], retried: false } }
  const harnessWith = (completion: Record<string, unknown>) => {
    // the processor parses _meta.completion through askHarness; the mock returns the parsed shape directly
    vi.mocked(askHarness).mockResolvedValue({ text: 'status report', mode: 'frank-tool', ms: 1, evidence: [{ tool: 'exec', input: 'nvidia-smi', result: 'ok', status: 'ok' }],
      completion: { loopFinished: completion.loop_finished === true, executionObserved: completion.execution_observed === true, skill: completion.skill as string | null,
        referents: completion.referents as any, pickup: completion.pickup as any } })
  }
  it('settled skill: affordance routes without Jev, clean completion delivers without the gate (2026-11-11)', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('system_status')
    harnessWith(clean)
    const { processor, deliver, historyPath } = setup('tools', false, { executor: 'harness', settledSkills: ['system_status'] })
    expect((await processor.submitAndWait('test', 'give me a systems check', 'test')).result).toBe('status report')
    expect(askJevRoute).not.toHaveBeenCalled(); expect(askJevAcceptance).not.toHaveBeenCalled(); expect(reviewer.call).not.toHaveBeenCalled()
    expect(askHarness).toHaveBeenCalledTimes(1); expect(spawnClaudeStream).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'status report')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(s => JSON.parse(s))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['status report'])
  })
  it('settled skill but unsupported referents: no Jev route, but the gate still runs', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('system_status')
    harnessWith({ ...clean, referents: { checked: 3, unsupported: ['/mnt/nas'], retried: true } })
    const { processor, deliver } = setup('tools', false, { executor: 'harness', settledSkills: ['system_status'] })
    expect((await processor.submitAndWait('test', 'give me a systems check', 'test')).result).toBe('status report')
    expect(askJevRoute).not.toHaveBeenCalled(); expect(askJevAcceptance).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'status report')
  })
  it('settled skill but a different skill ran: the gate runs', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('system_status')
    harnessWith({ ...clean, skill: null })
    const { processor } = setup('tools', false, { executor: 'harness', settledSkills: ['system_status'] })
    await processor.submitAndWait('test', 'give me a systems check', 'test')
    expect(askJevRoute).not.toHaveBeenCalled(); expect(askJevAcceptance).toHaveBeenCalledTimes(1)
  })
  it('unsettled skill: Jev routes and gates as before', async () => {
    vi.mocked(harnessAffordance).mockResolvedValue('self_model')
    harnessWith({ ...clean, skill: 'self_model' })
    const { processor } = setup('tools', false, { executor: 'harness', settledSkills: ['system_status'] })
    await processor.submitAndWait('test', 'what are your two brains', 'test')
    expect(askJevRoute).toHaveBeenCalledTimes(1); expect(askJevAcceptance).toHaveBeenCalledTimes(1)
  })
})
