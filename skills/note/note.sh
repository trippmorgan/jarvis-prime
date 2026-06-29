#!/usr/bin/env bash
# /note — human-override portfolio upsert (T3.3, T1 WRITE)
#        + memory search front-door (B4, T0 READ).
#
# Two modes:
#   /note <slug>                  T1 WRITE  — upsert STATE.md → project_state
#   /note --search "<query>"      T0 READ   — FTS5 query over hippocampus vault
#
# The search path hits the hippocampus server on :3401 (`/search`) and
# returns results from the migrated vault (B3 output). No external calls,
# no mutations.
#
# Public contract: see note.md (same dir).
# Source of truth: .planning/portfolio-surface/SPEC.md §Write Paths #3,
#                  .planning/memory-and-graphify/PLAN.md §Wave B4.

set -u

JARVIS_OS_ROOT="${JARVIS_OS_ROOT:-/home/tripp/.openclaw/workspace/jarvis-os}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/home/tripp/.openclaw/workspace}"
HIPPO_URL="${HIPPOCAMPUS_URL:-http://127.0.0.1:3401}"
CLI="$JARVIS_OS_ROOT/bin/project-state-upsert.mjs"

usage() {
  cat <<EOF
Usage: /note <project-slug | absolute-path-to-STATE.md>     # upsert
       /note --search "<query>" [--limit N]                  # search

Known slugs:
  jarvis-prime, jarvis-os, hippocampus,
  pretoria-fields (aliases: station, pretoria),
  frank-v3 (alias: frank),
  kitchen-hub (alias: kitchen),
  portfolio-surface,
  research (alias: frank-research),
  clinical (aliases: clinical-research, np)
EOF
}

# --- Search mode ------------------------------------------------------------
do_search() {
  local TIER="[T0 READ]"
  local query="" limit=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="${2:-10}"; shift 2 ;;
      --limit=*) limit="${1#--limit=}"; shift ;;
      *) if [[ -z "$query" ]]; then query="$1"; else query="$query $1"; fi; shift ;;
    esac
  done

  if [[ -z "$query" ]]; then
    echo "$TIER /note --search"
    echo "ERROR: missing query."
    echo "Usage: /note --search \"<query>\" [--limit N]"
    exit 1
  fi
  if ! [[ "$limit" =~ ^[0-9]+$ ]] || (( limit < 1 || limit > 50 )); then
    echo "$TIER /note --search"
    echo "ERROR: --limit must be 1..50 (got '$limit')"
    exit 1
  fi

  local q_enc
  q_enc="$(NOTE_Q="$query" python3 -c 'import os,urllib.parse; print(urllib.parse.quote(os.environ["NOTE_Q"]))')"
  local resp
  resp="$(curl -sS --max-time 10 "$HIPPO_URL/search?q=$q_enc&limit=$limit" 2>&1)"
  local rc=$?

  echo "$TIER /note --search \"$query\""
  if [[ $rc -ne 0 ]]; then
    echo "ERROR: hippocampus unreachable at $HIPPO_URL ($resp)"
    exit 2
  fi

  NOTE_SEARCH_JSON="$resp" NOTE_SEARCH_QUERY="$query" python3 <<'PY'
import json, os, sys
query = os.environ.get("NOTE_SEARCH_QUERY", "")
raw = os.environ.get("NOTE_SEARCH_JSON", "")
try:
    d = json.loads(raw)
except Exception as e:
    print(f"ERROR: bad search response ({e})"); sys.exit(2)
if not d.get("ok"):
    print(f"ERROR: search refused: {d}"); sys.exit(2)
total = d.get("total", 0)
results = d.get("results", []) or []
shown = len(results)
if total == 0:
    print(f"no matches for \"{query}\"")
    sys.exit(0)
print(f"{total} match{'es' if total != 1 else ''} for \"{query}\" (showing {shown})")
print()
vault_root = "/home/tripp/.openclaw/hippocampus-vault/"
for i, r in enumerate(results, 1):
    path = r.get("path", "") or ""
    slug = r.get("slug") or "?"
    rel = path[len(vault_root):] if path.startswith(vault_root) else path
    atom_type = rel.split("/", 1)[0] if "/" in rel else "?"
    snip = (r.get("snippet") or "").replace("<mark>", "*").replace("</mark>", "*")
    snip = " ".join(snip.split())
    if len(snip) > 200:
        snip = snip[:197] + "..."
    print(f"{i}. [{atom_type}] {slug}")
    print(f"   {snip}")
    print(f"   path: {rel}")
PY
}

# --- Mode dispatch ----------------------------------------------------------
ARG="${1:-}"
if [[ -z "$ARG" || "$ARG" == "-h" || "$ARG" == "--help" ]]; then
  echo "[T0 READ] /note"
  usage
  exit 1
fi

if [[ "$ARG" == "--search" || "$ARG" == "-s" ]]; then
  shift
  do_search "$@"
  exit $?
fi

# --- Upsert mode (original behavior) ---------------------------------------
TIER="[T1 WRITE]"

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
    research|frank-research)
      echo "$WORKSPACE_ROOT/research/.planning/STATE.md" ;;
    clinical|clinical-research|np)
      echo "$WORKSPACE_ROOT/clinical-data/.planning/STATE.md" ;;
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
