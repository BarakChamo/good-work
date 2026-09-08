# Engineering hooks

The optional plugin maps Codex and Claude lifecycle events to commands declared
in the consuming repository's root `work.json`. Hooks are advisory engineering
context and setup, cleanup, or validation helpers. They never perform Work
lifecycle transitions.

## Trust flow

```sh
work hooks init
work hooks inspect
git add work.json && git commit -m "chore: configure work hooks"
work hooks trust
work hooks status
```

Work resolves upward only to the current Git root and reads exactly
`<git-root>/work.json`. A digest is trusted in external project-scoped state.
Any configuration change prevents execution until reviewed and trusted again.

## Events and output

- `sessionStart`: context or setup; may filter startup/resume/clear/compact.
- `afterEdit`: post-edit checks; may filter event paths, the working tree, or the
  staged set with bounded include/exclude globs.
- `beforeStop`: final advisory validation; may continue the current agent once
  after failure without creating a stop loop.
- `sessionEnd`: best-effort silent cleanup only.

Each event contains an ordered array. Commands run sequentially without a shell,
from the Git root, with normalized bounded event JSON on stdin. Timeouts are
failures. Output policy is:

- `silent`: return no command output;
- `passthrough`: return bounded output directly;
- `summarize`: ask the current agent to summarize bounded output using the
  configured instruction; Work never starts a model itself.

`output.when` may be `always` or `failure`, allowing successful checks to remain
silent while failures become actionable context.

## Security

Configuration, globs, paths, event payloads, command output, timeouts, and trust
files are bounded and validated. Commands are arrays executed without shell
interpretation. Symlink and path escapes fail closed. Telemetry never records
arguments, output, paths, or native payloads.

Treat `work.json` review like any other executable repository configuration.
Trust is local, disposable, and never committed.
