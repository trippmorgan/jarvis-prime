/** Cross-process advisory lock shared by online collection and the drain worker. */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

export async function withShadowLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'inference.lock')
  closeSync(openSync(path, 'a', 0o600))
  // flock owns the lock until the helper exits. Pipe EOF also releases it if this
  // process crashes: no stale PID files, expired-lease races, or user GPU lease.
  const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', path, process.execPath, '-e',
    "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      let acquired = false
      child.once('error', () => reject(new Error('shadow-lock-unavailable')))
      child.once('exit', code => { if (!acquired) reject(new Error(code === 75 ? 'shadow-worker-busy' : 'shadow-lock-failed')) })
      child.stdout.once('data', data => {
        if (data.toString().trim() !== 'locked') { reject(new Error('shadow-lock-protocol')); return }
        acquired = true; resolve()
      })
    })
    return await work()
  } finally {
    child.stdin.end()
    await closed
  }
}
