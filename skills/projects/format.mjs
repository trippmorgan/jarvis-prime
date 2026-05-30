/**
 * /projects — pure formatter (W5.b).
 *
 * Renders a PortfolioEnvelope (from jarvis-os portfolio-surface-service)
 * as Telegram-friendly markdown. No I/O, no service calls — just shape.
 *
 * Trust contract (mirrored from jarvis-os/.planning/portfolio-surface/SPEC.md):
 *   #2 freshness rendered, never used to filter — `stale` rows carry the ⚠
 *      marker so Tripp can see staleness without it being hidden.
 *   #4 every row carries provenance — `source_path` is emitted verbatim.
 *   #5 same rows as the OS UI — this is a render-only adapter. We do not
 *      add, drop, re-sort, or re-derive anything from the service output.
 *
 * Envelope shape (read from PortfolioSurfaceService.getActivePortfolio):
 *   {
 *     rows: Array<{
 *       project, status, priority, summary, next_action,
 *       source, source_path, owner, updated_at, freshness
 *     }>,
 *     degraded: boolean,
 *     message?: string
 *   }
 */

/**
 * @typedef {Object} PortfolioRow
 * @property {string} project
 * @property {string} status
 * @property {number} priority
 * @property {string} summary
 * @property {string} next_action
 * @property {string} source
 * @property {string} source_path
 * @property {string} owner
 * @property {string} updated_at
 * @property {'fresh'|'aging'|'stale'} freshness
 */

/**
 * @typedef {Object} PortfolioEnvelope
 * @property {PortfolioRow[]} rows
 * @property {boolean} degraded
 * @property {string} [message]
 */

/**
 * Format a portfolio envelope as Telegram-ready markdown.
 * Pure: takes envelope, returns string. No side effects.
 *
 * @param {PortfolioEnvelope} envelope
 * @returns {string}
 */
export function formatPortfolioForTelegram(envelope) {
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  const degraded = envelope?.degraded === true;

  const lines = [];

  if (degraded) {
    // Degraded envelope path (reserved for W6.1; service emits {degraded:false}
    // in W5, but we render defensively in case a future change flips it).
    lines.push('[T0 READ] /projects — DEGRADED');
    const reason = typeof envelope?.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : 'Portfolio service degraded; data may be stale.';
    lines.push(`⚠ ${reason}`);
    lines.push('Recommend: check jarvis-os logs.');
    if (rows.length > 0) {
      lines.push('');
      lines.push(...renderRows(rows));
    }
    return lines.join('\n');
  }

  const headerCount = `${rows.length} active project${rows.length === 1 ? '' : 's'}`;
  lines.push(`[T0 READ] /projects — ${headerCount}`);

  if (rows.length === 0) {
    return lines.join('\n');
  }

  lines.push('');
  lines.push(...renderRows(rows));

  return lines.join('\n');
}

/**
 * @param {PortfolioRow[]} rows
 * @returns {string[]}
 */
function renderRows(rows) {
  const out = [];
  for (const row of rows) {
    // Invariant #2: stale rows MUST be marked. ⚠ appended after the tag.
    const freshnessTag = row.freshness === 'stale'
      ? 'stale ⚠'
      : row.freshness;

    out.push(`P${row.priority} ▸ ${row.project} · ${row.status} · ${freshnessTag}`);

    // Summary — pass through verbatim. Honest-gap rows ("Needs state review")
    // are not embellished. Invariant: do not edit summary content here.
    out.push(`   ${row.summary}`);

    // Next action — only render when present (service always emits a string,
    // but defensively skip empties so we don't leave a bare `→` line).
    if (typeof row.next_action === 'string' && row.next_action.length > 0) {
      out.push(`   → ${row.next_action}`);
    }

    // Invariant #4: provenance citation, every row.
    out.push(`   src: ${row.source_path}`);
  }
  return out;
}
