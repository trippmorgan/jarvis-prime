import { randomUUID } from 'node:crypto'

/**
 * 2026-10-20 — "let Jarvis Prime know": the LEFT had no way to reach Prime and searched the box for
 * one (round 27d48004). This posts to the jarvis-os room mesh on the kernel bus, the same path
 * TALOS.md documents for talos: POST /api/v1/registry/events, channel "room", members narrowed to
 * frank + the recipients, recipients in `mentions` so only their listeners answer.
 */
export interface HubNotifyRequest { message: string; to?: string[] }
export interface HubNotifyEnv { kernelUrl?: string; kernelToken?: string; node?: string; from?: string }

export const HUB_NOTIFY_DEFAULT_TO = ['prime']
const RECIPIENT = /^[a-z][a-z0-9_-]{0,31}$/
const MAX_MESSAGE_CHARS = 2000

export function hubNotifyEnv(env: NodeJS.ProcessEnv = process.env): HubNotifyEnv {
  return { kernelUrl: env.LEDGER_KERNEL_URL ?? env.KERNEL_URL ?? 'http://100.80.111.84:3000', kernelToken: env.KERNEL_TOKEN,
    node: env.LEDGER_NODE ?? 'voldemort', from: env.FRANK_MESH_ALIAS ?? 'frank' }
}

/** Builds the kernel event body. Pure, so tests and the tool share one shape. */
export function hubNotifyEvent(req: HubNotifyRequest, env: HubNotifyEnv): { to: string[]; body: Record<string, unknown> } | { error: string } {
  const message = String(req.message ?? '').trim()
  if (!message) return { error: 'notify_hub: empty message' }
  const to = [...new Set((req.to?.length ? req.to : HUB_NOTIFY_DEFAULT_TO).map(s => String(s).trim().toLowerCase()).filter(Boolean))]
  const bad = to.find(s => !RECIPIENT.test(s))
  if (bad) return { error: `notify_hub: invalid recipient "${bad.slice(0, 40)}"` }
  const from = env.from ?? 'frank'
  const members = [from, ...to.filter(s => s !== from)]
  return { to, body: { body: message.slice(0, MAX_MESSAGE_CHARS), severity: 'info', node: env.node ?? 'voldemort',
    metadata: { channel: 'room', chat_id: `room-${members.join('-')}`, from, members, mentions: to, source: 'frank-left-notify_hub', request_id: randomUUID() } } }
}

/** Never throws: the LEFT gets a one-line tool result either way, so it can report honestly. */
export async function notifyHub(req: HubNotifyRequest, env: HubNotifyEnv = hubNotifyEnv(), fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<{ ok: boolean; text: string; to: string[]; eventId?: string | number }> {
  const built = hubNotifyEvent(req, env)
  if ('error' in built) return { ok: false, text: `(${built.error})`, to: [] }
  if (!env.kernelUrl) return { ok: false, text: '(notify_hub failed: no kernel URL configured)', to: built.to }
  if (!env.kernelToken) return { ok: false, text: '(notify_hub failed: no KERNEL_TOKEN in this process — tell Tripp the hub bearer is missing)', to: built.to }
  try {
    const r = await fetchImpl(`${env.kernelUrl.replace(/\/$/, '')}/api/v1/registry/events`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.kernelToken}` },
      body: JSON.stringify(built.body),
    })
    const raw = await r.text().catch(() => '')
    if (!r.ok) return { ok: false, text: `(notify_hub failed: kernel HTTP ${r.status} ${raw.replace(/\s+/g, ' ').slice(0, 160)})`, to: built.to }
    let id: string | number | undefined
    try { const j = JSON.parse(raw) as Record<string, unknown>; const d = (j.data ?? j.event ?? j) as Record<string, unknown>; if (typeof d.id === 'string' || typeof d.id === 'number') id = d.id } catch { /* id optional */ }
    return { ok: true, eventId: id, to: built.to, text: `(delivered to ${built.to.join(', ')} on the jarvis-os room mesh${id !== undefined ? `, event ${id}` : ''}; they reply on the mesh, not in this chat)` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, text: `(notify_hub failed: ${msg.replace(/\s+/g, ' ').slice(0, 160)})`, to: built.to }
  }
}
