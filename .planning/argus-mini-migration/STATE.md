---
type: project_state
project: argus-mini-migration
status: done
priority: 1
summary: "Migration complete 2026-07-07: argus-mini is the sole reference across live workspace docs; retired-node refs cleaned."
next_action: "None — optionally remove the stale `Host sentry` block from ~/.ssh/config once confident nothing scripts against it."
source: human-note
source_path: jarvis-prime/.planning/argus-mini-migration/STATE.md
owner: prime
updated_at: "2026-07-07T00:45:00-04:00"
visibility: mesh
phi: false
---

# STATE: Argus Mini Migration

**Project:** argus-mini-migration  
**Status:** done  
**Owner:** prime  
**Updated:** 2026-07-07

## Current State

Argus Mini is the preferred new Argus home. The architectural decision is to use Tailscale as the primary SSH path because the Mac mini has multiple LAN legs and Tailscale avoids subnet ambiguity. Prime/Jarvis automation should use a dedicated SSH key rather than spreading/reusing fleet passwords. The Jarvis-os registry has recognized `argus-mini` and its local services, but final SSH key installation/hardening still needs completion.

## Next Action

Install and test dedicated SSH key auth from SuperServer to Argus Mini over Tailscale; then update service docs and retire password/fleet-key dependency where safe.
