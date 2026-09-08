# Contributing

Work welcomes focused bug fixes, documentation improvements, portability work,
and changes that strengthen its existing contract.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test:release
```

Use Bun 1.3.7 or newer. Do not enable dependency lifecycle scripts. Tests use
disposable Git repositories and external state roots; no test should mutate a
real project or require a paid agent account.

## Pull requests

- Keep the CLI a work-management and validation layer.
- Add behavioral tests before new behavior or bug fixes.
- Validate untrusted files, process output, paths, and persisted data.
- Update the README or owning guide when commands or contracts change.
- Add a changeset for user-visible behavior, schemas, skills, plugins, state, or
  compatibility. Documentation-only and internal-test changes may omit one.
- Report the exact commands run and any skipped live checks.

Proposals for agent launch, Git mutation, validation execution, a daemon, UI,
MCP, remote synchronization, or hosted services require a separate product
decision and should not be implemented in an ordinary contribution.
