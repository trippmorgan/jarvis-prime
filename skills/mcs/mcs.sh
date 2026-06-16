#!/usr/bin/env bash
# /mcs — Memory Consolidation Session driver (Wave B8).
#
# Thin shell wrapper around scripts/run-mcs-prep.mjs in jarvis-os.
# Public contract: see mcs.md (same dir).
#
# Source of truth:
#   jarvis-prime/.planning/memory-and-graphify/SPEC.md §Track B Primitive (MCS)
#   jarvis-prime/.planning/memory-and-graphify/PLAN.md §Wave B8

set -u

JARVIS_OS_ROOT="${JARVIS_OS_ROOT:-/home/tripp/.openclaw/workspace/jarvis-os}"
RUNNER="$JARVIS_OS_ROOT/scripts/run-mcs-prep.mjs"

usage() {
  cat <<EOF
Usage:
  /mcs status
  /mcs prep [--date YYYY-MM-DD] [--force-dry-run]
  /mcs writeback --date YYYY-MM-DD [--dry-run]
  /mcs regen [--out PATH]

Subcommands:
  status     T0 READ      — print MCS state (last prep/writeback, Q4 window)
  prep       T1 GENERATE  — render MCS-<date>.md skeleton from current snapshots
  writeback  T2 STAGE     — commit promoted-atoms YAML back to project_state
  regen      T1 GENERATE  — preview workspace MEMORY.md (writes to .preview path)
EOF
}

if [[ $# -eq 0 ]]; then
  echo "[T0] /mcs"
  usage
  exit 0
fi

cmd="$1"
shift || true

case "$cmd" in
  -h|--help|help)
    usage
    exit 0
    ;;
  status|prep|writeback|regen)
    ;;
  *)
    echo "[T0] /mcs"
    echo "ERROR: unknown subcommand '$cmd'"
    usage
    exit 2
    ;;
esac

if [[ ! -x "$RUNNER" && ! -f "$RUNNER" ]]; then
  echo "[T0] /mcs $cmd"
  echo "ERROR: runner not found at $RUNNER"
  echo "Check jarvis-os checkout (env JARVIS_OS_ROOT)."
  exit 1
fi

case "$cmd" in
  status)   tag="[T0 READ] /mcs status" ;;
  prep)     tag="[T1 GENERATE] /mcs prep" ;;
  writeback) tag="[T2 STAGE] /mcs writeback" ;;
  regen)    tag="[T1 GENERATE] /mcs regen" ;;
esac
echo "$tag"

exec /usr/bin/env node "$RUNNER" "$cmd" "$@"
