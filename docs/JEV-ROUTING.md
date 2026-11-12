# JEV routing and answer delivery

## 2026-10-31 — Jev as dispatcher: tools/web plans execute on the harness

**Why.** The 2026-10-30 eval (`jev-omni/analysis/LABELS-2026-10-30.md` §5–§6) scored the Jev-fronted jarvis-prime path 6.03/10 at 75 s median vs 8.23/10 at 13 s for the :30100 harness alone, and the log showed the dual brain never ran: the gap was jarvis-prime's own LEFT tool loop (no skill library) vs the harness's frank-v3 loop, plus Jev's GPU swap tax. Tripp's plan (2026-10-31): the conversation stays on the resident LEFT, Jev metes out the work; everything stays on the GPU ("model switching is not an issue, CPU is too slow").

**What changed.**
- `FRANK_DEFAULT_MODE=single` (was hard-coded dual). `/deep` still toggles at runtime; Jev's `deep` route escalates through the competing plan.
- `FRANK_JEV_TOOLS_EXECUTOR=harness`: a `tools` plan (routes `tools`, `web`, unknown) is executed by `askHarness` (`processor.ts processHarnessExecutor`) instead of the LEFT loop. The harness answer is the turn's PRIMARY: its evidence becomes the turn's evidence, Jev's acceptance gate and the reviewer run unchanged, history and delivery are the usual ones. `jev_executor` / `jev_executor_answer` / `jev_executor_failed` log lines; `executor` field in `jev_turn_summary` and in the selection record.
- Fallback: a transport error, or a harness turn in mode `frank-phi-blocked` / `frank-escalated`, is not an answer — the LEFT loop gets the task (`jev_executor_failed`). First live try was blocked by the harness's PHI scan matching "EMR access" in an older shared-history turn.
- Context: the executor sends only the SAME chat's last three exchanges (in-process per-chat ring, `rememberTurn`). The durable history is global across Telegram and virtual chats; sending it whole leaked other chats' turns into harness prompts and tripped the PHI scan.
- `FRANK_JEV_FRONT_PARALLEL=0`: the speculative CPU route is off under the GPU-only policy.
- `jev-gpu-swap`: `JEV_BUSY_GRACE_S=8`, `JEV_GRACE_S=15` so gate → reviewer → judge share one window (the judge was re-swapping after the 2 s busy grace: 33 s median).

**GPU window cost model (measured 2026-10-31, smoke turn "Run uptime and df -h /").** Route window 7 s → park → qwen restore ~24 s → harness generation ~15 s → acceptance window 7 s + restore: 72 s wall for a 15 s task. Every Jev window costs ~31 s round trip on this card. Two windows per turn (route + gate) is the floor of the current design; the structural fix under GPU-only is a Jev that fits beside qwen (int4 ≈ 7 GiB) so no window ever parks the LEFT — to be validated against the labels, since the head reads hidden states.

## 2026-10-30 — blind labels and the first closed loop

**Why.** The 2026-10-29 audit left one hole: every Jev number in this file was a *preference* (median pair-judge P(harness) 0.59, 14/54 coin flips, 15 order disagreements) with **zero labels**, so no accuracy figure existed and nothing Jev decided ever fed back into a knob. Gibson's "education of attention" needs an outcome signal; this is the smallest honest version.

**What changed.**
- `shadow-review label … --independent --model <name>` stores a label with `provenance: independent-model-declaration` and `reviewerIdentity: model:<name>`. Model labels are **never** human ground truth: `export` ignores them; `score` reports them under `modelAgreement` (overall + by `|pHarness−0.5|` band: `lt10 / 10to15 / 15to25 / ge25`) next to `humanAgreement`, plus `selectionOutcome` = did the side Frank actually delivered match the label.
- `scripts/label-with-claude.py` drives the Claude Code CLI (`--print --model sonnet`, system prompt = judge task fulfilment from evidence, A/B blind as handed out by `next`, never sees Jev scores) over every unlabeled case; one line per case in `.data/logs/claude-labels.jsonl`. A failed judgment is stored as `abstain` with family `labeler-error` so the loop advances.
- `shadow-review calibrate [--write]` picks the route margin: smallest of {.05,.10,.15,.20,.25,.30} with ≥10 decisive labeled cases and judge–label agreement ≥0.70 (human labels if ≥10, else model labels; `null` keeps the env default). `--write` saves `~/.local/state/frank-shadow/calibration.json` (0600).
- `server.ts` loads that file at startup (`jev_calibration` log line) and uses `routeMargin` in place of `FRANK_JEV_ROUTE_MARGIN`; `FRANK_JEV_CALIBRATION=0` ignores it. A restart applies it; no live decision is ever changed mid-flight.

**What this is not.** The head is still frozen; the margin is the only knob that learns. Route thresholds and the acceptance minimum stay hand-set until there are labels for routes (none yet: labels are pair labels).

## 2026-10-29 — token-throughput revision (after the Claude CLI audit)

Audit: `jev-omni/analysis/CLI-AUDIT-2026-10-29.md` (independent Claude CLI run over the log, the shadow store
and the code). Finding in one line: JEV added ~60 s and up to three extra LLM generations per message, mostly
through GPU windows that evicted the resident qwen, a reviewer that ran on every tools turn, and an acceptance
gate that never said "deliver". The scores could not be checked because selections were filed under the wrong
case and the plan path dropped the verdict fields. This revision fixes those and makes the client half portable.

What changed (code):

- **Route while generating** (`processor.ts` `selectParallelAnswer`, env `FRANK_JEV_FRONT_PARALLEL`, default on).
  When the single brain is going to answer anyway (mode is not `dual`), the route is asked on the parked CPU
  weights *in parallel* with generation; the plan is resolved in the answer selector. `deep` attaches the
  harness competitor late; everything else gates the single answer. No GPU window, no qwen eviction for the
  route. In `dual` mode the route still blocks (it decides whether the dual brain runs at all), on the
  configured device.
- **No route when the lane is already decided** (tier-0 shortcut, short fast lane): logged as
  `jev_front_route {skipped}` instead of a wasted decide.
- **Per-route gate**: `quick` needs 0.8 (`FRANK_JEV_FRONT_STRONG_QUICK`), others `FRANK_JEV_FRONT_STRONG` (0.6).
  The record carries `threshold`, `parallel`, `servedOn`.
- **Tools plan gates first** (`jev-turn.ts`): acceptance on the executor's report → deliver; the RIGHT reviewer
  only runs on `review` (or when the gate is unavailable). Reason strings: `jev-deliver`,
  `evidence-review:…`, `acceptance-unavailable:…`.
- **`web` = one executor** with the search tool (tools plan). Only `deep` earns a competing candidate.
- **Acceptance rule** (`jev-acceptance.ts`): both orders prefer DELIVER above `FRANK_JEV_ACCEPT_MIN` (0.5).
  The old "average ≥ .65" delivered 0 of 4. `pDeliverOrders` is kept per gate.
- **Scoring fixed**: selections are filed under the case the judge actually scored (`caseId` rides on the
  verdict); when nothing was judged the id is `sha256("selection:<messageId>:<primary>")`, so no phantom
  case with an empty harness text is written. Every judgment and every acceptance of the turn is kept
  (`results[]`, `acceptances[]`), with `phaseMs`. Plan-path selections carry the same verdict fields the legacy
  race path chained. Round labels are written under plans when an alternative existed.
- **One line per message**: `jev_turn_summary` — route, confidence, threshold, applied, lane, device,
  speculative, routeMs/routeWaitMs, plan, selected, reason, generations, every judgment and acceptance with
  per-order probabilities, caseId, phaseMs, primaryMs, harnessMs, sinceInboundMs. No message text.
- **Judge hygiene**: the coordinator's abort signal reaches the HTTP call; `pHarnessOrders` when the service
  returns `p_a_order1/2`; a 0.5 verdict is a tie (shown as "even"); harness errors log length + hash, not text.
- **Health gate**: a judge arriving during park/swap waits on the service lock instead of being rejected.
- **`shadow-review score`**: preference statistics (by plan/reason/selected, decisive and coin-flip rates,
  order disagreements, acceptance deliver rate, phase medians) next to the only accuracy figure, agreement with
  human labels (0 labels as of 2026-10-29 → no accuracy claim).

What changed (service `jev-omni/service/jev_gpu_swap.py`):

- VRAM gate on **measured free bytes** (`torch.cuda.mem_get_info`) ≥ weights (22.18 GiB) + `JEV_GPU_HEADROOM_GIB`
  (0.6), re-unloading residents that appear mid-wait, instead of "foreign use < 1500 MiB" (which let
  nomic + a stray CUDA worker through and OOM'd the swap-in on 10-29).
- If the card cannot be cleared in `JEV_UNLOAD_WAIT_S` (30 s) a `/decide` whose state fits the CPU limit is
  served on CPU (`cpu_fallbacks` in `/health`) instead of a 503.
- `/judge` returns `p_a_order1`, `p_a_order2`; `/health` adds `model_gib`, `needed_mib`, `last_headroom_mib`,
  `cpu_fallbacks`, `last_cpu_decide_s`, `last_gpu_decide_s`; OOM messages are logged in full.
- Unit drop-in: `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.

Portable client: `jev-omni/client/jev_client.py` + `jev-omni/docs/CLIENT-CONTRACT.md` (what to port to Prime /
Argus / DJ Jarvis / :30100, what not to, and why a remote harness must not call Voldemort's :30110).

Tests: `jev-turn`, `jev-execution` (incl. four route-while-generating cases), `jev-acceptance`, `jev-front`,
`jev-routing`, `harness-race`, `left-tool-loop` — all green; the two tier-0 failures in `processor.test.ts`
predate this work (the fixture runs in dual mode). Live verification is recorded below in "Live 2026-10-29".

### Live 2026-10-29 (chat `tui:jev-throughput-test`, Frank in `/deep` dual mode, so the route still blocked on the GPU)

| turn | route (device, ms) | plan | primary gen | gate (both orders) | reviewer | total | before (median since 10-10) |
|---|---|---|---|---|---|---|---|
| quick question about the JEV front end | quick 0.94 (gpu, 15.5 s) | quick | 89 s | deliver .90/.98, 7.0 s | none | 96.5 s | 81 s quick, but 0/4 delivered without a reviewer |
| "run uptime and df -h /" | tools 0.81 (gpu, 7.5 s) | tools | 45 s (1 tool call) | deliver .63/.73, 6.6 s | **none** (was: always) | 51.8 s | 191 s tools |

Both turns: 1 generation, 1 GPU window for the gate, `jev_turn_summary` emitted, selection chained (202).
CPU route cost measured with a realistic 4-turn history state: 39–42 s (so in dual mode the blocking GPU route,
≈7 s swap-in + ≈24 s park, stays cheaper; in single mode the CPU route overlaps generation). Service after
restart: `model_gib 22.18`, `needed_mib 23329`, `last_headroom_mib 700` with the card clear — the gate is
tight by design; the atelier-compute worker (pid 2934417, 338 MiB) still holds VRAM and will push decides to
the CPU fallback whenever it is resident. Its lazy-CUDA fix is outside this change.

## Execution-plan coordinator

The execution-plan coordinator now governs candidate count and bounded recovery. Quick runs one primary generator, then uses `/decide` in both option orders to choose deliver or review. Tools runs one primary executor and a tool-disabled reviewer on captured execution evidence; it never starts a competing harness executor. Web/deep retains competing candidates. Missing or unapplied input classifications conservatively use one executor and an evidence critic.

Tool results are paired with observed calls or captured from OpenClaw's synthesized result events. Missing evidence stays explicit. The JEV pair judge receives bounded task and execution evidence; evidence-aware cases have distinct IDs so they cannot reuse an older text-only prediction. Reviewer output is a proposed correction, not independent ground truth or proof of fresh execution.

At most one tool-free review occurs. JEV judges any changed answer against the original; unchanged reviewed answers still receive a JEV acceptance check. Uncertainty after that bounded recovery falls back to the original. Selection has a total 180-second budget by default, including candidate wait, review, and judgment. Timeout or late response cannot reopen final delivery. Existing generator timeouts remain separate. The GPU service retains physical lease/restoration ownership; the coordinator owns the generation/review/judgment phases and uses the shared inference lock. Quick/tool plans suppress the redundant post-delivery cross-review; competing plans also use the coordinator's bounded verification.

`FRANK_JEV_EXECUTION_PLANS=0` retains the older race policy. `FRANK_JEV_REVIEW_TIMEOUT_MS` defaults to 45000; `FRANK_JEV_SELECTION_BUDGET_MS` defaults to 180000. `/status` exposes execution-plan enablement. Logs contain `jev_execution_plan`, `jev_turn_phase`, `jev_evidence_review`, and final `jev_answer_route` with candidate source, reason, review count, and judgment count. Reviewer selections are explicitly identified as `reviewer`, never mislabeled as harness execution. Private selection records retain acceptance or judgment provenance; no synthetic independent labels are created.

Validation: 104 focused tests passed, covering topology, actual processor delivery/history, timeout/late response, no-tool reviewer transport, evidence pairing, both-order acceptance, prior routing, Telegram, and HTTP behavior. TypeScript build passed. These tests establish behavior, not model accuracy or calibration.

Live synthetic transport smoke completed against the shipped head. Both acceptance orders returned decision hashes, and JEV parked with qwen/nomic restored, maintenance flag clear, and no restore pending. JEV requested review for the correct `1 + 1 = 2` answer (average deliver preference approximately 0.423); this exposes conservative or poorly calibrated acceptance on that case. It does not establish an accuracy rate or justify threshold tuning. No independent human label or synthetic Telegram message was created. The coordinator must retain bounded review and operational fallbacks while independent traffic evaluation is collected.

## Earlier two-candidate policy

User authorized active routing and answer selection on 2026-10-10. This supersedes the advisory-only behavior described in JEV-SHADOW.md when active routing is enabled.

Before natural-language generation, the typed front end selects quick, tools, web, or deep. A preference of at least 0.6 applies its harness lane; `all` mode also permits the quick route to use the single-brain path. Low preference, malformed output, or failure leaves existing routing in control. Clinical and slash-command paths bypass JEV. Model preference is not calibrated correctness.

With answer selection enabled, harness and primary candidates are held. The primary generator must finish before judging can start; the harness has an additional bounded 30-second opportunity to finish. Missing/failed harness leaves primary deliverable. Failed primary can be recovered with a completed harness answer. Late candidates cannot send another final answer. Only the selected final answer is stored in conversation history or returned over HTTP/Telegram; dual-brain deliberation cards are suppressed in this mode. Execution progress remains visible. Selection concerns final text, not reversal of tools already executed by generators.

The judge is local HTTP only, refuses redirects, requests the shipped head and both answer orders, and has a 90-second inference timeout. Its `delivery_gate: true` request explicitly bypasses the GPU service's bridge-idle wait: the turn itself is still processing, but both generators have finished. The cooperative GPU lease and model restoration still apply. The online selector and background worker share the existing nonblocking inference lock; contention falls back to primary rather than overlapping inference.

The averaged harness preference must differ from 0.5 by at least 0.05, and both answer orders must prefer the same candidate. Per-order harness probabilities are recovered as `pHarness + positionBias` and `pHarness - positionBias`. Ties, weak preferences, order disagreement, invalid probabilities/provenance, and service failures fall back to primary. No head promotion, independent human label, or Phi claim is implied. Full execution evidence is retained privately but is not part of the judge's current input. Private prediction records mark active selection separately from advisory inference; immutable selection records retain winner, reason, judgment, and primary path.

Defaults: `FRANK_JEV_FRONT=all`, `FRANK_JEV_ROUTING=1`. `FRANK_JEV=0` disables both; `FRANK_JEV_FRONT=off` disables inbound classification; `FRANK_JEV_ROUTING=0` restores two-answer delivery with advisory review. Other controls: `FRANK_JEV_CANDIDATE_WAIT_MS`, `FRANK_JEV_ROUTE_TIMEOUT_MS`, `FRANK_JEV_ROUTE_MARGIN`, and the front-end controls documented in jev-front.ts. Bridge `/status` exposes effective front mode and delivery-selection enablement without configuration secrets.

Validation: focused routing, private persistence, both-order, failure, late-candidate, clinical exclusion, evolving Telegram, and HTTP tests. The broader processor suite retains two previously documented Tier-0 failures. Build and final test results are reported separately from deployment; activation must wait until the bridge queue is empty and idle.

### 2026-10-31 (evening) — quick-plan affordance dispatch
`harnessAffordance()` (GET `/affordance?q=` on the harness) runs on every `quick` plan when `jevQuickSkills`
(`FRANK_JEV_QUICK_SKILLS`, comma list) is non-empty. A listed skill (`self_model`) sends the turn to the
harness executor, otherwise the LEFT loop runs as before. Logged as `jev_affordance {skill, dispatch, ms}`.
`HARNESS_UNVERIFIED_PREFACE` is stripped from harness answers before the gate. Eval jev-1031b: 7.07 (self 6.4).

### 2026-10-31 (late) — competing plan: gate the harness answer when the LEFT runs long
`RaceGate.competing/processStart/selectionStarted/earlyDelivered`; `scheduleEarlyGate()` on the harness answer;
`earlyGate()` calls the selector with a late, failed primary → `JevTurnCoordinator` gates the alternative alone
(`primary-late:jev-deliver` / `primary-late:evidence-review`). Twelve `resolveAnswer` call sites return early via
`discardLatePrimary` when the message was already delivered. Env: `FRANK_JEV_COMPETING_PRIMARY_GRACE_MS` (45000),
`FRANK_JEV_COMPETING_MIN_ELAPSED_MS` (120000).

## 2026-11-11 — Tiered consistency pressure: settled skills

**Why.** Correlating the harness journal with `jev_turn_summary` (10-30 → 11-02, 109 harness runs, 72 with a
resonance skill): Jev's acceptance gate asked for review on 58 % of skill-less harness turns, 54 % of `self_model`,
100 % of `sports_score` / `news_headlines` — but **0 of 25** `system_status`, `watchdog`, `node_check` turns. On
those skills the probes *are* the evidence, and since 11-01/02 the harness also runs deterministic checks on its
final answer (referents, pickup). Spending a Jev GPU window (route swap-in + ~26 s qwen restore + 7 s assess) on a
turn the structure already settles is the opposite of optimal grip.

**What.** `FRANK_JEV_SETTLED_SKILLS=system_status,watchdog,node_check` (`HarnessRaceConfig.jevSettledSkills`).
Before Jev routes, the processor probes the harness's zero-GPU skill library (`GET /affordance?q=`, ~10 ms). If the
skill is settled, the turn is a `tools` plan on the harness by construction: a synthetic route record
(`servedOn: 'affordance'`, `hash: affordance:<skill>`), no `askJevRoute`, no restore wait. When the harness answers,
`settledBy(completion, skill)` checks that the same skill ran, the loop finished with execution observed, and the
referent and pickup checks are clean; if so `gate.settledReason` is set and the coordinator finishes with
`settled:affordance:<skill>` — no acceptance gate, no Jev hold. Any other outcome (different skill, unsupported
referents, missing pickup) falls back to the normal Jev gate. Events: `jev_front_route {device:'affordance',
settled:true}`, `jev_settle {settled, reason, referents, pickup}`, selection reason `settled:…`.

**Measured.** Live systems check: 19.7 s end to end (route 10 ms) vs 54–68 s medians on the previous evals.
Tests: `jev-execution.test.ts` +4 (settled clean → no route/no gate/one delivery; unsupported referents → gate
runs; different skill ran → gate runs; unsettled skill → Jev routes). 59/59 across the Jev suites.
Unsettled skills (self_model, web skills) and skill-less turns are unchanged: Jev routes and gates them.

Eval `settle-1111` (30 items, judge deepseek-v4-pro, ±2/category noise) vs `pickup-1102`: mean 7.47 vs 7.43,
judge-fabricated 8 vs 12, median 51.1 s vs 57.5 s. Status category 9.14 / fab 1 / median 15.5 s (was 8.71 / 2 /
50.9 s). In the eval window 8 turns matched a settled skill: 7 settled clean (`settled:affordance:<skill>`,
S1/S2/S3/S5 at 10.6–15.5 s end to end), 1 refused — the referent check flagged a bold GPU metric line as an
unsupported quote on S6, so the Jev gate ran as designed (scored 9). Two zeros (W4, F3) are the eval runner's
400 s timeout firing while live Telegram messages held the single processing queue for 335 s and 253 s; the
answers themselves completed. Caveat worth watching: F2 (`node_check`) settled clean but the judge flagged an
unsupported Tailscale side note — prose the deterministic classes do not cover passes the settled tier. If that
recurs, either add a host-status referent class or drop `node_check` from the settled set.
