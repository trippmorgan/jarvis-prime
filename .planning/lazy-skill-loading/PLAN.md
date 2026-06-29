---
type: plan
project: lazy-skill-loading
status: draft
phase: plan
created: 2026-06-29
updated: 2026-06-29
owner: prime
---

# Lazy Skill Loading — PLAN

## Summary

**5 tasks, 3 waves.** Estimated 25 min parallel / ~45 min sequential.

Single-file change to `src/context/prompt-builder.ts` plus a new test file
`src/__tests__/prompt-builder.test.ts`. No public API change — `build()`
keeps its `(userMessage) => Promise<string>` signature.

| Wave | Tasks | Notes |
|------|-------|-------|
| 1 | T1 (parse), T5 (test scaffold) | Independent; T5 writes failing tests first |
| 2 | T2 (trigger), T4 (header) | Both consume T1's `SkillEntry[]` |
| 3 | T3 (compose), then verify | T3 wires T1+T2 into `build()` |

---

## Wave 1 (parallel)

### Task 1: Refactor `loadSkills()` into a structured parser

- **Files:**
  - `src/context/prompt-builder.ts` (modify)
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] New private type `SkillEntry { command: string; description: string; body: string }` (file-local, not exported).
  - [ ] New private field `private skills: SkillEntry[] = []` replaces the eager `skillSummary` string.
  - [ ] `loadSkills()` parses every `*.md` file in `SKILLS_DIR` into a `SkillEntry`, preserving the existing frontmatter regex (`^command:`, `^description:`) and body extraction (everything after the second `---`).
  - [ ] `command` falls back to `/${filename without .md}` when frontmatter is missing (preserve current behavior at `prompt-builder.ts:80`).
  - [ ] Body is **not** truncated at parse time — store the full body in the entry; truncation happens at render time.
  - [ ] Skills loaded once in the constructor; identical to current eager-load lifecycle. No file reads in `build()`.
- **Test Requirements:**
  - Covered by Task 5's test scaffold — at this stage the test asserts the entry count matches `readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).length`.
- **Context Needed:**
  - Current `loadSkills()` at `src/context/prompt-builder.ts:58-101` is the source of truth for parsing rules. Keep the same regexes; only the destination structure changes.

### Task 5: Test scaffold for `PromptBuilder`

- **Files:**
  - `src/__tests__/prompt-builder.test.ts` (create)
- **Depends on:** none
- **Acceptance Criteria:**
  - [ ] New vitest file mirrors the conventions of `src/__tests__/skill-registry.test.ts` (vitest, no jest-only APIs).
  - [ ] Test fixture: a tmp `SKILLS_DIR` with 3 fake skill files. Use `vi.mock('node:fs')` OR a small refactor to accept `skillsDir` via config. **Recommend:** add an optional `skillsDir?: string` to `PromptBuilderConfig` (defaulted to current constant) so tests can point at a tmp dir without mocking the filesystem layer. This is a 2-line addition to T1.
  - [ ] Tests assert PRE-implementation state (TDD): write the four assertions below, expect them to fail against current code, expect them to pass after T2/T3:
    - **A1 (chitchat shrinks):** `build("good morning")` produces a prompt with **no** full skill body present. Concretely: `result.includes('## SSH target')` is false (SSH target is in body), but `result.includes('### /network-status — Check health of all 5')` is true (index line present).
    - **A2 (single-skill trigger):** `build("/network-status")` includes the full network-status body (string match on a known body sentence) AND does not include the body of an unrelated skill.
    - **A3 (multi-skill trigger):** `build("/upcoming then /swap-song")` includes both bodies.
    - **A4 (unknown slash):** `build("/banana")` includes no body — only index lines.
- **Test Requirements:**
  - Tests written BEFORE T2/T3 land. Initially expected to fail.
- **Context Needed:**
  - Reference `src/__tests__/skill-registry.test.ts` for vitest fixture style.
  - `ConversationHistory` is constructor-injected; pass a minimal stub or the real class with empty history.

---

## Wave 2 (parallel, depends on Wave 1 / T1)

### Task 2: Implement trigger predicate

- **Files:**
  - `src/context/prompt-builder.ts` (modify — add private method)
- **Depends on:** T1
- **Acceptance Criteria:**
  - [ ] New private method `private detectTriggeredCommands(userMessage: string): Set<string>`.
  - [ ] Returns the subset of `this.skills[].command` strings whose token (e.g. `/network-status`) appears in `userMessage`.
  - [ ] **Casing:** lowercase-fold both sides before matching (per SPEC Q2). So `/Network-Status` matches `/network-status`.
  - [ ] **Token boundary:** match `/<command>` as a whole token (regex `/\B\/<command>\b/i` or split-on-whitespace contains-check) — must NOT match a path like `/usr/bin/network-status`. Recommend the whole-token approach; document the chosen rule with a one-line code comment.
  - [ ] Returns empty `Set` when no skill matches. No throws on malformed input.
- **Test Requirements:**
  - Covered by Task 5 A2/A3/A4.
- **Context Needed:**
  - `this.skills` is the new field from T1. Commands are already strings like `/network-status`.

### Task 4: Update skill-block header text

- **Files:**
  - `src/context/prompt-builder.ts` (modify — the three `skills.push(...)` lines at `prompt-builder.ts:71-73`)
- **Depends on:** T1
- **Acceptance Criteria:**
  - [ ] Replace the three current header lines with text that reflects lazy loading. Recommended copy:
    ```
    ## Available skills
    When Tripp sends a message starting with /, match it to a skill below. The full instructions for a skill appear when that skill is invoked; otherwise only its one-line summary is shown here. Trigger a skill by typing `/<command>` (case-insensitive).
    These are NOT Claude Code slash commands — execute them by running the bash commands described in each skill.
    You can still propose a skill proactively when the request matches (e.g. "check the network" → /network-status); ask Tripp to confirm with the slash command if it would help.
    ```
  - [ ] Text is emitted as part of the assembled skill block in `build()` (since the eager `skillSummary` string is gone after T1/T3). Move this from `loadSkills()` into a small `renderSkillBlock(triggered: Set<string>)` helper that T3 will call.
- **Test Requirements:**
  - Covered indirectly by Task 5 A1 (index lines must still be present).
- **Context Needed:**
  - The header text lives at `prompt-builder.ts:70-74` today. Replace, do not append.

---

## Wave 3 (depends on Wave 2)

### Task 3: Wire lazy injection into `build()`

- **Files:**
  - `src/context/prompt-builder.ts` (modify `build()` + add `renderSkillBlock()`)
- **Depends on:** T1, T2, T4
- **Acceptance Criteria:**
  - [ ] New private `renderSkillBlock(triggered: Set<string>): string` method:
    - Emits the header text from T4.
    - For each skill in `this.skills`: always emit `### <command> — <description>` (single line). If `triggered.has(command)`, also emit the body, truncated to 1500 chars (preserve current truncation behavior from `prompt-builder.ts:91`).
    - If a skill has no description (frontmatter missed it), emit `### <command>` alone with no em-dash suffix.
  - [ ] `getSystemContext()` no longer holds the skill block. `build()` calls `renderSkillBlock(detectTriggeredCommands(userMessage))` and pushes the result into `parts` in the same slot the old `getSystemContext()` skill section occupied (between the system header and the memory block).
  - [ ] `loadSkills()` no longer assembles `skillSummary`; that field is removed.
  - [ ] `build()` remains `async` and its signature is unchanged.
- **Test Requirements:**
  - All four assertions from Task 5 now pass.
  - Add a fifth assertion **A5 (size delta):** in the same test file, build two prompts with the SAME stub history — one for `"ok thanks"`, one for the current implementation snapshot stored as a fixture (or just the eager-assembled prompt before T3). Assert the new chitchat prompt is at least 35 KB smaller than the old one. **Concrete approach:** snapshot the OLD eager prompt at test-setup time by temporarily reverting to the eager path via a feature flag on `PromptBuilder` — OR, simpler, assert an absolute bound: `chitchatPrompt.length < oldPromptCeilingBytes` where `oldPromptCeilingBytes = currentSkillCount * 1200`. Pick the simpler form; document the choice in the test.
- **Context Needed:**
  - Truncation rule: `body.length > 1500 ? body.slice(0, 1500) + '\n...(truncated)' : body` (lift from `prompt-builder.ts:91`).
  - `parts` array order in `build()` is: system context → skill block → memory block → history block → current message. Preserve that order.

---

## Risky / complex tasks (flagged for review)

- **T3 size-delta assertion.** The 35 KB acceptance number in SPEC is real but a fragile test. Recommend the absolute-bound formulation (`length < skillCount * 1200`) over the "before/after diff" form — diffing requires keeping the old code path, which the PR is removing. Confirm at execute time which form Tripp wants.
- **T2 token-boundary rule.** "Whole-token match" was not in SPEC; promoted here from R1 implicit risk. The alternative (loose `.includes('/network-status')`) over-triggers on file paths. Default to whole-token unless Tripp objects.

## Out-of-scope reminders (from SPEC, restated)

- No semantic NL → skill mapping (v1.x).
- No change to `memory-recall.ts`, `history.ts`, or `orchestrator/index.ts:131`.
- No change to skill files themselves or to `~/.claude/CLAUDE.md`.

## Gate

PLAN awaits Tripp's "approved" before Wave 1 begins. Two specific items
need an explicit nod:

1. Adopting `skillsDir?: string` config option for testability (T5/T1).
2. Picking the size-delta assertion form for T3 (absolute bound vs.
   before/after diff).
