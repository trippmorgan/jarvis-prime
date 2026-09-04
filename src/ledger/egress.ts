/**
 * egress.ts — every Telegram message Prime sends is an EGRESS entry on the
 * lifecoin jarvis chain (channel, purpose, HMAC'd recipient, sha256 of the
 * exact text, byte size, outcome). Prime's replies are the most significant
 * outbound flow in the mesh and were the last one unattested (2026-09-04).
 *
 * Uses lifecoin's built CLI library directly (same signer key + pepper the
 * daemon uses). Fire-and-forget: never delays or fails a send. Kill switch:
 * JARVIS_LEDGER_EGRESS=off.
 */

import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const LIFECOIN_DIST = process.env.LIFECOIN_DIST ?? '/home/tripp/.openclaw/workspace/lifecoin/dist'
const CFG_DIR = process.env.PHI_LEDGER_DIR ?? path.join(os.homedir(), '.config', 'phi-ledger')

interface LedgerLib {
  readLedgerEnv(env: NodeJS.ProcessEnv): unknown
  openChainForWriting(env: unknown): { db: { close(): void }; chain: { append(signer: unknown, t: string, p: unknown): unknown; count(): number }; signer: unknown }
  loadPepperFile(p: string): Buffer
  computePathToken(pepper: Buffer, rel: string): string
}

let libPromise: Promise<LedgerLib | null> | null = null
let pepper: Buffer | null = null
let disabledReason: string | null = null

async function lib(): Promise<LedgerLib | null> {
  if (!libPromise) {
    libPromise = (async () => {
      try {
        const signer = (await import(path.join(LIFECOIN_DIST, 'ledger-signer.js'))) as Record<string, unknown>
        const token = (await import(path.join(LIFECOIN_DIST, 'subject-token.js'))) as Record<string, unknown>
        const s = (signer.default ?? signer) as Record<string, unknown>
        const t = (token.default ?? token) as Record<string, unknown>
        const l: LedgerLib = {
          readLedgerEnv: s.readLedgerEnv as LedgerLib['readLedgerEnv'],
          openChainForWriting: s.openChainForWriting as LedgerLib['openChainForWriting'],
          loadPepperFile: t.loadPepperFile as LedgerLib['loadPepperFile'],
          computePathToken: t.computePathToken as LedgerLib['computePathToken'],
        }
        if (typeof l.openChainForWriting !== 'function') throw new Error('lifecoin dist missing openChainForWriting')
        pepper = l.loadPepperFile(process.env.PHI_LEDGER_PEPPER ?? path.join(CFG_DIR, 'pepper.v1'))
        return l
      } catch (err) {
        disabledReason = err instanceof Error ? err.message : String(err)
        return null
      }
    })()
  }
  return libPromise
}

export interface EgressInput {
  chatId: string
  text: string
  outcome: 'sent' | 'failed' | 'skipped'
  purpose: string
  redaction?: 'phi-free' | 'phi-redacted' | 'clinical'
}

/** Append one EGRESS entry. Resolves to the new head seq, or null when off/unavailable. */
export async function attestEgress(input: EgressInput): Promise<number | null> {
  if ((process.env.JARVIS_LEDGER_EGRESS ?? 'on').toLowerCase() === 'off') return null
  const l = await lib()
  if (!l || !pepper) return null
  try {
    const env = l.readLedgerEnv({ ...process.env, PHI_LEDGER_MODE: 'jarvis' })
    const opened = l.openChainForWriting(env)
    try {
      const bytes = Buffer.from(input.text, 'utf8')
      opened.chain.append(opened.signer, 'EGRESS', {
        payload_version: 1,
        channel: 'telegram',
        purpose: input.purpose.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'reply',
        recipient_token: l.computePathToken(pepper, `egress:telegram:${input.chatId}`),
        content_hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        byte_size: bytes.length,
        redaction: input.redaction ?? 'phi-free',
        outcome: input.outcome,
        sender: 'jarvis-prime',
        observed_at: new Date().toISOString(),
      })
      return opened.chain.count()
    } finally {
      opened.db.close()
    }
  } catch (err) {
    disabledReason = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Why attestation is currently unavailable (for /status), or null when fine. */
export function egressLedgerStatus(): { enabled: boolean; reason: string | null } {
  return { enabled: (process.env.JARVIS_LEDGER_EGRESS ?? 'on').toLowerCase() !== 'off' && disabledReason === null, reason: disabledReason }
}
