/** Content-free queue health; never reads or returns answer/reviewer text. */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shadowDir } from './shadow-review.js'
function files(dir: string, kind: string) {
  try { return readdirSync(join(dir, kind)).filter(x => /^[a-f0-9]{64}\.json$/.test(x)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
export function queueDiagnostics(dir = shadowDir(), now = Date.now()) {
  const cases = files(dir, 'cases'), predictions = new Set(files(dir, 'predictions'))
  const pending = cases.filter(id => !predictions.has(id))
  const oldest = pending.reduce((min, id) => Math.min(min, statSync(join(dir, 'cases', id)).mtimeMs), now)
  return { cases: cases.length, predictions: predictions.size, pending: pending.length,
    oldestPendingSeconds: pending.length ? Math.max(0, Math.floor((now - oldest) / 1000)) : 0,
    independentDeclarations: files(dir, 'labels').length }
}
