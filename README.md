# Jarvis Prime — Unified Command Runtime + Corpus Callosum (Dual-Brain)

Jarvis Prime is the central brain for the Jarvis network. It bridges Telegram with Claude Code's reasoning engine, giving Tripp a single conversation thread to command a 5-node infrastructure. Built on SuperServer, it polls the Telegram Bot API directly, processes messages through Claude Code CLI, and responds in-chat.

**v1:** single-brain Claude Code bridge (complete 2026-04-16).
**v1.1 — corpus-callosum:** Gibsonian dual-brain extension (Waves 1–4 complete 2026-04-18). Every natural-language message is now processed by two LLM hemispheres working in parallel through a "corpus callosum" — left (Claude, 51% dominant) = logical/structural, right (gpt-5.4 codex via OpenClaw gateway) = holistic/creative. Claude integrates the final response with dissent silently merged.
**v1.2 — Telegram evolving-message UX** (Wave 6, complete 2026-04-19). One evolving bubble per message with phase labels (Thinking → Drafting → Revising → Integrating → final) and typing heartbeat. Legacy ack path preserved behind `JARVIS_EVOLVING_MESSAGE_ENABLED=false`.
**v1.3 — OpenClaw-agent right hemisphere** (Wave 7, complete 2026-04-20). Right hemisphere can be served by a persistent `right-brain` OpenClaw agent with per-chat session memory, behind `RIGHT_BRAIN_AGENT_ENABLED`. Transport failures auto-fallback to the chat-completions client when `RIGHT_BRAIN_AGENT_FALLBACK=true`. Workspace allowlist enforces an 8-file view; credentials never in scope. PHI handling is delegated to the Claude-team clinical pipeline (clinical archive + `CORPUS_CLINICAL_OVERRIDE`).
**v1.4 — Brain-directed skill router** (Wave 8, shipped live 2026-04-21). Left hemisphere plans in a `<dispatch>` block, choosing skill / research / tool modes; skill dispatches run the methodology via `RightBrainSkillShim` (Path B — jarvis-prime spawns a full-tool Claude CLI, feeds the result back into right's pass-1 as `<skill-evidence>`). Bounded 1-retry self-correction. Router lives behind `JARVIS_ROUTER_ENABLED=true`. Same-day hotfix flipped `spawnClaude` defaults to `enableTools: true` / `enableSlashCommands: true` so the dispatcher and shim both get the full tool surface by default.

**v1.5 — Tier-0 quick-question short-circuit** (Wave 8.7, live 2026-04-22). An in-process embedding classifier (`@xenova/transformers`, all-MiniLM-L6-v2) runs against every natural-language turn before dual-brain. High-confidence `quick_q` matches bypass the full corpus callosum and route to single-brain Claude — fast lane for "good morning" / "thanks" / "what time is it" style messages. Threshold + flag: `JARVIS_TIER0_ENABLED=true`, `JARVIS_TIER0_THRESHOLD=0.65`. Other classifications (`tool_call`, `dispatch`, `deep_review`, null) fall through unchanged so the wave is purely additive.

**v1.6 — Langfuse observability spine** (Wave 8.8 / 8.8.3, live 2026-04-22). Every Telegram turn opens a root trace (`telegram_message`) finalised with classification kind, tier-0 metadata, path, outcome, and the final response (clinical-redacted under override). Per-phase spans (`tier0_classify`, `dual_brain`) and per-hemisphere generations (`pass1_left`, `pass1_right`, `pass2_left`, `pass2_right`, `integration`, `single_brain_call`) attach to the trace with model name, latency, and pass-2 draft text. Self-hosted on SuperServer at `http://100.80.111.84:3200` (Tailscale-only). Reporter is a thin wrapper around the Langfuse SDK and degrades to a `NoopReporter` when `LANGFUSE_ENABLED=false` or credentials are missing — observability never blocks the conversation path. See [OBSERVABILITY.md](./OBSERVABILITY.md) for dashboard access, query recipes, and PHI policy.

**Status (current, 2026-04-22):** 507/508 tests passing (1 live-only skipped by default), `tsc --noEmit` clean. Bridge live with `JARVIS_TIER0_ENABLED=true` and `LANGFUSE_ENABLED=true`. Tagged `v1.0.0` on `main` (2026-04-21 ship); waves 8.7 + 8.8 + 8.8.3 land on top of the tag.

## How Tripp Uses Me

Tripp talks to me on his phone. Primary interface: Telegram @trippassistant_bot. I stay out of his way until he asks for something, then I read the context, pick the right path, and come back with an answer rather than a question.

**What he actually asks for:**

- **Network pulse** — "How's Argus doing?" / "Are all five nodes up?" / "Is Frank still escalating?" I run `/network-status`, shell to the node in question, summarise in a paragraph, flag anything amber.
- **Radio station ops** — WPFQ on Pretoria (DJ Jarvis). "Is the station on air?" / "Schedule tomorrow's show" / "What's in the music brain?" I drive PlayoutONE automation without him having to SSH.
- **Lieutenant dispatch** — work that belongs on Frank (GPU inference / Ollama), Argus (security posture / visual cortex), Scalpel (clinical EMR). I pick the right node and go there.
- **Clinical workflow** — when `CORPUS_CLINICAL_OVERRIDE=true`, natural-language turns route single-brain Claude only; the right hemisphere / OpenAI never sees PHI. Anything touching a patient is handed off to the Claude-team clinical pipeline.
- **Thinking-out-loud** — he has ADHD. He jumps topics mid-thread. I don't resist the flow; I catch whatever's in the air, organise it, hand it back when it's useful.
- **Build partner** — most of what he writes is code and planning docs. I read the relevant files before answering, offer opinions, and push back when a plan is weak.

**How I pick a path:**

- Slash command (`/toggle status`, `/network-status`, `/deploy`, `/dispatch`, `/dev`, …) → single-brain Claude fast path, no deliberation.
- Clinical override on → single-brain Claude, PHI stays inside the archive.
- Everything else → corpus callosum. Wave 8 routes tool-heavy turns through a brain-directed dispatcher (left plans → dispatches a skill → right drafts with the skill evidence), and lets chatty turns run the fast lane with no tools. Router ships behind `JARVIS_ROUTER_ENABLED`.

**Voice.** Direct, dry, British-wit-adjacent. No "Great question!", no preamble, no trailing summary of what I just did. If I disagree, I say so. If I don't know, I say that too.

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
        │     └── right             ── affordance-framed: holistic/creative
        │         ├── RIGHT_BRAIN_AGENT_ENABLED=false → RightHemisphereClient
        │         │     POST /v1/chat/completions (stateless, gpt-5.4)
        │         └── RIGHT_BRAIN_AGENT_ENABLED=true  → RightBrainAgentClient
        │               openclaw agent --agent right-brain --session-id <sha256(chatId)[:16]>
        │               (persistent per-chat session; 8-file workspace allowlist)
        │               → FallbackRightClient retries once on TransportError
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
| Clinical bypass → single-brain Claude only | For clinical-archive paths, right hemisphere is disabled entirely. PHI never reaches OpenAI. PHI handling lives in the Claude-team clinical pipeline. |
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
│   └── processor.ts            queue → classify → single-brain OR dual-brain → deliver
├── brain/                      Corpus callosum (Waves 1-3 + W7-8.7)
│   ├── router.ts               classifyMessage() — slash/clinical/natural classifier
│   ├── tier0-classifier.ts     W8.7 — embedding-based quick_q short-circuit
│   ├── tier0-seeds.ts          W8.7 — 4 buckets × 30 utterances seed corpus
│   ├── affordance.ts           left/right pass-1 + pass-2 prompt builders
│   ├── integration.ts          integrationPrompt() — Claude silent-merge final call
│   ├── left-hemisphere.ts      LeftHemisphereClient — wraps spawnClaude behind HemisphereClient
│   ├── right-hemisphere.ts     RightHemisphereClient — POSTs OpenClaw /v1/chat/completions
│   ├── right-brain-agent.ts    RightBrainAgentClient (W7) — shells `openclaw agent --session-id <deterministic>`
│   ├── fallback-right-client.ts FallbackRightClient (W7) — retries once on transport error
│   ├── right-client-factory.ts makeRightClient() (W7) — picks client based on flags + chatId
│   ├── right-brain-skill-shim.ts W8 — spawns full-tool Claude CLI for skill dispatches
│   ├── dispatch-parser.ts      W8 — parse left's `<dispatch>` + `<tools>` blocks
│   ├── dispatch-types.ts       W8 — Dispatch, ToolEvidence types
│   ├── skill-registry.ts       W8 — ALLOWED_SKILLS allowlist
│   ├── right-prompts.ts        W8 — buildRightPass1Prompt for skill/research mode
│   ├── phase-labels.ts         W6/W8 — phase-label map for evolving UX
│   ├── sessionId.ts            deriveRightBrainSessionId() (W7) — sha256(chatId)[:16]
│   ├── corpus-callosum.ts      Orchestrator — p1 parallel, p2 exchange, integration w/ one retry
│   └── types.ts                HemisphereClient, CallosumTrace, BrainResult, error classes
├── observability/              W8.8 — Langfuse trace reporter
│   └── langfuse-reporter.ts    Reporter / TraceHandle / SpanHandle / GenerationHandle interfaces; LangfuseReporter wrapper; NoopReporter fallback
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
└── __tests__/                  35 test files, 507 tests (+1 live-only, skipped by default)
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
| `OPENCLAW_CHAT_MODEL_RIGHT` | `openai-codex/gpt-5.4` | OpenClaw path-style model ID for the right hemisphere |
| `CORPUS_CALLOSUM_TIMEOUT_MS` | 90000 | Per-hemisphere-call timeout |
| `CORPUS_CLINICAL_OVERRIDE` | false | Force every natural message to single-brain Claude (clinical pipeline guard — keeps PHI off the right hemisphere / OpenAI) |
| `JARVIS_EVOLVING_MESSAGE_ENABLED` | true | Wave 6 evolving-bubble UX with phase labels + typing heartbeat. `false` → legacy ack-then-final |
| `RIGHT_BRAIN_AGENT_ENABLED` | false | Wave 7 — serve the right hemisphere via the persistent `right-brain` OpenClaw agent (per-chat session memory). `false` → stateless `/v1/chat/completions` (Wave 5/6 path) |
| `RIGHT_BRAIN_AGENT_FALLBACK` | true | When the agent throws a transport error, retry once on the chat-completions client. Model errors never fall back |
| `JARVIS_ROUTER_ENABLED` | false | Wave 8 — brain-directed skill router (left plans `<dispatch>`, right drafts with skill evidence). Live default in v1.4 deploys. |
| `JARVIS_TIER0_ENABLED` | false | Wave 8.7 — Tier-0 embedding classifier short-circuit. When on, `quick_q` matches bypass dual-brain. Currently **live (true)**. |
| `JARVIS_TIER0_THRESHOLD` | 0.65 | Cosine cutoff for accepting a Tier-0 route. Lower = more eager shortcut. |
| `LANGFUSE_ENABLED` | false | Wave 8.8 — emit a root trace per Telegram turn to the configured Langfuse host. Currently **live (true)**. |
| `LANGFUSE_HOST` | `http://100.80.111.84:3200` | Self-hosted Langfuse base URL (Tailscale-only). |
| `LANGFUSE_PUBLIC_KEY` | — | `pk-lf-...` from `workspace/langfuse/.env`. **Required** when `LANGFUSE_ENABLED=true`. |
| `LANGFUSE_SECRET_KEY` | — | `sk-lf-...` from `workspace/langfuse/.env`. **Required** when `LANGFUSE_ENABLED=true`. |
| `LANGFUSE_FLUSH_AT` | 10 | Batch size for the SDK's background flush. |
| `LANGFUSE_FLUSH_INTERVAL_MS` | 5000 | Max time between background flushes (ms). |
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
npx vitest run       # 299 tests across 26 files
npx vitest           # watch mode
npm run build        # tsc --noEmit equivalent (emits dist/)
```

## Message Flow (Detailed)

### Common prefix (both paths)
1. **Telegram poll** — TelegramPoller calls `getUpdates` with 30s long-poll timeout
2. **Filter** — Only messages from allowed chat IDs proceed
3. **Queue** — Message enqueued with `crypto.randomUUID()` ID. 202 returned immediately
4. **Drain** — Sequential drain loop picks up next message
5. **User history append** — Message persisted to `conversation-history.jsonl` as `{role: 'user'}`
6. **Classify** — `classifyMessage({text, clinicalOverride})` → `slash | clinical | natural`
7. **Ack timer** — 8s timer starts. If no response yet, sends "Working on it..."

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
- **Telegram 409** — Another bot polling. 90s backoff, then retry
- **Missing `OPENCLAW_GATEWAY_TOKEN` when dual-brain enabled** — startup fails (Zod config error)

## Structured Log Events

All logs are JSON via Fastify pino. Content is never logged — only counts, durations, event names, hemisphere tags. Fields common to all: `event`, `messageId`, `durationMs` where applicable.

Every message has a full data-flow trace. Grep one `messageId` across logs to see its entire journey from inbound to delivery.

### Inbound + queue
| Event | When | Fields |
|-------|------|--------|
| `message_inbound` | `submit()` entered | `chatId`, `userId`, `textLength`, `timestamp` |
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

- PHI is handled by the Claude-team clinical pipeline (`~/Documents/claude-team/clinical-archive/`), not by jarvis-prime input scanning
- `CORPUS_CLINICAL_OVERRIDE=true` forces single-brain Claude only — the right hemisphere / OpenAI never sees clinical content
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
| AC6: PHI handled out-of-band | PASS | Routed through Claude-team clinical pipeline; in-bridge scanner removed v1.3 |
| AC7: Lieutenant OpenClaw unaffected | PASS | Only SuperServer Telegram disabled |
| AC8: Memory persists across sessions | PASS | "What did we talk about earlier" referenced real history |
| AC9: MCP servers accessible | PASS | All 6 verified |

### v1.1 (corpus-callosum)
| AC | Status | Evidence |
|----|--------|----------|
| AC2: All 5 LLM calls logged | PASS | `callosum_pass1_*`, `callosum_pass2_*`, `callosum_integration_*` events |
| AC3: Slash commands behave identically | PASS | `processor.test.ts` slash bypass case + Wave 5 S2 live smoke (`/toggle status` → `classification kind=slash` → `route_bypass` → `single_brain_call` → `process_end path=single_brain`, zero hemisphere events) |
| AC4: Clinical path → single-brain only | PASS | `clinicalOverride` test + Wave 5 S5 live smoke (CORPUS_CLINICAL_OVERRIDE=true → `classification kind=clinical` → 0 right_hemisphere events) |
| AC5: Missing gateway token → startup fails | PASS | `config.test.ts` superRefine case |
| AC6: jarvis-toggle round-trip | PASS | Unmodified from v1 + Wave 5 S6 live smoke (openclaw→prime→openclaw→prime sequence clean, conv-history.jsonl md5 unchanged pre/post, zero 409 Conflict errors, post-toggle e2e message completed `process_end path=single_brain outcome=success`) |
| AC7: History contains only final response | PASS | Canary test — `P1-LEFT-SECRET-A` / `P1-RIGHT-SECRET-B` never in jsonl |
| AC8: GPT is meta-aware | PASS | `right-affordance-suffix` hardcoded |
| AC9: Both hemispheres read same history | PASS | Orchestrator tests |
| AC10: Right failure → Telegram error | PASS | `RightHemisphereError` test + Wave 5 S3 live smoke (unreachable gateway URL → `right_hemisphere_network_error` → Telegram error) |
| AC11: All existing tests still pass | PASS | 66 legacy tests green + Wave 5 S4 live smoke (CORPUS_CALLOSUM_ENABLED=false → single-brain fallback) |
| AC12: New test suite covers dual-brain | PASS | 14 orchestrator + 12 processor-integration tests |
| AC1: Visibly differs from Claude-alone | PASS | Wave 5 S1 smoke — 74.2s, 5 calls (L-p1 34.9s / R-p1 10.6s / L-p2 24.7s / R-p2 11.1s / integration 14.7s), 1624-char integrated response on "Tononi IIT vs Gibson" — synthesis + Tripp-specific callback visible in output |

### v1.2 (Wave 6 — Telegram evolving-message UX)
| AC | Status | Evidence |
|----|--------|----------|
| AC W6-1: Single evolving bubble per message (no second ack) | PASS | `telegram-evolving.e2e.test.ts` T7/T8 — `sendMessageAndGetId` invoked exactly once; all subsequent updates are `editMessageText` on the same `messageId`. Live smoke S7 — one bubble per user message across three runs. |
| AC W6-2: Transparent phase labels for natural dual-brain | PASS | "Thinking…" → "Drafting…" → "Revising…" → "Integrating…" → final integrated text. Unit-covered by `phase-labels.test.ts`; E2E-covered by T7 (at least one of Drafting/Revising/Integrating observed in edit sequence, final edit = integrated text). |
| AC W6-3: Opaque "Thinking…" for slash/clinical/killswitch | PASS | `phase-labels.test.ts` + T8 (slash) — no Drafting/Revising/Integrating edits emitted on single-brain path; final edit is the Claude output. |
| AC W6-4: Edit debounce ≤ 1/sec per chat | PASS | `responder.test.ts` — `editDebounceMs=1000`, rapid phase updates coalesce into a single trailing edit on window close. |
| AC W6-5: Typing-indicator heartbeat during processing | PASS | `processor.test.ts` ("typing heartbeat fires repeatedly during a long-running orchestrator") + T7 — `sendChatAction('chat-A', 'typing')` fired immediately and on 4s interval. |
| AC W6-6: Legacy fallback when surface absent OR ack returns null | PASS | T9a/T9b — surface never touched (T9a) or only `sendMessageAndGetId` called (T9b); output delivered via legacy `deliver()`. `process_end uxPath="legacy"` emitted. |
| AC W6-7: uxPath field on process_end for observability | PASS | processor.test.ts — `process_end uxPath="evolving"` on responder path, `uxPath="legacy"` on fallback. Live smoke S7 logs confirm `uxPath: "evolving"` on all three dual-brain runs. |
| AC W6-8: Killswitch `JARVIS_EVOLVING_MESSAGE_ENABLED=false` → legacy path | PASS | `config.test.ts` boolFromEnv + processor.test.ts (flag-off case) — evolving responder not constructed; processor stays on 8s ack path. |
| AC W6-9: Live smoke on Telegram | PASS | Wave 6 S7 — three natural messages on 2026-04-19 via @trippassistant_bot (PID 4014849): `uxPath="evolving" path="dual_brain" outcome="success"` all three; totals 19s / 22s / 53s; single bubble per message; phase labels + typing indicator visible. |

### v1.3 (Wave 7 — OpenClaw-agent right hemisphere)
| AC | Status | Evidence |
|----|--------|----------|
| AC W7-1: `RIGHT_BRAIN_AGENT_ENABLED=true` → agent invocation, zero `/v1/chat/completions` for right hemisphere | PASS | `right-client-factory.test.ts` — when enabled, factory returns `RightBrainAgentClient` (wrapped by `FallbackRightClient`) and never the legacy `RightHemisphereClient` on the primary path. `right-brain-agent.test.ts` asserts exact CLI flags (`agent --agent right-brain --session-id <id> --message <...> --json --thinking medium`). |
| AC W7-2: Session id derived deterministically from chatId | PASS | `sessionId.test.ts` — `deriveRightBrainSessionId('8048875001')` is deterministic; two calls produce the same `[a-z0-9]{16}` output; 1000-id collision-resistance check green. `right-client-factory.test.ts` — two factory calls with the same chatId produce agent clients with identical `sessionId`; different chatIds produce different ones. |
| AC W7-3: Two-message continuity ("purple elephant") across same chat | PASS | `right-brain-continuity.test.ts` (live, `RIGHT_BRAIN_LIVE=1`) — turn 1 plants the fact, turn 2 asks for recall, agent's turn-2 response contains `purple elephant`. Deterministic session id ensures the OpenClaw agent's on-disk session persists turn-1's context. |
| AC W7-4: Workspace contains exactly 8 allowlisted symlinks | PASS | `right-brain-workspace-allowlist.test.ts` — enumerates `right-brain-workspace/` via `fs.readdir` recursive; asserts exactly the 8 allowlisted entries (MEMORY, SOUL, IDENTITY, USER, HEARTBEAT, AGENTS, TOOLS, conversation-history.jsonl); regular files and additional dirs rejected (OpenClaw's `.openclaw/workspace-state.json` carved out explicitly). |
| AC W7-5: Allowlist test fails on disallowed content | PASS | Same test — blocklist regex rejects `openclaw.json`, `*.env`, `*.key`, `*.pem`, any path under `clinical-archive/`; test is the enforcement mechanism. |
| AC W7-6: `RIGHT_BRAIN_AGENT_ENABLED=false` routes back through chat-completions | PASS | `right-client-factory.test.ts` — when disabled, factory returns `RightHemisphereClient` (chat-completions); no regression in Wave 5/6 path. |
| AC W7-7: Clinical override never invokes agent client | PASS | `processor.test.ts` W7-T9 regression — `clinicalOverride=true` with `rightBrainAgentEnabled=true` bypasses the orchestrator entirely; `spawnClaude` called once, orchestrator never called. |
| AC W7-8: Agent failure surfaces `dual_brain_failed hemisphere=right` + Telegram error | PASS | `fallback-right-client.test.ts` — `RightBrainModelError` propagates without fallback (model bug stays visible). `processor.test.ts` existing `right hemisphere failed` path unchanged. Transport failures with fallback enabled log `right_brain_agent_fallback` and surface the backup answer instead. |
| AC W7-9: Right-brain round-trip ≤ 2× baseline | PASS | `.planning/RESEARCH-W7.md` — CLI 3 runs avg 8.37s (8.60 / 8.15 / 8.36). Baseline chat-completions in Wave 5 S1 was 10.6s (R-p1) and 11.1s (R-p2). Agent path is comparable, not 2× slower. Live continuity test plant+recall completed in ~19s total (two turns) — within the 2× envelope. |
| AC W7-10: All Wave 5 + Wave 6 ACs regression-green | PASS | 312/312 vitest green; Wave 6 E2E suite unchanged; Wave 5 processor-integration tests unchanged. Killswitch (`CORPUS_CALLOSUM_ENABLED=false`) still single-brain even with `rightBrainAgentEnabled=true` — `processor.test.ts` W7-T9 regression. |

## Planning Artifacts

Spec and plan for the corpus-callosum extension live in the sibling project:

- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/SPEC.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/PLAN.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/STATE.md`
- `/home/tripp/.openclaw/workspace/corpus-callosum/.planning/SMOKE.md` — Wave 5 T17 + Wave 6 S7 manual smoke evidence

v1 planning artifacts (SPEC/PLAN/STATE/TRACES) were in `.planning/` in this tree pre-v1.1.

## Git History

```
98641df feat(bridge): W6-T5+T6 — processor evolving-message integration + typing heartbeat
37f2821 feat(telegram): W6-T2 — TelegramResponder with debounce + typing heartbeat
737afbc feat(brain): W6-T4 — phase label map
3977a00 feat(telegram): W6-T3 — add sendMessageAndGetId, editMessageText, sendChatAction
d4ab1ce feat(config): add JARVIS_EVOLVING_MESSAGE_ENABLED (W6-T1)
1e2c3a1 docs(corpus-callosum): Wave 5 close — AC3 + AC6 live smoke evidence
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
