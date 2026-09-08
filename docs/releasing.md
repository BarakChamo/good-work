# Maintainer release runbook

Work uses Changesets for version/changelog preparation and npm staged publishing
with OpenID Connect for publication. No npm write token belongs in GitHub.

## One-time owner setup

1. Confirm the public `BarakChamo/good-work` repository contains the clean import.
2. Choose the npm organization that will own `@<organization>/work`.
3. Run `bun run configure:identity -- <npm-organization>` and review every change.
4. Enable branch protection, secret scanning, push protection, private
   vulnerability reporting, and Actions pull-request creation.
5. Install Changeset Bot.
6. Add a second maintainer when available. If the repository later moves into an
   organization, create a maintainer team and update CODEOWNERS accordingly.
7. Create a protected `npm-stage` GitHub environment requiring maintainer review.
8. Add at least one second GitHub and npm maintainer when available.
9. After npm identity is configured, create the repository variable
   `NPM_RELEASES_ENABLED=true`. Until then, the release-PR workflow stays
   dormant while ordinary CI remains active.

Staged publishing requires an existing npm package. After `bun run test:release`
passes on the exact clean commit, build and inspect the bootstrap artifacts.
The release gate explicitly installs the checksum-verified provider before its
real-provider tests; dependency installation never performs that download:

```sh
RELEASE_VERSION=0.0.0 bun run scripts/build-release-artifacts.ts
(cd dist && shasum -a 256 -c work-0.0.0.tgz.sha256)
```

Create the package once with interactive 2FA:

```sh
npm publish ./dist/work-0.0.0.tgz --access public --tag bootstrap --provenance=false
```

Publish version `0.0.0` only. Then configure the npm trusted publisher for the
exact npm package, `BarakChamo/good-work` repository, `stage-release.yml`
workflow, and `npm-stage`
environment. Select stage-only permission, require 2FA, disallow publishing
tokens, and revoke any temporary automation credentials.

## Changesets

User-visible changes include one `.changeset/*.md` file. Merging such changes to
`main` causes `release-pr.yml` to maintain a version PR. The version step runs
Changesets and synchronizes plugin manifests, marketplace metadata, the bundled
skill, and the immutable schema URL.

Review the version, changelog, generated assets, and green release gate before
merging the release PR.

## Stage a release

Dispatch `stage-release.yml` with the exact version after its release PR merges.
The protected job:

1. confirms package identity and version;
2. runs `bun run test:release` from a frozen install;
3. packs and inspects the tarball;
4. generates SHA-256 and CycloneDX SBOM artifacts;
5. runs `npm stage publish` through OIDC;
6. creates the exact `v<version>` tag and draft GitHub Release.

Download and inspect the npm staged artifact, then approve it with npm 2FA.

## Finalize

Dispatch `finalize-release.yml` with the same version. It verifies that npm
verifies the registry signatures and attestations, then confirms the version,
trusted-publisher identity, package digest, and signed provenance source commit
match the tag before it
publishes the existing draft GitHub Release.

After 0.1.0 is public, remove the `bootstrap` dist-tag.

## Rejection and recovery

If a staged release is rejected, reject it in npm, delete only its unpublished
tag and draft release, fix the problem through a new changeset/version, and
stage again. Never replace source underneath a public version or reuse its tag.

The workflows intentionally cannot create the npm organization, reserve the
package, change account 2FA, configure trusted publishing, approve npm staging,
or alter branch protection. Those are owner-controlled operations.
