import type { SpawnResult } from './types.js'

/** True when the CLI refused to --resume because the session file is gone. */
export function isMissingSessionResult(result: SpawnResult): boolean {
  return result.errors?.some((e) => /no conversation found/i.test(e)) ?? false
}
