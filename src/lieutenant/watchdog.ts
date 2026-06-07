import { Worker } from 'node:worker_threads'

export interface WatchdogLogger {
  info: (o: object, m?: string) => void
  warn: (o: object, m?: string) => void
}

export interface WatchdogOptions {
  /** Kill the process if the event loop is blocked at least this long (ms). Default 60s. */
  thresholdMs?: number
  /** How often the main thread bumps its heartbeat counter (ms). Default 1s. */
  heartbeatMs?: number
  logger?: WatchdogLogger
}

/**
 * Event-loop watchdog.
 *
 * The main thread bumps a shared counter every `heartbeatMs`. A worker thread
 * — which has its OWN event loop, unaffected when the main loop wedges —
 * watches that counter. If it stops advancing for `thresholdMs`, the main loop
 * is blocked (the 100%-CPU freeze we cannot otherwise recover from), so the
 * worker SIGKILLs the shared OS process. pm2 then restarts it, and because the
 * Telegram offset is now persisted, the message that wedged it is NOT
 * re-fetched — the freeze self-heals in ~1 minute instead of hanging for ~24.
 *
 * Returns a stop() function for tests / graceful shutdown.
 */
export function startEventLoopWatchdog(opts: WatchdogOptions = {}): () => void {
  const thresholdMs = opts.thresholdMs ?? 60_000
  const heartbeatMs = opts.heartbeatMs ?? 1_000
  const log = opts.logger

  // Index 0: a counter the main thread increments each heartbeat.
  const sab = new SharedArrayBuffer(4)
  const beat = new Int32Array(sab)

  const timer = setInterval(() => {
    Atomics.add(beat, 0, 1)
  }, heartbeatMs)
  // Don't keep the process alive just for the heartbeat.
  if (typeof timer.unref === 'function') timer.unref()

  // The worker runs independently of the main event loop. When the main loop
  // is blocked the counter freezes; after thresholdMs the worker kills the
  // process. process.pid is shared, so SIGKILL takes down the whole process
  // even though the main thread is unresponsive.
  const workerSrc = `
    const { workerData } = require('node:worker_threads')
    const beat = new Int32Array(workerData.sab)
    const thresholdMs = workerData.thresholdMs
    const checkMs = workerData.checkMs
    let last = Atomics.load(beat, 0)
    let lastChange = Date.now()
    setInterval(() => {
      const cur = Atomics.load(beat, 0)
      if (cur !== last) { last = cur; lastChange = Date.now(); return }
      const stalledMs = Date.now() - lastChange
      if (stalledMs >= thresholdMs) {
        console.error('[watchdog] event loop blocked ' + stalledMs + 'ms (>= ' + thresholdMs + 'ms) — killing process for restart')
        process.kill(process.pid, 'SIGKILL')
      }
    }, checkMs)
  `

  const worker = new Worker(workerSrc, {
    eval: true,
    workerData: { sab, thresholdMs, checkMs: Math.min(heartbeatMs * 5, 10_000) },
  })
  // The watchdog must never, by itself, keep the process alive.
  worker.unref()
  worker.on('error', (err) => {
    log?.warn({ error: err instanceof Error ? err.message : String(err) }, 'watchdog worker error')
  })

  log?.info({ thresholdMs, heartbeatMs }, 'event-loop watchdog started')

  return () => {
    clearInterval(timer)
    void worker.terminate()
  }
}
