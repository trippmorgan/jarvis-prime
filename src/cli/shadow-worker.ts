/** One bounded retry batch, intended for a systemd timer. No model loading or labels. */
import { drain } from '../bridge/shadow-review.js'
import { queueDiagnostics } from '../bridge/shadow-diagnostics.js'
const before = queueDiagnostics()
if (!before.pending) console.log(JSON.stringify({ event: 'shadow_drain', status: 'idle', ...before }))
else {
  try {
    const completed = await drain({ url: '', model: '', timeoutMs: 1,
      jevUrl: process.env.FRANK_JEV_URL ?? 'http://127.0.0.1:30110', jevTimeoutMs: 240000 }, 3)
    console.log(JSON.stringify({ event: 'shadow_drain', status: 'completed', completed, ...queueDiagnostics() }))
  } catch {
    // Raw HTTP/model errors can contain private text: emit only a bounded category.
    console.log(JSON.stringify({ event: 'shadow_drain', status: 'deferred', ...queueDiagnostics() }))
    process.exitCode = 1
  }
}
