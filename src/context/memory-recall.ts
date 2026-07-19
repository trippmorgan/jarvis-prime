/**
 * Memory recall — before Prime answers, consult jarvis-OS shared memory so it
 * doesn't duplicate work already done and so it answers with current project
 * context. Pulls from two jarvis-OS surfaces (authenticated with KERNEL_TOKEN,
 * the same creds Prime already uses to register with the kernel):
 *
 *   - Hippocampus search  GET /api/v1/hippocampus/search?q=&limit=  → relevant notes
 *   - Active projects     GET /api/v1/projects                       → portfolio rows
 *
 * Fail-soft and timeout-bounded: any error / kernel-down returns '' so a memory
 * lookup can NEVER block or break a reply. Used by both single- and dual-brain
 * (they share PromptBuilder.build).
 */

interface HippoResult {
  slug: string
  name: string
  description: string
  type: string
  score?: number
}

interface ProjectRow {
  project: string
  status: string
  priority?: number
  summary?: string
  next_action?: string
}

export interface MemoryRecallOptions {
  timeoutMs?: number
  searchLimit?: number
  logger?: { warn: (o: object, m?: string) => void }
}

export async function recallMemory(query: string, opts: MemoryRecallOptions = {}): Promise<string> {
  if (process.env.JARVIS_MEMORY_RECALL_ENABLED === 'false') return ''
  // Read env at call time, not module-load: robust to import order and
  // `pm2 --update-env` without a rebuild.
  const kernelUrl = process.env.KERNEL_URL ?? 'http://127.0.0.1:3000'
  const kernelToken = process.env.KERNEL_TOKEN ?? ''
  if (!kernelToken) return ''

  const timeoutMs = opts.timeoutMs ?? 2500
  const limit = opts.searchLimit ?? 5
  const headers = { Authorization: `Bearer ${kernelToken}` }
  const q = encodeURIComponent(query.trim().slice(0, 200))

  const [notes, projects] = await Promise.all([
    fetchJson(`${kernelUrl}/api/v1/hippocampus/search?q=${q}&limit=${limit}`, headers, timeoutMs).catch(
      (err) => {
        opts.logger?.warn({ error: errMsg(err) }, 'memory recall: hippocampus search failed')
        return null
      },
    ),
    fetchJson(`${kernelUrl}/api/v1/projects`, headers, timeoutMs).catch((err) => {
      opts.logger?.warn({ error: errMsg(err) }, 'memory recall: projects fetch failed')
      return null
    }),
  ])

  const parts: string[] = []

  const results: HippoResult[] = Array.isArray(notes?.results) ? notes.results : []
  if (results.length > 0) {
    // Top hits get their full bodies (capped), not just one-line headlines —
    // a 240-char description wastes the semantic ranking. The direct note
    // read also chains the strongest MEMORY_RECALL signal for Φ consolidation.
    const bodies = await Promise.all(
      results.slice(0, 2).map((r) =>
        fetchNoteBody(kernelUrl, headers, timeoutMs, r.slug).catch(() => null),
      ),
    )
    const lines = results.map((r, i) => {
      const body = i < bodies.length ? bodies[i] : null
      const head = `- ${r.name} (${r.type}): ${oneLine(r.description)}`
      return body ? `${head}\n${indent(body)}` : head
    })
    parts.push(`### Relevant shared memory (jarvis-OS hippocampus)\n${lines.join('\n')}`)
  }

  const rows: ProjectRow[] = Array.isArray(projects?.rows) ? projects.rows : []
  const active = rows
    .filter((r) => r.status !== 'done' && r.status !== 'archived' && r.status !== 'complete')
    .slice(0, 6)
  if (active.length > 0) {
    const lines = active.map(
      (r) =>
        `- ${r.project} [${r.status}]: ${oneLine(r.summary ?? '')}` +
        (r.next_action ? ` — next: ${oneLine(r.next_action)}` : ''),
    )
    parts.push(`### Active projects (jarvis-OS)\n${lines.join('\n')}`)
  }

  if (parts.length === 0) return ''

  return (
    `## Memory check — consult before acting\n` +
    `Existing work and context from the Jarvis network. Reuse it; do NOT re-do or duplicate what is already in flight.\n\n` +
    parts.join('\n\n')
  )
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ results?: HippoResult[]; rows?: ProjectRow[] } | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as { results?: HippoResult[]; rows?: ProjectRow[] }
  } finally {
    clearTimeout(t)
  }
}

const NOTE_BODY_MAX_CHARS = 900

async function fetchNoteBody(
  kernelUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  slug: string,
): Promise<string | null> {
  const note = (await fetchJson(
    `${kernelUrl}/api/v1/hippocampus/notes/${encodeURIComponent(slug)}`,
    headers,
    timeoutMs,
  )) as { body?: string } | null
  const body = typeof note?.body === 'string' ? note.body.trim() : ''
  if (!body) return null
  return body.length > NOTE_BODY_MAX_CHARS ? `${body.slice(0, NOTE_BODY_MAX_CHARS)}…` : body
}

function indent(s: string): string {
  return s.split('\n').map((l) => `  ${l}`).join('\n')
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
