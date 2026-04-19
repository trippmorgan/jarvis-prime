import { spawn } from 'node:child_process'
import { NODES, type SshResult } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_SECS = 10

export function resolveNode(name: string): string | null {
  const lower = name.toLowerCase()
  const node = NODES[lower]
  return node?.sshTarget ?? null
}

export async function sshExec(
  node: string,
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SshResult> {
  const target = resolveNode(node)
  if (!target) {
    return {
      stdout: '',
      stderr: `Unknown node: ${node}. Known nodes: ${Object.keys(NODES).join(', ')}`,
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
    }
  }

  if (target === 'localhost') {
    return execLocal(command, timeoutMs)
  }

  return execRemote(target, command, timeoutMs)
}

async function execLocal(command: string, timeoutMs: number): Promise<SshResult> {
  return runProcess('bash', ['-c', command], timeoutMs)
}

async function execRemote(target: string, command: string, timeoutMs: number): Promise<SshResult> {
  const args = [
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECS}`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    target,
    command,
  ]
  return runProcess('ssh', args, timeoutMs)
}

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<SshResult> {
  const start = performance.now()

  return new Promise<SshResult>((resolve) => {
    let timedOut = false
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
        durationMs: Math.round(performance.now() - start),
        timedOut,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: Math.round(performance.now() - start),
        timedOut: false,
      })
    })
  })
}
