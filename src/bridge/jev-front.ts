/**
 * jev-front.ts — Jev as Frank's front end (2026-10-10, Tripp: "jev must be integrated into controlling
 * routing and answer delivery" / "use gpu and switch models in and out").
 *
 * Before the brains start, Jev is asked one typed question about the inbound message:
 *   "What does this message need from Frank?"  → quick | tools | web | deep
 * The answer picks the harness lane (frank-chat / frank / frank-deep) and, in `all` mode, whether the
 * primary path may take the single-brain shortcut. Answer *selection* (which of the two answers is
 * delivered) lives in jev-routing.ts (Frank's delivery gate); this file is only the route decision.
 *
 * Device: `gpu` (default, per Tripp) opens a GPU window on the jev-gpu-swap service — qwen is unloaded,
 * Jev is moved onto the 3090, the decision takes ~0.1 s, and qwen is restored after the service's grace
 * window. Measured cost: ~15–30 s swap-in plus ~35–40 s restore before the LEFT brain can answer.
 * `cpu` answers on the parked weights with no window (~29 s, no qwen outage). Both go through the same
 * confidence gate: below JEV_ROUTE_STRONG the existing router decides and Jev's view is only logged.
 */
import type { HistoryEntry } from '../context/history.js'
import { localService } from './shadow-review.js'

export type JevRoute = 'quick' | 'tools' | 'web' | 'deep'
export type JevFrontMode = 'off' | 'shadow' | 'harness' | 'all'
export type JevFrontDevice = 'gpu' | 'cpu'

export interface JevFrontConfig {
  jevUrl?: string
  mode: JevFrontMode
  device: JevFrontDevice
  timeoutMs: number        // whole decision incl. the GPU swap; the swap itself is ~15–30 s on this box
  strong: number           // apply Jev's route only at/above this probability
  /** 2026-10-29: per-route thresholds (ASSESSMENT-2026-10-16: the misses were all `quick` at 0.64–0.81 → quick 0.8). */
  strongByRoute?: Partial<Record<JevRoute, number>>
  /** 2026-10-29: decide on the parked CPU weights WHILE the single brain generates (no GPU window, no qwen eviction). */
  parallel?: boolean
}

export const JEV_ROUTE_OPTIONS: Array<[JevRoute, string]> = [
  ['quick', 'A quick direct reply: small talk, acknowledgement, or a short factual answer from memory'],
  ['tools', 'Work on the server: run commands, read or change files, check services or logs'],
  ['web', 'Fresh research on the web'],
  ['deep', 'Deep multi-step reasoning or analysis, no tools needed'],
]
export const JEV_ROUTE_QUESTION = 'What does this message need from Frank?'
export const JEV_ROUTE_STRONG_DEFAULT = 0.6

export interface JevRouteDecision {
  route: JevRoute
  confidence: number
  p: Record<JevRoute, number>
  ms: number
  hash: string       // service decision hash (service/decisions.jsonl) — chained via the round record
  device: string     // where the service actually answered (cuda | cpu)
}
export type JevRouteResult = JevRouteDecision | { error: string; ms: number }
export function isJevRoute(r: JevRouteResult | null | undefined): r is JevRouteDecision {
  return !!r && typeof (r as JevRouteDecision).confidence === 'number'
}

/** Harness lane for a route: quick → chat lane, tools/web → auto-route (DEEP with tools), deep → full DEEP. */
export function laneForRoute(route: JevRoute): string {
  return route === 'quick' ? 'frank-chat' : route === 'deep' ? 'frank-deep' : 'frank'
}

export function routeThreshold(cfg: JevFrontConfig, route: JevRoute): number {
  const t = cfg.strongByRoute?.[route]
  return typeof t === 'number' && Number.isFinite(t) ? t : cfg.strong
}
/** Apply Jev's route only when its probability clears the (per-route) gate and the mode allows acting on it. */
export function routeApplies(cfg: JevFrontConfig, r: JevRouteResult): boolean {
  return isJevRoute(r) && r.confidence >= routeThreshold(cfg, r.route) && (cfg.mode === 'harness' || cfg.mode === 'all')
}

export function parseFrontMode(v: string | undefined): JevFrontMode {
  const s = (v ?? '').trim().toLowerCase()
  if (s === 'shadow' || s === 'harness' || s === 'all') return s
  return 'off'
}

export function buildRouteState(text: string, history: HistoryEntry[]): string {
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '…' : t)
  const recent = history.slice(-4).map((h) => `${h.role === 'user' ? 'user' : 'assistant'}: ${clip(h.content.replace(/\s+/g, ' '), 300)}`).join('\n')
  return `RECENT CONVERSATION:\n${recent || '(none)'}\n\nNEW MESSAGE FROM TRIPP:\n${clip(text, 1500)}`
}

/** Ask Jev which route the message needs. Never throws; errors come back as { error }. */
export async function askJevRoute(cfg: JevFrontConfig, text: string, history: HistoryEntry[], fetchImpl: typeof fetch = fetch): Promise<JevRouteResult> {
  const start = Date.now()
  if (!cfg.jevUrl || cfg.mode === 'off') return { error: 'jev front disabled', ms: 0 }
  if (!localService(cfg.jevUrl)) return { error: 'jev front requires a loopback HTTP service', ms: 0 }
  try {
    const res = await fetchImpl(`${cfg.jevUrl.replace(/\/$/, '')}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        state: buildRouteState(text, history), question: JEV_ROUTE_QUESTION, options: JEV_ROUTE_OPTIONS.map((o) => o[1]),
        head: 'shipped', device: cfg.device === 'cpu' ? 'cpu' : 'auto', skip_idle_wait: true,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    const ms = Date.now() - start
    if (!res.ok) return { error: `jev route HTTP ${res.status}`, ms }
    const d = await res.json() as { probabilities?: Record<string, number>; hash?: string; device?: string; head?: string }
    if (d.head !== 'shipped' || !d.probabilities) return { error: 'jev route: unexpected response', ms }
    const p = {} as Record<JevRoute, number>
    for (const [route, desc] of JEV_ROUTE_OPTIONS) {
      const v = d.probabilities[desc]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return { error: 'jev route: invalid probabilities', ms }
      p[route] = v
    }
    if (Math.abs(Object.values(p).reduce((sum, v) => sum + v, 0) - 1) > 1e-5 || !d.hash || !['cpu', 'cuda'].includes(d.device ?? '')) return { error: 'jev route: invalid distribution or missing provenance', ms }
    const route = (Object.keys(p) as JevRoute[]).reduce((a, b) => (p[b] > p[a] ? b : a))
    return { route, confidence: p[route], p, ms, hash: String(d.hash ?? ''), device: String(d.device ?? '') }
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e), ms: Date.now() - start }
  }
}

/** What the round record stores; hashed into the ledger evidence like everything else on the record. */
export type JevRouteRecord =
  | { mode: JevFrontMode; device: JevFrontDevice; jev: JevRoute; confidence: number; applied: boolean; lane: string; ms: number; hash: string; threshold?: number; parallel?: boolean; servedOn?: string }
  | { mode: JevFrontMode; device: JevFrontDevice; error: string; ms: number; parallel?: boolean }

export function routeRecord(cfg: JevFrontConfig, r: JevRouteResult, applied: boolean, lane: string, parallel = false): JevRouteRecord {
  const device: JevFrontDevice = parallel ? 'cpu' : cfg.device
  return isJevRoute(r)
    ? { mode: cfg.mode, device, jev: r.route, confidence: r.confidence, applied, lane, ms: r.ms, hash: r.hash, threshold: routeThreshold(cfg, r.route), parallel, servedOn: r.device }
    : { mode: cfg.mode, device, error: r.error, ms: r.ms, parallel }
}
