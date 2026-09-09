#!/usr/bin/env node
/** @description Verifies public npm provenance and its existing draft GitHub release. */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1'
const GITHUB_ACTIONS_BUILD =
	'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'
const EXPECTED_REPOSITORY = 'BarakChamo/good-work'
const EXPECTED_WORKFLOW = '.github/workflows/release.yml'

const fail = (message) => {
	throw new Error(message)
}

const packagePurl = (packageName, version) => {
	if (packageName.startsWith('@')) {
		const [scope, name] = packageName.split('/')
		return `pkg:npm/%40${scope.slice(1)}/${name}@${version}`
	}
	return `pkg:npm/${packageName}@${version}`
}

const sha512Hex = (integrity) => {
	if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
		fail('The public npm package is missing SHA-512 integrity metadata.')
	}
	return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
}

const decodeStatement = (attestation) => {
	const payload = attestation?.bundle?.dsseEnvelope?.payload
	if (typeof payload !== 'string') {
		fail('The npm provenance attestation is missing its signed statement.')
	}
	try {
		return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
	} catch {
		return fail('The npm provenance statement is invalid.')
	}
}

const verifyNpmRegistryEvidence = (verifiedPackage) => {
	const attestationUrl = verifiedPackage?.attestations?.url
	if (
		verifiedPackage?.registry !== 'https://registry.npmjs.org/' ||
		typeof attestationUrl !== 'string'
	) {
		fail('The verified package evidence did not come from the npm registry.')
	}
	const parsedUrl = new URL(attestationUrl)
	if (
		parsedUrl.protocol !== 'https:' ||
		parsedUrl.hostname !== 'registry.npmjs.org' ||
		!parsedUrl.pathname.startsWith('/-/npm/v1/attestations/')
	) {
		fail('The verified package attestation is outside the npm registry.')
	}
}

export const verifyPublishedProvenance = ({
	published,
	audit,
	packageName,
	version,
	tagCommit,
}) => {
	if (published?.name !== packageName || published?.version !== version) {
		fail('The public npm package identity or version is incorrect.')
	}
	if (published?.dist?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE) {
		fail('The public npm package is missing SLSA provenance metadata.')
	}

	if (
		!Array.isArray(audit?.invalid) ||
		!Array.isArray(audit?.missing) ||
		audit.invalid.length > 0 ||
		audit.missing.length > 0
	) {
		fail('The npm signature audit contains invalid or missing verification results.')
	}
	const verifiedPackage = audit?.verified?.find(
		(entry) => entry?.name === packageName && entry?.version === version,
	)
	if (verifiedPackage === undefined) {
		fail('The npm signature audit does not contain the verified package.')
	}
	verifyNpmRegistryEvidence(verifiedPackage)
	const provenance = verifiedPackage.attestationBundles?.find(
		(attestation) => attestation?.predicateType === SLSA_PROVENANCE,
	)
	if (provenance === undefined) {
		fail('The npm registry did not return a SLSA provenance attestation.')
	}
	const statement = decodeStatement(provenance)
	if (statement?.predicateType !== SLSA_PROVENANCE) {
		fail('The npm provenance statement has the wrong predicate type.')
	}

	const expectedDigest = sha512Hex(published.dist.integrity)
	const expectedSubject = packagePurl(packageName, version)
	const subjectMatches = statement?.subject?.some(
		(subject) => subject?.name === expectedSubject && subject?.digest?.sha512 === expectedDigest,
	)
	if (subjectMatches !== true) {
		fail('The npm provenance subject does not match the published package bytes.')
	}

	const build = statement?.predicate?.buildDefinition
	const workflow = build?.externalParameters?.workflow
	if (
		build?.buildType !== GITHUB_ACTIONS_BUILD ||
		workflow?.repository !== `https://github.com/${EXPECTED_REPOSITORY}` ||
		workflow?.path !== EXPECTED_WORKFLOW ||
		workflow?.ref !== 'refs/heads/main'
	) {
		fail('The npm provenance does not identify the approved release workflow.')
	}
	const sourceMatches = build?.resolvedDependencies?.some(
		(dependency) =>
			dependency?.uri === `git+https://github.com/${EXPECTED_REPOSITORY}@refs/heads/main` &&
			dependency?.digest?.gitCommit === tagCommit,
	)
	if (sourceMatches !== true) {
		fail('The npm provenance source commit does not match the release source tag.')
	}
}

const run = (root, command, args) => {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `${command} failed.`)
	}
	return result.stdout.trim()
}

const main = async () => {
	const root = resolve(import.meta.dirname, '..')
	const version = process.env.RELEASE_VERSION
	if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
		fail('RELEASE_VERSION must be one exact semantic version.')
	}
	const packageDocument = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
	if (packageDocument.version !== version || typeof packageDocument.name !== 'string') {
		fail('Requested version does not match the checked-out package.')
	}

	const tagCommit = run(root, 'git', ['rev-list', '-n', '1', `v${version}`])
	const published = JSON.parse(
		run(root, 'npm', [
			'view',
			`${packageDocument.name}@${version}`,
			'--json',
			'--registry=https://registry.npmjs.org',
		]),
	)
	const auditPath = process.env.NPM_AUDIT_SIGNATURES_PATH
	if (auditPath === undefined || auditPath.length === 0) {
		fail('NPM_AUDIT_SIGNATURES_PATH must name the verified npm audit report.')
	}
	verifyPublishedProvenance({
		published,
		audit: JSON.parse(await readFile(auditPath, 'utf8')),
		packageName: packageDocument.name,
		version,
		tagCommit,
	})

	const release = JSON.parse(
		run(root, 'gh', ['release', 'view', `v${version}`, '--json', 'isDraft,tagName']),
	)
	if (release.tagName !== `v${version}` || typeof release.isDraft !== 'boolean') {
		fail('The matching GitHub Release must exist for the source tag.')
	}
	process.stdout.write(`${packageDocument.name}@${version} provenance matches v${version}.\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main()
}
