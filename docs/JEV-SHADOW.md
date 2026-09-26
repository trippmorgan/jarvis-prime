# Advisory Jev reviewer and independent decision collection

State: implemented and tested, 2026-09-26. This checkout contains unrelated work in progress. No production restart, model load, ledger submission, or head promotion was performed by this change. At inspection, port 30110 was unavailable and the new queue contained zero cases and zero independently declared human reviews.

## Behavior

When a natural-language harness race has both answers and cross-review is enabled, the processor saves a private case and starts a best-effort shadow request. Clinical override traffic is excluded. Normal-path classification is not a PHI detector; keep PHI in the clinical pipeline. Requests accept only a loopback HTTP service, forbid redirects, preflight an already-loaded CPU model, explicitly request `head: shipped`, and reject missing/non-shipped head provenance or invalid probabilities. The collector never calls load/unload or changes GPU leases.

Jev is no longer awaited by narrative review, included in Telegram summaries, a delivery trigger, or a fifth ledger process. Existing narrative/conscience records continue. No Phi, routing, training, or safety decisions consume the shadow score. Ties remain ties. There is one online request in flight per process; busy/unavailable cases stay pending on disk. Pending work needs an explicit `drain` batch; there is no retry daemon. Do not run multiple drain workers alongside online collection. CPU availability is checked before inference, not an atomic reservation against an administrator changing service devices.

Storage defaults to `~/.local/state/frank-shadow` (`FRANK_SHADOW_DIR` overrides). Directories use 0700 and files 0600. Cases include full local task, answers, and tool evidence; predictions and labels are separate. Do not put this directory in Git or publish its contents. The existing service logs input/model hashes separately. Jev receives at most 3000 task characters and 6000 per answer plus truncation markers; the stored prediction records this policy. Tool evidence is available to the human but is not included in the model's current judge input. Comparisons must account for this information difference.

Existing `FRANK_JEV=0` disables collection; `FRANK_JEV_URL` defaults to `http://127.0.0.1:30110`; cross-review and harness-race switches also apply. Reloading the application is required to activate new source code. Starting/loading the Jev CPU service is a separate operational step. Collection can operate without it; scores will remain pending.

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

Next operational step: resolve the existing routing failures and deploy the reviewed application changes; start a CPU-resident shipped-head service, collect a small batch, then have an unexposed independent human review it. Compare shadow scores with those labels on scenario-separated holdouts before any promotion or Phi/LifeCoin integration.
