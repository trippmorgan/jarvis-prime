/**
 * conscience.ts — Frank reads the network's chain-attested conscience (2026-09-17, per Tripp:
 * "we added the idea of conscience and bound it to the lifecoin blockchain observer — follow up").
 *
 * The kernel publishes the conscience bundle lifecoin builds nightly (README §9): Chamber I,
 * the pinned/Φ-ranked principles Tripp taught the network; Chamber II, recent findings it got
 * wrong. `attested: true` means a DECISION on the jarvis-ledger vouches for these exact bytes
 * (evidence_hash = snapshotHash), Argus-witnessed. Prime already injects it into every prompt
 * and stamps `conscience_hash` on decisions; this gives the two Franks the same compass:
 *   - the cross-reviewers judge both answers against the STANDING PRINCIPLES, and
 *   - every review record cites the snapshot hash that was in force (remote nodes can only
 *     post PROCESS_RUN, whose schema is strict, so the citation rides inside the hashed artifact).
 * Fail-soft: kernel down / no token → null → byte-identical pre-conscience behaviour.
 */

export interface ConscienceSnapshot {
  snapshotHash: string
  attested: boolean
  generatedAt: string
  normative: Array<{ slug: string; description: string }>
  reflective: Array<{ id: string; title: string; severity: string }>
}

export interface ConscienceCitation { snapshotHash: string; attested: boolean; generatedAt: string }

export function citeConscience(c: ConscienceSnapshot | null): ConscienceCitation | null {
  return c ? { snapshotHash: c.snapshotHash, attested: c.attested, generatedAt: c.generatedAt } : null
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

/** The compact block a reviewer (or a brain) can hold: slugs + one-line descriptions, not bodies. */
export function formatConscienceDigest(c: ConscienceSnapshot): string {
  const head = `STANDING PRINCIPLES — the network's chain-attested conscience (snapshot ${c.snapshotHash.slice(0, 8)}, ${c.attested ? 'attested on the jarvis-ledger' : 'NOT attested'}, ${c.generatedAt.slice(0, 10)})`
  const norm = c.normative.map((p) => `- ${p.slug}: ${clip(p.description, 220)}`)
  const refl = c.reflective.map((f) => `- [${f.severity}] ${clip(f.title, 200)}`)
  return [head, ...norm, ...(refl.length ? ['RECENT FINDINGS the network is asked not to repeat:', ...refl] : [])].join('\n')
}

let cache: { at: number; value: ConscienceSnapshot | null } | null = null

/** GET the conscience from the kernel, cached (default 60 s), never throws. */
export async function fetchConscience(opts: { kernelUrl?: string; token?: string; ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<ConscienceSnapshot | null> {
  const ttl = opts.ttlMs ?? 60_000
  if (cache && Date.now() - cache.at < ttl) return cache.value
  if (!opts.kernelUrl || !opts.token) return null
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(`${opts.kernelUrl.replace(/\/$/, '')}/api/v1/hippocampus/conscience`, {
      headers: { authorization: `Bearer ${opts.token}`, 'x-caller-identity': 'frank' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    })
    if (!res.ok) { cache = { at: Date.now(), value: null }; return null }
    const d = await res.json() as { attested?: boolean; snapshot?: { snapshotHash?: string; generatedAt?: string; normative?: unknown[]; reflective?: unknown[] } }
    const s = d.snapshot
    if (!s || typeof s.snapshotHash !== 'string') { cache = { at: Date.now(), value: null }; return null }
    const value: ConscienceSnapshot = {
      snapshotHash: s.snapshotHash,
      attested: d.attested === true,
      generatedAt: String(s.generatedAt ?? ''),
      normative: (Array.isArray(s.normative) ? s.normative : []).map((x) => { const o = x as { slug?: unknown; description?: unknown }; return { slug: String(o.slug ?? ''), description: String(o.description ?? '') } }).filter((p) => p.slug),
      reflective: (Array.isArray(s.reflective) ? s.reflective : []).map((x) => { const o = x as { id?: unknown; title?: unknown; severity?: unknown }; return { id: String(o.id ?? ''), title: String(o.title ?? ''), severity: String(o.severity ?? 'info') } }).filter((f) => f.title),
    }
    cache = { at: Date.now(), value }
    return value
  } catch {
    cache = { at: Date.now(), value: null }
    return null
  }
}

/** Test hook. */
export function resetConscienceCache(): void { cache = null }
