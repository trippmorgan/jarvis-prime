---
name: media-player-rfa
description: Radio Free Albany (WPFQ) media player + Jarvis DJ — current skill, website placement, and architecture. Update this when the RFA app or queue logic changes.
metadata:
  type: reference
  host: Mac mini (RFA app)
  status: live (with two open repairs)
---

# Radio Free Albany (RFA) / WPFQ — Media Player Skill

> **Maintainer note:** This file is the single source of truth for the RFA media player
> *as Argus understands it*. It is structured so each section can be edited in isolation.
> Anything marked **⚠ VERIFY ON MAC MINI** is not yet confirmed against the live app
> source — fill it in from the box, do not guess. Last grounded: 2026-06-26.

---

## 1. What this is

Radio Free Albany (RFA) is the Pretoria Fields internet-radio surface. **Jarvis DJ** is the
selector brain that decides what plays; the **media player** is the front-end + server that
streams it. Station identity on air is **WPFQ**.

- **Host:** Mac mini (per Tripp). This `jarvis-prime` repo is the **Argus/Prime brain**, not the
  RFA app — the player code lives on the Mac mini and is reached over the Jarvis network (SSH).
- **Listen surface:** RFA app served on **:4500** (Spec 0 Argus listening surface).
- **Catalog:** real Pretoria music playback; an interim catalog bridge currently stands in for
  a full Navidrome backend (open decision: promote to Navidrome proper).

## 2. Website placement / division

Where RFA lives in the site so it's easy to find and update:

- **Division:** RFA is its own media/radio area, distinct from the clinical, ops, and social
  surfaces. It should sit under a dedicated **/radio** (or media-player) route, not bolted onto
  an unrelated page.
- **Public vs. internal:** today it's the internal Spec 0 listening surface on :4500. The open
  promotion path is toward a **public Pretoria Fields radio site** — keep the internal app path
  stable while that's decided.
- ⚠ **VERIFY ON MAC MINI:** exact route/path the player is mounted at, and which web root /
  reverse proxy serves :4500.

## 3. Architecture (how a song gets to your ears)

```
Jarvis DJ (selector)  ──picks──▶  Queue (reservoir, ~15 songs)
                                      │
                                      ▼
                            Server (playback authority)  ──streamUrl──▶  Browser <audio>
                                      ▲                                       │
                                      └────────── advance on track end ───────┘
```

Key design principles (target state):

1. **Server is the playback authority.** The server owns `nowPlaying` (id + streamUrl) and the
   queue order. The browser should *follow* server state, not decide track order itself.
2. **Reservoir queue.** Keep ~15 songs staged. As tracks finish, the tail is topped back up so
   playback never runs dry.
3. **Advance on end, then refill.** When a track ends → advance pointer → append 1–5 fresh,
   de-duped songs to the tail.
4. **Anti-loop memory.** A just-played song/artist (e.g. "Bad to the Bone") goes temporarily
   ineligible so the selector can't immediately re-pick it.

⚠ **VERIFY ON MAC MINI** (fill these in from the app source — needed before repair):
- App entry point / process name and how it's launched (launchd? pm2? bare node?).
- Endpoints: `now-playing`, `play`, `skip`/advance, queue read. (names assumed, confirm)
- Where the queue lives (in-memory array? file? db?) and the refill function, if any.
- The "now playing" poll interval the browser uses (suspected ~3s).

## 4. Current skill / runbook

- **Status check:** confirm the RFA process is up on the Mac mini and :4500 is serving.
- **Inspect playback:** hit `now-playing` and watch whether `nowPlaying.id` / `streamUrl`
  actually change as a track ends, or whether slot 0 is being replayed.
- **Manual advance:** call the skip/advance endpoint and confirm the pointer moves.
- ⚠ Fill exact commands/URLs once §3 endpoints are verified.

## 5. Known issues (OPEN)

### 5a. First song repeats / queue doesn't progress
**Symptom:** the queued songs only play the **first song over and over**; playback doesn't walk
the list.
**Leading hypothesis (two layers):**
1. **Playback-ownership race** — the periodic "now playing" poll is likely racing the browser's
   `audio.ended` event and re-rendering track 1, so browser and server disagree on who owns the
   current track. **Fix ownership first.**
2. Only after ownership is clean, address selection/advance.

### 5b. Queue doesn't auto-refill (continuous play)
**Symptom:** the 15-song queue drains and isn't topped up — playback can't continue indefinitely.
**Target:** on each track end, advance + append 1–5 fresh, **de-duped** songs to the tail, with
the anti-loop memory from §3.4.

> **Repair order:** fix the ownership/advance race (5a) **before** building the refill generator
> (5b). Generating new songs into a queue that replays slot 0 just hides the real bug.

## 6. Related / adjacent

- Old Telegram **workflow/T3 orchestrator router** is disabled behind
  `JARVIS_WORKFLOW_ORCHESTRATOR_ENABLED=1` (separate surface — do not re-enable to fix RFA).
- **409 poller landmine:** legacy Python bridge plist still in `~/LaunchAgents`
  (`RunAtLoad`+`KeepAlive`) — unrelated to RFA but will restart the poller war on reboot.

## 7. How to update this doc

When the RFA app changes: edit the affected numbered section only, clear the matching
**⚠ VERIFY ON MAC MINI** marker once confirmed against source, and bump the `Last grounded`
date in the maintainer note at the top.
