#!/usr/bin/env bun
/**
 * @description Blocks publication until owner-supplied npm and GitHub identities are exact.
 *
 * @module work/check-release-identity
 * @file Check-release-identity.ts
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = await readFile(resolve(root, 'package.json'), 'utf8')
const document: unknown = JSON.parse(source)
if (typeof document !== 'object' || document === null || Array.isArray(document)) {
	throw new TypeError('package.json must contain one JSON object.')
}
const name = 'name' in document ? document.name : null
const version = 'version' in document ? document.version : null
const repository = 'repository' in document ? document.repository : null
const repositoryUrl =
	typeof repository === 'object' &&
	repository !== null &&
	'url' in repository &&
	typeof repository.url === 'string'
		? repository.url
		: undefined
const repositoryMatch =
	repositoryUrl === undefined
		? undefined
		: /^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/u.exec(repositoryUrl)
const packageMatch = typeof name === 'string' ? /^@([^/]+)\/work$/u.exec(name) : undefined
if (
	!('private' in document) ||
	document.private !== false ||
	packageMatch?.[1] === undefined ||
	packageMatch[1] === 'replace-with-org' ||
	repositoryMatch?.[1] === undefined ||
	repositoryMatch[1].includes('replace-with-org') ||
	typeof version !== 'string' ||
	!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
) {
	throw new Error(
		'Release identity is unresolved. Run bun run configure:identity -- <npm-organization> and review the result.',
	)
}
if (typeof name !== 'string' || repositoryMatch?.[1] === undefined) {
	throw new Error('Release identity validation produced an invalid narrowed result.')
}
const githubRepository = process.env.GITHUB_REPOSITORY
if (githubRepository !== undefined && githubRepository !== repositoryMatch[1]) {
	throw new Error('GITHUB_REPOSITORY does not match package.json release identity.')
}
for (const path of [
	'README.md',
	'plugins/work/README.md',
	'examples/basic/work.json',
	'.github/CODEOWNERS',
	'.github/ISSUE_TEMPLATE/config.yml',
	'.changeset/config.json',
	'src/release-identity.ts',
	'schemas/work.schema.json',
]) {
	const content = await readFile(resolve(root, path), 'utf8')
	if (content.includes('replace-with-org') || content.includes('your-org')) {
		throw new Error(`${path} still contains an unresolved owner placeholder.`)
	}
}
process.stdout.write(`${name}@${version} is configured for ${repositoryMatch[1]}.\n`)
