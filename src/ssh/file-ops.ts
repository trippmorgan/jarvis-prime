import { sshExec } from './executor.js'
import { NODES } from './types.js'

const FORBIDDEN_PATTERNS = ['..', '~root', '/etc/shadow', '/etc/passwd']

function validatePath(node: string, path: string): string | null {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (path.includes(pattern)) return `Forbidden path pattern: ${pattern}`
  }

  const nodeConfig = NODES[node.toLowerCase()]
  if (!nodeConfig) return `Unknown node: ${node}`

  if (nodeConfig.sshTarget !== 'localhost' && !path.startsWith('/')) {
    return 'Remote paths must be absolute'
  }

  return null
}

export async function readRemoteFile(
  node: string,
  path: string,
  maxLines: number = 500,
): Promise<{ content: string; error?: string }> {
  const err = validatePath(node, path)
  if (err) return { content: '', error: err }

  const result = await sshExec(node, `head -n ${maxLines} ${JSON.stringify(path)}`)

  if (result.exitCode !== 0) {
    return { content: '', error: result.stderr.trim() || `Exit code ${result.exitCode}` }
  }

  return { content: result.stdout }
}

export async function writeRemoteFile(
  node: string,
  path: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  const err = validatePath(node, path)
  if (err) return { success: false, error: err }

  // Use base64 to safely transfer content with special characters
  const b64 = Buffer.from(content).toString('base64')
  const result = await sshExec(node, `echo '${b64}' | base64 -d > ${JSON.stringify(path)}`)

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || `Exit code ${result.exitCode}` }
  }

  return { success: true }
}

export async function listRemoteDir(
  node: string,
  path: string,
): Promise<{ entries: string[]; error?: string }> {
  const err = validatePath(node, path)
  if (err) return { entries: [], error: err }

  const result = await sshExec(node, `ls -la ${JSON.stringify(path)}`)

  if (result.exitCode !== 0) {
    return { entries: [], error: result.stderr.trim() || `Exit code ${result.exitCode}` }
  }

  return { entries: result.stdout.trim().split('\n') }
}
