# Privacy and telemetry

Work does not transmit telemetry or feedback.

Sanitized command telemetry is enabled by default and stored in the project's
external local state. It records an allowlisted route, outcome, duration,
failure stage, bounded phase timings, and keyed correlations. It does not record
raw arguments, paths, prompts, transcripts, feedback text, provider output,
hook payloads, hook command output, or secrets.

```sh
work telemetry show --limit 20
work telemetry sessions --limit 20
work telemetry show --session-id <known-local-session-id> --limit 100
work telemetry show --work-id ISSUE-123 --limit 100
work telemetry disable
work telemetry enable
```

`telemetry sessions` is a newest-first index of HMAC session correlations,
event/outcome counts, command counts, and total CLI duration. Pass a correlation
back through `telemetry show --session-correlation` or provide a known local
session/work ID; Work hashes lookup values locally and never prints or stores
them as part of inspection. Filters can be combined for one workstream within a
session. Telemetry inspection itself is read-only and does not add an event.

Work correlates commands automatically when `WORK_SESSION_ID`,
`CODEX_THREAD_ID`, or `CLAUDE_CODE_SESSION_ID` is available, with
`CODEX_SESSION_ID` as the final fallback. A command's explicit `--session` wins.
These values are bounded and HMAC-hashed before persistence. Work does not read
or retain the agent transcript; a "session" view is only a timeline of sanitized
Work CLI and configured-hook events.

The opt-out persists for the local checkout.

`work feedback` stores a bounded explicit report in the same local coordination
area. Feedback is never promoted to a Git issue, uploaded, or combined with
telemetry automatically. Do not include prompts, transcripts, secrets, private
provider data, or full command output.

Hook telemetry records only event, configured entry ID, duration, outcome,
output mode, and skip reason. Hook command output is returned according to the
repository's trusted `work.json` policy and is not retained by Work.

Review telemetry records only the sanitized command route, outcome, duration,
and existing keyed correlations. Review reports, findings, source paths, exact
heads, and reviewer input are never copied into telemetry. The report and YAML
receipt are deliberately committed project artifacts; teams should apply their
normal repository privacy rules to them.

Removing the exact project directory under the configured state home deletes
local operational history and active coordination. It does not remove committed
work definitions or completion records.
