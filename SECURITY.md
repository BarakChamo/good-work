# Security policy

## Supported versions

Until 1.0, only the newest published minor release receives security fixes.

## Reporting

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue containing an exploit, secret, private path, provider data, hook
output, or affected project details.

Include the affected version, operating system, reproduction, impact, and any
safe mitigation. Maintainers will acknowledge a complete report, assess scope,
and coordinate disclosure and release timing through the private advisory.

## Security boundary

Treat `work.yaml`, Markdown definitions, `work.json`, Beads output, Git output,
local state, hook events, and command output as untrusted. Hook trust is local
and digest-bound. Package installation runs no lifecycle script and performs no
download; `work provider install` is explicit and checksum-verifying.
