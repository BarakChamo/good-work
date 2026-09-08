# Parallel work example

This example has two independent issues selected by one committed `work.yaml`.
After synchronizing the definitions, start each issue from a separate Git
worktree and agent session. Claims and handoffs coordinate through external
project state; definitions and final completion records remain in Git.

```sh
work sync --apply
work start ISSUE-101 --actor codex-101-a1b2c3 --role coder
work start ISSUE-102 --actor claude-102-d4e5f6 --role coder
```

The CLI does not create the worktrees or merge either candidate. Each worker
follows the returned actions, records evidence, submits its exact candidate,
and reconciles from its claimed worktree after external integration.
