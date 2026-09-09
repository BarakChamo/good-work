# Changelog

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
