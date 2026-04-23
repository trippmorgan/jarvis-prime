# Observability — Langfuse spine (Wave 8.8 / 8.8.3)

This doc covers the live Langfuse stack on SuperServer: how to reach the dashboard, what jarvis-prime sends to it, how to test the pipeline, and how to turn it off.

## TL;DR

- **Dashboard:** `http://100.80.111.84:3200` (Tailscale-only — must be on the mesh)
- **Login:** `pretoriafieldscollective@gmail.com` + the bootstrap password in `~/.openclaw/workspace/langfuse/.env` (`LANGFUSE_INIT_USER_PASSWORD`)
- **Org / project:** `jarvis` / `jarvis-prime`
- **Toggle:** `LANGFUSE_ENABLED=true|false` in `~/.openclaw/workspace/jarvis-prime/.env` (restart the bridge to pick up changes)
- **Status today:** flag is **on**. Bridge is recording every Telegram turn.

## How to use the dashboard

1. From any node on the Tailscale mesh, open `http://100.80.111.84:3200`.
2. Log in with the credentials above.
3. The default landing view is the `jarvis-prime` project's **Tracing** tab. Each Telegram turn appears as one trace named `telegram_message`.
4. Click a trace to see the timeline: classification metadata on the root, `tier0_classify` span, `dual_brain` span (when fired), and per-pass generations underneath.

### What's in a trace

| Object | Name | What it captures |
|--------|------|------------------|
| Root trace | `telegram_message` | Full turn — input, classification kind, tier-0 metadata, path (`single_brain`/`dual_brain`), outcome, final response (clinical-redacted under override), session id (`chat_<chatId>`), user id |
| Span | `tier0_classify` | Embedding classifier outcome — route, top route, top cosine, latency, threshold |
| Span | `dual_brain` | Parent for the corpus-callosum pass-1 / pass-2 / integration generations. Carries totalMs, integrationMs, tools-evidence counts |
| Generation | `pass1_left` | Claude pass-1 draft — model, hemisphere, durationMs (output text intentionally omitted to halve trace size; identical signal to pass-2 in legacy flow) |
| Generation | `pass1_right` | GPT pass-1 draft — same shape |
| Generation | `pass2_left` | Claude pass-2 draft — model, durationMs, **output** (clipped to 4000 chars, redacted under clinical-override) |
| Generation | `pass2_right` | GPT pass-2 draft — model, durationMs, mode (`skill`/`research`), skill name when applicable, output |
| Generation | `integration` | Final Claude integration — model, durationMs |
| Generation | `single_brain_call` | Slash-command, clinical, killswitch, or tier-0 quick-Q path — model, prompt + output, exit code, status (`DEFAULT`/`ERROR`) |

### Useful filters & queries

In the dashboard's Tracing tab:

- **Slash-command turns only:** filter `metadata.kind = "slash"`
- **Clinical-override turns only:** filter `metadata.kind = "clinical"` — note input/output show `[clinical_redacted]`
- **Tier-0 shortcut hits:** filter `metadata.tier0Route = "quick_q"`
- **Slow turns:** sort by latency descending, look at `metadata.totalPipelineMs`
- **Errors:** filter `tags includes "error"` or `metadata.outcome = "error"`
- **Per-chat history:** filter `sessionId = "chat_8048875001"` and sort newest first

### Cost / token tracking

Token usage is **not currently captured**. Generations carry latency + model name only. Reason: Claude CLI doesn't return usage on stdout, and the OpenClaw gateway returns usage on the JSON envelope but `RightHemisphereClient` doesn't forward it through `HemisphereCallResult`. Adding usage is a 2-3 file change tracked as future polish.

### Known issue — dual-brain phase timestamps (W8.8.3)

The `dual_brain` span and its 5 child generations (`pass1_left`, `pass1_right`, `pass2_left`, `pass2_right`, `integration`) currently land in the dashboard with `startTime` and `endTime` collapsed to the wall-clock moment when `recordDualBrainTrace` runs (immediately after the orchestrator returns). Standalone tests of the wrapper produce correct retroactive timestamps (verified end-to-end with proper latencies), but the same code path inside the live processor produces 0-latency entries. Cause is under investigation — likely a Date-serialization quirk specific to the live-bridge module loading or batched flush ordering.

What still works:
- Per-generation `metadata.durationMs` carries the correct per-pass latency from the orchestrator's `result.trace`. Dashboard latency display is wrong but the underlying signal is in metadata.
- The `tier0_classify` span uses live `new Date()` brackets and shows correct latency.
- The root trace's `totalPipelineMs` metadata is accurate.
- All trace shape (parent/child relationships, model names, output capture, redaction) is correct.

For A/B baseline measurement (W8.9), use `metadata.durationMs` on each generation instead of the dashboard's latency column. The follow-up fix is tracked in the project notes — not a blocker for capturing the signal Wave 8.9 needs.

## Testing the pipeline

### Smoke test the trace pipeline (without sending a real Telegram message)

```bash
# 1. Verify the stack is healthy
curl -sS http://100.80.111.84:3200/api/public/health
# → {"status":"OK","version":"..."}

# 2. POST a synthetic message via the bridge HTTP API
curl -sS -X POST http://localhost:3100/message \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"8048875001","text":"observability smoke test","userId":"smoke"}'

# 3. Wait ~10s for the dual-brain to complete + trace flush

# 4. Check the dashboard — newest trace named "telegram_message" should
#    have your text as input.
```

### Verify the trace shape from logs

```bash
# Bridge logs structured event names — grep for langfuse-related events:
journalctl -u jarvis-prime -f 2>/dev/null | grep -E "langfuse_|trace_"
# (or tail the dev log if running under tsx watch)
```

Expected events on a successful natural-language turn:
- `langfuse_enabled` (once at startup)
- No per-turn log noise — the SDK batches flushes silently every 5s

If you see `langfuse_disabled`, `langfuse_load_failed`, `langfuse_trace_*_failed` — the bridge degraded to NoopReporter; conversations still work, just no traces.

### What to verify in the dashboard

After sending a few real Telegram messages:

1. Open the latest trace → confirm input text matches what you sent.
2. Check the timeline shows: `tier0_classify` → `dual_brain` → 4 hemisphere generations → `integration`. Ordering and durations should add up to roughly the total trace latency.
3. Click `pass2_left` / `pass2_right` → confirm the output field shows the (possibly clipped) hemisphere drafts.
4. Slash command (`/network-status`) → trace should have only `single_brain_call`, no dual_brain span.
5. Clinical-override message (set `CORPUS_CLINICAL_OVERRIDE=true`, send a turn, flip back) → trace input/output show `[clinical_redacted]`; metadata still shows `kind=clinical`.

## How to turn it off

### Soft off (keep stack, stop tracing)

```bash
sed -i 's/^LANGFUSE_ENABLED=.*/LANGFUSE_ENABLED=false/' \
  /home/tripp/.openclaw/workspace/jarvis-prime/.env
# Restart the bridge — the reporter constructs as NoopReporter at startup.
```

### Hard off (stop the stack)

```bash
cd /home/tripp/.openclaw/workspace/langfuse
docker compose down
# Containers and volumes preserved; bring back up with `docker compose up -d`.
```

### Nuclear (delete data)

```bash
cd /home/tripp/.openclaw/workspace/langfuse
docker compose down -v
# Wipes Postgres + ClickHouse + MinIO volumes. You'd need to re-run the
# init bootstrap to recreate the org/project/admin user.
```

## Architecture notes

```
Telegram turn
  │
  ▼
processor.process()
  │
  ├── trace = reporter.startTrace({name:"telegram_message", input:msg, sessionId:"chat_<id>"})
  │
  ├── (natural only) tier0Span = trace.startSpan({name:"tier0_classify"})
  │   tier0Span.end({output:{route, topRoute}})
  │
  ├── single-brain path
  │     gen = trace.startGeneration({name:"single_brain_call", model, input:prompt})
  │     gen.end({output, level})
  │
  └── dual-brain path
        orchestrator returns BrainResult{trace}
        recordDualBrainTrace(trace, result):
          dualSpan = trace.startSpan({name:"dual_brain"})
            pass1_left  generation
            pass1_right generation
            pass2_left  generation (output captured)
            pass2_right generation (output captured)
            integration generation
          dualSpan.end()
  │
  ▼
emitProcessEnd → trace.update({output:final, metadata:{path,outcome,uxPath,totalPipelineMs}, tags:[...]})
                 trace.end()
```

### PHI policy

- `CORPUS_CLINICAL_OVERRIDE=true` → root trace input/output and `single_brain_call` input/output are replaced with the constant `[clinical_redacted]`. Pass-2 generation outputs use the same redaction path.
- Metadata (model, latency, exit codes, classification kind) is always captured — these are PHI-free.
- The Langfuse stack is **Tailscale-only** (langfuse-web bound to `100.80.111.84:3200`, never `0.0.0.0`). Postgres bound to `127.0.0.1:5435`. MinIO bound to `127.0.0.1:9090`. No data leaves the SuperServer.
- Postgres password and Clickhouse/MinIO secrets live in `workspace/langfuse/.env` (mode 0600, gitignored).

### Failure modes

| Symptom | Cause | Recovery |
|---------|-------|----------|
| No traces in dashboard | `LANGFUSE_ENABLED=false` or missing keys | Check `.env`, restart bridge, look for `langfuse_enabled` in logs |
| Bridge logs `langfuse_load_failed` | `langfuse` package missing or broken | `npm install` in `jarvis-prime/` |
| Bridge logs `langfuse_trace_start_failed` | Network failure to host | Check `curl http://100.80.111.84:3200/api/public/health` |
| Dashboard shows traces but missing spans | `recordDualBrainTrace` exception | Check bridge logs for stack traces; spans are wrapped in try/catch — failure here can't break message delivery |
| Stack containers exit | Postgres on `:5435` collides | `docker ps | grep 543` — ensure no other Postgres rebound |

## Stack components

`workspace/langfuse/docker-compose.yml` brings up six services:

| Service | Image | Port | Notes |
|---------|-------|------|-------|
| `langfuse-web` | langfuse/langfuse | `100.80.111.84:3200` | Web UI + ingestion API |
| `langfuse-worker` | langfuse/langfuse-worker | — | Background trace processing |
| `postgres` | postgres:15 | `127.0.0.1:5435` | Metadata DB (remapped from 5432 to avoid claude-team-pg) |
| `clickhouse` | clickhouse/clickhouse-server | — | Trace storage (no exposed port) |
| `minio` | minio/minio | `127.0.0.1:9090` | Blob storage for trace inputs/outputs (internal only) |
| `redis` | redis:7 | — | Job queue |

All containers restart on failure and survive host reboot.

## Wave history

- **W8.8.1** (2026-04-22) — stack brought up, init bootstrap, AC1 met
- **W8.8.2** (2026-04-22) — SDK + Reporter wrapper + root-trace plumbing
- **W8.8.3** (2026-04-22) — span/generation primitives, per-phase + per-hemisphere instrumentation
- **W8.9** (next) — A/B baseline measurement using the captured trace data
