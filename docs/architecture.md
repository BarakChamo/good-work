# Architecture

Work is a deterministic coordination layer above Git-owned definitions and the
Beads CLI. Its public API is deliberately smaller than its implementation.

## Authority

| Data                                  | Authority                    | Durability             |
| ------------------------------------- | ---------------------------- | ---------------------- |
| Project identity and policy           | root `work.yaml`             | Git                    |
| Initiatives, PRDs, issues, tasks      | selected Markdown            | Git                    |
| Completion evidence and attribution   | `docs/work/ledger/<ID>.yaml` | Git                    |
| Advisory engineering hooks            | root `work.json`             | Git                    |
| Claims, blocks, handoffs, submissions | Beads adapter state          | disposable local state |
| Telemetry, feedback, hook trust       | Work coordination state      | disposable local state |

The project UUID in `work.yaml` namespaces local state across linked worktrees.
Each separate clone receives a checkout identity, so deleting one clone's state
cannot affect another. State is stored under `~/.work` by default and can be
relocated with `WORK_CONTRACT_STATE_HOME`.

## Modules

- The compiler validates configuration and Markdown, resolves relationships,
  and computes a stable graph fingerprint.
- The provider adapter owns every Beads invocation, response schema, compatibility
  check, lock, and recovery projection.
- The service owns lifecycle transitions and expected failures.
- Delivery observation checks whether the surrounding Git workspace satisfies
  declared policy without mutating it.
- The CLI parses with Stricli and emits human output or stable JSON envelopes.
- Skills translate agent intent into the same CLI. They are not another state
  authority.
- The optional plugin normalizes native hook events and calls trusted repository
  commands without gaining lifecycle authority.

## Failure model

Untrusted files, CLI inputs, provider output, persisted metadata, Git output,
and hook payloads are validated at their boundaries. Expected conflicts return
typed work errors. Mutations publish a bounded recovery projection and fail
closed when ownership or persistence is uncertain.

Work intentionally leaves agent launch, Git changes, checks, pull requests,
merging, isolation provisioning, and cleanup to the surrounding engineering
environment.
