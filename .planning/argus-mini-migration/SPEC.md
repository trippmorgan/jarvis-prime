---
type: spec
project: argus-mini-migration
status: approved
phase: plan
created: 2026-06-06
updated: 2026-06-06
owner: prime
---

# Argus Mini Migration — SPEC

## Goal

Promote the Intel Mac mini (Sonoma 14.1.1, x86_64, 100.108.116.72) from bare machine
to the new **Argus node** — the network's security cortex and visual guardian.

The Mac Pro 5,1 (100.70.105.85 / jarvisagent) carried this role but is **offline and
unreachable** (both Tailscale and LAN as of 2026-06-06). Migration is therefore a fresh
install, not a lift-and-shift.

---

## Hardware Baseline (gathered 2026-06-06)

| Item | Value |
|------|-------|
| Hostname | Tripps-Mac-mini.local |
| Tailscale IP | 100.108.116.72 |
| LAN IP | 192.168.0.111 |
| OS | macOS Sonoma 14.1.1 (x86_64 Intel) |
| CPU | 4-core Intel |
| RAM | 8 GB |
| System disk free | ~16 GiB |
| External drive | /Volumes/Macintosh HD 1 — 880 GiB free |
| SSH user | trippmorgan |
| SSH auth | id_ed25519 (fleet key — replace with dedicated key) |
| VNC | Port 5900, listening 0.0.0.0 — restrict to Tailscale |
| Homebrew | NOT installed |
| Wazuh | NOT installed |
| Claude CLI | NOT installed |

---

## Immediate Blocker (P0 — pre-work)

**Code Helper (Plugin) PID 1948**: VS Code's Node service extension host has been
spinning at 100% CPU for **5 days, 17+ hours**. Consuming an entire core. Causes
system load 3.4–3.7 on a 4-core machine. Memory is severely compressed (only ~24MB
free pages, heavy swap activity).

- Action: Kill PID 1948, optionally kill the VS Code parent (PID 545 or 1925 chain)
- Root cause: likely a runaway Claude Code / Copilot extension in a tight loop
- Fix: After Homebrew + Claude CLI installed, test with a known-safe extension set

---

## Scope

### A — Homebrew + Base Argus Tooling

- Install Homebrew (x86_64 path: `/usr/local`)
- Install: `nmap`, `wget`, `git`, `openssl`, `jq`, `htop`, `mas`, `node`, `python3` (via brew)
- Install Claude CLI via npm
- Configure shell environment (`.zshrc` / `.bash_profile`)

### B — Wazuh Manager + Indexer + Dashboard

Wazuh stack fresh install on the Mac mini using the **external drive** for all data:

- Wazuh Manager (controls agents, generates alerts)
- Wazuh Indexer (OpenSearch — needs 4GB heap; tight on 8GB, use external for data)
- Wazuh Dashboard (web UI at port 443)
- Migrate configuration once Mac Pro comes back online (or rebuild from scratch)
- Enroll agents: SuperServer, Scalpel, Voldemort (when accessible), Mac mini itself

**Memory constraint**: Wazuh Indexer needs 4GB heap by default. On 8GB machine, tune
JVM to 2GB heap (`-Xms2g -Xmx2g`) and redirect Indexer data path to external drive.

### C — Code Helper / Stray Process Investigation

- Identify which VS Code extension causes the 100% CPU loop
- Log: Claude Code extension version, any other heavy extensions installed
- Remediation: either update extension or remove it; configure VS Code to start without
  auto-launching the offending extension

### D — Auth Doctrine Hardening

Per `NETWORK-SECURITY.md` doctrine: dedicated key per role, no fleet password reuse.

- Generate `~/.ssh/id_argus_mini` (ed25519) on SuperServer
- Install pubkey into `trippmorgan@argus-mini:~/.ssh/authorized_keys`
- Update `~/.ssh/config` on SuperServer: add `IdentityFile ~/.ssh/id_argus_mini`
- Retire the `id_ed25519` fleet key from argus-mini's authorized_keys
- Disable password authentication on argus-mini SSH

### E — Retire Mac Pro Stanza

Once Wazuh is live on mini and agents re-enrolled:
- Remove `jarvisagent@100.70.105.85` from SuperServer's known_hosts and SSH config
- Remove the `sentry` / `jarvis` Host stanzas from `~/.ssh/config`
- Update `NETWORK-SECURITY.md`, `SECURITY-STATUS.md`, `CLAUDE.md` node table
- Archive the Sentry/Argus section of docs as "Mac Pro 5,1 — retired"
- Update `MEMORY.md` references

---

## Constraints

1. **8GB RAM** — Wazuh Indexer JVM heap capped at 2GB; data on external drive
2. **x86_64** — Homebrew installs to `/usr/local` (not `/opt/homebrew`)
3. **Sonoma 14.1.1** — SIP active; no kext changes; Homebrew must run as user
4. **Auth doctrine** — dedicated key, PasswordAuthentication disabled
5. **No lift-and-shift** — Mac Pro offline; fresh Wazuh install, fresh agent enrollment
6. **VNC 5900 open to 0.0.0.0** — must restrict to Tailscale subnet before shipping

---

## Success Criteria

- [ ] Code Helper CPU spike resolved, load < 0.5 at idle
- [ ] Homebrew installed at `/usr/local`, core tools available
- [ ] Wazuh Manager + Indexer + Dashboard running and reachable via Tailscale
- [ ] At least SuperServer and Scalpel enrolled as Wazuh agents
- [ ] Dedicated SSH key `id_argus_mini` is the only auth path (no password, no fleet key)
- [ ] VNC restricted to Tailscale (100.64.0.0/10) only
- [ ] CLAUDE.md node table updated (100.108.116.72 = Argus)
- [ ] Mac Pro stanzas removed from SSH config

---

## Out of Scope

- Wazuh data restore from Mac Pro (machine offline; start fresh)
- Suricata IDS (nice-to-have, deferred to post-migration hardening)
- Honeypots (deferred)
- Claude Code session management on mini (that's a separate initiative)
