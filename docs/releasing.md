# Maintainer release runbook

Work uses Changesets and one event-driven GitHub Actions workflow. npm
publication uses OpenID Connect; no npm write token belongs in GitHub and normal
releases require no local npm commands.

## One-time owner setup

1. Enable branch protection, secret scanning, push protection, private
   vulnerability reporting, and Actions pull-request creation.
2. Install Changeset Bot and add a second GitHub/npm maintainer when available.
3. Create a protected `npm-release` GitHub environment. Require maintainer
   approval and restrict deployment to `main`.
4. Configure npm trusted publishing for `@good-work/work` with:
   - repository: `BarakChamo/good-work`;
   - workflow: `release.yml`;
   - environment: `npm-release`;
   - permission: direct `npm publish`.
5. Keep package publishing access set to require 2FA and disallow traditional
   publishing tokens. Trusted publishing uses short-lived OIDC credentials and
   continues to work without a token.
6. Set the repository variable `NPM_RELEASES_ENABLED=true`.

The initial bootstrap publication is complete and must not be repeated. The
historical `bootstrap` dist-tag can be removed once through npm account
authentication; it is not part of any future release.

## Changesets

Every user-visible CLI, schema, hook, skill, plugin, state, or compatibility
change includes one `.changeset/*.md` file. Merging such changes to `main` causes
`release-pr.yml` to maintain a release pull request. The version step updates the
changelog and synchronizes the package, schemas, plugin manifests, marketplace
metadata, and bundled skill.

Review the proposed version, changelog, generated assets, and green checks.
Bot-authored Changesets pull requests use a narrowly guarded same-repository
validation path, so their checks start automatically without an additional
workflow approval.

## Release

1. Merge the Changesets release pull request.
2. Wait for the unprotected preparation job to run the complete release gate and
   build the exact tarball, checksum, and CycloneDX SBOM.
3. Approve the protected `npm-release` deployment in GitHub.

The approved job then performs one continuous release transaction:

1. verifies the downloaded archive checksum;
2. creates or verifies the immutable source tag and draft GitHub Release;
3. publishes the exact tarball through npm trusted publishing;
4. verifies registry signatures, SLSA provenance, package identity, source
   commit, and release tag;
5. publishes the GitHub Release.

The workflow reads the version from `package.json`; maintainers do not enter it
again. It is triggered only by the release PR's version change and has no
scheduled or periodic component.

## Recovery

If the workflow fails before npm publication, fix the cause and rerun it. If npm
publication succeeds but provenance verification or GitHub Release publication
fails, use **Re-run jobs** on the original workflow run so recovery stays bound
to the exact release commit. The recovery run sees that the version is already
public, skips `npm publish`, re-verifies the immutable tag and package, and
completes the existing GitHub Release. Manual dispatch from `main` remains a
fallback only while `main` still names that exact release candidate.

Never delete or replace a public version or move its source tag. Manual dispatch
is a recovery entrypoint only; it is not part of the normal release path.
