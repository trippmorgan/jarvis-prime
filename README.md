# Jarvis Prime — Unified Command Runtime

Jarvis Prime is the central brain for the Jarvis network. It bridges Telegram with Claude Code's reasoning engine, giving Tripp a single conversation thread to command a 5-node infrastructure. Built on SuperServer, it polls the Telegram Bot API directly, processes messages through Claude Code CLI, and responds in-chat.

**Status:** v1 complete (2026-04-16). All 23 tasks, 65 tests, 7 E2E smoke tests passing.

## Architecture

```
Tripp (phone)
  │
  ▼
@trippassistant_bot (Telegram Bot API)
  │
  ▼
TelegramPoller ─── long-polls getUpdates, filters by allowed chat IDs
  │
  ▼
MessageProcessor
  ├── PHI Scanner ─── regex scan, blocks patient data before processing
  ├── Message Queue ─── FIFO, sequential drain (one Claude session at a time)
  ├── Ack Timer ─── 8s delay, sends "Working on it..." if Claude hasn't responded
  ├── Prompt Builder ─── injects system context + skill instructions + conversation history
  ├── Claude Spawner ─── `claude --print --model sonnet` with timeout
  └── Conversation History ─── JSONL, last 10 exchanges persisted to disk
  │
  ▼
Telegram Bot API sendMessage ─── response delivered to Tripp
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| Direct Telegram polling (bypass OpenClaw inbound) | OpenClaw has no hook/middleware for message interception. Gateway is WebSocket, not REST. Cleanest path: jarvis-prime owns the bot poll loop. |
| Claude Code CLI, not Agent SDK | `claude --print` loads full .claude/ config (identity, skills, rules, agents) for free. SDK can replace later. |
| Single brain on SuperServer | Memory, skills, and config stay in one place. Lieutenants accessed via SSH. No sync complexity. |
| Sequential message queue | Parallel Claude sessions are expensive and produce interleaved results. One at a time. |
| 8-second ack delay | Claude CLI cold start takes 6-10s. At 5s, every message got a spurious "Working on it..." before the real response. 8s lets simple messages complete silently. |
| OpenClaw Telegram disabled | When jarvis-prime is live, it owns @trippassistant_bot polling. OpenClaw's Telegram poller is disabled to avoid 409 conflicts. |

## The Network

Jarvis Prime commands four lieutenant nodes via SSH over Tailscale mesh:

| Node | Machine | SSH Target | Role |
|------|---------|------------|------|
| **Jarvis Prime** | SuperServer | localhost | General — orchestration, Telegram, main brain |
| **Frank** | Voldemort (ROMED8-2T) | root@192.168.0.108 | Local AI — Ollama, GPU inference |
| **Argus** | Mac Pro 5,1 | jarvisagent@100.70.105.85 | Network security, visual cortex |
| **DJ Jarvis** | Pretoria (3630) | djjarvis@100.116.2.71 | Radio station (WPFQ) |
| **Scalpel** | Precision T3600 | tripp@100.104.39.64 | Clinical ops, Athena EMR |

## Source Structure

```
src/
├── index.ts                    Entry point — load config, build server, start poller
├── config.ts                   Zod-validated environment config
├── server.ts                   Fastify server factory, route registration
├── bridge/
│   └── processor.ts            Central nervous system — PHI scan → queue → spawn → deliver
├── claude/
│   ├── spawner.ts              Spawns `claude --print` subprocess with timeout + SIGKILL
│   └── types.ts                SpawnOptions, SpawnResult types
├── context/
│   ├── history.ts              JSONL conversation history (append, getRecent, formatForPrompt)
│   └── prompt-builder.ts       Reads skill .md files, builds system prompt with context
├── delivery/
│   └── delivery-client.ts      POST to OpenClaw gateway (legacy), spool on failure, splitMessage
├── lieutenant/
│   ├── status.ts               SSH health check per node, parallel getAllNodeStatuses
│   └── relay.ts                Send messages to lieutenant OpenClaw instances
├── phi/
│   └── scanner.ts              Regex patterns: MRN, DOB, patient names, clinical notes
├── queue/
│   ├── message-queue.ts        FIFO sequential queue with event emission
│   └── types.ts                QueueMessage, QueueReceipt, QueueEvent types
├── routes/
│   └── message.ts              POST /message (202 + queue), GET /queue (status)
├── ssh/
│   ├── executor.ts             Node resolution → SSH exec, local vs remote, ConnectTimeout=10
│   ├── file-ops.ts             readRemoteFile, writeRemoteFile, listRemoteDir, path validation
│   └── types.ts                SshResult, NodeConfig, NODES registry
├── telegram/
│   └── poller.ts               Bot API getUpdates long-poll, 409 conflict backoff, sendMessage
└── __tests__/                  11 test files, 65 tests + E2E results doc
```

## Claude Code Configuration

jarvis-prime relies on Claude Code's `.claude/` directory for identity and capabilities. When `claude --print` is spawned, it automatically loads:

| Path | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Jarvis Prime identity, personality, network topology |
| `~/.claude/skills/*.md` | 6 skills: /network-status, /frank-status, /station-check, /deploy, /dispatch, /dev |
| `~/.claude/agents/*.md` | 3 agents: network-ops, clinical-reviewer, frank-debugger |
| `~/.claude/rules/*.md` | 3 rules: phi-security, credentials-protection, network-conventions |
| `~/.claude/hooks/session-start-context.sh` | Injects HEARTBEAT, MEMORY, node pings at session start |
| `~/.claude/settings.json` | Auto-allow patterns for SSH, git, npm, system commands |

The PromptBuilder additionally reads skill files and injects their instructions into every prompt, since `--print` mode doesn't support interactive slash commands.

## MCP Servers

Available to all spawned Claude sessions (account-level, no local config needed):

| Server | Tools |
|--------|-------|
| PubMed | 7 tools — article search, full text, citations, related articles |
| ICD-10 Codes | 6 tools — diagnosis/procedure lookup, validation, hierarchy |
| CMS Coverage | 8 tools — NCD/LCD search, contractor lookup, coverage details |
| Clinical Trials | 6 tools — trial search, eligibility, sponsors, endpoints |
| Google Calendar | 8 tools — events, scheduling, calendars |
| Gmail | 2 tools — authenticate, complete auth |

## Running

### Prerequisites

- Node.js 22+
- Claude Code CLI installed (`~/.local/bin/claude`)
- Telegram bot token for @trippassistant_bot
- SSH keys configured for all lieutenant nodes
- Tailscale connected to mesh

### Start

```bash
cd /home/tripp/.openclaw/workspace/jarvis-prime
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN

# Development
npx tsx src/index.ts

# Production
npm run build && npm start
```

### Health Check

```
GET http://localhost:3100/status
→ {"ok": true, "version": "0.1.0", "uptime": ..., "queue": {...}, "telegram": "active"}
```

### Send a Message (HTTP API)

```
POST http://localhost:3100/message
{"chatId": "8048875001", "text": "Hello Jarvis", "userId": "user1"}
→ 202 {"queued": true, "position": 1, "id": "..."}
```

### Tests

```bash
npx vitest run       # 65 tests across 11 files
npx vitest           # watch mode
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Fastify HTTP server port |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to Claude Code CLI binary |
| `CLAUDE_MODEL` | sonnet | Model for `claude --print` (sonnet, opus, haiku) |
| `CLAUDE_TIMEOUT_MS` | 120000 | Hard timeout per Claude invocation |
| `TELEGRAM_BOT_TOKEN` | — | Bot API token for @trippassistant_bot |
| `TRIPP_CHAT_ID` | 8048875001 | Allowed Telegram chat ID |
| `OPENCLAW_GATEWAY_URL` | http://127.0.0.1:18789 | Legacy OpenClaw delivery endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | — | Bearer token for OpenClaw gateway |
| `WORKSPACE_DIR` | ~/.openclaw/workspace | OpenClaw workspace root |
| `DELIVERY_QUEUE_DIR` | ~/.openclaw/delivery-queue | Spool dir for failed deliveries |

## Message Flow (Detailed)

1. **Telegram poll** — TelegramPoller calls `getUpdates` with 30s long-poll timeout
2. **Filter** — Only messages from allowed chat IDs proceed
3. **PHI scan** — `scanText()` runs regex patterns against message text. Match → 422 response, message blocked
4. **Queue** — Message enqueued with `crypto.randomUUID()` ID. 202 returned immediately
5. **Drain** — Sequential drain loop picks up next message
6. **History** — Message appended to conversation-history.jsonl
7. **Ack timer** — 8-second timer starts. If Claude hasn't responded, sends "Working on it..." via Telegram
8. **Prompt build** — PromptBuilder assembles: system context + skill instructions + last 10 conversation exchanges + current message
9. **Claude spawn** — `claude --print --model sonnet --dangerously-skip-permissions` via child_process. Prompt piped via stdin
10. **Response** — Output captured from stdout. Ack timer cancelled if still pending
11. **Deliver** — Response sent via Telegram Bot API `sendMessage`. Messages over 4096 chars split at newline boundaries
12. **Log** — Both user message and response appended to conversation history JSONL

### Error Handling

- **Claude timeout** (>120s) — Process killed with SIGKILL, "timed out" message delivered
- **Claude error** (non-zero exit) — stderr captured, error message delivered
- **PHI detected** — Message blocked with 422, user notified, PHI content never echoed
- **Telegram 409** — Another bot instance polling. 90-second backoff, then retry
- **SSH unreachable** — ConnectTimeout=10, graceful "node unreachable" response

## OpenClaw Rollback

jarvis-prime replaces OpenClaw's Telegram polling on SuperServer. To revert to the previous state where OpenClaw handles @trippassistant_bot directly:

### 1. Stop jarvis-prime

```bash
# Find the process
pgrep -af "tsx src/index"
# or
ss -tlnp | grep 3100

# Kill it
kill <pid>
```

### 2. Re-enable OpenClaw Telegram

Edit `/home/tripp/.openclaw/openclaw.json` on SuperServer. Find the Telegram provider block and set `enabled` back to `true`:

```json
{
  "providers": {
    "telegram": {
      "enabled": true,
      ...
    }
  }
}
```

The exact path: `~/.openclaw/openclaw.json` — look for `"telegram"` inside the providers object.

### 3. Restart OpenClaw on SuperServer

```bash
cd ~/.openclaw
# OpenClaw uses its own process manager
openclaw restart
# or if using systemd:
systemctl --user restart openclaw
```

### 4. Verify

Send a test message to @trippassistant_bot. OpenClaw should respond using its default LLM gateway (not Claude Code). Check OpenClaw logs at `~/.openclaw/logs/` for confirmation.

### What Changes Back

| Component | jarvis-prime active | After rollback |
|-----------|-------------------|----------------|
| Telegram polling | jarvis-prime TelegramPoller | OpenClaw bot poller |
| Message brain | Claude Code CLI (`claude --print`) | OpenClaw default LLM gateway |
| Skills/agents | Full .claude/ config (6 skills, 3 agents) | OpenClaw workspace skills only |
| PHI scanning | Regex scanner in bridge | None (OpenClaw has no PHI gate) |
| Conversation history | JSONL in .data/ | OpenClaw conversation state |
| Lieutenant SSH | Direct SSH from Claude sessions | Not available through OpenClaw |
| MCP servers | PubMed, ICD-10, CMS, Calendar, etc. | Not available through OpenClaw |

### Coexistence Notes

- jarvis-prime and OpenClaw cannot both poll @trippassistant_bot simultaneously (Telegram 409 conflict)
- OpenClaw on lieutenant nodes (Frank, DJ Jarvis, Scalpel) is unaffected by jarvis-prime — they have their own bots
- The `openclaw.json` change is the only modification to OpenClaw. Everything else is additive (new project directory, new .claude/ config files)
- jarvis-prime's HTTP API on :3100 can run alongside OpenClaw even when OpenClaw Telegram is re-enabled, for testing or hybrid operation

## Acceptance Criteria (v1)

| AC | Status | Evidence |
|----|--------|----------|
| AC1: Simple message < 30s | PASS | "Hello Jarvis" in 9.4s, "You still there" in 5.1s |
| AC2: /network-status returns 5-node health | PASS | Full table with warnings (Argus CPU, Scalpel disk) in ~23s |
| AC5: SSH command on Voldemort → result | PASS | "Run uptime on Voldemort" in 8.6s |
| AC6: PHI blocked before Claude | PASS | 8 unit tests — MRN, DOB, patient names, clinical notes |
| AC7: Lieutenant OpenClaw unaffected | PASS | Only SuperServer Telegram disabled |
| AC8: Memory persists across sessions | PASS | "What did we talk about earlier" referenced real history |
| AC9: MCP servers accessible | PASS | All 6 servers verified (37 tools total) |

AC3 (/dispatch), AC4 (/dev via Telegram), AC10 (morning cron) are v2 scope.

## Planning Artifacts

Detailed spec, plan, task breakdown, and execution traces in `.planning/`:

- `SPEC.md` — Requirements, architecture, acceptance criteria (approved 2026-04-16)
- `PLAN.md` — 23 tasks, 6 waves, dependency DAG (approved 2026-04-16)
- `STATE.md` — Task-by-task execution log with status, retries, notes
- `TRACES.md` — Execution traces and deviation records

## v2 Roadmap

Not yet planned. Candidate features from the spec:

- **Cron/scheduled tasks** — Morning briefing, network health monitor, PR/deploy watcher
- **Loop integration** — OpenClaw loop system invoking Claude for reasoning on each tick
- **Cross-lieutenant coordination** — Multi-node deploy, aggregated status dashboard
- **Conversation continuity** — Session handoff on context window fill, resume capability
- **/dispatch integration** — Fire Claude Managed Agents via jarvis-dispatch from Telegram
