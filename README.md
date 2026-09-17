# Work

Work is a local-first work-management layer for humans and coding agents. It
keeps initiatives, PRDs, issues, policies, and completed-work records in Git,
while Beads supplies disposable concurrent claims, handoffs, review decisions, submissions,
telemetry, and feedback outside the repository.

The CLI is deterministic and scriptable. The included agent skill turns the
same commands into `$work` for Codex and `/work` for Claude Code. An optional
dependency-free plugin adds trusted, repository-configured engineering hooks.

> Work is beta software. Its file and CLI contracts are tested for real
> project use, but compatibility may still change before 1.0.

## Install

Work requires [Bun](https://bun.sh/) 1.3.7 or newer. For development, clone this
repository, run `bun install --frozen-lockfile`, and use `bun run work`.

Install it globally when several repositories should share one CLI:

```sh
bun add --global --ignore-scripts @good-work/work
work provider install
```

Or pin it in one repository and expose a package script:

```sh
bun add --dev --ignore-scripts @good-work/work
```

Expose the binary from the consuming repository:

```json
{
  "scripts": {
    "work": "work"
  }
}
```

Install the verified native Beads executable and initialize the repository:

```sh
bun run work provider install
bun run work init --project my-project
```

Work never downloads a provider during package installation. The explicit
provider command downloads Beads 1.2.2, verifies the official checksum, checks
the reported version, and installs it beside the package launcher. The bundled
JavaScript launcher remains a supported fallback.

Work 0.1 supports Bun on macOS, Linux, and Windows, on x64 and arm64. The
portability matrix installs the packed product globally and exercises the
verified provider, Git repository discovery, paths containing spaces, sync,
lifecycle, and both standalone skill destinations on every operating system.

## Five-minute setup

1. Commit the generated `work.yaml`.
2. Add the Markdown sources selected by that manifest.
3. Compile and synchronize committed definitions.
4. Install the agent skill if agents will operate the project.

```sh
bun run work doctor
bun run work compile
bun run work sync --plan
bun run work sync --apply
bun run work skill install
git add work.yaml .agents/skills/work .claude/skills/work
git commit -m "chore: configure work"
```

Then inspect the work inbox:

```sh
bun run work
bun run work prepare ISSUE-123
```

Starting is always explicit:

```sh
bun run work start ISSUE-123 --actor codex-issue-123-a1b2c3 --json
```

Agent-native `start` first evaluates `work prepare`; when isolation is required,
the skill provisions it through the repository workflow and calls `start` only
after preparation admits that workspace. The returned `nextActions` guide the
caller. Review-required work returns a `prepare_review` action: the surrounding
runtime runs a distinct reviewer in the same worktree, verifies its durable
disposition with `work review status`, and Work records the exact-tree result
without launching that agent. Pending or partially persisted review attempts
are never treated as completed handoffs.
Work validates repository policy but does not create worktrees, run tests,
commit, open pull requests, merge, or clean up branches.

## Agent sessions

After `work skill install`, start the agent from the repository root:

```text
Codex:       $work
Claude Code: /work
```

An ID or registered issue path is inspect-only. Include `start` only when the
agent should claim and perform it:

```text
$work ISSUE-123
$work start ISSUE-123
/work start docs/work/issues/ISSUE-123-example.md
```

See [Agent workflows](docs/agent-workflows.md) for the complete lifecycle,
parallel-session rules, handoffs, and recovery.

## Optional plugin and hooks

The repository also hosts a `work` plugin for Codex and Claude. It packages the
same skill plus a thin bridge for advisory `work.json` hooks. The plugin depends
on the separately installed `work` executable and does not contain package
dependencies or installation scripts.

```text
Codex:       codex plugin marketplace add BarakChamo/good-work
             codex plugin add work@work

Claude Code: /plugin marketplace add BarakChamo/good-work
             /plugin install work@work
```

Create, review, and trust a root hook configuration:

```sh
bun run work hooks init
bun run work hooks inspect
git add work.json && git commit -m "chore: configure work hooks"
bun run work hooks trust
```

Hooks may provide context, run setup/cleanup, and report validation feedback.
They cannot claim, finalize, submit, reconcile, merge, or create completion
evidence. See [Engineering hooks](docs/hooks.md).

## Authority and storage

```text
work.yaml + Markdown + docs/work/{ledger,reviews}/*
                 │
                 ├── compile/recover ──> ~/.work/<project-uid>/<checkout>/
                 │                         claims, handoffs, telemetry, feedback
                 └── Git history ───────> durable definitions and completions
```

- `work.yaml` selects repository-owned work definitions and policy.
- Markdown owns initiatives, PRDs, issues, and tasks.
- `docs/work/ledger/<ID>.yaml` records durable completion evidence.
- `docs/work/reviews/<ID>.md` and `.yaml` record durable independent review.
- `work.json` owns optional trusted engineering hooks.
- `~/.work` contains disposable per-checkout coordination. Deleting it loses
  active local sessions, not committed definitions or completion history.

Read [Configuration](docs/configuration.md), [Architecture](docs/architecture.md),
and [Privacy](docs/privacy.md) for the complete contract.

## Commands

| Command                                  | Use                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `work` / `work overview`                 | Show health, active work, and ready work.                         |
| `work init`                              | Create `work.yaml` and initialize local state.                    |
| `work provider install`                  | Download and verify the pinned native Beads binary.               |
| `work doctor`                            | Check manifest, provider, state, plugin, and hook health.         |
| `work sync --check` / `--plan` / `--apply` | Compare or synchronize committed definitions.                  |
| `work prepare <ref>`                     | Validate an ID/path and produce bounded context without claiming. |
| `work start <ref> --actor <actor>`       | Prepare, admit, and atomically claim work.                        |
| `work finalize` / `submit` / `reconcile` | Record evidence, submit a candidate, and close after landing.     |
| `work review`                            | Prepare and record independent exact-tree review.                 |
| `work handoff` / `resume`                | Transfer bounded state between sessions.                          |
| `work integration`                       | Coordinate one participating local integrator.                    |
| `work skill install`                     | Install the canonical Codex and Claude skill.                     |
| `work hooks`                             | Initialize, inspect, trust, and dispatch advisory hooks.          |
| `work feedback`                          | Record explicit local product feedback.                           |
| `work telemetry`                         | Index sessions, inspect timelines, or disable local telemetry.    |

Use `work --help` and `work <route> --help` for the generated reference. The
maintained overview is in [CLI reference](docs/cli.md).

## Scope

Work owns repository work definitions, readiness, claims, handoffs, evidence
records, submissions, reconciliation, and bounded local observations.

It intentionally does not own:

- agent or subagent launch;
- reviewer launch or source-control mutation, pull requests, CI, or merging;
- worktree or container provisioning;
- a daemon, hosted service, remote synchronization, or UI;
- transcripts, prompts, or remote telemetry;
- an MCP server.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test:release
```

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and the
[maintainer release runbook](docs/releasing.md). The optional local-account
review campaign is documented in
[Independent-review evaluation](docs/review-evaluation.md).
