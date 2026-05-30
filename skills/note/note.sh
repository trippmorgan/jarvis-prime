#!/usr/bin/env bash
# /note — human-override portfolio upsert (T3.3, T1 WRITE).
#
# Resolves a project slug (or absolute STATE.md path) and fires the
# canonical bin/project-state-upsert.mjs CLI with --source human-note.
#
# Public contract: see note.md (same dir).
# Source of truth: .planning/portfolio-surface/SPEC.md §Write Paths #3.

set -u

TIER="[T1 WRITE]"
JARVIS_OS_ROOT="${JARVIS_OS_ROOT:-/home/tripp/.openclaw/workspace/jarvis-os}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/home/tripp/.openclaw/workspace}"
CLI="$JARVIS_OS_ROOT/bin/project-state-upsert.mjs"

usage() {
  cat <<EOF
Usage: /note <project-slug | absolute-path-to-STATE.md>

Known slugs:
  jarvis-prime, jarvis-os, hippocampus,
  pretoria-fields (aliases: station, pretoria),
  frank-v3 (alias: frank),
  kitchen-hub (alias: kitchen),
  portfolio-surface
EOF
}

ARG="${1:-}"
if [[ -z "$ARG" || "$ARG" == "-h" || "$ARG" == "--help" ]]; then
  echo "$TIER /note"
  usage
  exit 1
fi

# --- Slug resolver ----------------------------------------------------------
resolve_state_md() {
  local input="$1"
  # Absolute path passthrough.
  if [[ "$input" == /* ]]; then
    echo "$input"
    return
  fi
  case "$input" in
    jarvis-prime)
      echo "$WORKSPACE_ROOT/jarvis-prime/.planning/STATE.md" ;;
    jarvis-os)
      echo "$WORKSPACE_ROOT/jarvis-os/.planning/STATE.md" ;;
    hippocampus)
      echo "$WORKSPACE_ROOT/jarvis-os/.planning/hippocampus/STATE.md" ;;
    pretoria-fields|station|pretoria)
      echo "$WORKSPACE_ROOT/PretoriaFields/.planning/STATE.md" ;;
    frank-v3|frank)
      echo "$WORKSPACE_ROOT/frank-v3/.planning/STATE.md" ;;
    kitchen-hub|kitchen)
      echo "$WORKSPACE_ROOT/kitchen-hub/.planning/STATE.md" ;;
    portfolio-surface)
      echo "$WORKSPACE_ROOT/jarvis-os/.planning/portfolio-surface/STATE.md" ;;
    *)
      return 1 ;;
  esac
}

STATE_MD="$(resolve_state_md "$ARG" || true)"
if [[ -z "$STATE_MD" ]]; then
  echo "$TIER /note $ARG"
  echo "ERROR: unknown project slug '$ARG'."
  usage
  exit 1
fi

if [[ ! -f "$STATE_MD" ]]; then
  echo "$TIER /note $ARG"
  echo "ERROR: STATE.md not found at $STATE_MD"
  exit 1
fi

if [[ ! -f "$CLI" ]]; then
  echo "$TIER /note $ARG"
  echo "ERROR: portfolio-surface CLI missing at $CLI"
  echo "  Run 'npm run build:daemon' in jarvis-os or check JARVIS_OS_ROOT."
  exit 1
fi

OUTPUT="$(node "$CLI" "$STATE_MD" --source human-note 2>&1)"
RC=$?

echo "$TIER /note $ARG"
if [[ $RC -eq 0 ]]; then
  # Parse the one-line JSON for a friendly summary, falling back to raw.
  PROJECT="$(echo "$OUTPUT" | sed -n 's/.*"project":"\([^"]*\)".*/\1/p')"
  PATH_OUT="$(echo "$OUTPUT" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
  rel_state="${STATE_MD#"$WORKSPACE_ROOT"/}"
  if [[ -n "$PROJECT" && -n "$PATH_OUT" ]]; then
    echo "ok — upserted ${PROJECT} (source=human-note)"
    echo "  store: ${PATH_OUT}"
    echo "  state: ${rel_state}"
  else
    echo "ok — $OUTPUT"
  fi
  exit 0
fi

echo "ERROR: portfolio upsert refused (exit $RC)"
echo "$OUTPUT"
exit "$RC"
