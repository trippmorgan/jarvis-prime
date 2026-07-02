import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Mode = 'single' | 'dual'

// 'openclaw' = native direct-Ollama GLM left runtime; 'claude' = Anthropic Claude CLI left.
export type LeftRuntime = 'openclaw' | 'claude'

interface PersistedState {
  mode: Mode
  updatedAt: string
}

export class ModeState {
  private mode: Mode
  private readonly persistPath: string | null
  // In-memory only — deliberately NOT persisted (predictable boot: you should
  // never wake up surprised which left runtime is active).
  private leftRuntime: LeftRuntime

  constructor(initial: Mode = 'single', persistPath?: string, leftRuntime: LeftRuntime = 'openclaw') {
    this.persistPath = persistPath ?? null
    this.mode = this.restore() ?? initial
    this.leftRuntime = leftRuntime
  }

  get current(): Mode {
    return this.mode
  }

  get currentLeftRuntime(): LeftRuntime {
    return this.leftRuntime
  }

  setLeftRuntime(runtime: LeftRuntime): LeftRuntime {
    this.leftRuntime = runtime
    return this.leftRuntime
  }

  toggle(): Mode {
    this.mode = this.mode === 'single' ? 'dual' : 'single'
    this.persist()
    return this.mode
  }

  private restore(): Mode | null {
    if (!this.persistPath) return null
    try {
      const raw = readFileSync(this.persistPath, 'utf-8')
      const state: PersistedState = JSON.parse(raw)
      if (state.mode === 'single' || state.mode === 'dual') return state.mode
    } catch {
      // missing or corrupt — fall through to default
    }
    return null
  }

  private persist(): void {
    if (!this.persistPath) return
    const state: PersistedState = { mode: this.mode, updatedAt: new Date().toISOString() }
    const dir = dirname(this.persistPath)
    mkdirSync(dir, { recursive: true })
    const tmp = this.persistPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(state) + '\n')
    renameSync(tmp, this.persistPath)
  }
}
