#!/bin/bash
# env-token-guard.sh — Argus (Mac mini)
# Managed-OAuth lock. Strips any static Claude/Anthropic auth token (and the
# "Stopgap re-inject" breadcrumb comments) from jarvis-prime/.env so a token
# can never shadow the auto-refreshing CLI OAuth. A re-injected
# CLAUDE_CODE_OAUTH_TOKEN is the root cause of the recurring 401 / "run /login"
# loop (diagnosed 2026-06-28). Fired by launchd WatchPaths on every .env
# change. Idempotent; does not block legitimate edits.
ENV_FILE="/Users/trippmorgan/.openclaw/workspace/jarvis-prime/.env"
LOG="/Users/trippmorgan/.openclaw/workspace/jarvis-prime/logs/env-token-guard.log"
TOKEN_PATTERN="^[[:space:]]*(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)="
STRIP_PATTERN="${TOKEN_PATTERN}|^[[:space:]]*#[[:space:]]*Stopgap re-inject"

[ -f "$ENV_FILE" ] || exit 0
if grep -Eq "$STRIP_PATTERN" "$ENV_FILE"; then
  ts="$(date "+%Y-%m-%dT%H:%M:%S%z")"
  hits="$(grep -Ec "$TOKEN_PATTERN" "$ENV_FILE")"
  cp "$ENV_FILE" "${ENV_FILE}.guard-bak-$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp)"
  grep -Ev "$STRIP_PATTERN" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "$ts  STRIPPED $hits token line(s) + cleaned stopgap breadcrumb(s) (managed-OAuth lock active)" >> "$LOG"
fi
exit 0
