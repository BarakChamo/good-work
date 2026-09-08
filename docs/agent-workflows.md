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
3. runs `work finalize` and commits the one completion record;
4. reruns applicable checks and runs `work submit`;
5. uses the repository's external review/CI/merge flow;
6. returns to the claimed worktree and runs `work reconcile`;
7. cleans up only after the terminal action says cleanup is eligible.

An agent statement that work is done is not completion evidence.

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
