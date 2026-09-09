# Changelog

## 0.5.0

### Minor Changes

- [#23](https://github.com/BarakChamo/good-work/pull/23) [`979aff2`](https://github.com/BarakChamo/good-work/commit/979aff26818277e9605cfe2d21c9d8bb52f21b47) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Version review-status responses as schema v2, expose partially persisted or
  superseded review decisions as `incomplete`, preserve the surviving decision
  metadata, and return idempotent evidence-commit plus mandatory status-verification
  actions. The generated skills document interruption recovery for agents.

## 0.4.0

### Minor Changes

- [#21](https://github.com/BarakChamo/good-work/pull/21) [`f94da76`](https://github.com/BarakChamo/good-work/commit/f94da76bcc4a6ecd253784b05be8cf8eebdc14c7) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Add an independent exact-tree review gate with prepare, status, approve, and
  request-changes commands. Review reports and receipts remain in Git, reviewer
  launch stays in the surrounding runtime, and finalization rejects missing or
  stale approval when review evidence is configured.

## 0.3.0

### Minor Changes

- [#16](https://github.com/BarakChamo/good-work/pull/16) [`f8459fd`](https://github.com/BarakChamo/good-work/commit/f8459fd9d39036d213a3a1254a42ca2924e957a1) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Add privacy-preserving session indexes and session/work filters for local command telemetry. Automatically correlate commands with supported Codex and Claude session environments while keeping inspection read-only and excluding agent transcripts.

## 0.2.0

### Minor Changes

- [#11](https://github.com/BarakChamo/good-work/pull/11) [`b9289a7`](https://github.com/BarakChamo/good-work/commit/b9289a7570d0c3201f0edd8592e4e31ebd112fd2) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Automate releases through one protected GitHub Actions pipeline using direct npm OIDC publishing, provenance verification, and same-run GitHub Release finalization.

### Patch Changes

- [#15](https://github.com/BarakChamo/good-work/pull/15) [`698a762`](https://github.com/BarakChamo/good-work/commit/698a76201770aa81fd9b521a5e38bdcfe654e8cf) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Prevent short-lived hook commands that close standard input early from causing an unhandled `EPIPE`; the hook process exit remains the authoritative outcome.

## 0.1.0

### Minor Changes

- [`c9b8ee0`](https://github.com/BarakChamo/good-work/commit/c9b8ee01d25aad50507e6bbcd4d592c556ff7562) Thanks [@BarakChamo](https://github.com/BarakChamo)! - Publish the first beta of the standalone Work CLI, agent skill, and optional
  Codex/Claude engineering-hooks plugin.

This file is maintained by Changesets. The first public release will be
`0.1.0` and is described as beta software.
