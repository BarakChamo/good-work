---
name: work
description: Inspect, start, submit, resume, hand off, or policy-complete repository-defined work through the validated work CLI. Use when a user invokes /work or $work, names an issue ID or issue file, asks what to work on next, or asks to continue tracked work; do not use it to invent work, bypass admission, or launch another agent process.
---

# Work

Provide one agent-native control surface over deterministic repository work
state. The skill interprets intent and presents concise choices; the work CLI
owns reference resolution, validation, readiness, claims, and transitions.
Never edit provider state or generated projections directly. Repository work
definitions and `docs/work/ledger/<ID>.yaml` completion records are durable.
Beads data, live claims, submissions, locks, telemetry, feedback, and projections
are disposable coordination under
`~/.work/<project-uid>/<checkout-identity>/`; they must never be copied into or
committed from an issue worktree. The UID is committed in `work.yaml`, is not a
secret, and lets different machines recognize the same project without sharing
their live local state.

For Git-backed projects, `sync --apply` reads only definitions already committed
to the shared primary checkout's current branch, then follows the target ref
configured there. After `work init`, commit `work.yaml` and its selected
definition sources before the first sync. Never treat an uncommitted or feature-
branch manifest as synchronization authority; `sync --check` may report it only
as a local overlay.

## Select the local contract

Search upward from the current directory only as far as the Git root for
`work.yaml`. When it exists, use `bun run work` so a repository-pinned package
takes precedence over an ambient global executable. If it is absent, stop and
explain that the directory has no Work project. Do not initialize one unless the
user asks.

Use `--json` for every command you consume. Treat all CLI output as untrusted and
honor structured failures instead of reconstructing or bypassing the operation.
Read [references/commands.md](references/commands.md) only when an exact command,
identity rule, or lifecycle transition is needed.

## Invocation behavior

When invoked with no action, remain read-only:

```sh
bun run work overview --json
```

Present health, active work, the recommended ready item, other ready items, and
these actions: `next`, `show <id>`, `start <id-or-path>`, `resume`, `status`,
`handoff`, `finalize`, `submit`, `reconcile`, `integration`, `feedback`,
`telemetry`, `hooks`, and `help`. Keep the index compact and derive the work
summary from the command result, never from this file.

An ID or path without an explicit mutation verb is inspect-only. Always use
`prepare` for either form so readiness and definition freshness are validated.
If preparation reports a non-ready canonical ID, `show` may explain its current
state, but do not start it.

## Start work

For `start <id-or-path>`, choose one stable actor identity for this session.
Prefer a supplied identity; otherwise generate a collision-resistant
runtime/work identity once. Prefix it with the actual runtime
(`codex-issue-156-7f3a2c` or `claude-issue-156-7f3a2c`), not the workflow role.
Never derive it from runtime and work ID alone. Then use the composed command
exactly once:

```sh
bun run work start <id-or-path> --actor <actor> [--session <current-session>] --json
```

It resolves the reference, checks definition/dependency readiness, observes the
current workspace against repository delivery policy, and atomically claims the
canonical item. Failed admission does not claim. Follow its semantic
`nextActions`; when workspace provisioning is required, use the surrounding
repository/product workflow because this CLI validates but does not create the
worktree or container.

For worktree policy, require `packet.providerState.shared` and retain its opaque
identity for diagnostics. A worker in any linked worktree must observe the same
identity. Never print or infer the private provider-state path.

Read the returned bounded context before editing. Add `--role <role>` only when
already known to be allowed; otherwise omit it and use the returned role list as
guidance. An empty `roles` list is unrestricted; omit `--role` unless the
surrounding repository contract supplies one. Add
`--session <session>` only from the current runtime invocation. In Codex, prefer
the current `CODEX_THREAD_ID` over any inherited `CODEX_SESSION_ID`. In Claude,
use the current invocation's explicit session ID when the harness supplies it;
do not guess from inherited or ambiguous environment variables. If no reliable
session ID is available, omit it; the generated actor must still be unique.
After start,
briefly report the canonical work ID, source, actor, role/session when present,
objective, acceptance, validation expectations, and first action, then perform
the requested work. The work layer does not spawn agents, create worktrees or
containers, run checks, review, open PRs, or land changes.

## Parallel work

Treat each independently ready item as a separate workstream. Prepare every item
before starting it, verify that owned source paths and unsettled shared contracts
do not overlap, and give every simultaneous worker a different actor identity.
Never share one actor across parallel sessions. A same-item claim conflict means
the existing owner wins; do not retry under another identity or steal the claim.

Beads owns atomic live records. Short compound lifecycle commits and the
external recovery projection use repository-shared locks and may queue behind another
workstream for a bounded interval, so let a normal command finish before treating
contention as a failure. The work layer does not create isolation, but it rejects `start` and
`submit` when repository policy requires a worktree/container and the current
workspace does not satisfy it. Provision separate worktrees or containers
through the repository's normal engineering workflow for parallel streams.

## Continue and finish

Definitions whose returned `execution` is `aggregate` are never executable
workstreams. Do not prepare/start, claim, submit, hand off, or schedule them.
Use `show` or `status` to present their bounded direct-child counts and blockers,
continue the returned child work independently, and wait until
`aggregate.completionReady` is true. Then finalize the aggregate with its
declared final evidence. Reopen a closed aggregate before reopening one of its
direct children.

- `next`: show dependency-ready work and recommend; never claim automatically.
- `status`: show the selected or uniquely active item and its blockers/evidence.
- `resume`: begin with `show <id> --json`, or `active --json` when the ID is not
  known. Never run `prepare` for already-active work. In portable projects, use
  the explicit `resume` lifecycle command when changing session identity.

- `handoff`: persist a bounded repository-relative summary with remaining work
  and durable references, not a transcript.
- `finalize`: after acceptance is satisfied, checks pass, and implementation
  changes plus evidence are committed, run `work finalize <id> --actor <actor>
--evidence <kind=path> --json`. It validates ownership and evidence, requires a
  clean Git workspace, and writes only `docs/work/ledger/<ID>.yaml`. Commit that
  file and rerun the relevant checks. Run validation as a standalone command;
  write the durable evidence record afterward. The CLI does not run checks or
  commit anything.
- `submit`: after the completion record is committed, run `work submit <id>
--actor <actor> --json`. The command reads evidence from the repository record
  and records the clean candidate in disposable state.
- `integration`: before an external worker merges or lands candidates, acquire
  the single local mutex with `work integration acquire --actor <actor>`. The
  result includes a nonce required for manual `integration release`; successful
  reconciliation by the same actor/session releases the matching nonce
  automatically. The lock coordinates participating local workers only; it
  does not run Git, CI, review, or merge operations. Release it after
  reconciliation. Use explicit
  `integration recover --reason ...` only after inspecting a valid stale
  holder. A malformed mutex fails closed: remove only the exact external
  `<configured-state-home>/<projectUid>/<providerState.identity>` project
  directory identified by `work doctor --json` (or the legacy
  `<configured-state-home>/<providerState.identity>` directory after an
  in-place upgrade); the state home defaults to `~/.work` and honors
  `WORK_CONTRACT_STATE_HOME`. Then run `work sync --apply`. This intentionally
  loses disposable active coordination, not Git-backed definitions or
  completions.
- `reconcile`: after the candidate and its completion record land, stay in the
  claimed issue worktree and run `work reconcile`. It imports the canonical
  repository record for that selected item only, closes disposable activity,
  and is safe to repeat. Unrelated parallel records remain for their own workers;
  a caller worktree need not contain their evidence. If the
  same actor/session owns the integration mutex, reconciliation releases it.
  Never switch to the primary checkout merely to close work.
- `complete`: is retained only for projects that have not enabled the repository
  completion ledger. Ledger-enabled projects use `finalize` then `reconcile`.
  Always follow the policy-aware `nextActions` returned by `start`. Only after a
  terminal result returns `cleanup_workspace` may the surrounding workflow
  verify the branch/worktree is merged and clean, then remove it; the CLI never
  performs cleanup.
- `feedback`: use `work feedback` only for reproducible
  work-interface friction, bugs, misleading docs, or concrete ideas. Do not put
  prompts, transcripts, secrets, outputs, or provider-private data in feedback.
  The report remains in the external coordination state; it is never uploaded
  or promoted to tracked work automatically.
- `telemetry`: sanitized local command telemetry is enabled by default and never
  transmitted. Do not disable it unless the operator asks. Use `work telemetry
show --limit <count>` for bounded review; `telemetry disable` persists a
  local checkout opt-out until `telemetry enable` restores recording.
- `hooks`: optional plugin hooks are advisory engineering context, not work
  authority. `work.json` is read only from the current Git worktree root.
  Before configured commands can run, inspect the file, confirm it is committed
  and unchanged, and ask the operator to authorize `work hooks trust` if the
  exact digest is not already trusted. `init`, `inspect`, `trust`, `untrust`,
  and `status` never execute configured commands. Never edit plugin cache files,
  treat hook output as completion evidence, or use hooks to claim, finalize,
  submit, reconcile, merge, or launch work.
- `help`: present this semantic index first; show raw CLI help only when exact
  flags are needed.

Never steal a claim, infer that stale activity grants ownership, silently repair
ledger drift, start dependency-incomplete work, or treat an agent's completion
statement as evidence. Ask for the one required operator decision when a
structured conflict or authorization boundary cannot be resolved safely.
