# Configuration

Work has two independent root configuration files.

## `work.yaml`

`work.yaml` defines durable work authority: project identity, selected Markdown
sources, completion-ledger behavior, context bounds, stale-claim policy, and
delivery requirements.

```yaml
version: 1
project:
  id: example-project
  uid: 123e4567-e89b-42d3-a456-426614174000
completionLedger: true
sources:
  - kind: prd
    include: docs/work/prds/*.md
  - kind: issue
    include: docs/work/issues/*.md
    parentFields: [prd, parent]
    dependencyFields: [depends_on, dependencies]
policies:
  contextMaxBytes: 12000
  staleClaimMinutes: 90
  terminalEvidence: [artifact, review]
  delivery:
    profile: protected-pr
    isolation: worktree
    targetRef: refs/heads/main
    requiredGates: [validation, pull-request, review, ci, merge]
```

The UUID is generated once, committed, and is not a secret. For Git-backed
projects, `sync --apply` reads definitions from the configured target authority;
an uncommitted feature-branch manifest cannot publish global provider state.

Selected Markdown uses YAML frontmatter for identity and relationships. IDs and
paths must be unique, dependencies and parents must exist, and cycles are
rejected. `execution: aggregate` makes an item a non-claimable rollup over its
direct children.

Adding `review` to `terminalEvidence` enables Work's independent-review
protocol. It requires a distinct reviewer decision bound to the exact committed
implementation tree before finalization. The reviewer is launched by the agent
runtime or operator, not by Work. `requiredGates` describes delivery receipts;
include `review` there when the final delivery policy must also retain the
candidate-bound review gate. Protected-PR defaults may continue to obtain their
review gate from the external code-hosting adapter without enabling the local
review protocol.

## `work.json`

`work.json` defines optional trusted engineering hooks. It does not define work,
read Beads state, or change lifecycle policy. It is resolved exactly at the
current Git worktree root. See [Engineering hooks](hooks.md).

## Durable and disposable files

- Commit `work.yaml`, selected Markdown, `work.json`, and completion records.
- Do not commit `.work`, `.beads`, telemetry, feedback, claims, handoffs,
  submissions, locks, or recovery projections.
- Do not copy disposable state between machines. Commit and pull definitions and
  completions, then run `work sync --apply` on the new machine.
