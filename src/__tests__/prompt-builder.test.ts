import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PromptBuilder } from "../context/prompt-builder.js"
import { ConversationHistory } from "../context/history.js"

const SKILL_A = `---
command: /network-status
description: Check health of all 5 Jarvis network nodes via SSH
---

# /network-status — Network Health Check

## SSH target
Run this against every node and report uptime.
`

const SKILL_B = `---
command: /swap-song
description: Swap one music slot in a future PlayoutONE hour
---

# /swap-song body

UPDATE Playlists SET UID = <new> WHERE GIndex = <slot>
`

const SKILL_C = `---
command: /upcoming
description: List upcoming songs in the WPFQ schedule
---

# /upcoming body

SELECT TOP N from Playlists ORDER BY GIndex
`

let skillsDir: string
let historyPath: string

beforeAll(() => {
  process.env.JARVIS_MEMORY_RECALL_ENABLED = "false"
  skillsDir = mkdtempSync(join(tmpdir(), "prompt-builder-skills-"))
  writeFileSync(join(skillsDir, "network-status.md"), SKILL_A)
  writeFileSync(join(skillsDir, "swap-song.md"), SKILL_B)
  writeFileSync(join(skillsDir, "upcoming.md"), SKILL_C)
})

afterAll(() => {
  rmSync(skillsDir, { recursive: true, force: true })
})

beforeEach(() => {
  historyPath = join(
    mkdtempSync(join(tmpdir(), "prompt-builder-hist-")),
    "history.jsonl",
  )
})

function makeBuilder(): PromptBuilder {
  const history = new ConversationHistory(historyPath)
  return new PromptBuilder(history, { skillsDir })
}

describe("PromptBuilder — lazy skill loading", () => {
  it("A1 chitchat ships index lines only, no skill bodies", async () => {
    const result = await makeBuilder().build("good morning")

    // Index line for each skill present (with em-dash + description).
    expect(result).toContain("### /network-status — Check health of all 5 Jarvis network nodes via SSH")
    expect(result).toContain("### /swap-song — Swap one music slot in a future PlayoutONE hour")
    expect(result).toContain("### /upcoming — List upcoming songs in the WPFQ schedule")

    // No bodies — the body sentinels must NOT be present.
    expect(result).not.toContain("## SSH target")
    expect(result).not.toContain("UPDATE Playlists SET UID")
    expect(result).not.toContain("SELECT TOP N from Playlists")
  })

  it("A2 single-skill trigger inlines only that body", async () => {
    const result = await makeBuilder().build("/network-status")

    expect(result).toContain("## SSH target")
    // Unrelated skill bodies stay collapsed.
    expect(result).not.toContain("UPDATE Playlists SET UID")
    expect(result).not.toContain("SELECT TOP N from Playlists")
  })

  it("A3 multi-skill trigger inlines both bodies", async () => {
    const result = await makeBuilder().build("/upcoming then /swap-song")

    expect(result).toContain("UPDATE Playlists SET UID")
    expect(result).toContain("SELECT TOP N from Playlists")
    // The non-triggered skill stays collapsed.
    expect(result).not.toContain("## SSH target")
  })

  it("A4 unknown slash command triggers no bodies", async () => {
    const result = await makeBuilder().build("/banana")

    expect(result).not.toContain("## SSH target")
    expect(result).not.toContain("UPDATE Playlists SET UID")
    expect(result).not.toContain("SELECT TOP N from Playlists")
    // Index still present.
    expect(result).toContain("### /network-status —")
  })

  it("A5 chitchat prompt is bounded — well under skillCount * 1200 bytes for skill block", async () => {
    const result = await makeBuilder().build("ok thanks")
    // 3 skills, ~1200 bytes-per-skill upper bound for the full prompt's skill
    // section. Even with system context + header, chitchat must stay under
    // skillCount * 1200 + 2 KB headroom for surrounding blocks.
    expect(result.length).toBeLessThan(3 * 1200 + 2048)
  })

  it("token-boundary: a path like /usr/bin/network-status does NOT trigger", async () => {
    const result = await makeBuilder().build("look at /usr/bin/network-status please")
    expect(result).not.toContain("## SSH target")
  })

  it("case-insensitive: /Network-Status triggers /network-status", async () => {
    const result = await makeBuilder().build("/Network-Status")
    expect(result).toContain("## SSH target")
  })
})
