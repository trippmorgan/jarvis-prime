import { queueDiagnostics } from '../bridge/shadow-diagnostics.js'
/** Local trusted-human CLI. It does not send messages or auto-label decisions. */
import { nextBlind, labelIndependent, exportIndependent, shadowStatus, drain, scoreShadow, calibrateShadow, writeCalibration } from '../bridge/shadow-review.js'
const [command, ...args] = process.argv.slice(2)
try {
  if (command === 'diagnostics') console.log(JSON.stringify(queueDiagnostics(), null, 2))
  else if (command === 'status') console.log(JSON.stringify(shadowStatus(), null, 2))
  else if (command === 'score') console.log(JSON.stringify(scoreShadow(), null, 2))
  else if (command === 'calibrate' && (args.length === 0 || (args.length === 1 && args[0] === '--write'))) {
    const c = calibrateShadow(); console.log(JSON.stringify(c, null, 2))
    if (args[0] === '--write') console.error(`written ${writeCalibration(c)} — applies at the next jarvis-prime restart`)
  }
  else if (command === 'next' && args.length === 1) console.log(JSON.stringify(nextBlind(args[0]), null, 2))
  else if (command === 'label' && args.length === 6 && args[5] === '--independent') {
    labelIndependent(args[0], args[1], args[2], args[3], args[4], true)
    console.log('Independent declaration saved. No model promotion or live policy change.')
  } else if (command === 'label' && args.length === 8 && args[5] === '--independent' && args[6] === '--model') {
    labelIndependent(args[0], args[1], args[2], args[3], args[4], true, undefined, args[7])
    console.log('Model declaration saved (not human ground truth). No model promotion or live policy change.')
  } else if (command === 'export') console.log(exportIndependent().map(x => JSON.stringify(x)).join('\n'))
  else if (command === 'drain') console.log(JSON.stringify({ completed: await drain({ url: '', model: '', timeoutMs: 1, jevUrl: args[0] ?? 'http://127.0.0.1:30110' }) }))
  else throw new Error('Usage: shadow-review status | score | calibrate [--write] | diagnostics | next REVIEWER | label REVIEWER CASE A|B|equal|abstain REASON SCENARIO_FAMILY --independent [--model NAME] | export | drain [LOOPBACK_URL]')
} catch (e) { console.error(e instanceof Error ? e.message : 'Review command failed'); process.exitCode = 1 }
