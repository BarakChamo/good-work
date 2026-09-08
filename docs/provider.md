# Beads provider

Work uses Beads 1.2.2 as an adapter-backed store for concurrent disposable work
state. Work never reads or writes Beads' underlying storage directly.

## Installation

The package dependency includes the supported JavaScript launcher. For faster
native execution, run:

```sh
work provider install
```

This explicit command downloads the matching upstream release archive and
official checksum manifest, bounds both downloads, verifies SHA-256, extracts
without a shell on normal paths, checks `bd version 1.2.2`, and atomically
publishes the executable beside the package launcher. Package installation has
no lifecycle script and performs no download.

Verified targets are Darwin, Linux, and Windows on arm64 or x64/amd64 when the
corresponding upstream artifact is present. Unsupported targets return a clear
failure and retain the launcher or documented `--bd <path>` override.

## Compatibility and recovery

Every explicit override is version-gated before operational use. Provider JSON,
metadata, relationships, identifiers, counts, and process output are bounded
and validated. Mutation uncertainty is reported instead of guessed.

Run `work doctor --json` to inspect provider availability and obtain the opaque
state identity. Never edit the state or generated recovery projection directly.
If disposable state must be removed, use only the exact project directory
identified by doctor, then reconstruct committed definitions and completions
with `work sync --apply`.
