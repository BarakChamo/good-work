# Work Command Reference

Load this reference only when executing a lifecycle action. Use `--json` for
agent-consumed commands and honor structured errors without fallback mutation.

| Intent             | Command                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Index              | `bun run work overview --json`                                                                                                               |
| Prepare            | `bun run work prepare <id-or-path> --json`                                                                                                   |
| Inspect            | `bun run work show <id> --json`                                                                                                              |
| Aggregate progress | `bun run work status <id> --json`; operate returned direct children, never start the aggregate                                               |
| Start              | `bun run work start <id-or-path> --actor <actor> [--role <role>] [--session <current-session>] --json`                                       |
| Resume             | `bun run work show <id> --json`, then `resume <id> --actor <actor> [--role <role>] [--session <current-session>] --json`                     |
| Prepare review     | `bun run work review prepare <id> --actor <implementation-actor> [--role <role>] [--session <session>] --json`                              |
| Review decision    | `bun run work review <approve\|request-changes> <id> --actor <reviewer> [--session <session>] --evaluator <agent\|human> --report docs/work/reviews/<id>.md --head <prepared-head> --json` |
| Review status      | `bun run work review status <id> --json`                                                                                                      |
| Finalize           | `bun run work finalize <id> --actor <actor> [--role <role>] [--session <session>] --evidence <kind=path> --json`                             |
| Submit             | `bun run work submit <id> --actor <actor> [--role <role>] [--session <session>] --json`; reads finalized evidence from the repository record |
| Integration mutex  | `bun run work integration acquire --actor <actor> [--session <session>] --json`; retain the nonce for manual release                         |
| Reconcile          | `bun run work reconcile <id> --actor <actor> [--role <role>] [--session <session>] --json`                                                   |
| Reopen             | `bun run work reopen <id> --actor <actor> --reason <reason> --json`                                                                          |
| Recovery export    | `bun run work export --json`                                                                                                                 |
| Telemetry sessions | `bun run work telemetry sessions --limit <count> --json`                                                                                     |
| Telemetry review   | `bun run work telemetry show [--session-id <id> | --session-correlation <digest>] [--work-id <id>] --limit <count> --json`                   |
| Hook setup         | `bun run work hooks init`, commit `work.json`, inspect it, then run `bun run work hooks trust`                                               |
| Hook health        | `bun run work hooks status --json`                                                                                                           |

For Git-backed projects, commit `work.yaml` and every selected definition source
to the shared primary checkout's current branch before the first `sync --apply`.
Synchronization never falls back to uncommitted or feature-branch definitions;
`sync --check` reports those only as diagnostic overlays.

Preparation is always read-only. `start` composes prepare, delivery admission,
and canonical claim atomically from the caller's perspective. Follow returned
`nextActions`; never pass a path to later lifecycle mutations.

Sanitized local telemetry is enabled by default and never transmitted. It and
all other active coordination live under
`~/.work/<project-uid>/<checkout-identity>/`. The committed UID groups the
project across machines; the local checkout identity keeps separate clones
isolated while linked worktrees share state. Existing pre-UID stores retain
their legacy location during upgrade. An explicit `telemetry disable` persists
the local repository opt-out until `telemetry enable` restores recording.
Inspection commands are read-only. Use `telemetry sessions` to find an HMAC
correlation, then `telemetry show` to inspect its sanitized Work-command
timeline. A known raw session or work ID is hashed locally and never returned.
`WORK_SESSION_ID`, `CODEX_THREAD_ID`, and `CLAUDE_CODE_SESSION_ID` automatically
attribute commands that lack a lifecycle `--session`, with `CODEX_SESSION_ID` as
a final fallback. This timeline is not an agent transcript.

For a new worker, reuse an operator-supplied actor or generate one
collision-resistant actor once per session, combining runtime, work ID, and a
random suffix. Never use the same actor concurrently. In portable projects,
add `--role <role>` only when preparation returns allowed roles; an empty role
list is unrestricted. Add `--session <session>` only when it is bound to the
current invocation: Codex uses `CODEX_THREAD_ID` before any inherited
`CODEX_SESSION_ID`; Claude uses an explicit current-invocation session ID and
must not guess from ambiguous environment state. `claim` establishes these optional values and actor-owned
commands may assert them. `resume --session` replaces the session while asserting
the role when one is established. Release and reopen clear ownership; completion
retains final attribution.

For parallel work, start only distinct dependency-ready items whose
implementation scopes can be isolated. Normal
simultaneous lifecycle commits queue briefly; a bounded `provider_busy` or
projection failure means contention did not clear and must not be bypassed. The
same-item race still has one winner. Git branches/worktrees and containers are
provisioned by the surrounding workflow; the CLI observes and enforces the
declared isolation before claim and submission.

When an item requires review, `start` returns `prepare_review` instead of
`finalize`. Commit implementation and evidence, prepare the exact review packet,
then ask the runtime or operator to run a distinct reviewer sequentially in the
same worktree. The reviewer writes only an uncommitted
`docs/work/reviews/<ID>.md`, keeps the prepared HEAD unchanged until it records
the decision against that exact SHA, and lets the CLI write the YAML receipt.
The prepared packet is sufficient: the reviewer never reruns `review prepare`
or runs Git mutations before deciding. An abandoned report is inspected and
overwritten in place, not discarded or moved. After deciding, the reviewer may
commit exactly the report and receipt when repository policy permits, then must
verify `review status` again; otherwise the parent commits them. A change request
keeps the original claim active and
requires a new implementation commit and review. Commit an approval report and
receipt before finalization; `finalize` adds the verified review evidence
automatically. Work records review but never launches the reviewer.
Follow `ensure_review_evidence_committed` and `verify_review_status` before the
returned rework or finalization action.
Both reviewer and parent must verify `review status` after the reviewer returns.
Only `approved` or `changes_requested` with a receipt is a complete handoff.
Retry an `incomplete` decision with the exact same reviewer identity and inputs;
route `pending` through another reviewer and `stale` through a fresh prepare.

Use `touch` after meaningful progress, `block` only for a concrete impediment,
and `handoff --summary-file <repo-relative-path>` for durable cross-session
continuity. Summaries contain remaining work and durable references, not
transcripts. Checks, Git mutation, worktree/container creation, review, and
landing remain the agent or surrounding product's responsibility. `finalize`
writes the selected repository completion record; commit it before `submit`.
After integration, run `reconcile` from the same claimed worktree; it imports
only that item's canonical record, closes idempotently, and returns cleanup
guidance. Other parallel records are reconciled by their own workers. `doctor`, `prepare`,
and `start` expose only an opaque provider-state identity; linked workers must
agree on it. Deleting the external state loses only current-session coordination;
`sync --apply` reconstructs completed work from repository records.
