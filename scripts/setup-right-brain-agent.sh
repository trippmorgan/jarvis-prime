#!/usr/bin/env bash
# Provisions the `right-brain` OpenClaw agent for Wave 7.
#
# Creates ~/.openclaw/workspace/right-brain-workspace/ containing symlinks
# to exactly the 8 allowlisted files (7 workspace .md + conversation
# history). Registers the agent with `openclaw agents add`.
#
# Idempotent: re-running is a no-op once the agent and symlinks exist.
# Backs up openclaw.json before mutation (agents add rewrites it).
#
# Exit codes: 0 = success (no-op or provisioned); non-zero = hard failure.

set -euo pipefail

AGENT_NAME="right-brain"
MODEL_ID="openai-codex/gpt-5.4"
WORKSPACE_ROOT="/home/tripp/.openclaw/workspace"
AGENT_WORKSPACE="${WORKSPACE_ROOT}/right-brain-workspace"
OPENCLAW_CONFIG="/home/tripp/.openclaw/openclaw.json"
HISTORY_FILE="${WORKSPACE_ROOT}/jarvis-prime/.data/conversation-history.jsonl"

ALLOWLIST=(
  "MEMORY.md"
  "SOUL.md"
  "IDENTITY.md"
  "USER.md"
  "HEARTBEAT.md"
  "AGENTS.md"
  "TOOLS.md"
)

echo "[W7-T3] Provisioning right-brain agent..."

# 1. Guard — verify all source files exist before we touch anything.
for f in "${ALLOWLIST[@]}"; do
  if [[ ! -f "${WORKSPACE_ROOT}/${f}" ]]; then
    echo "  ERROR: source file missing: ${WORKSPACE_ROOT}/${f}" >&2
    exit 1
  fi
done
if [[ ! -f "${HISTORY_FILE}" ]]; then
  echo "  ERROR: conversation-history.jsonl missing at ${HISTORY_FILE}" >&2
  exit 1
fi

# 2. Backup openclaw.json (agents add mutates it in place).
if [[ -f "${OPENCLAW_CONFIG}" ]]; then
  backup="${OPENCLAW_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "${OPENCLAW_CONFIG}" "${backup}"
  echo "  backed up openclaw.json → ${backup}"
fi

# 3. Create workspace directory + symlinks.
mkdir -p "${AGENT_WORKSPACE}"
for f in "${ALLOWLIST[@]}"; do
  src="${WORKSPACE_ROOT}/${f}"
  dst="${AGENT_WORKSPACE}/${f}"
  if [[ -L "${dst}" ]]; then
    echo "  symlink exists: ${f}"
  else
    ln -s "${src}" "${dst}"
    echo "  linked ${f}"
  fi
done

# conversation-history.jsonl lives under jarvis-prime/.data/
hist_dst="${AGENT_WORKSPACE}/conversation-history.jsonl"
if [[ -L "${hist_dst}" ]]; then
  echo "  symlink exists: conversation-history.jsonl"
else
  ln -s "${HISTORY_FILE}" "${hist_dst}"
  echo "  linked conversation-history.jsonl"
fi

# 4. Register agent if not already present.
if openclaw agents list 2>/dev/null | grep -q "^- ${AGENT_NAME}\b"; then
  echo "  agent ${AGENT_NAME} already registered — skipping agents add"
else
  echo "  registering ${AGENT_NAME} via openclaw agents add..."
  openclaw agents add "${AGENT_NAME}" \
    --workspace "${AGENT_WORKSPACE}" \
    --model "${MODEL_ID}" \
    --non-interactive
fi

# 5. Verification.
echo ""
echo "[W7-T3] Post-provision state:"
echo "--- agents list ---"
openclaw agents list | grep -A3 "${AGENT_NAME}" || {
  echo "  ERROR: agent ${AGENT_NAME} not found after agents add" >&2
  exit 1
}
echo ""
echo "--- workspace tree ---"
ls -la "${AGENT_WORKSPACE}"
echo ""
echo "[W7-T3] done."
