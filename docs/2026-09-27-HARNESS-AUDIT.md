# Harness / Jev / usage / Phi audit — 2026-09-27

Checked UTC: 2026-09-28T02:55:58+00:00. Read-only service/log/database audit; no service settings changed. Consultation with localhost:30100 timed out after five seconds; its eventual local inference may be included in usage counters.

## Actual integration

Bridge and CPU service active, zero systemd restarts; CPU model loaded with no errors, no restoration pending and maintenance flag false. Qwen and nomic remain GPU-resident. Jev health calls=4, unchanged from the two deployment smoke pairs. Production cases=0, predictions=0, pending=0, independent declarations=0. Retry timer succeeds but only performs idle runs.

In the bridge's last-24-hour file log, one real natural-language harness race completed: inbound 2026-09-27T04:52:30.870Z, harness answer 04:55:59.180Z, cross-review and label round completed 04:56:15.685Z. There are no jev_shadow events. Four untagged error-level lines are present in the window; their contents were not exposed or assigned a speculative cause. Thus prior synthetic success did not establish production integration: a completed real round did not reach Jev.

Compiled code includes collectShadow. Dedicated systemd drop-in sets FRANK_JEV=1 and the correct local URL, but the unit also loads an EnvironmentFile. An effective-setting override is a candidate explanation for the collector's silent disabled branch, not a confirmed cause. The credential-bearing environment file was not opened. Next diagnostic should expose only safe effective shadow settings and an explicit disabled/clinical skip reason; do not dump process environment or credentials.

## Usage, last 24 hours at inspection

| Scope | Calls | Input | Output | Total |
|---|---:|---:|---:|---:|
| Harness token tracker, local qwen3.8:27b | 325 | 403706 | 17377 | 421083 |
| Bridge right_hemisphere_call_ok | 3 | 19951 | 2170 | 22121 |

Do not add these as an audited whole-system/per-user-round total. All 325 local tracker records lack run_id, and uninstrumented calls may exist. information-flow.jsonl includes 327 run starts and 324 speech_direct events in this window, so most observed traffic is outside the single dual-brain bridge round; the purpose of those calls was not inferred from prompt content. The Ollama client uses measured prompt_eval_count/eval_count when present but falls back to approximately characters/4 for missing/zero prompt counts without marking that provenance.

The harness HTTP completion response incorrectly populates usage.prompt_tokens and completion_tokens with string lengths (dual-brain-server.mjs:1677,1684). Those fields are character counts, not measured token totals, and do not include intermediate calls. Jev produces probabilities rather than generated text; its logs do not currently expose input-token accounting. Four Jev forwards are not four generated tokens.

## Phi

The live server does not call calculatePhi. The offline scorer maps accuracy, depth, creativity, coherence and speed into a weighted sum with an integration multiplier, capped at 100. Jev shadow outputs do not feed it. The inspected experiment/data/experiment.db has 604 historical phi_scores rows; latest timestamp 2026-04-03T02:50:56.955Z, bilateral score 85.85. This is stale experimental history, not current Frank/Jev quality or evidence of improvement. Other experiment artifacts may hold separate offline results; no global latest score is claimed.

Sources: jarvis-prime/.data/logs/jarvis-prime.log; Jev /health; bridge /status; shadow diagnostics; systemd drain journal; voldemort-botspace/experiment/data/token-usage.jsonl and information-flow.jsonl; read-only experiment.db; source scorer, token tracker, Ollama client and live server code.
