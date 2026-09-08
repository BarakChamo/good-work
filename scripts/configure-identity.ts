#!/usr/bin/env bun
/**
 * @description Configures the owner-supplied GitHub/npm organization exactly once.
 *
 * @module work/configure-identity
 * @file Configure-identity.ts
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { synchronizeReleaseAssets } from './release-assets'

const placeholder = 'replace-with-org'
const organizationPattern = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/u
const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`

const replaceInOptionalFile = async (
	root: string,
	path: string,
	organization: string,
): Promise<void> => {
	const file = join(root, path)
	const source = await readFile(file, 'utf8').catch((error: unknown) => {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null
		}
		throw error
	})
	if (source === null) return
	const updated = source
		.replaceAll('@your-org/work', `@${organization}/work`)
		.replaceAll('your-org/work', `${organization}/work`)
		.replaceAll('@replace-with-org/work', `@${organization}/work`)
		.replaceAll('replace-with-org/work', `${organization}/work`)
	if (updated !== source) await writeFile(file, updated)
}

const parseRecord = (source: string, label: string): Record<string, unknown> => {
	const value: unknown = JSON.parse(source)
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must contain one JSON object.`)
	}
	return { ...value }
}

/** @description Replaces only the guarded package and Changesets owner placeholders. */
export const configureProjectIdentity = async (input: {
	readonly root: string
	readonly organization: string
}): Promise<void> => {
	if (!organizationPattern.test(input.organization)) {
		throw new TypeError('Organization must be a valid GitHub and npm organization slug.')
	}
	const packagePath = join(input.root, 'package.json')
	const changesetPath = join(input.root, '.changeset/config.json')
	const packageDocument = parseRecord(await readFile(packagePath, 'utf8'), 'package.json')
	const packageName = packageDocument.name
	if (packageName !== `@${placeholder}/work` && packageName !== `@${input.organization}/work`) {
		throw new Error('Project identity is already configured for another organization.')
	}
	const changesetDocument = parseRecord(await readFile(changesetPath, 'utf8'), 'Changesets config')
	const repositoryUrl = `https://github.com/${input.organization}/work`
	await writeFile(
		packagePath,
		json({
			...packageDocument,
			name: `@${input.organization}/work`,
			private: false,
			repository: { type: 'git', url: `git+${repositoryUrl}.git` },
			bugs: { url: `${repositoryUrl}/issues` },
			homepage: `${repositoryUrl}#readme`,
			funding: `https://github.com/sponsors/${input.organization}`,
		}),
	)
	await writeFile(
		changesetPath,
		json({
			...changesetDocument,
			changelog: ['@changesets/changelog-github', { repo: `${input.organization}/work` }],
		}),
	)
	const changesetFiles = await readdir(join(input.root, '.changeset')).catch(() => [])
	await Promise.all(
		[
			'README.md',
			'plugins/work/README.md',
			'examples/basic/work.json',
			'.github/CODEOWNERS',
			'.github/ISSUE_TEMPLATE/config.yml',
			...changesetFiles.filter((path) => path.endsWith('.md')).map((path) => `.changeset/${path}`),
		].map((path) => replaceInOptionalFile(input.root, path, input.organization)),
	)
}

const main = async (): Promise<void> => {
	const organization = process.argv[2]
	if (organization === undefined) {
		throw new Error('Usage: bun run configure:identity -- <github-and-npm-org>')
	}
	const root = resolve(import.meta.dirname, '..')
	await configureProjectIdentity({ root, organization })
	await synchronizeReleaseAssets({ root, check: false })
	process.stdout.write(
		`Configured @${organization}/work. Review and commit the generated changes.\n`,
	)
}

if (import.meta.main) {
	void main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : 'Identity configuration failed.'}\n`,
		)
		process.exitCode = 1
	})
}
