# SPEC: kernel-janitor

## Goal

A nightly maintenance job that keeps the kernel database lean. Retention window: 7 days. Runs at 06:00 ET — after DIL (05:50) so the improvement loop reads a full event log, then janitor prunes the stale tail. Archives to JSONL before any hard delete.

## What It Cleans

### 1. events table
- **Prune:** rows where `ts < NOW() - INTERVAL '7 days'`
- **Archive:** write to `.planning/kernel-archive/YYYY-MM-DD/events.jsonl` before delete
- **Safe:** DIL reads events for the prior calendar day (always within the 7-day window)
- **PHI:** `events.metadata` may contain PHI — archive file is local-only, never logged to stdout row-by-row; only counts are logged

### 2. sessions table
- **Prune:** rows where `status IN ('done','failed')` AND `ended_at < NOW() - INTERVAL '7 days'`
- **Archive:** `.../sessions.jsonl`
- **Do not touch:** `status IN ('running','awaiting_input','blocked')` — may be long-running legitimate sessions

### 3. envelopes table
- **Prune (terminal):** `status IN ('consumed','failed')` AND `created_at < NOW() - INTERVAL '7 days'`
- **Prune (expired):** `status IN ('pending','running')` AND `deadline IS NOT NULL` AND `deadline < NOW() - INTERVAL '1 hour'` — mark `status = 'expired'` before archiving and deleting (preserves audit trail for the brief window before purge)
- **Do not touch:** `status IN ('pending','running')` with no deadline or non-expired deadline
- **Archive:** `.../envelopes.jsonl`

### 4. agents — tombstone dead
- **Tombstone:** `status != 'dead'` AND `last_heartbeat < NOW() - INTERVAL '24 hours'`
- **Action:** `UPDATE agents SET status = 'dead'` — do NOT delete; agents are a registry
- **Log:** count of agents tombstoned by node + tier

## What It Does NOT Touch

- `clinical_ai_metrics` — clinical telemetry; separate retention policy (365 days minimum)
- `pgboss.*` schema — pg-boss manages its own archive via `archiveCompletedAfterSeconds`
- Events within the 7-day window, regardless of severity
- Any session that is still active

## Archive Format

```
.planning/kernel-archive/
  YYYY-MM-DD/
    events.jsonl       # one JSON object per line
    sessions.jsonl
    envelopes.jsonl
    summary.json       # counts + timestamp, not row data
```

`summary.json` structure:
```json
{
  "run_at": "2026-05-20T06:00:12.341Z",
  "retention_days": 7,
  "cutoff": "2026-05-13T06:00:12.341Z",
  "pruned": {
    "events": 1842,
    "sessions": 23,
    "envelopes_terminal": 156,
    "envelopes_expired": 4
  },
  "tombstoned": {
    "agents": 2
  },
  "errors": []
}
```

## Scheduling

- Cron: `'0 6 * * *'` (06:00 NY)
- Queue: `'kernel-janitor'`
- Capability: `'maintenance'` (new capability group)
- Timezone: `America/New_York`
- Fits between: DIL (05:50) → **janitor (06:00)** → self-healing-digest (06:25) → morning-briefing (06:30)

## Failure Handling

- Handler never rethrows — a janitor failure must not cascade
- On partial failure: archive what was written, log which step failed, return degraded result
- On archive write failure: skip delete for that table (archive is prerequisite to delete)
- Logs a single `logSystemEvent('kernel_janitor_complete', summary)` on finish

## Constraints

- Minimum batch size before archive write: 1 row (don't write empty JSONL files)
- Archive directory created on first use (mkdirp)
- Delete uses `WHERE id = ANY($1::text[])` with the archived ID set — not a blind time-range DELETE, to ensure what was archived is exactly what was deleted
- Max batch per run: 50,000 rows per table (safety cap; unlikely to be hit at 7-day window with current traffic)
