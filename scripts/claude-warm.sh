#!/bin/bash
# claude-warm.sh — keep the Claude managed-OAuth access token warm.
#
# Argus idles overnight; its OAuth access token (~8h life) goes cold. A small
# serialized ping every few hours keeps the file-based token (~/.claude/
# .credentials.json) fresh so Prime's first morning spawn never lands on a cold
# refresh. Defense-in-depth with Prime's in-process auth-failure retry.
#
# NOTE: this only works because the stale login-keychain "Claude Code-credentials"
# items (Codex "oauthfix" artifacts, 2026-06-27) were removed on 2026-06-29 —
# Claude now resolves auth from the auto-refreshing FILE, which the launchd
# context CAN read. If "Not logged in" returns here, a stale keychain item was
# recreated; clear it again (see feedback_argus_401_managed_oauth memory).
#
# Runs from $HOME (not the jarvis-prime dir) so it loads no project MCP servers.
export PATH="$HOME/.local/bin:$HOME/hermes-trial/.hermes-home/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CLAUDE="$HOME/.local/bin/claude"
LOG="$HOME/.openclaw/workspace/jarvis-prime/logs/claude-warm.log"
ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"

cd "$HOME" || exit 0
out="$(printf 'ping' | "$CLAUDE" --print --model opus 2>&1)"
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "$ts  OK   token warm (rc=0)" >> "$LOG"
else
  echo "$ts  WARN warm ping rc=$rc: $(printf '%s' "$out" | head -c 100 | tr '\n' ' ')" >> "$LOG"
fi
exit 0
