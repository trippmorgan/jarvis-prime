import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // Keep vitest's defaults (node_modules, dist, .git, …) and also ignore
    // .claude/ — agent worktrees under .claude/worktrees/ are full repo copies,
    // so without this vitest collects every *.test.ts twice (or N times),
    // inflating collection time and surfacing phantom failures from stale,
    // path-broken worktree copies. The real source tree lives in src/.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // SuperServer has 128 cores; an uncapped worker pool once contributed
    // to a hard freeze under concurrent load (2026-07-04). Keep it modest.
    maxWorkers: 8,
  },
})
