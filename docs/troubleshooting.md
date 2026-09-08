# Troubleshooting

## No Work project found

Run from a Git worktree containing a committed root `work.yaml`, or explicitly
initialize a new repository with `work init --project <slug>`.

## Provider unavailable or incompatible

Run `work provider install`, then `work doctor --json`. An explicit `--bd` path
must report exactly the supported Beads version.

## Definitions are missing after sync

For Git-backed delivery, synchronization uses committed target authority rather
than uncommitted feature-branch files. Commit and land definition changes, then
run `work sync --check` and `work sync --apply`.

## A claim or lock looks stale

Do not edit Beads or lock files. Inspect `work show`, `work active`, and
`work doctor`. Use the documented release/reopen/integration recovery route only
after confirming the previous owner is not active.

## Plugin hooks do not run

Verify the standalone `work` executable is on `PATH`, then run `work hooks
status`. The plugin does not fall back to repository scripts. Commit `work.json`,
inspect it, and trust the current digest.

## Package generations conflict

Drain all sessions using the old package before upgrading. Install the new
package and skill, run doctor and sync, and only then start new workers. Work
does not claim to coordinate concurrently running incompatible generations.

## Recovering from deleted local state

Committed definitions and completion records are durable. Reinstall the
provider if needed and run `work sync --apply`. Active claims, handoffs,
submissions, feedback, telemetry, and hook trust are intentionally not restored
from Git.
