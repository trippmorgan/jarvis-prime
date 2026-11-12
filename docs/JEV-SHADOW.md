# Advisory Jev reviewer and independent decision collection

State: deployed and live-verified, 2026-09-26. Jev is CPU-resident on port 30110; the bridge has shadow collection explicitly enabled. Live smoke validation passed with the shipped head. Production collection currently has zero cases and zero independent human reviews; synthetic validation data is isolated. No new shadow ledger submission or head promotion was performed. This checkout retains unrelated work in progress.

## Behavior

When a natural-language harness race has both answers and cross-review is enabled, the processor saves a private case and starts a best-effort shadow request. Clinical override traffic is excluded. Normal-path classification is not a PHI detector; keep PHI in the clinical pipeline. Requests accept only a loopback HTTP service, forbid redirects, preflight an already-loaded CPU model, explicitly request `head: shipped`, and reject missing/non-shipped head provenance or invalid probabilities. The collector never calls load/unload or changes GPU leases.

Jev is no longer awaited by narrative review, included in Telegram summaries, a delivery trigger, or a fifth ledger process. Existing narrative/conscience records continue. No Phi, routing, training, or safety decisions consume the shadow score. Ties remain ties. There is one online request in flight per process; busy/unavailable cases stay pending on disk. Pending work is retried by `jev-shadow-drain.timer` five minutes after the previous run, at most three cases per batch. Online and drain requests share a nonblocking filesystem flock; a busy worker defers rather than overlapping inference. The lock is released on normal exit, failure, or process death. Each batch stops on its first failure; persistent invalid cases still require operator investigation. CPU availability is checked before inference, not an atomic reservation against an administrator changing service devices.

Storage defaults to `~/.local/state/frank-shadow` (`FRANK_SHADOW_DIR` overrides). Directories use 0700 and files 0600. Cases include full local task, answers, and tool evidence; predictions and labels are separate. Do not put this directory in Git or publish its contents. The existing service logs input/model hashes separately. Jev receives at most 3000 task characters and 6000 per answer plus truncation markers; the stored prediction records this policy. Tool evidence is available to the human but is not included in the model's current judge input. Comparisons must account for this information difference.

Existing `FRANK_JEV=0` disables collection; `FRANK_JEV_URL` defaults to `http://127.0.0.1:30110`; cross-review and harness-race switches also apply. The application has been restarted and the CPU service is loaded. On future upgrades a reload is required to activate new source code. Collection can operate without Jev available; scores will remain pending.

## Human review workflow

Run from this repository using `npx tsx src/cli/shadow-review.ts` (or the built `node dist/cli/shadow-review.js`):

```text
status
next REVIEWER
label REVIEWER CASE_ID A|B|equal|abstain "reason" SCENARIO_FAMILY --independent
export
drain http://127.0.0.1:30110
```

`next` shows one case with a persisted randomized A/B order, matching execution evidence, and no model scores, author keys, or other reviewers' verdicts. Assignment is stable for that reviewer. Submit only if you did not author either answer and have not consulted prior judgments or model scores. The answer text/evidence can reveal identity; this is presentation blinding, not a guarantee of anonymity. A user who already read this round's cross-review is not a blind reviewer for that round. Use another independent reviewer instead. No agent or model should use this CLI to impersonate a human.

Identity and independence are explicit self-declarations by a trusted local human, not authenticated proof. Every label retains its reviewer, reason, assignment, timestamp, and scenario-family ID. Labels cannot silently overwrite earlier labels. No reviews are invented or automatically converted from weak consensus. The legacy `/label` command remains a potentially unblinded correction channel and is excluded from this export.

`export` writes JSONL to stdout only for independently declared, non-abstaining, non-disputed cases. Multiple reviewers must agree on both label and scenario-family ID. Disputes remain in the store for later adjudication; no adjudication UI is implemented. Give related/paraphrased cases the same family ID before splitting evaluation data. Keep every review of a case/family in one fold; reserve a held-out set before tuning. A label alone establishes neither improved accuracy nor calibrated probabilities. No universal minimum sample size is established.

## Validation

- TypeScript build passed.
- 47 focused tests: private/deduplicated cases; shipped-only validation; health/CPU refusal; remote/redirect exclusion; timeouts and bounded concurrency; stable blind assignments; explicit declarations; immutable labels; conflict/abstention exclusion; tie handling; no shadow influence on delivery/ledger; clinical exclusion.
- Broader processor suite: 71 passed, two Tier-0 routing tests failed. Both failures reproduced in a temporary source copy with this change's processor/harness/labels files replaced by their HEAD versions, preserving the other worktree edits. They predate this change.
- No live model benchmark or independently reviewed production decision is claimed. Synthetic test labels were written only under temporary test directories.

Next operational step: collect upcoming completed answer pairs and have an unexposed independent human review a small batch. The unrelated Tier-0 routing failures remain recorded for separate repair. Compare shadow scores with those labels on scenario-separated holdouts before any promotion or Phi/LifeCoin integration.

## Deployment started — 2026-09-26

User authorized activation. Installed/enabled `jev-shadow-cpu.service` with CPU autoload, CUDA hidden, 16 OpenMP threads, private file permissions, and a 36 GiB memory limit. Disabled the prior `jev-batch.timer`, whose GPU/ledger workflow conflicts with advisory-only operation. Added a bridge drop-in enabling Jev and cross-review explicitly. Existing unrelated source work was preserved; the already-built runtime was snapshotted before restarting the bridge. This snapshot is the pre-restart disk build, not a recovered copy of the previous process's loaded modules.

A shell sequencing error caused the first bridge restart to proceed after its preflight reported a newly busy queue. An in-flight request may have been interrupted. The bridge recovered with Telegram active and an empty queue. The subsequent activation script uses checked subprocess calls and refuses a busy restart.

Detached verification job: `1790461355-jev-shadow-verify-73eee045`. It checks the real shipped CPU judge, private blind-view plumbing, bridge health, and continued Qwen/nomic GPU residency. Its synthetic case lives in a temporary directory, excluded from production collection. No independent human labels are fabricated. Check the job result before claiming live validation passed.

Operational units are copied under `deployment/`; `verify-shadow.py` is an activation/verification script and refuses to overwrite an existing drop-in. Rollback can disable the CPU unit and set `FRANK_JEV=0` in the dedicated bridge override; do not re-enable the legacy GPU timer as part of shadow-only operation. Pending scores now have a bounded retry timer (see reliability update below); no automated human review or promotion is enabled.

### Live verification result

Job `1790461355-jev-shadow-verify-73eee045` completed with exit 0. The shipped head completed two CPU forwards through the real `/judge` endpoint. Synthetic queue: one case, one prediction, zero independent declarations. Evidence: `/tmp/frank-shadow-deploy-smoke-kj22wwr1/deployment-result.json` (temporary runtime artifact). Jev health: CPU loaded, no errors, no restore pending, maintenance flag false. Bridge: healthy, Telegram active, empty queue. Ollama retained Qwen at 17,399,734,598 VRAM bytes and nomic at 323,150,151 bytes, matching pre-deployment residency. Production queue remains empty and will fill from future eligible complete races; no historical decisions were imported or independently labeled automatically.

## Harness reliability update — 2026-09-26

Reviewed bounded bridge logs and CPU service logs without printing message/tool content. Since the then-current bridge deployment, zero error events and zero shadow cases were observed. Older log events included hemisphere failures and the superseded typed-verdict hook; they were not attributed to the new deployment. CPU service and bridge had zero systemd restarts. The CPU startup warning about disabled CUDA autocast is expected with CUDA hidden; live CPU judgment was already verified.

Added a shared `flock` around shadow inference so the online collector and scheduled worker cannot race. The helper exits on pipe EOF and releases its OS lock if the caller dies; no stale PID lease must be deleted. Completed prediction IDs are checked again under lock. Added a content-free `diagnostics` CLI command with pending count and oldest age. The worker logs only bounded status/counts, never task text or raw model errors, and does not load models, evict Ollama, send messages, submit ledger events, or create labels.

Installed/enabled `jev-shadow-drain.timer` and `.service`; the first production drain completed idle. Tests: 50 focused tests passed, including overlapping process lock refusal, recovery after request failure, diagnostics privacy, existing blind labeling, and shadow isolation. TypeScript build passed. Existing timeout increases in harness/server/shadow files were preserved as separate worktree changes rather than incorporated into this commit. The runtime uses those existing values; the worker requests a four-minute timeout, subject to the collector's configured limit.

Live worker smoke passed: a separately persisted synthetic case in `/tmp/shadow-worker-live-smoke-yl1w8881` was drained by the standalone worker against the CPU service; one prediction, zero pending, zero independent declarations. Production queue remained empty. Bridge and CPU service remained healthy and the production timer recorded a successful idle run.

## 2026-10-24 — advisory drain retired (Tripp: "retire it")

The advisory shadow path was superseded on 2026-10-10 when Jev became the live answer selector (every round's verdict is now
recorded through the delivery-gate path and chained by `jev-shadow-chain.timer`). `jev-shadow-drain.service` had been failed
since 2026-09-28: its timer was never enabled, and the advisory branch of `evaluateShadow` (shadow-review.ts) still requires
a CPU-loaded model, which the GPU-swap service on :30110 never reports. Retired rather than fixed:
- `jev-shadow-drain.timer` and `.service` disabled and removed from `~/.config/systemd/user` (copies remain in `deployment/` as history).
- 18 pre-live advisory cases (2026-09-28 … 2026-10-10, never judged) moved to the trash; manifest with sha256 per case at
  `~/.config/lifecoin/changes/20261024-shadow-drain-retired-cases.json`. Live-era cases without a prediction (judge abstained; selection recorded) were left in place.
- `jev-shadow-cpu.service` (already disabled since 2026-10-04) and `src/cli/shadow-worker.ts` untouched; the worker is now dead code.
- Unchanged: `jev-shadow-chain.timer`, the delivery-gate path, labels, ledger chaining.
