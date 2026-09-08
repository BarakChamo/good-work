/** @description Verifies staged npm provenance against the immutable source tag. */

import { describe, expect, it } from 'vitest'

import { verifyPublishedProvenance } from './verify-public-release.mjs'

const packageName = '@good-work/work'
const version = '0.1.0'
const commit = 'f3babb4065a8a70505a802b0fd26b00a78374211'
const sha512 =
	'24e84b212f1a7d074eb4ec7335b4965a176536dbbe7ed3ad9f15b3bcce90c5ac55df95653998059188dca7c13e47936f507011996401e335af5d08411b1106e8'

const statement = {
	_type: 'https://in-toto.io/Statement/v1',
	subject: [{ name: `pkg:npm/%40good-work/work@${version}`, digest: { sha512 } }],
	predicateType: 'https://slsa.dev/provenance/v1',
	predicate: {
		buildDefinition: {
			buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
			externalParameters: {
				workflow: {
					ref: 'refs/heads/main',
					repository: 'https://github.com/BarakChamo/good-work',
					path: '.github/workflows/stage-release.yml',
				},
			},
			resolvedDependencies: [
				{
					uri: 'git+https://github.com/BarakChamo/good-work@refs/heads/main',
					digest: { gitCommit: commit },
				},
			],
		},
	},
}

const published = {
	name: packageName,
	version,
	dist: {
		integrity:
			'sha512-JOhLIS8afQdOtOxzNbSWWhdlNtu+ftOtnxWzvM6QxaxV35VlOZgFkYjcp8E+R5NvUHARmWQB4zWvXQhBGxEG6A==',
		attestations: {
			url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(packageName)}@${version}`,
			provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
		},
	},
	_npmUser: { trustedPublisher: { id: 'github' } },
}

const audit = {
	invalid: [],
	missing: [],
	verified: [
		{
			name: packageName,
			version,
			registry: 'https://registry.npmjs.org/',
			attestations: {
				url: 'https://registry.npmjs.org/-/npm/v1/attestations/@good-work%2fwork@0.1.0',
			},
			attestationBundles: [
				{
					predicateType: 'https://slsa.dev/provenance/v1',
					bundle: {
						dsseEnvelope: {
							payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
						},
					},
				},
			],
		},
	],
}

describe('public release provenance', () => {
	it('accepts the staged package when signed provenance names the tagged source commit', () => {
		expect(() =>
			verifyPublishedProvenance({
				published,
				audit,
				packageName,
				version,
				tagCommit: commit,
			}),
		).not.toThrow()
	})

	it('rejects provenance for a different source commit', () => {
		const wrong = structuredClone(audit)
		const envelope = wrong.verified[0]?.attestationBundles[0]?.bundle.dsseEnvelope
		const wrongStatement = structuredClone(statement)
		wrongStatement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
			'0000000000000000000000000000000000000000'
		envelope!.payload = Buffer.from(JSON.stringify(wrongStatement)).toString('base64')

		expect(() =>
			verifyPublishedProvenance({
				published,
				audit: wrong,
				packageName,
				version,
				tagCommit: commit,
			}),
		).toThrow(/source commit/u)
	})

	it('rejects packages without GitHub trusted-publisher attribution', () => {
		expect(() =>
			verifyPublishedProvenance({
				published: { ...published, _npmUser: {} },
				audit,
				packageName,
				version,
				tagCommit: commit,
			}),
		).toThrow(/trusted publisher/u)
	})

	it('rejects an audit report that did not verify the released package', () => {
		expect(() =>
			verifyPublishedProvenance({
				published,
				audit: { ...audit, verified: [] },
				packageName,
				version,
				tagCommit: commit,
			}),
		).toThrow(/verified package/u)
	})

	it('rejects audit evidence from another registry', () => {
		const wrong = structuredClone(audit)
		wrong.verified[0]!.registry = 'https://registry.example.invalid/'

		expect(() =>
			verifyPublishedProvenance({
				published,
				audit: wrong,
				packageName,
				version,
				tagCommit: commit,
			}),
		).toThrow(/npm registry/u)
	})
})
