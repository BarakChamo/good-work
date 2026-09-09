# Independent-review evaluation

The review gate is tested at three levels.

## Deterministic gates

Unit and real-provider suites cover exact clean-tree preparation, distinct
reviewers, self-review rejection, first-decision-wins behavior, requested-change
iterations, stale approvals, report and receipt containment, provider metadata,
finalization refusal, candidate-bound review gates, repository recovery, and the
unchanged non-review lifecycle.

## Packed cross-runtime pilot

Run the bounded local-account evaluation explicitly:

```sh
bun run eval:review:live -- --confirm-live \
  --codex-model=gpt-5.6-sol \
  --claude-model=sonnet \
  --effort=medium
```

It packs and installs the candidate, creates two fresh Git fixtures, installs the
skill, and runs both directions:

1. Codex implements and Claude reviews.
2. Claude implements and Codex reviews.

The implementation runtime must stop at `review prepare`. The fresh reviewer
must use a distinct actor in the same worktree, leave the implementation head
unchanged, write the canonical report, and approve that exact head. The
controller then proves finalization, review evidence, submission,
reconciliation, telemetry, and terminal closure. Each agent process has a
three-minute timeout; Claude has a USD 1 cap per invocation. Raw streams are
private, ignored artifacts under `artifacts/work-review-evals/<run-id>`.

Passing requires both directions to close with the expected implementation and
reviewer attribution, current review evidence, and a sanitized command timeline.
The live pilot does not claim to measure review quality statistically. A seeded-
defect benchmark comparing zero-review and independent-review flows is a later
research evaluation, not a release correctness gate.

## 2026-09-09 release-candidate result

The packed source candidate at `071bff0` passed both directions with no runtime
warnings:

| Implementer | Reviewer | Implementation | Review | Outcome |
|---|---|---:|---:|---|
| Codex | Claude | 136.368 s | 46.554 s | Exact head approved; terminally closed |
| Claude | Codex | 71.789 s | 160.119 s | Exact head approved; terminally closed |

Both implementers stopped after `review prepare`. Each fresh reviewer used a
distinct actor, left the implementation head unchanged, independently ran the
focused test, wrote the canonical report, and recorded approval. Controller
steps then committed review evidence, finalized, submitted, reconciled, and
verified terminal review attribution plus sanitized `review.*` telemetry.

The campaign exposed two pre-release gaps that were corrected before this
result: review routes were initially missing from the telemetry allowlist, and
the Claude fixture initially composed a test command with an unapproved pipe.
The driver now reports harmless runtime permission warnings separately and
classifies a denial as runtime failure only when it prevents the required
repository state.

The deterministic release gate passed 648 unit/contract tests, 41 real Git and
Beads integration tests, packed-consumer checks, dual-plugin validation, and
the installed-product portability smoke. These results establish workflow
conformance and recovery safety, not comparative defect-detection efficacy.

## 2026-09-09 interruption and revision campaign

Run `2da8d2dc-407f-41d9-b496-625becbe3e87` exercised six additional packed,
fresh-process scenarios:

| Scenario | Runtime direction | Durable result |
|---|---|---|
| Abandoned report recovery | Codex reviewer | Approved receipt recovered |
| Abandoned report recovery | Claude reviewer | Approved receipt recovered |
| Provider decision with missing receipt | Codex reviewer | Byte-identical receipt restored |
| Provider decision with missing receipt | Claude reviewer | Byte-identical receipt restored |
| Requested changes and revision | Codex implementer → Claude reviewer | Changes preserved; revised head approved |
| Requested changes and revision | Claude implementer → Codex reviewer | Changes preserved; revised head approved |

All six passed the state oracle. Fresh implementation sessions recovered
requested changes from the committed report without transcript inheritance. No
review was accepted from prose alone, no decision was overwritten, and
finalization was attempted only after `review status` returned a disposition and
receipt.

The campaign found one correctness gap: when exactly one of the provider review
record or repository receipt survived, `review status` previously returned
`pending`. That hid recoverable decision metadata and could lead a new reviewer
to conflict with the first decision. The service now returns `incomplete`, names
the missing layer, preserves the surviving decision, blocks finalization, and
supports an idempotent retry with the same reviewer identity and inputs. Unit
tests cover both missing layers; the real Beads/Git suite covers a missing
repository receipt after the report has been committed.

The initial live run also exposed an instruction mismatch. Codex left review
artifacts for the implementation owner, while Claude commonly followed the
CLI's old `commit_review_receipt` action and committed the report and receipt itself.
The safe invariant is the reviewed implementation head, not which external
actor commits the two evidence files. The final contract therefore requires the
prepared head to remain unchanged until the decision is recorded, permits a
reviewer to commit only the canonical report and receipt afterward when
repository policy allows it, and requires a final status check. The parent
accepts either committed or uncommitted review artifacts without creating an
empty duplicate commit. Any implementation or unrelated change still makes the
review stale and blocks finalization.

A focused Claude follow-up (`0c56fc5f-3fd6-462f-aa38-c09bbad13cd3`) reran an
abandoned-report recovery and a complete changes-requested round trip against a
freshly packed skill. Both passed. Claude recorded every decision against the
controller-provided implementation head and verified the durable status; its
post-decision review-only commits remained within the supported boundary. The
raw local streams are ignored private artifacts and are not release assets.

An independent code review then found that the structured continuation still
encoded the old ambiguity. Review decisions now return
`ensure_review_evidence_committed`, followed by the mandatory
`verify_review_status`, before rework or finalization. “Ensure” is intentionally
idempotent: the caller commits the two files only when they are not already in a
review-only commit.

The same review found two additional interrupted-re-review edges. A fresh
provider decision could be hidden by a stale receipt from a previous owner or
definition, and the two recovery paths did not repeat the normal path's
post-persistence freshness check. Status now selects the current surviving
decision, reports the other layer as missing, and permits that exact decision to
replace an obsolete receipt. Every recording path revalidates after its final
write, so a concurrent source or report change returns `review_target_stale`
rather than a false success. Regression tests cover prior-owner receipts and a
source change during provider recovery.

Final candidate run `4534cf8d-6b2c-4b34-840e-f4ebae743b24` strengthened the
live oracle. Each reviewer received the complete prepared packet and had to
record a decision, run `review status` after that decision, and avoid rerunning
`review prepare`. Both Codex-to-Claude and Claude-to-Codex directions passed,
closed terminally, and produced no runtime warnings. The implement/review times
were 141.139/37.277 seconds and 44.187/175.723 seconds respectively. The full
candidate release gate passed 650 deterministic tests, 41 real Git/Beads tests,
27 eval-driver tests, both plugin validators, packed installation, package
allowlist inspection, and the Darwin arm64 portability smoke.
