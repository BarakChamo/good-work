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
→ work finalize writes one completion record
→ completion record is committed
→ work submit records the clean candidate
→ external Git/review/CI integration lands it
→ work reconcile imports the landed record and closes activity
```

`work complete` remains only for manifests without the repository completion
ledger. Follow returned `nextActions` instead of assuming a lifecycle.

## Coordination and diagnostics

| Command                  | Use                                       |
| ------------------------ | ----------------------------------------- |
| `work integration status | acquire                                   | release | recover`                                        | Coordinate participating local target writers. |
| `work feedback`          | Record bounded explicit product feedback. |
| `work telemetry show     | disable                                   | enable` | Review or opt out of sanitized local telemetry. |
| `work hooks init         | inspect                                   | trust   | untrust                                         | status                                         | dispatch` | Operate advisory engineering hooks. |
| `work skill install`     | Install the canonical agent skill.        |

The CLI never runs a check, launches an agent, changes Git, opens a pull request,
merges, creates isolation, or removes a worktree.
