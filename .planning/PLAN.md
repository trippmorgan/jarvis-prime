# Implementation Plan: Jarvis Prime — Unified Command Runtime

> Generated 2026-04-16 by Jarvis Development Methodology

## Summary
- Total tasks: 23
- Total waves: 6
- Estimated time (parallel): ~45 minutes
- Estimated time (sequential): ~90 minutes
- Scope: v1 only (R1–R5). v2 (R6–R9) deferred to separate plan.

## Global Context
**Project:** Jarvis Prime — Unified Command Runtime
**Tech Stack:** TypeScript/Node.js (bridge service, Fastify), Claude Code CLI (`claude --print`), OpenClaw (Telegram transport), SSH/Tailscale (lieutenant access)
**Goal:** Bridge OpenClaw's Telegram infrastructure with Claude Code's reasoning engine so Tripp interacts via @trippassistant_bot and Jarvis Prime commands 4 lieutenant nodes.

**Key paths:**
- Bridge service: `/home/tripp/.openclaw/workspace/jarvis-prime/`
- Claude config: `/home/tripp/.claude/`
- OpenClaw config: `/home/tripp/.openclaw/openclaw.json`
- Existing dispatch (reference): `/home/tripp/.openclaw/workspace/jarvis-dispatch/`

---

## Wave 1 — Foundation (parallel, no dependencies)

### Task 1: Bridge Service Scaffold
- **Files:** `src/index.ts`, `src/server.ts`, `package.json`, `tsconfig.json`, `.env.example`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `npm run build` succeeds
  - [ ] `npm start` binds Fastify on configurable port (default 3100)
  - [ ] `GET /status` returns `{ ok: true }`
- **Test Requirements:**
  - Write test: server starts, /status returns 200
- **Context Needed:** Fastify 5.x, TypeScript. Pattern: see jarvis-dispatch `src/server.ts` and `src/index.ts`. Keep minimal — just HTTP scaffold + health endpoint.

### Task 2: Claude CLI Spawner Module
- **Files:** `src/claude/spawner.ts`, `src/claude/types.ts`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `spawnClaude(prompt, opts)` spawns `claude --print` subprocess
  - [ ] Captures stdout as string result
  - [ ] Respects timeout (default 120s, configurable)
  - [ ] Returns `{ output, exitCode, durationMs }`
  - [ ] Passes `--model` flag when specified
- **Test Requirements:**
  - Write test: spawner returns output from simple prompt
  - Write test: spawner handles timeout (kill after N seconds)
  - Write test: spawner captures non-zero exit code
- **Context Needed:** Use `child_process.spawn`. The `claude` CLI is at `/home/tripp/.local/bin/claude`. Key flags: `--print` (non-interactive, stdout only), `--model sonnet` or `--model opus`, `--allowedTools` for permissions. Working directory should be the jarvis-prime workspace so `.claude/` config loads.

### Task 3: Message Queue Module
- **Files:** `src/queue/message-queue.ts`, `src/queue/types.ts`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] FIFO queue: `enqueue(message)` adds, processes sequentially
  - [ ] Only one message processed at a time (no parallel Claude sessions)
  - [ ] Returns immediate receipt with queue position
  - [ ] Emits events: `processing`, `complete`, `error`
- **Test Requirements:**
  - Write test: 3 messages enqueued, processed in order
  - Write test: concurrent enqueue doesn't spawn parallel processors
- **Context Needed:** In-memory queue is fine for v1. No persistence needed. Pattern: async generator or simple array + processing flag. SPEC constraint: "Sequential message queue — don't spawn parallel Claude Code sessions."

### Task 4: OpenClaw Delivery Client
- **Files:** `src/delivery/delivery-client.ts`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `deliver(chatId, text)` POSTs to OpenClaw gateway
  - [ ] Uses gateway token auth (from env)
  - [ ] Spools to `/home/tripp/.openclaw/delivery-queue/` on failure
  - [ ] Handles long messages (Telegram 4096 char limit — splits if needed)
- **Test Requirements:**
  - Write test: delivery POSTs correct payload
  - Write test: delivery spools on HTTP error
  - Write test: long message split at 4096 chars
- **Context Needed:** Reuse pattern from jarvis-dispatch `src/delivery/openclaw-delivery-client.ts`. OpenClaw gateway at `http://127.0.0.1:18789` with Bearer token from `openclaw.json`. Delivery queue dir: `/home/tripp/.openclaw/delivery-queue/`. Format: `{ chatId, text, parseMode: "Markdown" }`.

### Task 5: .claude/ Skills — /network-status
- **Files:** `/home/tripp/.claude/skills/network-status.md`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `/network-status` skill file exists with valid frontmatter
  - [ ] Instructions SSH to all 5 nodes and check: ping, uptime, disk, key services
  - [ ] Output formatted as table (node, status, uptime, disk%, services)
- **Test Requirements:**
  - Manual: run skill via `claude` CLI with `/network-status`
- **Context Needed:** Nodes from SPEC: SuperServer (localhost), Voldemort (192.168.0.108 or SSH `joevoldemort`), Argus (`jarvis` or `sentry`), Pretoria (`djjarvis`), Scalpel (`scalpel`). SSH config at `~/.ssh/config`. Check: `uptime`, `df -h /`, service-specific commands per node.

### Task 6: .claude/ Skills — /dispatch
- **Files:** `/home/tripp/.claude/skills/dispatch.md`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `/dispatch <task>` skill file exists
  - [ ] Instructions: POST to jarvis-dispatch `/dispatch` endpoint with task_goal
  - [ ] Handles response: session_id, polls for completion, returns result
- **Test Requirements:**
  - Manual: `/dispatch "check Frank GPU temps"` triggers jarvis-dispatch
- **Context Needed:** jarvis-dispatch runs on SuperServer port 3000. Endpoint: `POST /dispatch` with `{ task_goal: string }`. Returns `{ session_id }`. Poll `POST /session { session_id }` for status. When complete, result in response.

### Task 7: .claude/ Skills — /frank-status and /station-check
- **Files:** `/home/tripp/.claude/skills/frank-status.md`, `/home/tripp/.claude/skills/station-check.md`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] `/frank-status` SSHs to Voldemort, checks: Ollama running, GPU temps (nvidia-smi), recent escalations, disk space
  - [ ] `/station-check` SSHs to Pretoria, checks: PlayoutONE status, now-playing, automation state, log errors
- **Test Requirements:**
  - Manual: run each skill, verify output
- **Context Needed:** Frank/Voldemort SSH: `ssh root@192.168.0.108`. Ollama: `curl localhost:11434/api/tags`. GPU: `nvidia-smi --query-gpu=temperature.gpu --format=csv`. Pretoria SSH: `ssh djjarvis`. PlayoutONE: check service status, recent logs at `/home/djjarvis/.openclaw/workspace/PretoriaFields/logs/`.

### Task 8: .claude/ Rules — PHI + Credentials Protection
- **Files:** `/home/tripp/.claude/rules/phi-security.md`, `/home/tripp/.claude/rules/credentials-protection.md`, `/home/tripp/.claude/rules/network-conventions.md`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] PHI rule: never write PHI outside clinical-archive paths, never log PHI, never send PHI to external services
  - [ ] Credentials rule: never read/write/log .env files, SSH keys, API tokens, bot tokens
  - [ ] Network conventions rule: node names, SSH aliases, standard paths per node
- **Test Requirements:**
  - Review: rules loaded when `claude` starts in workspace
- **Context Needed:** Clinical archive: `/home/tripp/Documents/claude-team/clinical-archive/`. PHI edict: `/home/tripp/.openclaw/workspace/PHI-SECURITY-EDICT.md`. Sensitive files: `.env`, `*.key`, `*.pem`, `credentials*`, `openclaw.json` (contains bot tokens).

### Task 9: .claude/ Agents — network-ops, clinical-reviewer, frank-debugger
- **Files:** `/home/tripp/.claude/agents/network-ops.md`, `/home/tripp/.claude/agents/clinical-reviewer.md`, `/home/tripp/.claude/agents/frank-debugger.md`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] network-ops: SSH diagnostics across nodes, service health, log analysis
  - [ ] clinical-reviewer: PHI-aware document review, scoped to clinical paths only
  - [ ] frank-debugger: Frank harness/escalation specialist, reads Voldemort logs and manifest
- **Test Requirements:**
  - Review: agents listed when `claude` starts
- **Context Needed:** Agent format per Claude Code docs: markdown file with name, description, instructions. network-ops needs SSH access patterns. clinical-reviewer needs PHI edict constraints. frank-debugger needs knowledge of Frank's manifest-log.jsonl format and escalation flow.

### Task 10: .claude/ Hooks — Session Start Context Injection
- **Files:** `/home/tripp/.claude/hooks/session-start-context.sh`
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] Hook runs on session start
  - [ ] Reads and injects: HEARTBEAT.md, MEMORY.md summary, network node states
  - [ ] Output < 2000 tokens (context budget)
- **Test Requirements:**
  - Run hook standalone: `bash session-start-context.sh` outputs valid context
- **Context Needed:** Files to read: `/home/tripp/.openclaw/workspace/HEARTBEAT.md`, `/home/tripp/.openclaw/workspace/MEMORY.md` (first 50 lines), quick SSH ping to each node. Hook format: shell script, stdout becomes context injection. Register in `.claude/settings.json` hooks.SessionStart array.

---

## Wave 2 — Core Bridge Wiring (depends on Wave 1: Tasks 1–4)

### Task 11: Bridge Route — POST /message
- **Files:** `src/routes/message.ts`
- **Depends on:** Task 1 (server), Task 2 (spawner), Task 3 (queue), Task 4 (delivery)
- **Acceptance Criteria:**
  - [ ] `POST /message` accepts `{ chatId, text, userId }`
  - [ ] Enqueues message, returns `{ queued: true, position: N }`
  - [ ] Queue processes: spawns Claude CLI with message text
  - [ ] Claude output delivered back via delivery client
  - [ ] PHI scan on input text before processing (reject if PHI detected)
- **Test Requirements:**
  - Write test: POST /message → queued → spawner called → delivery called
  - Write test: PHI in message → rejected with 422
  - Write test: Claude error → error delivered to chat
- **Context Needed:** Wire together spawner + queue + delivery. The message route is the central nervous system. PHI scan: reuse pattern from jarvis-dispatch `src/phi/scanner.ts` (regex-based).

### Task 12: Acknowledgment + Async Long Tasks
- **Files:** `src/routes/message.ts` (extend), `src/claude/spawner.ts` (extend)
- **Depends on:** Task 11
- **Acceptance Criteria:**
  - [ ] If queue position > 0, deliver "Queued (position N)" ack to Telegram
  - [ ] If Claude takes > 5s, deliver "Working on it..." ack, then final result when done
  - [ ] Timeout at 300s: deliver "Timed out" error message
- **Test Requirements:**
  - Write test: slow Claude response triggers ack at 5s mark
  - Write test: timeout at 300s delivers error
- **Context Needed:** SPEC constraint: "Long-running tasks return immediate 'working on it' acknowledgment within 5s." Use a timer: after 5s of Claude running, fire ack delivery. When Claude completes, fire result delivery.

---

## Wave 3 — OpenClaw Integration (depends on Wave 2)

### Task 13: OpenClaw Telegram → Bridge Routing
- **Files:** OpenClaw config changes (TBD — may be `openclaw.json` or webhook config), `src/openclaw/webhook-receiver.ts` (if needed)
- **Depends on:** Task 11 (bridge route working)
- **Acceptance Criteria:**
  - [ ] When @trippassistant_bot receives a DM from Tripp, message reaches bridge `POST /message`
  - [ ] OpenClaw continues to handle delivery (bridge doesn't need to call Telegram API directly)
  - [ ] Non-Tripp messages still handled by OpenClaw's default LLM
- **Test Requirements:**
  - Integration test: send Telegram message → bridge receives it → Claude responds → Telegram delivery
- **Context Needed:** This is the critical integration point. Options: (a) OpenClaw webhook/callback that POSTs to bridge, (b) OpenClaw "custom model" that forwards to bridge, (c) modify OpenClaw's agent routing. Need to investigate OpenClaw's extension points. Gateway at `http://127.0.0.1:18789`. May need to read OpenClaw source or docs to find the right hook.

### Task 14: Deploy Skill — /deploy
- **Files:** `/home/tripp/.claude/skills/deploy.md`
- **Depends on:** Task 5 (network-status pattern), Task 11 (bridge working)
- **Acceptance Criteria:**
  - [ ] `/deploy <service> [node]` builds, syncs (rsync), and restarts a service
  - [ ] Supports known services: jarvis-prime, jarvis-dispatch, openclaw
  - [ ] Supports known nodes: superserver, voldemort, pretoria, scalpel
  - [ ] Reports each step (build → sync → restart → verify)
- **Test Requirements:**
  - Manual: `/deploy jarvis-prime superserver` builds and restarts the bridge service
- **Context Needed:** Build: `npm run build`. Sync: `rsync -avz --exclude node_modules`. Restart: `systemctl restart` or `pm2 restart`. Each service has different paths on different nodes.

---

## Wave 4 — Lieutenant Command Interface (depends on Wave 2)

### Task 15: SSH Command Executor Utility
- **Files:** `src/ssh/executor.ts`, `src/ssh/types.ts`
- **Depends on:** Task 2 (spawner pattern)
- **Acceptance Criteria:**
  - [ ] `sshExec(node, command)` runs command on named node via SSH
  - [ ] Resolves node name to SSH alias (voldemort → `root@192.168.0.108`)
  - [ ] Returns `{ stdout, stderr, exitCode, durationMs }`
  - [ ] Timeout: 30s default, configurable
  - [ ] Handles unreachable node gracefully
- **Test Requirements:**
  - Write test: `sshExec("voldemort", "uptime")` returns output
  - Write test: unreachable node returns error (not hang)
- **Context Needed:** SSH config at `~/.ssh/config`. Node map: `{ superserver: "localhost", voldemort: "root@192.168.0.108", argus: "jarvisagent@100.70.105.85", pretoria: "djjarvis@100.116.2.71", scalpel: "tripp@100.104.39.64" }`.

### Task 16: Remote File Read/Write
- **Files:** `src/ssh/file-ops.ts`
- **Depends on:** Task 15
- **Acceptance Criteria:**
  - [ ] `readRemoteFile(node, path)` returns file contents via SSH cat
  - [ ] `writeRemoteFile(node, path, content)` writes via SSH heredoc
  - [ ] `listRemoteDir(node, path)` returns directory listing
  - [ ] Path validation: reject paths with `..` or absolute paths outside allowed dirs
- **Test Requirements:**
  - Write test: read a known file from Voldemort
  - Write test: path traversal attempt blocked
- **Context Needed:** Use `sshExec` from Task 15. Read: `ssh node "cat /path"`. Write: `ssh node "cat > /path << 'JARVIS_EOF'\ncontent\nJARVIS_EOF"`. Security: each node has allowed base paths (e.g., Voldemort: `/home/joevoldemort/`, Pretoria: `/home/djjarvis/`).

### Task 17: Lieutenant OpenClaw Status + Relay
- **Files:** `src/lieutenant/status.ts`, `src/lieutenant/relay.ts`
- **Depends on:** Task 15
- **Acceptance Criteria:**
  - [ ] `getLieutenantStatus(node)` SSHs to node, checks OpenClaw process, returns status
  - [ ] `relayToLieutenant(node, message)` sends message to lieutenant's bot via OpenClaw relay
  - [ ] Escalation receiver: lieutenant can POST to bridge to escalate to Prime
- **Test Requirements:**
  - Write test: status check on Voldemort returns OpenClaw running/stopped
  - Write test: relay sends message (mock delivery)
- **Context Needed:** OpenClaw status: `ssh node "pgrep -f openclaw"` or check systemd service. Relay: each node has its own OpenClaw gateway. Voldemort: port TBD, Pretoria: port TBD. Escalation: bridge accepts `POST /escalation` from lieutenant IPs.

---

## Wave 5 — Memory, Skills, MCP (depends on Wave 3)

### Task 18: Memory + Skill Preservation Verification
- **Files:** `src/tests/memory-preservation.test.ts`
- **Depends on:** Task 13 (OpenClaw integration)
- **Acceptance Criteria:**
  - [ ] Claude Code session loads `~/.claude/projects/-home-tripp/memory/` correctly
  - [ ] jarvis-dev-methodology available as `/dev:spec`, `/dev:plan` etc.
  - [ ] Workspace files (MEMORY.md, SOUL.md, IDENTITY.md, etc.) accessible
  - [ ] Session-start hook injects context
- **Test Requirements:**
  - Integration test: spawn Claude session, verify it mentions loaded memory
  - Integration test: `/dev:spec` skill responds correctly
- **Context Needed:** This is a verification task. Existing memory system should "just work" because Claude CLI loads `.claude/` config from the project directory. The session-start hook (Task 10) injects workspace context. Verify by spawning a test session and checking output.

### Task 19: MCP Server Configuration
- **Files:** `/home/tripp/.claude/settings.json` (update mcpServers section)
- **Depends on:** Task 13 (bridge working)
- **Acceptance Criteria:**
  - [ ] PubMed MCP server configured and accessible
  - [ ] CMS Coverage MCP server configured and accessible
  - [ ] ICD-10 MCP server configured and accessible
  - [ ] Google Calendar MCP server configured and accessible
  - [ ] Gmail MCP server configured and accessible
  - [ ] Clinical Trials MCP server configured and accessible
- **Test Requirements:**
  - Integration test: Claude session can call PubMed search
  - Integration test: Claude session can look up ICD-10 code
- **Context Needed:** MCP servers are already available in current Claude Code session (see deferred tools list). This task verifies they're configured in settings.json and accessible when spawned via bridge. Check current `.claude/settings.json` for existing mcpServers config.

---

## Wave 6 — End-to-End Integration (depends on all above)

### Task 20: E2E Smoke Test — Simple Message
- **Files:** `src/tests/e2e-simple.test.ts`
- **Depends on:** Task 13
- **Acceptance Criteria:**
  - [ ] Send "What time is it?" via Telegram → get Claude-powered response < 30s
  - [ ] Send "/network-status" via Telegram → get 5-node health table
  - [ ] Send "/frank-status" via Telegram → get Voldemort GPU/Ollama status
- **Test Requirements:**
  - E2E test with actual Telegram message (manual or scripted via bot API)
- **Context Needed:** AC1 from spec: "Tripp sends message to @trippassistant_bot → gets Claude Code–powered response within 30s." AC2: "/network-status returns health of all 5 nodes."

### Task 21: E2E Smoke Test — Lieutenant Commands
- **Files:** `src/tests/e2e-lieutenant.test.ts`
- **Depends on:** Tasks 15–17
- **Acceptance Criteria:**
  - [ ] "Run `uptime` on Voldemort" → SSH exec → result in Telegram
  - [ ] "Check OpenClaw status on Pretoria" → status check → result in Telegram
  - [ ] AC5: "Jarvis Prime can run a command on Voldemort via SSH and return result in Telegram"
- **Test Requirements:**
  - E2E test with actual SSH execution
- **Context Needed:** Verify the lieutenant command interface works end-to-end through Telegram.

### Task 22: E2E Smoke Test — PHI + Error Handling
- **Files:** `src/tests/e2e-security.test.ts`
- **Depends on:** Tasks 11, 12
- **Acceptance Criteria:**
  - [ ] AC6: PHI in Telegram message blocked before reaching Claude Code
  - [ ] AC7: Existing OpenClaw functionality on all lieutenant nodes unaffected
  - [ ] Timeout produces graceful error message in Telegram
  - [ ] SSH unreachable node produces "node X unreachable" (not hang)
- **Test Requirements:**
  - Security test: message containing patient name + DOB → rejected
  - Resilience test: offline node handled gracefully
- **Context Needed:** PHI patterns: patient names with DOB, SSN, MRN numbers. Test by sending a message with fake PHI. Verify it's blocked and Tripp gets notification.

### Task 23: Update CLAUDE.md for Unified Command Role
- **Files:** `/home/tripp/.claude/CLAUDE.md` (update)
- **Depends on:** Task 13 (integration working)
- **Acceptance Criteria:**
  - [ ] CLAUDE.md reflects Jarvis Prime as unified command brain
  - [ ] Documents available skills, agents, hooks
  - [ ] References bridge service and lieutenant command interface
  - [ ] Preserves existing personality and context
- **Test Requirements:**
  - Review: CLAUDE.md reads correctly, no stale references
- **Context Needed:** Current CLAUDE.md already has Jarvis identity, network table, key paths. Add: new skills (/network-status, /dispatch, /frank-status, /station-check, /deploy), agents (network-ops, clinical-reviewer, frank-debugger), hooks (session-start, phi-scan), and unified command role description.

---

## Dependency DAG

```
Wave 1 (parallel): T1, T2, T3, T4, T5, T6, T7, T8, T9, T10
         │
         ▼
Wave 2 (parallel): T11 (needs T1+T2+T3+T4), T12 (needs T11)
         │
         ▼
Wave 3 (parallel): T13 (needs T11), T14 (needs T5+T11)
         │
         ▼
Wave 4 (parallel): T15 (needs T2), T16 (needs T15), T17 (needs T15)
         │
         ▼
Wave 5 (parallel): T18 (needs T13), T19 (needs T13)
         │
         ▼
Wave 6 (parallel): T20 (needs T13), T21 (needs T15-T17), T22 (needs T11+T12), T23 (needs T13)
```

Note: Wave 4 (Lieutenant Interface) can actually start as soon as Wave 1 completes (T15 depends only on T2). It's grouped as Wave 4 for clarity but can run in parallel with Waves 2–3.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenClaw routing hook unclear (T13) | High — blocks all Telegram integration | Research OpenClaw extension points early. Fallback: poll Telegram directly from bridge (bypass OpenClaw routing). |
| Claude CLI latency > 30s for simple tasks | Medium — fails AC1 | Use `--model sonnet` for routine tasks. Pre-warm with session-start hook. |
| SSH key auth failures on some nodes | Medium — blocks lieutenant commands | Test SSH to all 5 nodes before Wave 4. Fix any key issues. |
| PHI scan false positives | Low — blocks legitimate messages | Tune regex patterns. Allow user override. |

---
**Status:** APPROVED
**Approved:** 2026-04-16
