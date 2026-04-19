# Jarvis Prime — Unified Command Runtime + Corpus Callosum (Dual-Brain)

Jarvis Prime is the central brain for the Jarvis network. It bridges Telegram with Claude Code's reasoning engine, giving Tripp a single conversation thread to command a 5-node infrastructure. Built on SuperServer, it polls the Telegram Bot API directly, processes messages through Claude Code CLI, and responds in-chat.

**v1:** single-brain Claude Code bridge (complete 2026-04-16).
**v1.1 — corpus-callosum:** Gibsonian dual-brain extension (Waves 1–4 complete 2026-04-18). Every natural-language message is now processed by two LLM hemispheres working in parallel through a "corpus callosum" — left (Claude, 51% dominant) = logical/structural, right (gpt-5.4 codex via OpenClaw gateway) = holistic/creative. Claude integrates the final response with dissent silently merged.

**Status:** 216 tests passing across 19 test files. `tsc` + `npm run build` clean. Live dual-brain smoke test S1 passed 2026-04-18 (74.2s, 5 LLM calls, integrated synthesis on Tononi/Gibson).

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
  ├── Queue ─── FIFO, sequential drain (one message at a time)
  ├── Router ─── classifyMessage({text, clinicalOverride}) → slash | clinical | natural
  │
  ├── slash / clinical / killswitch → Single-Brain path
  │     ├── PromptBuilder ─── system context + skills + last 10 history + message
  │     ├── spawnClaude ─── `claude --print --model sonnet` with timeout
  │     └── deliver + history.append('assistant', output)
  │
  └── natural (dual-brain) → Corpus Callosum
        ├── PASS 1 (parallel)
        │     ├── left (Claude)     ── affordance-framed: logical/structural
        │     └── right (GPT-5.4)   ── affordance-framed: holistic/creative
        ├── PASS 2 (revision exchange)
        │     ├── left sees right-p1, revises
        │     └── right sees left-p1, revises
        ├── INTEGRATION (Claude only)
        │     └── integrationPrompt(basePrompt, history, userMsg, p2Left, p2Right)
        │        ── one retry on failure, silent dissent merge
        └── deliver + history.append('assistant', finalText)   ← only final persists
```

Five LLM calls per natural-language message: `left-p1`, `right-p1`, `left-p2`, `right-p2`, `integration`. Slash commands and clinical override paths keep the original single-brain behavior byte-for-byte.

### Gibsonian doctrine (why two passes)

Per `voldemort-botspace/gibson-research`:

- **Affordance reframing per hemisphere.** The same sensory input (user message + history) is framed differently for each hemisphere so the affordance invites the respective cognitive style. Left = "logical structure, sequential dependencies, precise definitions, constraints, causal chains." Right = "patterns, holistic connections, creative alternatives, action-possibilities."
- **Twice, minimum.** Pass 1 = parallel independent drafts. Pass 2 = each hemisphere sees the other's draft and revises. Invariants emerge from direct pickup — no explicit "extract invariants" step.
- **Shared sensory history.** Both hemispheres read the same `.data/conversation-history.jsonl` slice. Only Claude's final integrated response is written back.
- **Meta-aware right hemisphere.** GPT's system prompt tells it explicitly: "You are the right hemisphere of a dual-brain system. Claude is the left hemisphere and final integrator. Your job is pattern recognition, holistic connection, creative alternatives."
- **51% dominance.** Claude is always the final integrator. No consensus, no tie-breaking — dissent is merged silently into Claude's natural voice.

### Key Design Decisions

| Decision | Why |
|----------|-----|
| Direct Telegram polling (bypass OpenClaw inbound) | OpenClaw has no hook/middleware for message interception. Cleanest path: jarvis-prime owns the bot poll loop. |
| Claude Code CLI, not Agent SDK | `claude --print` loads full `.claude/` config (identity, skills, rules, agents) for free. SDK can replace later. |
| Right hemisphere via OpenClaw gateway | Reuses OpenClaw's existing OpenAI-compatible route at `127.0.0.1:18789/v1/chat/completions`. No second OpenAI key in jarvis-prime. |
| Dual-brain always-on for natural messages | Maximum quality by default. Tripp's insight: Gibson's depth is structural — both hemispheres always engage. |
| Slash commands bypass dual-brain | `/toggle`, `/network-status`, `/frank-status`, `/station-check`, `/deploy`, `/dispatch`, `/dev` go single-brain → skill. Preserves existing routing. |
| Clinical bypass → single-brain Claude only | For clinical-archive paths, right hemisphere is disabled entirely. PHI never reaches OpenAI. Belt-and-suspenders on top of the PHI scanner. |
| Silent dissent merge | Claude integrates GPT's perspective without visible "GPT disagreed" flags. Highest quality, loses some transparency. |
| API errors surface to Tripp | Hemisphere failure relays the error to Telegram. No auto-fallback. Handled case-by-case. |
| Sequential message queue | Parallel sessions are expensive and interleave. One at a time. |
| 8-second ack delay | Claude CLI cold start takes 6–10s. 8s lets simple messages complete silently. |

## The Network

Jarvis Prime commands four lieutenant nodes via SSH over Tailscale mesh:

| Node | Machine | SSH Target | Role |
|------|---------|------------|------|
| **Jarvis Prime** | SuperServer | localhost | General — orchestration, Telegram, main brain |
| **Frank** | Voldemort (ROMED8-2T) | root@192.168.0.108 | Local AI — Ollama, GPU inference, dual-brain Gibson |
| **Argus** | Mac Pro 5,1 | jarvisagent@100.70.105.85 | Network security, visual cortex |
| **DJ Jarvis** | Pretoria (3630) | djjarvis@100.116.2.71 | Radio station (WPFQ) |
| **Scalpel** | Precision T3600 | tripp@100.104.39.64 | Clinical ops, Athena EMR |

## Source Structure

```
src/
├── index.ts                    Entry point — load config, build server, start poller
├── config.ts                   Zod-validated env; superRefine enforces OPENCLAW_* when dual-brain on
├── server.ts                   Fastify factory; wires dual-brain config into MessageProcessor
├── bridge/
│   └── processor.ts            PHI scan → queue → classify → single-brain OR dual-brain → deliver
├── brain/                      Corpus callosum (Waves 1-3)
│   ├── router.ts               classifyMessage() — slash/clinical/natural classifier
│   ├── affordance.ts           left/right pass-1 + pass-2 prompt builders
│   ├── integration.ts          integrationPrompt() — Claude silent-merge final call
│   ├── left-hemisphere.ts      LeftHemisphereClient — wraps spawnClaude behind HemisphereClient
│   ├── right-hemisphere.ts     RightHemisphereClient — POSTs OpenClaw /v1/chat/completions
│   ├── corpus-callosum.ts      Orchestrator — p1 parallel, p2 exchange, integration w/ one retry
│   └── types.ts                HemisphereClient, CallosumTrace, BrainResult, error classes
├── claude/
│   ├── spawner.ts              child_process → `claude --print` with timeout + SIGKILL
│   └── types.ts                SpawnOptions, SpawnResult
├── context/
│   ├── history.ts              JSONL history (append, getRecent, formatForPrompt)
│   └── prompt-builder.ts       Reads skill .md files, builds single-brain system prompt
├── delivery/
│   └── delivery-client.ts      POST to OpenClaw gateway (legacy), spool-on-failure
├── lieutenant/
│   ├── status.ts               SSH health check per node, parallel getAllNodeStatuses
│   └── relay.ts                Send messages to lieutenant OpenClaw instances
├── phi/
│   └── scanner.ts              Regex: MRN, DOB, patient names, clinical notes
├── queue/
│   ├── message-queue.ts        FIFO sequential queue with event emission
│   └── types.ts                QueueMessage, QueueReceipt, QueueEvent
├── routes/
│   └── message.ts              POST /message (202 + queue), GET /queue
├── ssh/
│   ├── executor.ts             Node resolution → SSH exec, ConnectTimeout=10
│   ├── file-ops.ts             readRemoteFile, writeRemoteFile, listRemoteDir, path validation
│   └── types.ts                SshResult, NodeConfig, NODES registry
├── telegram/
│   └── poller.ts               Bot API getUpdates long-poll, 409 backoff, sendMessage
└── __tests__/                  18 test files, 212 tests
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Fastify HTTP server port |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to Claude Code CLI binary |
| `CLAUDE_MODEL` | sonnet | Model for `claude --print` / left hemisphere |
| `CLAUDE_TIMEOUT_MS` | 120000 | Hard timeout per Claude invocation |
| `TELEGRAM_BOT_TOKEN` | — | Bot API token for @trippassistant_bot |
| `TRIPP_CHAT_ID` | 8048875001 | Allowed Telegram chat ID |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | OpenClaw OpenAI-compatible gateway base URL |
| `OPENCLAW_GATEWAY_TOKEN` | — | Bearer token for gateway. **Required** when dual-brain enabled |
| `CORPUS_CALLOSUM_ENABLED` | true | Dual-brain kill-switch. `false` → always single-brain |
| `OPENCLAW_CHAT_MODEL_RIGHT` | `gpt-5.4 codex` | Model name sent to OpenClaw gateway for right hemisphere |
| `CORPUS_CALLOSUM_TIMEOUT_MS` | 90000 | Per-hemisphere-call timeout |
| `WORKSPACE_DIR` | `~/.openclaw/workspace` | OpenClaw workspace root |
| `DELIVERY_QUEUE_DIR` | `~/.openclaw/delivery-queue` | Spool dir for failed deliveries |

Config validation enforces: `CORPUS_CALLOSUM_ENABLED=true` requires both `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` to be non-empty. Missing either → startup fails with a Zod error.

## Running

### Prerequisites

- Node.js 22+
- Claude Code CLI installed (`~/.local/bin/claude`)
- OpenClaw gateway running on `127.0.0.1:18789` with an OpenAI-compatible model configured for `gpt-5.4 codex` (or whatever `OPENCLAW_CHAT_MODEL_RIGHT` points at)
- Telegram bot token for @trippassistant_bot
- SSH keys configured for all lieutenant nodes
- Tailscale connected to mesh

### Start

```bash
cd /home/tripp/.openclaw/workspace/jarvis-prime
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, OPENCLAW_GATEWAY_TOKEN

# Development
npx tsx src/index.ts

# Production
npm run build && npm start

# Kill-switch to single-brain (skip dual-brain entirely)
CORPUS_CALLOSUM_ENABLED=false npm start
```

### Health check

```
GET http://localhost:3100/status
→ {"ok": true, "version": "0.1.0", "uptime": ..., "queue": {...}, "telegram": "active"}
```

### Send a message (HTTP API)

```
POST http://localhost:3100/message
{"chatId": "8048875001", "text": "Hello Jarvis", "userId": "user1"}
→ 202 {"queued": true, "position": 1, "id": "..."}
```

### Tests

```bash
npx vitest run       # 212 tests across 18 files
npx vitest           # watch mode
npm run build        # tsc --noEmit equivalent (emits dist/)
```

## Message Flow (Detailed)

### Common prefix (both paths)
1. **Telegram poll** — TelegramPoller calls `getUpdates` with 30s long-poll timeout
2. **Filter** — Only messages from allowed chat IDs proceed
3. **PHI scan** — `scanText()` regex. Match → message blocked, user notified, PHI never echoed
4. **Queue** — Message enqueued with `crypto.randomUUID()` ID. 202 returned immediately
5. **Drain** — Sequential drain loop picks up next message
6. **User history append** — Message persisted to `conversation-history.jsonl` as `{role: 'user'}`
7. **Classify** — `classifyMessage({text, clinicalOverride})` → `slash | clinical | natural`
8. **Ack timer** — 8s timer starts. If no response yet, sends "Working on it..."

### Single-brain path (slash / clinical / killswitch)
9a. **Prompt build** — PromptBuilder assembles: system context + skill instructions + last 10 history + current message
10a. **Claude spawn** — `claude --print --model sonnet` via child_process. Prompt piped via stdin
11a. **Response** — Output captured from stdout. Ack timer cancelled
12a. **Deliver** — Response sent via `sendMessage`. Over 4096 chars split at newline boundaries
13a. **Assistant history append** — `{role: 'assistant', content: output}`

### Dual-brain path (natural language)
9b. **Base prompt build** — PromptBuilder (reused) produces the shared `basePrompt` for the orchestrator's system blocks
10b. **History slice** — `history.getRecent(10)` — both hemispheres will see the same slice
11b. **PASS 1 parallel** (`Promise.all`):
   - left-p1 via `leftAffordancePrompt(basePrompt, history, userMsg)` → `LeftHemisphereClient.call()`
   - right-p1 via `rightAffordancePrompt(...)` → `RightHemisphereClient.call()` → POST `/v1/chat/completions`
12b. **PASS 2 exchange** (`Promise.all`, each hemisphere sees the other's pass-1 draft):
   - left-p2 via `leftRevisionPrompt(basePrompt, history, userMsg, leftP1, rightP1)`
   - right-p2 via `rightRevisionPrompt(basePrompt, history, userMsg, rightP1, leftP1)`
13b. **INTEGRATION** — single Claude call via `integrationPrompt(basePrompt, history, userMsg, leftP2, rightP2)`. One retry on failure; throws `IntegrationError` after the second failure.
14b. **Deliver** — `finalText` chunked + sent to Telegram
15b. **Assistant history append** — only `finalText` persists. Pass-1/pass-2 drafts stay in memory (emitted only via logger).

### Error handling

- **Claude timeout / non-zero exit (single-brain)** — "Request timed out" or error message delivered
- **`LeftHemisphereError`** — "Left hemisphere failed: {message}" delivered, `dual_brain_failed` logged with `hemisphere: "left"`
- **`RightHemisphereError`** — "Right hemisphere failed: {message}" delivered, `hemisphere: "right"`
- **`IntegrationError`** — "Integration failed after retry: {message}" delivered, `hemisphere: "integration"`
- **PHI detected** — Message blocked, user notified, PHI never echoed back
- **Telegram 409** — Another bot polling. 90s backoff, then retry
- **Missing `OPENCLAW_GATEWAY_TOKEN` when dual-brain enabled** — startup fails (Zod config error)

## Structured Log Events

All logs are JSON via Fastify pino. Content is never logged — only counts, durations, event names, hemisphere tags. Fields common to all: `event`, `messageId`, `durationMs` where applicable.

Every message has a full data-flow trace. Grep one `messageId` across logs to see its entire journey from inbound to delivery.

### Inbound + queue
| Event | When | Fields |
|-------|------|--------|
| `message_inbound` | `submit()` entered | `chatId`, `userId`, `textLength`, `timestamp` |
| `phi_scan` | After regex scan | `chatId`, `blocked`, `reasonsCount`, `reasons?` (codes only, when blocked) |
| `message_enqueued` | After `queue.enqueue()` | `messageId`, `position`, `chatId` |

### Processing
| Event | When | Fields |
|-------|------|--------|
| `process_start` | Dequeued, starting processing | `messageId`, `queueLength` |
| `history_user_appended` | After `history.append('user', …)` | `messageId`, `userContentLength` |
| `classification` | `classifyMessage()` returned | `messageId`, `kind` (slash/clinical/natural) |
| `prompt_built` | After `PromptBuilder.build()` | `messageId`, `promptLength`, `historyEntriesUsed` |
| `ack_sent` | Ack timer fired | `messageId`, `ackDelayMs` |
| `process_end` | Final exit of process loop | `messageId`, `totalPipelineMs`, `path` (single_brain/dual_brain), `outcome` (success/error/timeout) |

### Routing
| Event | When | Fields |
|-------|------|--------|
| `route_dual_brain` | Natural message going through orchestrator | `messageId` |
| `route_bypass` | Slash / clinical / killswitch taking single-brain | `kind`, `messageId` |

### Single-brain
| Event | When | Fields |
|-------|------|--------|
| `single_brain_call_start` | Before `spawnClaude()` | `messageId` |
| `single_brain_call_end` | `spawnClaude()` returned | `messageId`, `durationMs`, `timedOut`, `exitCode`, `outputLength`, `stderrLength` |

### Delivery
| Event | When | Fields |
|-------|------|--------|
| `delivery_start` | Before `deliverChunked()` | `messageId`, `chatId` |
| `delivery_end` | All chunks sent | `messageId`, `chatId`, `chunks`, `totalLength`, `deliveryMs`, `outcome` (success/error) |
| `history_assistant_appended` | After `history.append('assistant', …)` | `messageId`, `assistantContentLength` |

### Orchestrator (corpus-callosum.ts)
| Event | When | Fields |
|-------|------|--------|
| `callosum_start` | Orchestrator entered | `userMsgLength` |
| `callosum_pass1_start` | Before `Promise.all([left-p1, right-p1])` | — |
| `callosum_pass1_ok` | Both pass-1 drafts returned | `leftMs`, `rightMs` |
| `callosum_pass2_start` | Before `Promise.all([left-p2, right-p2])` | — |
| `callosum_pass2_ok` | Both pass-2 drafts returned | `leftMs`, `rightMs` |
| `callosum_integration_start` | Before integration call | — |
| `callosum_integration_retry` | Integration failed once, retrying | — |
| `callosum_integration_ok` | Integration succeeded | `integrationMs` |
| `callosum_integration_failed` | Integration failed twice | `error` |
| `callosum_done` | End of orchestrator | `totalMs` |

### Hemispheres
| Event | When | Fields |
|-------|------|--------|
| `left_hemisphere_call_start` | Before spawn | `model`, `timeoutMs`, `hemisphere: "left"` |
| `left_hemisphere_call_success` | Spawn returned ok | `durationMs`, `outputLength` |
| `left_hemisphere_timeout` | Spawn exceeded timeout | `durationMs`, `timeoutMs` |
| `left_hemisphere_exit_error` | Spawn exit ≠ 0 | `exitCode`, `stderrLength` |
| `left_hemisphere_spawn_error` | Spawner threw | `error` |
| `right_hemisphere_call_start` | Before POST | `model`, `timeoutMs` |
| `right_hemisphere_call_ok` | 2xx + valid JSON | `durationMs`, `promptTokens?`, `completionTokens?`, `totalTokens?` |
| `right_hemisphere_timeout` | AbortController fired | `durationMs`, `timeoutMs` |
| `right_hemisphere_http_error` | Non-2xx | `status`, `durationMs` |
| `right_hemisphere_parse_error` | JSON.parse threw | `durationMs` |
| `right_hemisphere_network_error` | fetch rejected | `durationMs`, `errorMessage` |

### Dual-brain outcome
| Event | When | Fields |
|-------|------|--------|
| `dual_brain_call_start` | Before orchestrator invocation | `messageId`, `timeoutMs` |
| `dual_brain_done` | Dual-brain processed + delivered | `totalMs`, `integrationMs`, `outputLen`, `ackSent` |
| `dual_brain_failed` | Any error class caught in dual-brain path | `hemisphere` (left/right/integration), `error` |

## OpenClaw gateway — right hemisphere endpoint

The right hemisphere is GPT-5.4 codex (or any model OpenClaw's gateway can route), called via OpenClaw's standard OpenAI-compatible route:

```
POST http://127.0.0.1:18789/v1/chat/completions
Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN
Content-Type: application/json

{
  "model": "gpt-5.4 codex",
  "messages": [
    {"role": "system", "content": "<base-prompt>\n\n<right-affordance-suffix>"},
    {"role": "user",   "content": "<formatted-history>\n\nTripp: <message>"}
  ],
  "stream": false
}
```

No second OpenAI key needed in jarvis-prime — auth flows through OpenClaw.

## jarvis-toggle

The existing `jarvis-toggle prime|openclaw|status` command at the bot-poller level is unaffected by dual-brain. Dual-brain only applies when jarvis-prime is the active poller. Toggling to OpenClaw drops back to OpenClaw's default LLM entirely.

## PHI Security (Immutable)

Patient health information is sacred. Never exposed in logs, external services, or unencrypted channels. Rules per `~/.claude/rules/phi-security.md`:

- PHI scanner intercepts before any LLM call (single-brain or dual-brain)
- Clinical override env flag forces single-brain Claude only — GPT never sees PHI
- All log events are content-free; only counts, durations, hemisphere tags, event names
- History canary tests verify pass-1/pass-2 drafts never leak to `conversation-history.jsonl`

## Claude Code Configuration

jarvis-prime relies on Claude Code's `.claude/` directory for identity and capabilities. When `claude --print` is spawned for the left hemisphere or a bypass path, it automatically loads:

| Path | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Jarvis Prime identity, personality, network topology |
| `~/.claude/skills/*.md` | Skills matched by slash-prefix classifier |
| `~/.claude/agents/*.md` | 3 agents: network-ops, clinical-reviewer, frank-debugger |
| `~/.claude/rules/*.md` | 3 rules: phi-security, credentials-protection, network-conventions |
| `~/.claude/hooks/session-start-context.sh` | Injects HEARTBEAT, MEMORY, node pings at session start |
| `~/.claude/settings.json` | Auto-allow patterns for SSH, git, npm, system commands |

## MCP Servers

Available to all spawned Claude sessions (account-level):

| Server | Tools |
|--------|-------|
| PubMed | 7 tools — article search, full text, citations, related articles |
| ICD-10 Codes | 6 tools — diagnosis/procedure lookup, validation, hierarchy |
| CMS Coverage | 8 tools — NCD/LCD search, contractor lookup, coverage details |
| Clinical Trials | 6 tools — trial search, eligibility, sponsors, endpoints |
| Google Calendar | 8 tools — events, scheduling, calendars |
| Gmail | 2 tools — authenticate, complete auth |

## OpenClaw Rollback

jarvis-prime replaces OpenClaw's Telegram polling on SuperServer. To revert:

1. **Stop jarvis-prime** — `pgrep -af "tsx src/index"` → `kill <pid>`
2. **Re-enable OpenClaw Telegram** — edit `~/.openclaw/openclaw.json`, set `providers.telegram.enabled = true`
3. **Restart OpenClaw** — `openclaw restart` (or systemd equivalent)
4. **Verify** — send test message to @trippassistant_bot; OpenClaw responds via its default gateway

| Component | jarvis-prime active | After rollback |
|-----------|-------------------|----------------|
| Telegram polling | jarvis-prime TelegramPoller | OpenClaw bot poller |
| Message brain | dual-brain (Claude + GPT) / single-brain Claude | OpenClaw default LLM |
| Skills/agents | Full `.claude/` config | OpenClaw workspace skills only |
| PHI scanning | Regex scanner in bridge | None |
| Conversation history | JSONL in `.data/` | OpenClaw state |
| Lieutenant SSH | Direct SSH from Claude sessions | Not available |
| MCP servers | Full MCP access | Not available |

jarvis-prime and OpenClaw cannot both poll @trippassistant_bot simultaneously (Telegram 409 conflict). Lieutenant OpenClaw instances (Frank, DJ Jarvis, Scalpel) are unaffected — they have their own bots.

## Acceptance Criteria

### v1 (single-brain bridge)
| AC | Status | Evidence |
|----|--------|----------|
| AC1: Simple message < 30s | PASS | "Hello Jarvis" in 9.4s |
| AC2: /network-status returns 5-node health | PASS | Full table with warnings in ~23s |
| AC5: SSH command on Voldemort → result | PASS | "Run uptime on Voldemort" in 8.6s |
| AC6: PHI blocked before Claude | PASS | 8 unit tests |
| AC7: Lieutenant OpenClaw unaffected | PASS | Only SuperServer Telegram disabled |
| AC8: Memory persists across sessions | PASS | "What did we talk about earlier" referenced real history |
| AC9: MCP servers accessible | PASS | All 6 verified |

### v1.1 (corpus-callosum)
| AC | Status | Evidence |
|----|--------|----------|
| AC2: All 5 LLM calls logged | PASS | `callosum_pass1_*`, `callosum_pass2_*`, `callosum_integration_*` events |
| AC3: Slash commands behave identically | PASS | `processor.test.ts` slash bypass case + existing tests unchanged |
| AC4: Clinical path → single-brain only | PASS | `clinicalOverride` test; orchestrator not called |
| AC5: Missing gateway token → startup fails | PASS | `config.test.ts` superRefine case |
| AC6: jarvis-toggle round-trip | PASS | Unmodified from v1 |
| AC7: History contains only final response | PASS | Canary test — `P1-LEFT-SECRET-A` / `P1-RIGHT-SECRET-B` never in jsonl |
| AC8: GPT is meta-aware | PASS | `right-affordance-suffix` hardcoded |
| AC9: Both hemispheres read same history | PASS | Orchestrator tests |
| AC10: Right failure → Telegram error | PASS | `RightHemisphereError` test |
| AC11: All existing tests still pass | PASS | 66 legacy tests green |
| AC12: New test suite covers dual-brain | PASS | 14 orchestrator + 12 processor-integration tests |
| AC1: Visibly differs from Claude-alone | PASS | Wave 5 S1 smoke — 74.2s, 5 calls (L-p1 34.9s / R-p1 10.6s / L-p2 24.7s / R-p2 11.1s / integration 14.7s), 1624-char integrated response on "Tononi IIT vs Gibson" — synthesis + Tripp-specific callback visible in output |

## Planning Artifacts

Spec and plan for the corpus-callosum extension live in the sibling project:

- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/SPEC.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/PLAN.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/STATE.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/SMOKE.md` — Wave 5 T17 manual checklist

v1 planning artifacts (SPEC/PLAN/STATE/TRACES) were in `.planning/` in this tree pre-v1.1.

## Git History

```
e90c4b7 feat(corpus-callosum): Wave 5 T16 — e2e smoke test (AC1+AC2+AC3+AC4)
817127a feat(processor): add data-flow logging across full pipeline
86b1d38 corpus-callosum Wave 4: processor integration (T13-T15)
9f67998 corpus-callosum Wave 3: orchestrator (T09-T12)
aad1eb2 test(corpus-callosum): add failing tests for Wave 3 orchestrator
86117e4 corpus-callosum Wave 2: hemisphere clients (T07-T08)
97273de Initial commit: jarvis-prime v1 + corpus-callosum Wave 1 scaffolding
```

## v2 Roadmap

- **Explicit invariant logging** for Gibsonian research/analysis
- **User-visible dissent flags** (toggleable)
- **Third hemisphere** (chairman/judge) pattern
- **Dual-brain for non-conversational channels** (email, webhooks)
- **Adaptive depth gate** — skip pass 2 for trivial messages based on confidence
- **Cost/latency budgets** with per-message caps
- **Swappable right-hemisphere model** (currently locked to `OPENCLAW_CHAT_MODEL_RIGHT`)
- **Cron/scheduled tasks** — morning briefing, network health monitor
- **/dispatch integration** — fire Claude Managed Agents from Telegram
