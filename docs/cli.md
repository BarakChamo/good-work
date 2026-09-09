# CLI reference

Run `work --help` for the complete generated index and `work <route> --help` for
exact flags. Add `--json` to every command consumed by automation or an agent.

## Setup and health

| Command                      | Use                                                                 |
| ---------------------------- | ------------------------------------------------------------------- |
| `work provider install`      | Explicitly install the verified pinned Beads binary.                |
| `work init --project <slug>` | Create a new manifest and initialize state.                         |
| `work doctor`                | Diagnose manifest, provider, coordination, plugin, and hook health. |
| `work compile`               | Print the validated deterministic graph.                            |
| `work sync --check`          | Report provider and definition drift without mutation.              |
| `work sync --plan`           | Show the proposed synchronization.                                  |
| `work sync --apply`          | Apply committed canonical definitions to local state.               |

## Read and start

| Command                            | Use                                              |
| ---------------------------------- | ------------------------------------------------ |
| `work` / `work overview`           | Dynamic read-only inbox.                         |
| `work ready`                       | Dependency-ready executable work.                |
| `work active`                      | Claimed or blocked work.                         |
| `work show <id>`                   | Full selected item state.                        |
| `work status [id]`                 | Current item and aggregate rollup.               |
| `work prepare <id-or-path>`        | Validate readiness and context without claiming. |
| `work start <ref> --actor <actor>` | Prepare, admit, and atomically claim.            |

## Lifecycle

`touch`, `resume`, `handoff`, `block`, `release`, `reopen`, `finalize`,
`submit`, and `reconcile` require the owning actor. Optional role and session
values are assertions against the current activity, except that
`resume --session` intentionally replaces the session.

Ledger-enabled repositories finish through:

```text
implementation and checks are committed
→ work review prepare binds a distinct reviewer to the exact tree (when required)
→ review report and approval receipt are committed
→ work finalize writes one completion record
→ completion record is committed
→ work submit records the clean candidate
→ external Git/review/CI integration lands it
→ work reconcile imports the landed record and closes activity
```

`work complete` remains only for manifests without the repository completion
ledger. Follow returned `nextActions` instead of assuming a lifecycle.

## Independent review

| Command                                | Use                                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| `work review status <id>`              | Inspect the current decision and exact-tree freshness.      |
| `work review prepare <id> --actor ...` | Prepare a clean committed tree for a distinct reviewer.     |
| `work review approve <id> ...`         | Record approval and write the repository review receipt.    |
| `work review request-changes <id> ...` | Record findings without releasing or reopening the item.    |

`approve` and `request-changes` require a distinct reviewer actor,
`--evaluator agent|human`, the exact `--head` returned by `prepare`, and the
canonical report path `docs/work/reviews/<ID>.md`. Work does not launch the
reviewer. A source change makes the prior decision stale and requires a new
prepare/decision cycle. `finalize` refuses review-required work until the current
tree is approved.

## Coordination and diagnostics

| Command                                       | Use                                                |
| --------------------------------------------- | -------------------------------------------------- |
| `work integration status`                     | Inspect the participating local integration mutex. |
| `work integration acquire / release / recover` | Coordinate participating local target writers.     |
| `work feedback`                               | Record bounded explicit product feedback.          |
| `work telemetry sessions`                     | Index privacy-preserving command sessions.          |
| `work telemetry show`                         | Review all or filter sanitized command events.      |
| `work telemetry disable / enable`             | Opt out of or restore local telemetry.               |
| `work hooks init / inspect / trust / untrust`  | Configure and authorize advisory hooks.              |
| `work hooks status / dispatch`                | Diagnose or invoke the reviewed hook bridge.         |
| `work skill install`                          | Install the canonical agent skill.                  |

Inspect one agent session or workstream without exposing its raw identifier:

```sh
work telemetry sessions --limit 20 --json
work telemetry show --session-id "$CODEX_THREAD_ID" --limit 100 --json
work telemetry show --work-id ISSUE-123 --limit 100 --json
work telemetry show --session-correlation <digest-from-sessions> --json
```

Inspection commands do not append telemetry events. `WORK_SESSION_ID`,
`CODEX_THREAD_ID`, and `CLAUDE_CODE_SESSION_ID` automatically correlate commands
that do not already carry `--session`; `CODEX_SESSION_ID` is a final Codex
fallback. `WORK_SESSION_ID` has highest precedence and an explicit command
session has priority over every environment value.

The CLI never runs a check, launches an agent or reviewer, changes Git, opens a
pull request, merges, creates isolation, or removes a worktree.
