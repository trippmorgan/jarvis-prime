export interface SshResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

export interface NodeConfig {
  name: string
  sshTarget: string
  basePath: string
  services: string[]
}

export const NODES: Record<string, NodeConfig> = {
  superserver: {
    name: 'SuperServer',
    sshTarget: 'localhost',
    basePath: '/home/tripp/.openclaw/workspace/',
    services: ['openclaw', 'jarvis-prime', 'jarvis-dispatch'],
  },
  voldemort: {
    name: 'Voldemort',
    sshTarget: 'root@192.168.0.108',
    basePath: '/home/joevoldemort/',
    services: ['openclaw', 'ollama', 'frank-v3'],
  },
  argus: {
    name: 'Argus',
    sshTarget: 'jarvisagent@100.70.105.85',
    basePath: '/home/jarvisagent/',
    services: ['openclaw'],
  },
  pretoria: {
    name: 'Pretoria',
    sshTarget: 'djjarvis@100.116.2.71',
    basePath: '/home/djjarvis/',
    services: ['openclaw', 'playoutone'],
  },
  scalpel: {
    name: 'Scalpel',
    sshTarget: 'tripp@100.104.39.64',
    basePath: '/home/tripp/',
    services: ['openclaw'],
  },
}
