# Systems Processes (W21)

Codified, orchestrator-driven workflows. Each is a state machine the
Prime orchestrator recognizes (`classify` → `plan` → `execute` →
render), with explicit tiers, human gates, and abort conditions.

These two were reconstructed from the runs Tripp validated in mid-May
2026 (the X post, then the 2026-05-18 morning show — "especially
good"). Source of truth for the morning show is the
`PretoriaFields/morning-show/SKILL.md` pipeline cross-checked against
the real `shows/2026-05-18/` artifact tree; for X, the
`openclaw-pretoria/social/` skill chain. Before W21 neither was
recognized by the orchestrator — both ran as conversational/skill
invocations. W21 promotes them to first-class orchestrated processes.

Tier semantics (kernel-enforced): **T0** read-only · **T1** local
write / generate (auto) · **T2** safe service write · **T3** typed
confirmation gate (kernel parks the envelope in `awaiting_input`; the
preceding step's result is rendered at the gate so the human reviews
the actual artifact before confirming).

---

## Process A — X / Twitter post

**Intent:** publish a persona-consistent post to `@xAIDJPretoria`.
**Decision (Tripp, W21):** *confirm at publish only* — status/draft are
automatic; the human confirms exactly once, at publish, with the draft
shown.

### State machine

| # | State | Tier | Auto? | Command | Notes |
|---|-------|------|-------|---------|-------|
| 1 | draft | T1 | yes | `social-draft` | Reads PretoriaFields `README.md` / `PLAYBOOK.md` / `SOCIAL-MEDIA-STRATEGY.md` + live WPFQ now-playing, generates a ≤280-char post. (`/x:status` context is folded into this step — the draft handler pulls live station state itself.) |
| 2 | publish | **T3** | **gate** | `social-post` | Kernel parks in `awaiting_input`. The drafted text + char count + station source are rendered at the gate. On typed confirm → OAuth1 `POST api.twitter.com/2/tweets`. Ignore = abort. |

### Triggers (classifier → `workflow`)

- WPFQ-specific: `post/tweet/send … x/twitter … radio|wpfq|pretoria|now-playing|station` (topic defaults to now-playing)
- General: `draft/post/compose a tweet`, `post/publish to X`, `tweet about <topic>` → topic extracted after `about/re/on`, default now-playing

### Abort / failure

- Draft >280 chars → handler returns error, no publish step reached.
- Station source unreachable → draft step fails, pause-on-failure (no publish).
- Missing X credentials → publish returns `ok:false` with `missing:[…]`; nothing posted.
- Human does not type the phrase → envelope expires; nothing posted.

### Plan shape

`plan.ts` → 2 steps, target `prime`, `social-draft`(T1, `dry_run:true`)
→ `social-post`(T3, `dry_run:false`). Same args object (platform, topic,
workspace, context_files).

---

## Process B — Morning-show production

**Intent:** produce and air the daily 4-hour WPFQ morning show (Mon–Fri
5–9 AM ET), published the weekend before.
**Decision (Tripp, W21):** *preview gate only* — scripts auto-approved;
the single human checkpoint is the preview, shown at the publish gate;
publish remains T3 typed-confirm.

### State machine

| # | Stage | Script | Tier | Auto? | Artifact marker |
|---|-------|--------|------|-------|-----------------|
| 1 | research | `research-date.sh` | T1 | yes | `research.json` |
| 2 | write | `write-scripts.sh` | T1 | yes | `scripts/` |
| 3 | render | `render-voice.sh` (ElevenLabs) | T1 | yes | `segments/*.mp3` |
| 4 | pull-songs | `pull-songs.sh` | T1 | yes | `songs-manifest.json` |
| 5 | produce | `produce-hour.sh` (−16 LUFS) | T1 | yes | `music-preview-summary.json` |
| 6 | preview | `preview.sh` | T1 | yes | `previews/` |
| — | **PREVIEW GATE** | — | **T3** | **human** | preview rendered at the gate |
| 7 | publish | `publish.sh` (AutoImporter) | T3 | gate | `deploy.sql` |
| 8 | verify | `publish.sh` (built-in) | — | yes | Playlists rows confirmed |

Stages 1–6 are one orchestrator step (`morning-show-build`, T1). Stages
7–8 are the second step (`morning-show-publish`, T3). The kernel parks
step 2 in `awaiting_input`; the build result (per-stage status, preview
files, deploy asset count) is rendered at the gate — that *is* the
preview checkpoint.

### Triggers (classifier → `workflow`)

- `build/produce/make/design/generate/publish/preview … morning show`
- `morning show … build/produce/publish/preview/status`
- Distinct from W19b `morning briefing|check|sitrep` (different tokens — no collision).
- Optional date token: `YYYY-MM-DD` · `today` · `tomorrow` · weekday name · `next <weekday>` · default `next` = next Mon–Fri after today.

### AutoImporter guardrails (immutable — from the 2026-03-30 broadcast failure)

1. AutoImporter flow only — **never** direct `INSERT`/`UPDATE` on `Playlists` (it is a log, not a queue).
2. `Audio.Extro = length − 3000ms`, **never 0** (Extro=0 → instant-skip → PlayoutONE crash). Confirmed in `deploy-plan.json`.
3. DPL drop target = `F:\PlayoutONE\Import\Music Logs\` **only** (the `C:\PlayoutONE\data\playlists\` path is ignored).
4. Never publish <30 min before air; never before Music1 + playlist scheduler finish (they overwrite).
5. Recommended publish window: Sat/Sun evening for the Monday show.

### Execution safety (W21 wiring is inert by default)

`cmd_morning_show` runs in **plan mode** unless `{"execute": true}` is
passed. The orchestrator plan does **not** set `execute`, so wiring the
process does not spend ElevenLabs credits or touch the live station.
Plan mode resolves the date, returns the documented stage→script
pipeline, and reflects which artifacts already exist on disk. A real
build/publish is a deliberate Tripp action through the T3 gate; even
then, `morning-show-publish` only runs `publish.sh` when `execute:true`
**and** the kernel has flipped the confirmed envelope to `pending`.

When `execute:true`:
- build → `build-show.sh <date>` spawned **detached** with a log
  (the full pipeline far outlasts any envelope poll window); re-query
  `morning-show` status to track progress.
- publish → `publish.sh <date>` run synchronously (240 s budget);
  `verified` = exit 0.

---

## Orchestrator wiring map (W21)

| Concern | File | Change |
|---|---|---|
| recognize | `src/orchestrator/classify.ts` | broadened X rules; new morning-show rules |
| plan | `src/orchestrator/plan.ts` | general X-post template; 2-step morning-show template |
| tier mirror | `src/orchestrator/execute.ts` | `morning-show-build`=1, `morning-show-publish`=3 (+poll budget) |
| gate UX | `src/orchestrator/index.ts` | `awaiting_confirm` now renders the prior step's result (draft/preview) before the confirm prompt — fixes the "generic/unusable" gate |
| render | `src/orchestrator/index.ts` | morning-show renderer (stage table, previews, deploy summary, guardrails) |
| substrate | `jarvis-os/scripts/room-listener/commands.py` | `cmd_morning_show` (prime-only, plan-mode default); tier + HANDLERS entries |

Tier maps are mirrored in two places and **must stay in sync**:
`execute.ts COMMAND_TIER` (TypeScript) and `commands.py COMMAND_TIER`
(Python).
