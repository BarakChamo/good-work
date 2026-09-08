# Privacy and telemetry

Work does not transmit telemetry or feedback.

Sanitized command telemetry is enabled by default and stored in the project's
external local state. It records an allowlisted route, outcome, duration,
failure stage, bounded phase timings, and keyed correlations. It does not record
raw arguments, paths, prompts, transcripts, feedback text, provider output,
hook payloads, hook command output, or secrets.

```sh
work telemetry show --limit 20
work telemetry disable
work telemetry enable
```

The opt-out persists for the local checkout. `DO_NOT_TRACK=1` also suppresses
recording for the current process.

`work feedback` stores a bounded explicit report in the same local coordination
area. Feedback is never promoted to a Git issue, uploaded, or combined with
telemetry automatically. Do not include prompts, transcripts, secrets, private
provider data, or full command output.

Hook telemetry records only event, configured entry ID, duration, outcome,
output mode, and skip reason. Hook command output is returned according to the
repository's trusted `work.json` policy and is not retained by Work.

Removing the exact project directory under the configured state home deletes
local operational history and active coordination. It does not remove committed
work definitions or completion records.
