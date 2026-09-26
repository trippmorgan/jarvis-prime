/** Private advisory queue. No delivery, routing, Phi, training, or ledger authority. */
import { createHash, randomInt } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { askJevJudge, type HarnessRaceConfig, type ToolEvidence } from './harness-race.js'

export interface ShadowInput {
  messageId: string; chatId: string; task: string; harness: string; jarvis: string
  evidence: { harness: ToolEvidence[]; jarvis: ToolEvidence[] }
}
export interface ShadowCase extends ShadowInput { id: string; schema: 1; createdAt: string; scenarioId: string }
export const digest = (s: string) => createHash('sha256').update(s).digest('hex')
export const shadowDir = () => process.env.FRANK_SHADOW_DIR ?? join(homedir(), '.local/state/frank-shadow')
function pathFor(dir: string, kind: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid case ID')
  return join(dir, kind, `${id}.json`)
}
function save(dir: string, kind: string, id: string, data: unknown): boolean {
  mkdirSync(join(dir, kind), { recursive: true, mode: 0o700 })
  try { writeFileSync(pathFor(dir, kind, id), JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' }); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
}
function read<T>(dir: string, kind: string, id: string): T { return JSON.parse(readFileSync(pathFor(dir, kind, id), 'utf8')) as T }
function ids(dir: string, kind: string): string[] {
  try { return readdirSync(join(dir, kind)).filter(x => /^[a-f0-9]{64}\.json$/.test(x)).sort().map(x => x.slice(0, -5)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
export function collectCase(input: ShadowInput, dir = shadowDir()): ShadowCase {
  const id = digest(JSON.stringify([input.messageId, input.chatId, input.task, input.harness, input.jarvis, input.evidence]))
  const record: ShadowCase = { ...input, id, schema: 1, createdAt: new Date().toISOString(), scenarioId: digest(input.task.trim().replace(/\s+/g, ' ')) }
  if (save(dir, 'cases', id, record)) return record
  return read<ShadowCase>(dir, 'cases', id)
}

/** Explicit loopback only; never follow redirects carrying private text elsewhere. */
export function localService(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' }
  catch { return false }
}
export async function evaluateShadow(cfg: HarnessRaceConfig, c: ShadowCase, dir = shadowDir(), fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!cfg.jevUrl || !localService(cfg.jevUrl)) throw new Error('Shadow requires a loopback HTTP Jev service')
  const localFetch: typeof fetch = (url, init) => fetchImpl(url, { ...init, redirect: 'error' })
  const health = await localFetch(`${cfg.jevUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000) })
  if (!health.ok) throw new Error(`Health HTTP ${health.status}`)
  const h = await health.json() as { loaded?: boolean; device?: string }
  if (h.loaded !== true || h.device !== 'cpu') throw new Error('Shadow requires an already-loaded CPU model')
  const result = await askJevJudge({ ...cfg, jevTimeoutMs: Math.min(cfg.jevTimeoutMs ?? 120000, 120000) }, c.task, c.harness, c.jarvis, localFetch)
  if ('error' in result) throw new Error(result.error)
  save(dir, 'predictions', c.id, { schema: 1, caseId: c.id, createdAt: new Date().toISOString(), advisory: true, result, inputPolicy: 'task:first3000; answers:first6000; truncation-marker appended; evidence excluded' })
  return 'recorded'
}

// One in-flight request. All cases persist even when busy; `drain` retries pending ones.
let busy = false
export function collectShadow(cfg: HarnessRaceConfig, input: ShadowInput, report: (status: string) => void = () => {}, dir = shadowDir()): void {
  if (!cfg.jevUrl) return
  try {
    const c = collectCase(input, dir)
    if (ids(dir, 'predictions').includes(c.id)) { report('already-recorded'); return }
    if (busy) { report('queued'); return }
    busy = true
    void evaluateShadow(cfg, c, dir).then(() => report('recorded'), () => report('queued-service-unavailable'))
      .catch(() => {}).finally(() => { busy = false })
  } catch { try { report('collection-failed') } catch { /* logging cannot affect delivery */ } }
}
export async function drain(cfg: HarnessRaceConfig, limit = 10, dir = shadowDir()): Promise<number> {
  const done = new Set(ids(dir, 'predictions')); let count = 0
  for (const id of ids(dir, 'cases').filter(id => !done.has(id)).slice(0, limit)) {
    await evaluateShadow(cfg, read<ShadowCase>(dir, 'cases', id), dir); count++
  }
  return count
}

interface Assignment { caseId: string; reviewer: string; a: 'harness' | 'jarvis'; assignedAt: string }
export interface IndependentLabel {
  schema: 1; caseId: string; reviewer: string; reviewerIdentity: 'self-declared-local-human'
  label: 'harness' | 'jarvis' | 'equal' | 'abstain'; reason: string; scenarioId: string; createdAt: string
  provenance: 'independent-human-declaration'; declaration: true; assignment: Assignment
}
function assignmentId(reviewer: string, id: string) { return digest(JSON.stringify([reviewer, id])) }
function checkReviewer(reviewer: string) { if (!reviewer.trim() || reviewer.length > 100) throw new Error('A reviewer identity is required') }
export function nextBlind(reviewer: string, dir = shadowDir()) {
  checkReviewer(reviewer)
  for (const id of ids(dir, 'cases')) {
    const aid = assignmentId(reviewer, id)
    if (ids(dir, 'labels').includes(aid)) continue
    const assignment: Assignment = { caseId: id, reviewer, a: randomInt(2) ? 'harness' : 'jarvis', assignedAt: new Date().toISOString() }
    save(dir, 'assignments', aid, assignment)
    const a = read<Assignment>(dir, 'assignments', aid)
    const c = read<ShadowCase>(dir, 'cases', id), b = a.a === 'harness' ? 'jarvis' : 'harness'
    return { caseId: id, task: c.task, A: c[a.a], B: c[b], evidenceA: c.evidence[a.a], evidenceB: c.evidence[b], instruction: 'Judge task fulfillment from evidence. A/B/equal/abstain. Do not consult model scores or other reviews. If you authored either answer or have seen their judgments, do not submit an independent label. Answer text may reveal authorship; abstain or withhold independence if blinding is compromised.' }
  }
  return null
}
export function labelIndependent(reviewer: string, id: string, choice: string, reason: string, scenarioId: string, independent: boolean, dir = shadowDir()): void {
  checkReviewer(reviewer)
  if (!independent || !reason.trim() || !scenarioId.trim()) throw new Error('Independent declaration, reason, and scenario-family ID required')
  if (!['A', 'B', 'equal', 'abstain'].includes(choice)) throw new Error('Choice must be A, B, equal, or abstain')
  const aid = assignmentId(reviewer, id), a = read<Assignment>(dir, 'assignments', aid)
  read<ShadowCase>(dir, 'cases', id)
  const label = choice === 'A' ? a.a : choice === 'B' ? (a.a === 'harness' ? 'jarvis' : 'harness') : choice as 'equal' | 'abstain'
  const record: IndependentLabel = { schema: 1, caseId: id, reviewer, reviewerIdentity: 'self-declared-local-human', label, reason, scenarioId, createdAt: new Date().toISOString(), provenance: 'independent-human-declaration', declaration: true, assignment: a }
  if (!save(dir, 'labels', aid, record)) throw new Error('Label already exists; immutable reviews cannot be overwritten')
}
export function exportIndependent(dir = shadowDir()) {
  const labels = ids(dir, 'labels').map(id => read<IndependentLabel>(dir, 'labels', id))
  // No majority vote silently manufactures ground truth. Conflicts require adjudication.
  const result = []
  for (const id of ids(dir, 'cases')) {
    const reviews = labels.filter(l => l.caseId === id && l.provenance === 'independent-human-declaration' && l.declaration)
    if (!reviews.length || reviews.some(l => l.label === 'abstain') || new Set(reviews.map(l => l.label)).size !== 1 || new Set(reviews.map(l => l.scenarioId)).size !== 1) continue
    const c = read<ShadowCase>(dir, 'cases', id)
    result.push({ caseId: id, scenarioId: reviews[0].scenarioId, task: c.task, a: c.harness, b: c.jarvis, label: reviews[0].label, reviews })
  }
  return result
}
export function shadowStatus(dir = shadowDir()) {
  return { cases: ids(dir, 'cases').length, predictions: ids(dir, 'predictions').length, independentDeclarations: ids(dir, 'labels').length, exportableCases: exportIndependent(dir).length }
}
