# Specification: Jarvis Prime — Unified Command Runtime

> Generated 2026-04-16 by Jarvis Development Methodology

## Project Goal

Make Claude Code (Jarvis Prime) the primary brain for the entire Jarvis network by bridging OpenClaw's multi-node Telegram infrastructure with Claude Code's reasoning engine, skills, memory, and MCP servers. Tripp interacts through @trippassistant_bot on Telegram. Jarvis Prime commands four lieutenant nodes, each with its own OpenClaw instance and specialization. The result is a command hierarchy where one conversation thread gives access to the full network.

## The Network

| Node | Machine | IP | OpenClaw Bot | Role | Model |
|------|---------|-----|-------------|------|-------|
| **Jarvis Prime** | SuperServer | 100.80.111.84 | @trippassistant_bot | General — orchestration, all capabilities | Claude Code (Opus/Sonnet) |
| **Frank** | Voldemort (ROMED8-2T) | 192.168.0.108 | @Frank_Voldemort_Bot | Local AI, GPU inference, tool execution | Nemotron (Ollama) |
| **Argus** | Mac Pro 5,1 | 100.70.105.85 | TBD | Network security, visual cortex, Elder guardian | Gemini 3 Pro |
| **DJ Jarvis** | Pretoria (3630) | 100.116.2.71 | @pretoriafields_bot | Radio station, PlayoutONE, WPFQ automation | Claude Sonnet 4.6 |
| **Scalpel** | Precision T3600 | 100.104.39.64 | TBD | Clinical ops, Athena EMR, vascular proxy | Claude Sonnet 4.5 |

**Connectivity:** All nodes reachable via Tailscale mesh + SSH. Voldemort also on LAN (192.168.0.108).

## Architecture

```
Tripp → @trippassistant_bot (Telegram)
           ↓
    OpenClaw (SuperServer) — receives message
           ↓
    Route to Claude Code CLI (not the default OpenClaw LLM)
           ↓
    claude CLI session with full .claude/ config:
      ├── Jarvis identity (CLAUDE.md)
      ├── Skills (jarvis-dev-methodology, /dispatch, /network-status, etc.)
      ├── Memory (persistent cross-session)
      ├── Agents (clinical-reviewer, network-ops, frank-debugger)
      ├── Hooks (PHI scan, session-start context injection)
      ├── MCP servers (PubMed, CMS Coverage, ICD-10, Calendar, Gmail)
      └── SSH access to all lieutenant nodes
           ↓
    Result → OpenClaw delivery → Telegram → Tripp

    Jarvis Prime can also command lieutenants:
      ├── SSH direct: run commands, read files, check status
      ├── OpenClaw relay: send messages to lieutenant bots
      └── jarvis-dispatch: delegate Claude Managed Agent tasks to Voldemort
```

## Requirements (v1 — Must Have)

### R1: OpenClaw → Claude Code Bridge
- [ ] When @trippassistant_bot receives a message from Tripp, OpenClaw routes it to `claude` CLI on SuperServer instead of the default LLM gateway
- [ ] Claude Code session loads full `.claude/` configuration (identity, skills, memory, hooks, rules, agents)
- [ ] Session output (text, structured results) flows back through OpenClaw → Telegram delivery
- [ ] Long-running tasks return an immediate "working on it" acknowledgment, then deliver the result when complete
- [ ] Errors and timeouts are caught and reported gracefully via Telegram

### R2: Full .claude/ Configuration
- [ ] `CLAUDE.md` — Jarvis Prime identity (already exists, adapt for unified command role)
- [ ] `settings.json` — Permissions, auto-allow patterns for SSH, git, npm, system commands
- [ ] `rules/` — PHI security (scoped to clinical paths), network node conventions, Frank operations
- [ ] `skills/` — Existing skills preserved (jarvis-dev-methodology), new skills added:
  - `/dispatch <task>` — fire Claude Managed Agent (replaces Telegram command-bot)
  - `/network-status` — check all 5 nodes health
  - `/frank-status` — Frank health, recent escalations, GPU temps
  - `/station-check` — WPFQ radio station status
  - `/deploy <service>` — build + sync + restart a service across nodes
- [ ] `agents/` — Specialized subagents:
  - `network-ops.md` — multi-node SSH diagnostics
  - `clinical-reviewer.md` — PHI-aware document review
  - `frank-debugger.md` — Frank harness/escalation specialist
- [ ] `hooks/` — Automated behaviors:
  - `session-start.sh` — inject HEARTBEAT, MEMORY, network state on startup
  - `phi-scan.sh` — block PHI before file writes to non-clinical paths
  - `protect-sensitive.sh` — block edits to .env, credentials, keys

### R3: Lieutenant Command Interface
- [ ] Jarvis Prime can SSH to any lieutenant node and run commands
- [ ] Jarvis Prime can read/write files on any node
- [ ] Jarvis Prime can check OpenClaw status on each node
- [ ] Jarvis Prime can send messages TO lieutenant bots (relay scripts)
- [ ] Lieutenant bots can escalate TO Jarvis Prime (via jarvis-dispatch or direct)

### R4: Memory and Skill Preservation
- [ ] Existing memory system (`~/.claude/projects/-home-tripp/memory/`) continues to work
- [ ] jarvis-dev-methodology skill available as `/dev:spec`, `/dev:plan`, etc.
- [ ] All existing workspace state (MEMORY.md, SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md) accessible
- [ ] Session context injection reads these at startup via hook

### R5: MCP Server Access
- [ ] PubMed — article search, full text retrieval
- [ ] CMS Coverage — NCD/LCD lookup, Medicare Part B policies
- [ ] ICD-10 Codes — diagnosis/procedure code lookup and validation
- [ ] Google Calendar — event management
- [ ] Gmail — email access (when authenticated)
- [ ] Clinical Trials — trial search, eligibility, endpoint analysis

## Requirements (v2 — Should Have)

### R6: Cron / Scheduled Tasks
- [ ] Morning briefing (daily, ~6:30 AM ET): node health, weather, calendar, station status
- [ ] Network health monitor (every 30 min): ping all nodes, check services, alert on failures
- [ ] PR/deploy watcher (on-demand loop): monitor CI status until green, then notify
- [ ] Implemented via Claude Code `CronCreate` triggers + OpenClaw delivery for results

### R7: Loop Integration
- [ ] OpenClaw's loop system can invoke `claude` CLI on each tick for Claude-level reasoning
- [ ] Simple monitoring loops stay with lieutenants (GPU temps, station watchdog)
- [ ] Complex analysis loops route through Jarvis Prime

### R8: Cross-Lieutenant Coordination
- [ ] Jarvis Prime can dispatch subtasks to specific lieutenants and collect results
- [ ] Multi-node operations (e.g., "deploy this to Pretoria and Scalpel") orchestrated by Prime
- [ ] Status dashboard: aggregated view of all lieutenant states

### R9: Conversation Continuity
- [ ] Telegram thread context preserved across Claude Code sessions (via memory + OpenClaw state)
- [ ] "Resume" capability: Tripp can reference earlier tasks and Jarvis picks up context
- [ ] Session handoff when context window fills: save state, start fresh session, inject context

## Out of Scope

- Replacing OpenClaw on lieutenant nodes (they keep their own brains and specializations)
- Running Claude Code CLI on lieutenant nodes (SuperServer is the single brain)
- Creating new Telegram bots (use existing bots for each node)
- Modifying OpenClaw's core framework (we integrate at the extension/config level)
- Real-time voice or video processing
- Running local LLMs on SuperServer (that's Voldemort's job)

## Constraints

- **Tech stack:** TypeScript/Node.js (OpenClaw), Claude Code CLI (bash invocation or Agent SDK), existing Tailscale mesh
- **Latency:** Telegram → Claude Code → response should be under 30s for simple tasks. Long tasks get an acknowledgment within 5s.
- **Cost:** Claude Code sessions use Anthropic API credits. Default to Sonnet for routine work, Opus for planning/reasoning. Avoid unnecessary session creation.
- **Security:** PHI never leaves the clinical pipeline. Credentials never in logs or memory. SSH keys must exist (no passwords in code except legacy Elder/Tiger).
- **Compatibility:** Must not break existing OpenClaw functionality on any node. Additive integration only.
- **Single brain:** Only SuperServer runs Claude Code. Lieutenants accessed via SSH/relay.

## Edge Cases

- **OpenClaw down on SuperServer:** Telegram messages not received. No fallback — known limitation.
- **Claude Code CLI timeout:** Long tasks (>5 min) need async handling. OpenClaw sends "working on it," spawns background process, delivers result when done.
- **SSH unreachable:** Lieutenant node offline. Jarvis detects gracefully and reports "node X unreachable" rather than hanging.
- **PHI in Telegram message:** PHI scan catches it before routing to Claude Code. Block and notify.
- **Concurrent sessions:** Multiple Telegram messages arrive rapidly. Queue sequentially — don't spawn parallel Claude Code sessions (expensive, confusing).
- **Context compaction:** Long session fills context window. session-start hook + memory system provide enough context to resume cleanly.
- **MCP server unavailable:** Graceful degradation — report "PubMed unavailable" rather than crashing.

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Claude Code CLI (not Agent SDK) for v1 | Simpler to integrate — `claude --print` gives us full .claude/ config for free. SDK can replace later if we need finer control. |
| Single brain on SuperServer | Keeps memory, skills, and config in one place. Avoids sync complexity. Lieutenants accessed via SSH. |
| OpenClaw as transport only (for Prime) | OpenClaw is battle-tested for Telegram. No reason to rebuild that. Just swap the brain behind it. |
| Lieutenants keep their own brains | Each node has specialized tasks. Frank needs local Ollama. Pretoria needs local PlayoutONE access. Prime commands, doesn't replace. |
| Sequential message queue (not parallel) | Parallel Claude sessions are expensive and produce confusing interleaved results. Queue and process one at a time. |

## Acceptance Criteria

- [ ] AC1: Tripp sends a message to @trippassistant_bot → gets a Claude Code–powered response within 30s (simple task) or acknowledgment within 5s (complex task)
- [ ] AC2: `/network-status` returns health of all 5 nodes via SSH checks
- [ ] AC3: `/dispatch <task>` fires a Claude Managed Agent and delivers result via Telegram
- [ ] AC4: jarvis-dev-methodology `/dev:spec` works through Telegram interaction
- [ ] AC5: Jarvis Prime can run a command on Voldemort via SSH and return the result in Telegram
- [ ] AC6: PHI in a Telegram message is blocked before reaching Claude Code
- [ ] AC7: Existing OpenClaw functionality on all lieutenant nodes is unaffected
- [ ] AC8: Memory persists across sessions — Jarvis remembers context from previous conversations
- [ ] AC9: MCP servers (PubMed, ICD-10, CMS Coverage) accessible from Telegram-triggered sessions
- [ ] AC10: Morning briefing cron delivers daily status to Telegram at ~6:30 AM ET

---
**Status:** APPROVED
**Approved:** 2026-04-16
