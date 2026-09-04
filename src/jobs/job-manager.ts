/**
 * job-manager.ts — long tasks as monitored background jobs (2026-09-04).
 *
 * A job posts ONE monitor bubble the moment it starts ("Task #3 · handled by
 * agent X · started 09:12") and edits it on a ticker with elapsed time and
 * tool activity; the result lands as a fresh message when the run ends; the
 * chat queue is never blocked. `status` renders the board, `stop [#n]`
 * aborts. Every job is a PROCESS_RUN on the jarvis chain (via `attest`).
 */

export interface JobSurface {
  sendMessageAndGetId(chatId: string, text: string): Promise<number | null>
  editMessageText(chatId: string, messageId: number, text: string): Promise<boolean>
}

export interface JobRunContext {
  signal: AbortSignal
  onActivity: (label: string) => void
}

export interface JobRunResult {
  output: string
  timedOut?: boolean
  aborted?: boolean
  exitCode?: number
  stderr?: string
}

export interface JobSpec {
  chatId: string
  title: string
  kind: 'task' | 'dual'
  agentLabel: string
  run: (ctx: JobRunContext) => Promise<JobRunResult>
}

export type JobStatus = 'running' | 'done' | 'stopped' | 'failed' | 'timeout'

export interface JobRecord {
  id: number
  chatId: string
  title: string
  kind: 'task' | 'dual'
  agentLabel: string
  startedAt: number
  endedAt?: number
  status: JobStatus
  activity: Map<string, number>
  lastActivity?: string
  monitorMessageId: number | null
  output?: string
  controller: AbortController
}

export interface JobManagerLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export interface JobManagerDeps {
  surface: JobSurface | null
  /** Long-text delivery (chunked) for the final result. */
  deliverLong: (chatId: string, text: string) => Promise<void>
  log?: JobManagerLogger
  now?: () => number
  tickMs?: number
  maxConcurrent?: number
  timeZone?: string
  onFinished?: (job: JobRecord, result: JobRunResult | null) => void
  attest?: (job: JobRecord) => void
}

const noop: JobManagerLogger = { info: () => {}, warn: () => {}, error: () => {} }

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

export class JobManager {
  private readonly jobs = new Map<number, JobRecord>()
  private readonly tickers = new Map<number, ReturnType<typeof setInterval>>()
  private nextId = 1
  private readonly deps: Required<Pick<JobManagerDeps, 'tickMs' | 'maxConcurrent' | 'timeZone'>> & JobManagerDeps

  constructor(deps: JobManagerDeps) {
    this.deps = { tickMs: 30_000, maxConcurrent: 3, timeZone: 'America/New_York', ...deps }
  }

  running(chatId?: string): JobRecord[] {
    return [...this.jobs.values()].filter((j) => j.status === 'running' && (!chatId || j.chatId === chatId))
  }

  private fmtClock(ms: number): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: this.deps.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  }

  private activityLine(job: JobRecord): string {
    if (job.activity.size === 0) return job.kind === 'dual' ? 'both hemispheres drafting' : 'starting up'
    return [...job.activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(' · ')
  }

  renderMonitor(job: JobRecord, now = (this.deps.now ?? Date.now)()): string {
    const elapsed = fmtElapsed((job.endedAt ?? now) - job.startedAt)
    const head = `🛠 Task #${job.id} · ${job.title}`
    const agent = `Agent: ${job.agentLabel}`
    switch (job.status) {
      case 'running':
        return `${head}\n${agent}\nStarted ${this.fmtClock(job.startedAt)} · ${elapsed} elapsed · ${this.activityLine(job)}\n(say \`status\` or \`stop #${job.id}\`)`
      case 'done':
        return `✅ Task #${job.id} done · ${elapsed} · ${this.activityLine(job)} — result below`
      case 'stopped':
        return `⏹ Task #${job.id} stopped at ${elapsed} · partial result below`
      case 'timeout':
        return `⏱ Task #${job.id} hit its time limit at ${elapsed} · partial result below`
      default:
        return `❌ Task #${job.id} failed at ${elapsed}`
    }
  }

  statusText(chatId: string, now = (this.deps.now ?? Date.now)()): string {
    const running = this.running(chatId)
    const recent = [...this.jobs.values()].filter((j) => j.chatId === chatId && j.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 3)
    const lines: string[] = []
    if (running.length === 0) lines.push('No jobs running.')
    else {
      lines.push(`${running.length} running:`)
      for (const j of running) lines.push(`• #${j.id} ${j.title} — ${fmtElapsed(now - j.startedAt)} · ${this.activityLine(j)} · ${j.agentLabel}`)
    }
    if (recent.length > 0) {
      lines.push('Recent:')
      for (const j of recent) lines.push(`• #${j.id} ${j.title} — ${j.status} in ${fmtElapsed((j.endedAt ?? now) - j.startedAt)}`)
    }
    return lines.join('\n')
  }

  async stop(chatId: string, id?: number): Promise<string> {
    const running = this.running(chatId)
    const target = id !== undefined ? this.jobs.get(id) : running.length === 1 ? running[0] : undefined
    if (id !== undefined && (!target || target.chatId !== chatId)) return `No job #${id} here.`
    if (!target) return running.length === 0 ? 'Nothing is running.' : `${running.length} jobs running — say \`stop #n\`: ${running.map((j) => `#${j.id}`).join(', ')}`
    if (target.status !== 'running') return `Task #${target.id} already ${target.status}.`
    target.status = 'stopped'
    target.controller.abort()
    return `Stopping task #${target.id} — I'll post what it had.`
  }

  async start(spec: JobSpec): Promise<JobRecord | null> {
    if (this.running().length >= this.deps.maxConcurrent) return null
    const now = this.deps.now ?? Date.now
    const job: JobRecord = {
      id: this.nextId++,
      chatId: spec.chatId,
      title: spec.title,
      kind: spec.kind,
      agentLabel: spec.agentLabel,
      startedAt: now(),
      status: 'running',
      activity: new Map(),
      monitorMessageId: null,
      controller: new AbortController(),
    }
    this.jobs.set(job.id, job)
    this.trim()
    const log = this.deps.log ?? noop
    log.info({ event: 'job_start', jobId: job.id, kind: job.kind, chatId: job.chatId }, 'job start')

    if (this.deps.surface) {
      try {
        job.monitorMessageId = await this.deps.surface.sendMessageAndGetId(job.chatId, this.renderMonitor(job))
      } catch {
        job.monitorMessageId = null
      }
    }
    const ticker = setInterval(() => void this.refresh(job), this.deps.tickMs)
    if (typeof ticker === 'object' && ticker && 'unref' in ticker) (ticker as { unref(): void }).unref()
    this.tickers.set(job.id, ticker)

    void this.execute(job, spec)
    return job
  }

  private async refresh(job: JobRecord): Promise<void> {
    if (!this.deps.surface || job.monitorMessageId === null) return
    try {
      await this.deps.surface.editMessageText(job.chatId, job.monitorMessageId, this.renderMonitor(job))
    } catch {
      /* monitor edits are best-effort */
    }
  }

  private async execute(job: JobRecord, spec: JobSpec): Promise<void> {
    const log = this.deps.log ?? noop
    let result: JobRunResult | null = null
    try {
      result = await spec.run({
        signal: job.controller.signal,
        onActivity: (label) => {
          job.activity.set(label, (job.activity.get(label) ?? 0) + 1)
          job.lastActivity = label
        },
      })
      if (job.status === 'running') {
        job.status = result.aborted ? 'stopped' : result.timedOut ? 'timeout' : result.output.trim().length === 0 && (result.exitCode ?? 0) !== 0 ? 'failed' : 'done'
      }
      job.output = result.output.trim()
    } catch (err) {
      if (job.status === 'running') job.status = 'failed'
      job.output = `Task failed: ${err instanceof Error ? err.message : String(err)}`
      log.error({ event: 'job_error', jobId: job.id, error: job.output.slice(0, 200) }, 'job failed')
    } finally {
      job.endedAt = (this.deps.now ?? Date.now)()
      const ticker = this.tickers.get(job.id)
      if (ticker) clearInterval(ticker)
      this.tickers.delete(job.id)
      log.info({ event: 'job_end', jobId: job.id, status: job.status, durationMs: job.endedAt - job.startedAt, outputLen: job.output?.length ?? 0 }, 'job end')
      await this.refresh(job)
      const body = job.output && job.output.length > 0 ? job.output : job.status === 'failed' ? '(no output)' : '(no output before it stopped)'
      const header = job.status === 'done' ? `📬 Task #${job.id} result:\n\n` : `📬 Task #${job.id} (${job.status}):\n\n`
      try {
        await this.deps.deliverLong(job.chatId, header + body)
      } catch (err) {
        log.warn({ event: 'job_deliver_failed', jobId: job.id, error: String(err) }, 'job result delivery failed')
      }
      try { this.deps.attest?.(job) } catch { /* ledger is best-effort */ }
      try { this.deps.onFinished?.(job, result) } catch { /* observer errors never matter */ }
    }
  }

  /** Keep memory bounded: last 50 finished jobs. */
  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    while (finished.length > 50) this.jobs.delete(finished.shift()!.id)
  }
}
