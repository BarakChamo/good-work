# Agent workflows

Install the canonical skill with `work skill install`. Commit the generated
`.agents/skills/work` and `.claude/skills/work` directories so every session
receives the same operating contract.

## Start

- `$work` in Codex or `/work` in Claude is read-only and presents current work.
- `$work ISSUE-123` prepares and validates without claiming.
- `$work start ISSUE-123` authorizes claim and execution.
- The skill generates one collision-resistant actor for that session and uses a
  real runtime session ID only when the runtime supplies it unambiguously.
- The caller follows the CLI's `nextActions`. A worktree or container is created
  by the surrounding runtime, not Work.

## Finish

For ledger-enabled delivery, the agent:

1. satisfies acceptance and runs the repository-owned checks;
2. commits implementation and evidence;
3. when configured, runs `work review prepare` and pauses source edits while a
   distinct reviewer operates sequentially in the same worktree;
4. runs `work review status` after the reviewer returns and trusts only a
   structured `approved` or `changes_requested` result with a receipt;
5. ensures the review report and receipt are committed after approval—without a
   duplicate commit if the reviewer already committed only those artifacts—or
   preserves and reads requested changes, commits the decision when needed,
   fixes them, and repeats review without reopening the issue;
6. runs `work finalize` and commits the one completion record;
7. reruns applicable checks and runs `work submit`;
8. uses the repository's external CI/merge flow;
9. returns to the claimed worktree and runs `work reconcile`;
10. cleans up only after the terminal action says cleanup is eligible.

An agent statement that work is done is not completion evidence.

## Independent review

Enable the gate with `terminalEvidence: [artifact, review]` (or the project's
chosen evidence kinds). The implementation owner calls:

```sh
work review prepare ISSUE-123 --actor <implementation-actor> --json
```

The surrounding runtime or human operator creates the reviewer. Work only
returns the exact tree, issue source, acceptance criteria, report path, and
semantic next action. A reviewer must use a different actor, may share the same
runtime session, and must not modify source. The prepared head stays immutable:
the reviewer must not commit, amend, switch revisions, or substitute a later
HEAD before recording the decision. It writes `docs/work/reviews/ISSUE-123.md`
without committing it, then records one decision:

The reviewer uses the supplied packet and does not rerun `review prepare` or use
Git mutations before deciding. If an abandoned report already exists, inspect
and overwrite it in place; do not move or discard it. After the decision, the
reviewer may commit exactly the canonical report and receipt when repository
policy permits, then recheck `review status`; otherwise the implementation agent
commits them. The implementation agent must tolerate either case, verify that an
existing review-artifact commit contains no unrelated files, and never create an
empty duplicate commit.

```sh
work review approve ISSUE-123 --actor <reviewer> --evaluator agent \
  --report docs/work/reviews/ISSUE-123.md --head <prepared-head> --json
work review request-changes ISSUE-123 --actor <reviewer> --evaluator agent \
  --report docs/work/reviews/ISSUE-123.md --head <prepared-head> --json
```

The first decision for an exact head wins. Self-review and conflicting decisions
fail without replacing the receipt. Any later source change makes approval stale;
the implementer commits the fix and prepares a fresh review. Once completion is
recorded, the report digest and receipt are historical evidence: unrelated later
commits, squash integration, a fresh clone, or deleted local Beads state do not
invalidate them.

Both reviewer and implementation owner run `work review status ISSUE-123
--json` after the decision attempt. `pending` means the reviewer never recorded
a decision. `incomplete` identifies whether the provider record or repository
receipt is missing and returns the surviving decision; repeat that exact
`approve` or `request-changes` command with the same reviewer identity to repair
the interrupted half. `stale` requires a fresh implementation review. Never
discard a changes-requested report or infer approval from an agent message.

## Handoff and recovery

Use `work handoff --summary-file <path>` for a bounded repository-relative
summary of completed work, remaining work, and durable references. Do not store
a transcript. A successor uses `work show`, then `work resume` with its own
actor/session.

Claims are never stolen because activity looks old. Use the explicit release,
reopen, or authorized recovery route after inspecting the typed conflict.

## Parallel sessions

- Prepare every candidate before starting it.
- Give every worker a unique actor.
- Use separate worktrees or containers when policy requires isolation.
- Avoid workstreams that own the same unsettled files or contracts.
- Let bounded provider locks finish; do not bypass them with direct Beads edits.
- Use the integration mutex before participating local workers advance the same
  target. It coordinates only Work-aware local sessions; it is not a Git lock.
- Reconcile each item from its original claimed worktree after landing.

Definitions and completion records are safely shared through Git. Live claims,
telemetry, feedback, and hook trust remain local and disposable.
