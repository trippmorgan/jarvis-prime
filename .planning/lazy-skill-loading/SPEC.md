---
type: spec
project: lazy-skill-loading
status: draft
phase: spec
created: 2026-06-29
updated: 2026-06-29
owner: prime
---

# Lazy Skill Loading — SPEC

## Goal

Shrink the per-message prompt the Jarvis Prime Telegram bridge sends to Claude
Code by **not** injecting every skill's full body on every turn. Only the
skill(s) actually invoked (or about to be invoked) should ship their full
instructions. Everything else collapses to a one-line index entry.

This is a token-economy fix, not a behavior change. Same skills, same SSH
surface, same personality. Less Anthropic Max quota burned per "good morning."

---

## Why now

The 2026-06-28 Max session-limit hit prompted a context-cap audit. Real numbers
from `src/context/prompt-builder.ts:58-101` and `/home/tripp/.claude/skills/`:

| Block | Source | Size per message |
|-------|--------|------------------|
| Skill catalog (all bodies, each truncated to 1500 chars) | `prompt-builder.ts:75-98` | **~50 KB** (33 skills × ~1.5 KB) |
| System context header | `prompt-builder.ts:49-55` | ~0.5 KB |
| Memory + active projects | `memory-recall.ts` | ~2-5 KB |
| Conversation history (cap: 20 entries / 6000 chars) | `history.ts:11-12` | ≤ 6 KB |
| Current user message | direct | tiny |
| **+ Claude Code auto-loads** (CLAUDE.md, rules/*.md) | outside bridge | ~10 KB |

So ~75 KB of prompt is sent on a 5-character "ok thanks." The skill catalog is
the only big lever inside the bridge (Claude Code's own auto-loads are
orthogonal and out of scope). 33 skills today; the catalog grows with every
new `/x:*`, `/wp:*`, `/morning-show *` we ship.

The 1500-char truncation already existed; this SPEC is the next step.

---

## Scope

### IN

1. **Lazy skill body injection.** In `prompt-builder.ts:58-101`, change
   `loadSkills()` (and `build()`) so that on each `build(userMessage)` call:
   - Always emit a compact **skill index** — one line per skill:
     `### <command> — <description>` (~50-100 chars each, ~3 KB total for 33).
   - Inline the **full body** ONLY for skills the user message references
     (see Trigger Predicate below).

2. **Trigger predicate** — minimal v1:
   - If the message contains a token matching `/<command>` (case-insensitive)
     where `<command>` is a known skill name, inline that skill's full body.
   - Multi-skill messages allowed (e.g. `/upcoming` followed by `/swap-song`
     in the same turn loads both bodies).
   - **No semantic match in v1.** The keyword-trigger behavior currently
     advertised in the header ("check the network" → `/network-status`)
     becomes best-effort: the LLM can still propose running `/network-status`
     from the index line alone, then we'd inline the body on the next turn
     when the user types `/network-status`. This is the v1 regression we
     accept (see Risks).

3. **Header text update.** The line
   "When Tripp sends a message starting with /, match it to a skill below"
   already implies the slash-trigger model; keep the index always visible so
   the LLM still knows what's available. Update wording to make it explicit
   that bodies appear when invoked.

### OUT (this phase)

- Memory recall changes (`memory-recall.ts` stays as-is).
- History tightening (cap stays at 20 entries / 6000 chars).
- Semantic trigger detection (NL → skill mapping) — explicit v1.x.
- Claude Code auto-load reduction (CLAUDE.md, `~/.claude/rules/`) — not
  controllable from the bridge.
- Skill catalog deterministic short-circuit in `orchestrator/index.ts:131`
  (W21.4) — that path already returns the catalog explicitly when asked;
  re-using the new index there is a follow-up, not a blocker.

---

## Acceptance criteria

1. For a chitchat user message (no `/` token), the assembled prompt from
   `PromptBuilder.build()` shrinks by **≥ 35 KB** vs the current
   implementation. (Measured by writing the built prompt to disk in a unit
   test and asserting `length` before/after.)
2. For a `/upcoming 2026062920` user message, the assembled prompt
   **contains the full `/upcoming` body** (matching the current 1500-char
   truncation behavior) and **does not contain** the bodies of
   `/swap-song`, `/wp:publish`, etc.
3. The compact index line for every skill in `~/.claude/skills/*.md`
   appears in every prompt, regardless of trigger state.
4. Existing test
   `src/__tests__/orchestrator/w21-systems-processes.test.ts:182`
   (deterministic catalog return) still passes — that path is outside this
   change but must not regress.
5. No new test fails. New tests cover: (a) chitchat-size assertion,
   (b) single-skill trigger, (c) multi-skill trigger,
   (d) unknown-slash (e.g. `/banana`) inlines nothing.

---

## Risks

- **R1: Lost keyword-trigger UX.** Today, "check the network" could trigger
  `/network-status` because the LLM reads the full body and decides to act.
  With only the index line visible, the LLM might still propose the skill
  in plain text rather than running it. **Mitigation:** the index entry
  description is enough for the LLM to mention/propose the skill; the user
  can confirm by typing `/network-status`, which will load the body next
  turn. Plan v1.x semantic trigger if Tripp finds this annoying.
- **R2: Truncation already exists** (1500 chars) — some skill bodies are
  cut mid-instruction today. Lazy loading doesn't fix this; it just stops
  shipping the truncated copy when it's irrelevant. Out of scope to
  re-tune 1500 → larger; revisit in v1.x.
- **R3: Argus Prime parallel.** Argus runs the same `prompt-builder.ts`
  via shared source. Lazy loading deploys to both nodes when Prime is
  redeployed. Verify with `/deploy jarvis-prime argus` flow.

---

## Open questions

- **Q1: Index entry length** — `### <command> — <description>` from frontmatter
  vs. the more verbose `### <command>\n<desc>` two-line block currently used.
  Recommend single-line for compactness.
- **Q2: Trigger match casing** — `/Upcoming` and `/upcoming` should both
  match. Lowercase-fold the matcher; verify against existing skill filenames
  (all lowercase today).
- **Q3: PHI skill bodies** — none currently contain PHI, but `/note` and
  clinical-adjacent skills should still be safe to inline. Confirm pre-PR.

---

## Non-goals

- Reducing Claude Code's own context (`/home/tripp/.claude/CLAUDE.md`).
- Migrating to a different model for Argus (Codex bridge) — separate
  discussion thread.
- Restructuring the skills directory (e.g. sub-folders by tier).
