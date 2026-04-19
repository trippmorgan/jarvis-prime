import { sshExec } from '../ssh/executor.js'
import { NODES } from '../ssh/types.js'

export interface LieutenantStatus {
  node: string
  reachable: boolean
  uptime?: string
  disk?: string
  memory?: string
  openclawRunning?: boolean
  services: Record<string, boolean | string>
  error?: string
}

export async function getLieutenantStatus(node: string): Promise<LieutenantStatus> {
  const nodeConfig = NODES[node.toLowerCase()]
  if (!nodeConfig) {
    return { node, reachable: false, services: {}, error: `Unknown node: ${node}` }
  }

  const status: LieutenantStatus = {
    node: nodeConfig.name,
    reachable: false,
    services: {},
  }

  // Single SSH call with multiple commands to reduce connection overhead
  const commands = [
    'echo "UPTIME:$(uptime -p 2>/dev/null || uptime)"',
    'echo "DISK:$(df -h / | tail -1 | awk \'{print $5}\')"',
    'echo "MEM:$(free -h | grep Mem | awk \'{print $3\"/\"$2}\')"',
    'echo "OPENCLAW:$(pgrep -f openclaw > /dev/null 2>&1 && echo running || echo stopped)"',
  ].join(' && ')

  const result = await sshExec(node, commands)

  if (result.timedOut) {
    return { ...status, error: 'SSH timeout — node unreachable' }
  }

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return { ...status, error: result.stderr.trim().slice(0, 200) || 'SSH connection failed' }
  }

  status.reachable = true

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('UPTIME:')) status.uptime = line.slice(7).trim()
    if (line.startsWith('DISK:')) status.disk = line.slice(5).trim()
    if (line.startsWith('MEM:')) status.memory = line.slice(4).trim()
    if (line.startsWith('OPENCLAW:')) status.openclawRunning = line.includes('running')
  }

  return status
}

export async function getAllNodeStatuses(): Promise<LieutenantStatus[]> {
  const nodes = Object.keys(NODES)
  const results = await Promise.all(nodes.map((n) => getLieutenantStatus(n)))
  return results
}

export function formatStatusTable(statuses: LieutenantStatus[]): string {
  const lines = ['```']
  lines.push('Node          | Status | Uptime        | Disk  | RAM       | OpenClaw')
  lines.push('------------- | ------ | ------------- | ----- | --------- | --------')

  for (const s of statuses) {
    if (!s.reachable) {
      lines.push(`${s.node.padEnd(13)} | DOWN   | -             | -     | -         | -`)
      continue
    }

    const uptime = (s.uptime ?? '-').slice(0, 13).padEnd(13)
    const disk = (s.disk ?? '-').padEnd(5)
    const mem = (s.memory ?? '-').padEnd(9)
    const oc = s.openclawRunning ? '✓ running' : '✗ stopped'

    lines.push(`${s.node.padEnd(13)} | UP     | ${uptime} | ${disk} | ${mem} | ${oc}`)
  }

  lines.push('```')
  return lines.join('\n')
}
