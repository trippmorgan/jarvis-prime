// AVSO v2 — Wave 1 T2: pending-write ledger (Boundary Contract C3).
//
// The structural enforcement of "no EMR write without a correlated
// Telegram affirmative". Every Athena write to a clinical field must be
// staged here as a *pending* entry; it commits ONLY when an affirmative
// arrives that matches the staged entry on ALL of:
//
//   • session/chat key   (which conversation armed the write)
//   • correlation id      (opaque string, minted by T1's context layer)
//   • resolved field      (the exact target field)
//   • exact text          (byte-exact fingerprint — NO normalization)
//
// Anything else — wrong id, wrong field, one-character-off text, a stale
// entry past its TTL, or a second request while one is already in flight
// — ABORTS and commits nothing. This is a pure, in-memory, single-process
// primitive: no network, no LLM, no real timers (the clock is injected so
// timeout is deterministically testable, and tests never hang).
//
// PHI is sacred. The staged text is held in memory only to fingerprint
// the eventual affirmative; this module NEVER logs, prints, or otherwise
// emits that text. peekPending() deliberately returns metadata WITHOUT
// the text so callers/observability can see *that* a write is armed and
// *which field*, but never *what* would be written.

/** Injected so timeout is deterministic and tests never hang on timers. */
export type NowFn = () => number

export interface AthenaWriteLedgerOptions {
  /** Monotonic-ish millisecond clock. Inject in tests; default Date.now. */
  now?: NowFn
  /** Time-to-live for a pending entry, in ms. Default 10 minutes. */
  ttlMs?: number
}

export interface OpenRequest {
  /** Session / chat key — one in-flight write per key (single-in-flight). */
  sessionKey: string
  /** Opaque correlation id (minted upstream by the v2 context layer). */
  correlationId: string
  /** The exact resolved clinical field the write targets. */
  field: string
  /** The exact text to be written (held only to fingerprint the confirm). */
  text: string
}

/** What an affirmative carries back for matching against the pending entry. */
export interface ConfirmRequest {
  sessionKey: string
  correlationId: string
  field: string
  text: string
}

export type OpenResult =
  | { accepted: true }
  | { accepted: false; reason: 'already_pending' }

export type AbortReason =
  | 'no_pending'
  | 'expired'
  | 'correlation_mismatch'
  | 'field_mismatch'
  | 'text_mismatch'

export type LedgerResolution =
  | {
      committed: true
      sessionKey: string
      correlationId: string
      /** Echoed so the caller can perform the write without re-deriving. */
      field: string
      text: string
    }
  | { committed: false; reason: AbortReason }

/** PHI-safe view of an armed write: metadata only, NEVER the staged text. */
export interface PendingMeta {
  sessionKey: string
  correlationId: string
  field: string
  /** Epoch ms (from the injected clock) when the entry was opened. */
  openedAt: number
  /** Epoch ms after which the entry is considered expired. */
  expiresAt: number
}

interface PendingEntry {
  correlationId: string
  field: string
  text: string
  openedAt: number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

/**
 * In-memory single-in-flight pending-write ledger. Module/process scoped
 * by construction (one Map); callers share one instance per process.
 */
export class AthenaWriteLedger {
  private readonly now: NowFn
  private readonly ttlMs: number
  private readonly pending = new Map<string, PendingEntry>()

  constructor(opts: AthenaWriteLedgerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** True iff this entry has aged strictly past its TTL. */
  private isExpired(e: PendingEntry, at: number): boolean {
    return at - e.openedAt > this.ttlMs
  }

  /** Drop the entry if present AND past TTL. Returns the live entry else. */
  private liveEntry(sessionKey: string): PendingEntry | undefined {
    const e = this.pending.get(sessionKey)
    if (!e) return undefined
    if (this.isExpired(e, this.now())) {
      this.pending.delete(sessionKey)
      return undefined
    }
    return e
  }

  /**
   * Stage a write. At most ONE live pending entry per sessionKey: a second
   * open() while one is in flight is rejected (it does NOT clobber the
   * first). An entry already past its TTL is treated as gone, so a fresh
   * open() after expiry is accepted.
   */
  open(req: OpenRequest): OpenResult {
    if (this.liveEntry(req.sessionKey)) {
      return { accepted: false, reason: 'already_pending' }
    }
    this.pending.set(req.sessionKey, {
      correlationId: req.correlationId,
      field: req.field,
      text: req.text,
      openedAt: this.now(),
    })
    return { accepted: true }
  }

  /**
   * Resolve an affirmative against the pending entry. Commits ONLY on an
   * exact match of correlation id AND field AND text (byte-exact, no
   * normalization). The entry is single-use: a successful commit consumes
   * it. Expiry consumes it too. A non-matching attempt does NOT consume a
   * still-valid entry (so a typo'd affirmative doesn't burn the gate), but
   * it commits nothing.
   */
  confirm(req: ConfirmRequest): LedgerResolution {
    const raw = this.pending.get(req.sessionKey)
    if (!raw) return { committed: false, reason: 'no_pending' }

    if (this.isExpired(raw, this.now())) {
      this.pending.delete(req.sessionKey)
      return { committed: false, reason: 'expired' }
    }

    if (raw.correlationId !== req.correlationId) {
      return { committed: false, reason: 'correlation_mismatch' }
    }
    if (raw.field !== req.field) {
      return { committed: false, reason: 'field_mismatch' }
    }
    if (raw.text !== req.text) {
      return { committed: false, reason: 'text_mismatch' }
    }

    // All gates passed — consume and commit.
    this.pending.delete(req.sessionKey)
    return {
      committed: true,
      sessionKey: req.sessionKey,
      correlationId: raw.correlationId,
      field: raw.field,
      text: raw.text,
    }
  }

  /** Explicitly drop a pending entry. True iff one was present & removed. */
  cancel(sessionKey: string): boolean {
    return this.pending.delete(sessionKey)
  }

  /** True iff a live (non-expired) pending write exists for this session. */
  hasPending(sessionKey: string): boolean {
    return this.liveEntry(sessionKey) !== undefined
  }

  /**
   * PHI-safe inspection: metadata of the live pending write, or null.
   * Deliberately omits the staged text — observability can see THAT a
   * write is armed and WHICH field, never WHAT would be written.
   */
  peekPending(sessionKey: string): PendingMeta | null {
    const e = this.liveEntry(sessionKey)
    if (!e) return null
    return {
      sessionKey,
      correlationId: e.correlationId,
      field: e.field,
      openedAt: e.openedAt,
      expiresAt: e.openedAt + this.ttlMs,
    }
  }
}
