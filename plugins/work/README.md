# Work plugin

This dependency-free plugin exposes the packaged `work` skill and bridges Codex
and Claude hook events into a separately installed Work CLI.

## Prerequisite

Install the Work package globally so the immutable bridge can resolve `work`
from `PATH`, then install its verified provider:

```sh
npm install --global --ignore-scripts @good-work/work
work provider install
work --help
```

A repository may additionally pin `@good-work/work` and expose it through a
package script for lifecycle commands. That does not replace the PATH-visible
CLI required by the plugin bridge.

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
