import { sshExec } from '../ssh/executor.js'
import { NODES } from '../ssh/types.js'

export interface RelayResult {
  success: boolean
  node: string
  error?: string
}

export async function relayToLieutenant(
  node: string,
  message: string,
): Promise<RelayResult> {
  const nodeConfig = NODES[node.toLowerCase()]
  if (!nodeConfig) {
    return { success: false, node, error: `Unknown node: ${node}` }
  }

  if (nodeConfig.sshTarget === 'localhost') {
    return { success: false, node: nodeConfig.name, error: 'Cannot relay to self (SuperServer)' }
  }

  // Send message via OpenClaw's gateway on the remote node
  // Each node's OpenClaw listens on port 18789
  const escapedMessage = message.replace(/'/g, "'\\''")
  const cmd = `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:18789/api/message -H "Content-Type: application/json" -d '{"text": "${escapedMessage}"}' 2>/dev/null || echo "CURL_FAILED"`

  const result = await sshExec(node, cmd)

  if (result.timedOut) {
    return { success: false, node: nodeConfig.name, error: 'SSH timeout' }
  }

  const output = result.stdout.trim()
  if (output === 'CURL_FAILED' || result.exitCode !== 0) {
    return { success: false, node: nodeConfig.name, error: `Relay failed: ${result.stderr.trim() || output}` }
  }

  return { success: true, node: nodeConfig.name }
}
