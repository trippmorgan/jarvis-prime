import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DeathWatchLogger {
  info: (o: object, m?: string) => void
  warn: (o: object, m?: string) => void
}

export interface DeathWatchOptions {
  /** Where to write the rolling snapshot file. */
  path: string
  /** How often to snapshot (ms). Default 10s. */
  intervalMs?: number
  /** How many snapshots to retain in the rolling buffer. Default 30 (~5 min @ 10s). */
  keep?: number
  /** Reads the current queue depth (-1 if unavailable). */
  getQueueDepth?: () => number
  /** Reads whether the processor is mid-turn. */
  isProcessing?: () => boolean
  logger?: DeathWatchLogger
}

/**
 * Death-watch — a rolling pre-mortem snapshot.
 *
 * prime (esp. on the Mac mini / argus-prime) dies by EXTERNAL SIGKILL (-9)
 * with EMPTY stderr: it is NOT the event-loop watchdog (which logs
 * "[watchdog] event loop blocked …" before it kills), NOT a Node exception
 * (which leaves a stack trace), and NOT a graceful SIGTERM (which logs
 * "Shutting down"). A SIGKILL cannot be caught, so the process cannot report
 * its own cause of death — leaving us blind.
 *
 * This persists a small rolling buffer of {rss, heap, queue, processing}
 * snapshots to disk every `intervalMs`. After the next kill, the TAIL of the
 * file is the process state at the moment of death — RSS at kill time and
 * whether it was climbing. That distinguishes memory-pressure / Jetsam
 * (rss ramping before death) from an unrelated external kill (rss flat).
 *
 * The file is overwritten in place (tmp + atomic rename) and never grows past
 * `keep` lines, so it is safe to run forever. Returns stop() for shutdown/tests.
 */
export function startDeathWatch(opts: DeathWatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 10_000
  const keep = opts.keep ?? 30
  const log = opts.logger
  const ring: string[] = []

  try {
    mkdirSync(dirname(opts.path), { recursive: true })
  } catch {
    /* dir almost certainly already exists */
  }

  const snapshot = (): void => {
    try {
      const mem = process.memoryUsage()
      const line = JSON.stringify({
        t: new Date().toISOString(),
        pid: process.pid,
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        externalMb: Math.round(mem.external / 1048576),
        queue: opts.getQueueDepth?.() ?? -1,
        processing: opts.isProcessing?.() ?? false,
      })
      ring.push(line)
      while (ring.length > keep) ring.shift()
      // tmp + rename so a kill mid-write can't leave a torn file.
      const tmp = `${opts.path}.tmp`
      writeFileSync(tmp, ring.join('\n') + '\n', 'utf-8')
      renameSync(tmp, opts.path)
    } catch (err) {
      log?.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'death-watch snapshot failed',
      )
    }
  }

  // First snapshot immediately so a near-boot kill still leaves a marker.
  snapshot()
  const timer = setInterval(snapshot, intervalMs)
  // Never keep the process alive just for the snapshot loop.
  if (typeof timer.unref === 'function') timer.unref()

  log?.info({ path: opts.path, intervalMs, keep }, 'death-watch started')

  return () => clearInterval(timer)
}
