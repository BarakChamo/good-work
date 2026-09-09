---
'@good-work/work': patch
---

Prevent short-lived hook commands that close standard input early from causing an unhandled `EPIPE`; the hook process exit remains the authoritative outcome.
