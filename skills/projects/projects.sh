#!/usr/bin/env bash
# /projects — Telegram skill entry (W5.b).
# Wrapper around the canonical render.mjs. T0 READ — no confirmation,
# no mutations, safe during live ops.
set -u
exec /usr/bin/env node "$(dirname -- "${BASH_SOURCE[0]}")/render.mjs"
