---
name: work-contract
description: Coordinate repository-defined work across humans, agents, and sessions through the work CLI when a project contains work.yaml. Use it for readiness, bounded context, claims, handoffs, evidence, approved planning changes, and material dogfood feedback; do not use it to launch agents, create worktrees, run tests, or replace repository instructions.
---

# Work Contract

Use `work` as the only interface to the operational work ledger. Markdown files matched by `work.yaml` own definitions; Beads owns status, claims, activity, handoffs, evidence, and history. Never edit `.beads`, `.work/lock.json`, or `.work/snapshots/current.json` directly.

Install the packaged skill with `work skill install`. The canonical skill is now
named `work` and is installed into `.agents/skills/work` for Codex/Agent Skills
clients and `.claude/skills/work` for Claude Code. Installation is idempotent,
preflights every target, and preserves locally modified copies unless `--force`
is explicit. In consuming repositories, use `bun run work`;
there is no separate repository-private command vocabulary.

Before implementation:

1. Run `work doctor`, then `work sync --check`.
2. Inspect `work ready --role <role>` or the assigned item with `work show <id>`.
3. Load a bounded packet with `work context <id>`.
4. Claim atomically with `work claim <id> --actor <stable-name> --role <role> --session <session-id>`.

`claim` establishes actor ownership plus optional role/session context. Every
actor-owned command (`touch`, `resume`, `handoff`, `block`, `release`, `reopen`,
and `complete`) accepts optional `--role` and `--session` assertions. Supply both
when the active claim has them: a mismatch fails before mutation with
`role_conflict` or `session_conflict`. Omission remains compatible with legacy
items. The one exception is `resume --session`: it deliberately replaces the
session while `--role` remains an assertion against the active claim.

During work, use `work touch` with the claiming role/session after meaningful
progress. Treat stale activity as advisory; never take another actor's claim
without an authorized release. Use `work block` only for a concrete impediment
and include the reason. `release` and `reopen` clear activity because ownership
ends; a later claim establishes fresh context.

At a session boundary, write the summary to a repository-relative file and run `work handoff --summary-file`. Include remaining work and durable references, not transcripts. Add `--release` only when another actor may continue.

Before completion, run the repository-prescribed checks yourself. Record each
durable result with `work complete --actor <actor> --role <role> --session
<session> --evidence kind=repo-relative-path`. External HTTPS evidence
additionally needs `--evidence-digest kind=<lowercase-sha256>`. The CLI verifies
evidence; it does not run validation. Successful completion retains the final
actor, role, and session on the closed item for auditability.

For changes to work definitions, create `.work/proposals/<ID>/proposal.yaml`, validate it, inspect the exact file/hash plan, and apply it. Deletion always requires explicit `--allow-delete`. After definition changes, run `work sync --plan` and let a human or authorized workflow choose `work sync --apply`.

## Dogfood feedback

When the CLI, skill, context packet, or coordination model causes material friction, a reproducible bug, misleading documentation, or a concrete product idea, capture it before leaving the session:

```sh
work feedback --kind friction --message "<concise observation>" \
  --work-id <id> --actor <stable-name> --session <session-id>
```

Do not report routine task difficulty, normal review churn, or vague preferences. Never put secrets, prompts, transcripts, command output, or private provider data in feedback. The report stays under `.work/feedback` for human triage and does not change work status.

Telemetry is separate and opt-in. Do not enable or disable it unless the
operator asks. When enabled, commands automatically append only sanitized
route/outcome/duration, parser failure stage, keyed work/actor/role/session
correlations, an optional HMAC run correlation from `WORK_CONTRACT_RUN_ID`, and
a numeric context budget. Use `work telemetry sessions --limit 20` to index
sessions and `work telemetry show --limit 50` to inspect events;
original identifiers, invalid flags/routes, free-form inputs, paths, error text,
and command output must never appear there. An invalid run ID causes only a
sanitized warning and never changes the command result.

Prefer `--json` for automation. On ownership conflicts, stale plans, missing evidence, unsafe paths, or ledger drift, stop and report the structured error rather than bypassing the contract.
