# Work plugin

This dependency-free plugin exposes the packaged `work` skill and bridges Codex
and Claude hook events into a separately installed Work CLI.

## Prerequisite

Install the Work package and verify the CLI first:

```sh
bun add --dev --ignore-scripts @good-work/work
bun run work provider install
bun run work --help
```

The bridge invokes `work hooks dispatch`. It never runs a repository package
script as a fallback and never installs dependencies.

## Local validation

```sh
python3 /path/to/plugin-creator/scripts/validate_plugin.py ./plugins/work
claude plugin validate ./plugins/work --strict
```

For local development, add the repository as a marketplace in Codex or Claude,
then install `work@work`. Plugin skills are namespaced by the runtime; the
standalone skill installed by `work skill install` remains available without
the plugin.

Configuration belongs only in the consuming repository's root `work.json`.
Run `work hooks inspect`, review the exact digest, and run `work hooks trust`
before commands can execute. A changed digest requires review again.

See [Engineering hooks](../../docs/hooks.md) for event, condition, output,
security, and recovery behavior.
