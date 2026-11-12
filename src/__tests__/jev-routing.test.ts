import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MessageProcessor } from '../bridge/processor.js'
import { askHarness, type JevVerdict } from '../bridge/harness-race.js'
import { collectShadow, evaluateShadow, recordAnswerSelection } from '../bridge/shadow-review.js'
import { selectAnswerRoute } from '../bridge/jev-routing.js'
import { spawnClaudeStream } from '../claude/spawner-stream.js'

vi.mock('../claude/spawner-stream.js', () => ({ spawnClaudeStream: vi.fn() }))
vi.mock('../bridge/harness-race.js', async original => ({ ...await original<object>(), askHarness: vi.fn(), attestRound: vi.fn(async () => 202) }))
vi.mock('../bridge/shadow-review.js', () => ({
  localService: vi.fn(() => true),
  collectShadow: vi.fn(), collectCase: vi.fn(input => ({ ...input, id: 'synthetic' })),
  evaluateShadow: vi.fn(), recordAnswerSelection: vi.fn(),
}))

const verdict = (pHarness = .8, positionBias = .05): JevVerdict => ({ pHarness, pJarvis: 1 - pHarness,
  positionBias, head: 'shipped', order1: 'first', order2: 'second', verdict: pHarness > .5 ? 'harness' : 'jarvis', strong: true, ms: 2 })

function setup(evolving = false, clinicalOverride = false, dual = false) {
  const historyPath = join(mkdtempSync(join(tmpdir(), 'jev-routing-')), 'history.jsonl')
  const deliver = vi.fn(async () => {})
  const surface = { sendMessageAndGetId: vi.fn(async () => 42), editMessageText: vi.fn(async () => true), sendChatAction: vi.fn(async () => true) }
  const processor = new MessageProcessor({
    claudePath: 'synthetic', claudeModel: 'synthetic', claudeTimeoutMs: 1000, workingDir: '/tmp', nodeName: 'test', botUsername: 'test', historyPath,
    corpusCallosumEnabled: dual, defaultMode: dual ? 'dual' : 'single', defaultLeftRuntime: 'claude', clinicalOverride,
    shortMessageFastLaneEnabled: false, gatewayUrl: 'http://unused', gatewayToken: '', rightModel: 'test', corpusCallosumTimeoutMs: 1000,
    evolvingMessageEnabled: evolving, telegramSurface: surface,
    orchestrator: dual ? async input => {
      input.onEvent?.('callosum_pass2_ok', { p2Left: 'unselected draft', p2Right: 'other draft' })
      return { finalText: 'primary answer', trace: { totalMs: 1, integrationMs: 1 } } as any
    } : undefined,
    harnessRace: { url: 'http://unused', model: 'test', timeoutMs: 1000, jevUrl: 'http://127.0.0.1:30110', jevRouting: true, jevCandidateWaitMs: 5, jevRouteTimeoutMs: 100 },
  }, deliver, Fastify({ logger: false }).log)
  return { processor, deliver, surface, historyPath }
}

describe('Jev answer routing and delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('FRANK_CROSS_REVIEW', '0')
    vi.mocked(askHarness).mockResolvedValue({ text: 'harness answer', mode: 'test', ms: 1 })
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: 'primary answer', stderr: '', exitCode: 0, durationMs: 1, timedOut: false })
    vi.mocked(evaluateShadow).mockImplementation(async (_cfg, _case, _dir, _fetch, callback) => { callback?.(verdict()); return 'recorded' })
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([false, true])('delivers and remembers only the JEV-selected answer; evolving=%s', async evolving => {
    const { processor, deliver, surface, historyPath } = setup(evolving)
    const reply = await processor.submitAndWait('test', 'Which answer should be delivered?', 'test')
    expect(reply.result).toBe('harness answer')
    if (evolving) expect(surface.editMessageText).toHaveBeenCalledWith('test', 42, 'harness answer')
    else expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness answer')
    const turns = readFileSync(historyPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(turns.filter(t => t.role === 'assistant').map(t => t.content)).toEqual(['harness answer'])
    expect(evaluateShadow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(evaluateShadow).mock.calls[0][5]).toBe(true)
    expect(recordAnswerSelection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selected: 'harness', reason: 'jev-harness' }))
    expect(collectShadow).not.toHaveBeenCalled()
  })

  it('holds both candidates until JEV decides', async () => {
    let complete!: () => void
    vi.mocked(evaluateShadow).mockImplementation((_cfg, _case, _dir, _fetch, callback) => new Promise(resolve => {
      complete = () => { callback?.(verdict()); resolve('recorded') }
    }))
    const { processor, deliver } = setup()
    const pending = processor.submitAndWait('test', 'Compare these alternatives', 'test')
    await vi.waitFor(() => expect(evaluateShadow).toHaveBeenCalled())
    expect(deliver).not.toHaveBeenCalled()
    complete()
    expect((await pending).result).toBe('harness answer')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each([verdict(.51, 0), verdict(.7, .25), { error: 'timeout', ms: 100 }])('uses primary when JEV abstains: %s', async result => {
    vi.mocked(evaluateShadow).mockImplementation(async (_cfg, _case, _dir, _fetch, callback) => { callback?.(result); return 'recorded' })
    const { processor, deliver } = setup()
    expect((await processor.submitAndWait('test', 'Pick an answer', 'test')).result).toBe('primary answer')
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
  })

  it('falls back on inference failure', async () => {
    vi.mocked(evaluateShadow).mockRejectedValue(new Error('service unavailable'))
    const { processor, deliver } = setup()
    expect((await processor.submitAndWait('test', 'Pick an answer', 'test')).result).toBe('primary answer')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('late harness cannot send a second answer or trigger a GPU judge', async () => {
    let late!: (a: any) => void
    vi.mocked(askHarness).mockImplementation(() => new Promise(resolve => { late = resolve }))
    const { processor, deliver } = setup()
    expect((await processor.submitAndWait('test', 'Pick an answer', 'test')).result).toBe('primary answer')
    late({ text: 'late answer', mode: 'test', ms: 100 })
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'primary answer')
    expect(evaluateShadow).not.toHaveBeenCalled()
  })

  it('recovers a failed primary with the available harness answer', async () => {
    vi.mocked(spawnClaudeStream).mockResolvedValue({ output: '', stderr: 'failure', exitCode: 1, durationMs: 1, timedOut: false })
    const { processor, deliver, historyPath } = setup()
    expect((await processor.submitAndWait('test', 'Pick an answer', 'test')).result).toBe('harness answer')
    expect(deliver).toHaveBeenCalledExactlyOnceWith('test', 'harness answer')
    expect(readFileSync(historyPath, 'utf8')).toContain('harness answer')
    expect(evaluateShadow).not.toHaveBeenCalled()
  })

  it('keeps clinical traffic out of both the race and JEV', async () => {
    const { processor } = setup(false, true)
    await processor.submitAndWait('test', 'Synthetic clinical task', 'test')
    expect(askHarness).not.toHaveBeenCalled()
    expect(evaluateShadow).not.toHaveBeenCalled()
  })

  it('dual evolving path does not expose drafts and records the selected final answer', async () => {
    const { processor, surface, historyPath } = setup(true, false, true)
    expect((await processor.submitAndWait('test', 'Compare the alternatives', 'test')).result).toBe('harness answer')
    expect(surface.editMessageText).toHaveBeenCalledExactlyOnceWith('test', 42, 'harness answer')
    expect(surface.sendMessageAndGetId).toHaveBeenCalledTimes(1)
    expect(readFileSync(historyPath, 'utf8')).not.toContain('primary answer')
  })
})

describe('both-order route policy', () => {
  it('selects either candidate when both orders agree', () => {
    expect(selectAnswerRoute(verdict(.8, .05))).toEqual({ selected: 'harness', reason: 'jev-harness' })
    expect(selectAnswerRoute(verdict(.2, -.05))).toEqual({ selected: 'jarvis', reason: 'jev-jarvis' })
  })
  it('2026-10-29: a 0.5 verdict is a tie, never a jarvis win', () => {
    expect(selectAnswerRoute({ pHarness: .5, pJarvis: .5, positionBias: 0, verdict: 'tie', strong: false, head: 'shipped', order1: 'a', order2: 'b', ms: 1 }, .05)).toMatchObject({ selected: 'jarvis', reason: 'jev-uncertain' })
  })
  it('rejects impossible per-order probabilities and non-shipped provenance', () => {
    expect(selectAnswerRoute(verdict(.9, .3)).reason).toBe('invalid-jev-result')
    expect(selectAnswerRoute({ ...verdict(), head: 'candidate' }).reason).toBe('invalid-jev-result')
  })
})
