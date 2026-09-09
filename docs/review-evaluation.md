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
