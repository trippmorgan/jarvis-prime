import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, lstatSync, readlinkSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * W7-T4 — Workspace allowlist enforcement test (THE PHI boundary).
 *
 * Enumerates the actual right-brain-workspace/ tree and asserts:
 *   1. Exactly the 8 allowlisted files are present as symlinks.
 *   2. No paths contain openclaw.json, *.env, *.key, *.pem, or anything
 *      under clinical-archive/ (credentials + PHI blocklist from SPEC W7-F6).
 *   3. No regular files exist other than OpenClaw's own state marker
 *      (~/.openclaw-managed workspace-state.json inside .openclaw/).
 *
 * If the workspace is missing (e.g. clean CI checkout that hasn't run
 * scripts/setup-right-brain-agent.sh), the test is skipped rather than
 * failed — scope is local + post-setup verification.
 */

const WORKSPACE = '/home/tripp/.openclaw/workspace/right-brain-workspace'

const ALLOWLIST = new Set<string>([
  'MEMORY.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'AGENTS.md',
  'TOOLS.md',
  'conversation-history.jsonl',
])

const BLOCKLIST_PATTERNS = [
  /openclaw\.json$/,
  /\.env$/,
  /\.key$/,
  /\.pem$/,
  /clinical-archive/,
]

/**
 * Walks the workspace tree (following link targets with lstat so we can
 * distinguish symlinks from regular files). Returns a flat list of entries.
 */
interface Entry {
  relPath: string
  absPath: string
  kind: 'symlink' | 'file' | 'directory'
  linkTarget?: string
}

function walk(root: string, rel: string = ''): Entry[] {
  const here = rel === '' ? root : join(root, rel)
  const entries: Entry[] = []
  for (const name of readdirSync(here)) {
    const relPath = rel === '' ? name : join(rel, name)
    const absPath = join(root, relPath)
    const lst = lstatSync(absPath)
    if (lst.isSymbolicLink()) {
      entries.push({
        relPath,
        absPath,
        kind: 'symlink',
        linkTarget: readlinkSync(absPath),
      })
    } else if (lst.isDirectory()) {
      entries.push({ relPath, absPath, kind: 'directory' })
      entries.push(...walk(root, relPath))
    } else {
      entries.push({ relPath, absPath, kind: 'file' })
    }
  }
  return entries
}

const workspacePresent = existsSync(WORKSPACE) && statSync(WORKSPACE).isDirectory()
const testFn = workspacePresent ? it : it.skip

describe('right-brain-workspace allowlist (W7-T4 — AC7.4 + AC7.5)', () => {
  testFn('contains exactly the 8 allowlisted files as symlinks', () => {
    const entries = walk(WORKSPACE)
    const symlinks = entries
      .filter((e) => e.kind === 'symlink')
      .map((e) => basename(e.relPath))
      .sort()
    const expected = [...ALLOWLIST].sort()
    expect(symlinks).toEqual(expected)
  })

  testFn('every symlink target is a real file (not dangling)', () => {
    const entries = walk(WORKSPACE)
    const symlinks = entries.filter((e) => e.kind === 'symlink')
    for (const sl of symlinks) {
      const stat = existsSync(sl.absPath) ? statSync(sl.absPath) : null
      expect(stat, `symlink ${sl.relPath} → ${sl.linkTarget} is dangling`).not.toBeNull()
      expect(stat!.isFile()).toBe(true)
    }
  })

  testFn('no blocklisted paths appear anywhere in the tree (credentials + PHI)', () => {
    const entries = walk(WORKSPACE)
    for (const e of entries) {
      const target = e.linkTarget ?? e.absPath
      for (const pattern of BLOCKLIST_PATTERNS) {
        expect(
          pattern.test(target) || pattern.test(e.relPath),
          `blocklisted path matched ${pattern}: entry=${e.relPath} target=${target}`,
        ).toBe(false)
      }
    }
  })

  testFn('no regular files exist outside of OpenClaw-managed .openclaw/ and tmp/', () => {
    // tmp/ is agent scratch: right-brain-agent writes transient session artifacts
    // (images sent for visual analysis, fetched content) there during Telegram turns.
    // The PHI/credentials blocklist below still applies — tmp/ is scope-limited to
    // "binary scratch, never persisted into memory files", not "anything goes".
    const entries = walk(WORKSPACE)
    const stray = entries.filter(
      (e) =>
        e.kind === 'file' &&
        !e.relPath.startsWith('.openclaw/') &&
        e.relPath !== '.openclaw' &&
        !e.relPath.startsWith('tmp/') &&
        e.relPath !== 'tmp',
    )
    expect(stray, `unexpected regular files: ${stray.map((s) => s.relPath).join(', ')}`).toEqual([])
  })

  testFn('no symlink targets escape /home/tripp/.openclaw/workspace/', () => {
    const entries = walk(WORKSPACE)
    for (const e of entries) {
      if (e.kind !== 'symlink') continue
      expect(
        e.linkTarget!.startsWith('/home/tripp/.openclaw/workspace/'),
        `symlink ${e.relPath} escapes workspace: target=${e.linkTarget}`,
      ).toBe(true)
    }
  })
})
