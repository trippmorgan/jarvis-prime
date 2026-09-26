# Advisory Jev reviewer and independent decision collection

State: deployed and live-verified, 2026-09-26. Jev is CPU-resident on port 30110; the bridge has shadow collection explicitly enabled. Live smoke validation passed with the shipped head. Production collection currently has zero cases and zero independent human reviews; synthetic validation data is isolated. No new shadow ledger submission or head promotion was performed. This checkout retains unrelated work in progress.

## Behavior

When a natural-language harness race has both answers and cross-review is enabled, the processor saves a private case and starts a best-effort shadow request. Clinical override traffic is excluded. Normal-path classification is not a PHI detector; keep PHI in the clinical pipeline. Requests accept only a loopback HTTP service, forbid redirects, preflight an already-loaded CPU model, explicitly request `head: shipped`, and reject missing/non-shipped head provenance or invalid probabilities. The collector never calls load/unload or changes GPU leases.

Jev is no longer awaited by narrative review, included in Telegram summaries, a delivery trigger, or a fifth ledger process. Existing narrative/conscience records continue. No Phi, routing, training, or safety decisions consume the shadow score. Ties remain ties. There is one online request in flight per process; busy/unavailable cases stay pending on disk. Pending work needs an explicit `drain` batch; there is no retry daemon. Do not run multiple drain workers alongside online collection. CPU availability is checked before inference, not an atomic reservation against an administrator changing service devices.

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

Operational units are copied under `deployment/`; `verify-shadow.py` is an activation/verification script and refuses to overwrite an existing drop-in. Rollback can disable the CPU unit and set `FRANK_JEV=0` in the dedicated bridge override; do not re-enable the legacy GPU timer as part of shadow-only operation. Pending scored work remains manual (`drain`); no automated human review or promotion is enabled.

### Live verification result

Job `1790461355-jev-shadow-verify-73eee045` completed with exit 0. The shipped head completed two CPU forwards through the real `/judge` endpoint. Synthetic queue: one case, one prediction, zero independent declarations. Evidence: `/tmp/frank-shadow-deploy-smoke-kj22wwr1/deployment-result.json` (temporary runtime artifact). Jev health: CPU loaded, no errors, no restore pending, maintenance flag false. Bridge: healthy, Telegram active, empty queue. Ollama retained Qwen at 17,399,734,598 VRAM bytes and nomic at 323,150,151 bytes, matching pre-deployment residency. Production queue remains empty and will fill from future eligible complete races; no historical decisions were imported or independently labeled automatically.
