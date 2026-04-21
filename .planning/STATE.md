# Project State: Jarvis Prime — Unified Command Runtime

> Last updated: 2026-04-21

## Current Phase
**Phase:** shipped — **v1.0 working model**
**Started:** 2026-04-16 (execute) → 2026-04-20 (review) → 2026-04-21 (v1 ship, tag `v1.0.0`)
**Status:** Waves 1–8 all complete. tsc clean, **468/469 tests passing** (1 skipped live-only). PHI input scanner removed 2026-04-20 — PHI handling now lives in the Claude-team clinical pipeline (clinical archive + `CORPUS_CLINICAL_OVERRIDE`). Right-hemisphere agent live behind `RIGHT_BRAIN_AGENT_ENABLED` with chat-completions fallback. Wave 8 brain-directed skill router shipped 2026-04-21 behind `JARVIS_ROUTER_ENABLED=true`. Spawner defaults flipped same-day: every Claude spawn gets `enableTools: true` + `enableSlashCommands: true` by default; opt-out is explicit and rare. Live Telegram smoke confirmed tools flow end-to-end (left hemisphere SSHes, skill shim executes dispatched skills).

## Progress
| Wave | Task | Status | Retries | Notes |
|------|------|--------|---------|-------|
| 0 | Socratic questioning | complete | 0 | 3 rounds of Q&A with Tripp |
| 0 | SPEC.md draft | complete | 0 | 10 acceptance criteria, 9 requirements |
| 0 | Spec approval | complete | 0 | Approved 2026-04-16 |
| 0 | PLAN.md decomposition | complete | 0 | 23 tasks, 6 waves |
| 0 | Plan approval | complete | 0 | Approved 2026-04-16 |
| 1 | T1: Bridge scaffold | complete | 0 | Fastify on :3100, /status route, graceful shutdown |
| 1 | T2: Claude CLI spawner | complete | 0 | spawnClaude() with timeout, 5 tests pass |
| 1 | T3: Message queue | complete | 0 | FIFO sequential queue, 4 tests pass |
| 1 | T4: Delivery client | complete | 0 | OpenClaw gateway POST + spool, 8 tests pass |
| 1 | T5: /network-status skill | complete | 0 | SSH health check all 5 nodes |
| 1 | T6: /dispatch skill | complete | 0 | POST to jarvis-dispatch |
| 1 | T7: /frank-status + /station-check | complete | 0 | GPU/Ollama + WPFQ checks |
| 1 | T8: Rules (PHI, creds, network) | complete | 0 | 3 rule files in .claude/rules/ |
| 1 | T9: Agents (3) | complete | 0 | network-ops, clinical-reviewer, frank-debugger |
| 1 | T10: Session-start hook | complete | 0 | Context injection script |
| 2 | T11: POST /message route | complete | 0 | PHI scan + queue + spawn + deliver, 7 tests |
| 2 | T12: Ack + async long tasks | complete | 0 | 5s ack timer, 300s hard timeout, chunked delivery |
| 3 | T13: Telegram → Bridge routing | complete | 0 | Direct Bot API poller, bypasses OpenClaw for inbound |
| 3 | T14: /deploy skill | complete | 0 | Build + rsync + restart across nodes |
| 4 | T15: SSH command executor | complete | 0 | sshExec() with node resolution, timeout, local+remote |
| 4 | T16: Remote file read/write | complete | 0 | readRemoteFile, writeRemoteFile, listRemoteDir, path validation |
| 4 | T17: Lieutenant status + relay | complete | 0 | getLieutenantStatus, getAllNodeStatuses, relayToLieutenant |
| 5 | T18: Memory + skill verification | complete | 0 | All memory files, workspace docs, skills, agents, rules verified. 11 tests. |
| 5 | T19: MCP server verification | complete | 0 | All 6 MCP servers available to CLI sessions (PubMed 7, ICD-10 6, CMS 8, Trials 6, Calendar 8, Gmail 2) |
| 6 | T20: Simple message smoke tests | complete | 0 | 7 tests pass — identity, history, skills, network-status, frank-status |
| 6 | T21: Lieutenant command tests | complete | 0 | SSH exec on Voldemort, file read on Pretoria |
| 6 | T22: Security & error handling | complete | 0 | PHI scan (removed 2026-04-20 — handled by Claude-team clinical pipeline), history isolation, chat ID filtering |
| 7 | Corpus-callosum v1.1 → v1.3 | complete | 0 | See corpus-callosum/.planning/STATE.md — Waves 1–7 all green |
| — | PHI scanner removal | complete | 0 | scanText/scanner.ts + tests deleted, processor + route simplified, README updated. PHI handling delegated to Claude Team. |
| 6 | T23: CLAUDE.md update | complete | 0 | Title, network table, skills, agents, paths, communication updated |
| 8 | Brain-directed skill router (sub-waves 8.1–8.6) | complete | 0 | `<dispatch>` protocol, RightBrainSkillShim Path B, 1-retry self-correction, router E2E green (T15a–g). Flipped live 2026-04-21 behind `JARVIS_ROUTER_ENABLED=true`. |
| — | Spawner tools-on default (post-W8 hotfix) | complete | 0 | `spawnClaude` `enableTools`/`enableSlashCommands` default → `true`. Dispatcher + shim + single-brain all get tools unless caller opts out. Commit `a62955e`. |

## Completed Phases
| Phase | Date | Notes |
|-------|------|-------|
| spec | 2026-04-16 | Approved by Tripp — 5 v1 reqs, 4 v2, 10 ACs |
| plan | 2026-04-16 | Approved by Tripp — 23 tasks, 6 waves, v1 scope |
| execute | 2026-04-16 → 2026-04-20 | Waves 1–6 (v1) + Wave 7 (v1.3 right-brain agent) shipped. PHI scanner removed at exit. |
| ship v1 | 2026-04-21 | Wave 8 router flipped live, tools-on defaults flipped, Telegram smoke clean. Tagged `v1.0.0`. |

## Blockers
- None

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-16 | Claude Code CLI (not Agent SDK) for v1 | Simpler — `claude --print` loads full .claude/ config. SDK can replace later. |
| 2026-04-16 | Single brain on SuperServer only | Keeps memory/skills/config in one place. Lieutenants via SSH. |
| 2026-04-16 | OpenClaw as transport, Claude Code as brain | OpenClaw handles Telegram. Claude Code handles reasoning. Don't rebuild what works. |
| 2026-04-16 | Sequential message queue | Parallel Claude sessions too expensive and confusing. Process one at a time. |
| 2026-04-16 | Lieutenants keep own brains | Each has specialized local tasks. Prime commands, doesn't replace. |
| 2026-04-16 | Direct Telegram polling (bypass OpenClaw inbound) | OpenClaw has no hook/middleware system for message interception. Gateway is WebSocket, not REST. Cleanest v1: jarvis-prime polls Bot API directly, sends responses via Bot API. OpenClaw keeps cron, workspace, WhatsApp. Disable OpenClaw Telegram when jarvis-prime goes live. |
| 2026-04-20 | Remove in-bridge PHI scanner | PHI is now handled out-of-band by the Claude-team clinical pipeline (`~/Documents/claude-team/clinical-archive/`) plus `CORPUS_CLINICAL_OVERRIDE`. Bridge-side regex was duplicating coverage and producing false-positive blocks on benign clinical-flavored prose. |
| 2026-04-21 | Flip `spawnClaude` defaults to tools-on | Dispatcher was spawning Claude without tools (carryover from the 240s left-hemisphere timeout fix), so the router kept hallucinating "no shell in this session" cards to Telegram. Policy now: every Claude spawn gets Bash/Read/Edit/slash by default. Opt-out is explicit (`enableTools: false`). Restrict later only when a concrete problem shows up. The right-brain agent's W7 8-file workspace sandbox is untouched — that's the PHI/credentials firewall. |
| 2026-04-21 | Ship v1 | Waves 1–8 delivered end-to-end, live-tested over Telegram, router + tools-on confirmed working. Tagged `v1.0.0` on `main`. |
