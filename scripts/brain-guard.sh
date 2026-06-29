#!/bin/bash
# brain-guard.sh — PreToolUse guardrail entry point for the Argus jarvis-prime brain.
#
# WHY: Argus spawns `claude --print --dangerously-skip-permissions` — a fully
# unrestricted shell on the *security* node, with no audit trail. This hook adds
# the two missing pieces: (1) an append-only audit log of every brain tool call,
# and (2) a tight catastrophe deny-list. PreToolUse hooks fire even under
# --dangerously-skip-permissions, so this is the only enforcement that survives
# that flag.
#
# SCOPE: only active when JARVIS_BRAIN_GUARD is set (the brain inherits it from
# its launchd plist). Every other claude session on this box (Tripp's interactive
# Claude Code, other fleet spawns) is an instant no-op.
#
# SAFETY: fails OPEN. Missing guard file, python crash, or any non-deny exit ->
# allow (exit 0). A real block requires exit 2 AND the deny token on stderr, so
# an interpreter error (which can also exit 2) can never masquerade as a deny.
#
# CONTRACT: PreToolUse. exit 0 = allow, exit 2 = block (stderr -> model).

[ -z "${JARVIS_BRAIN_GUARD:-}" ] && exit 0

PY="/Users/trippmorgan/.openclaw/workspace/jarvis-prime/scripts/brain-guard.py"
[ -f "$PY" ] || exit 0   # guard logic missing -> fail open

out="$(python3 "$PY" 2>&1)"
rc=$?

if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q '^BRAIN-GUARD BLOCKED:'; then
  printf '%s\n' "$out" >&2
  exit 2
fi
exit 0
