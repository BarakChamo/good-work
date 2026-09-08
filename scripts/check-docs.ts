#!/usr/bin/env bun
/**
 * @description Verifies required public guides and rejects leaked monorepo branding or paths.
 *
 * @module work/check-docs
 * @file Check-docs.ts
 */

import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { WORK_SCHEMA_URL } from '../src/release-identity'

const root = resolve(import.meta.dirname, '..')
const required = [
	'README.md',
	'CHANGELOG.md',
	'LICENSE',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'CODE_OF_CONDUCT.md',
	'GOVERNANCE.md',
	'MIGRATION.md',
	'docs/architecture.md',
	'docs/cli.md',
	'docs/configuration.md',
	'docs/hooks.md',
	'docs/agent-workflows.md',
	'docs/privacy.md',
	'docs/provider.md',
	'docs/releasing.md',
	'docs/troubleshooting.md',
] as const
await Promise.all(required.map((path) => access(resolve(root, path))))
const publicSources = [
	...required,
	'plugins/work/README.md',
	'skills/work/SKILL.md',
	'skills/work/references/commands.md',
] as const
const forbidden = ['@workspace/', 'remember-symphony', 'packages/work-contract', 'feature-frozen']
const localLinkPattern = /\[[^\]]+\]\(([^)]+)\)/gu
for (const path of publicSources) {
	const source = await readFile(resolve(root, path), 'utf8')
	const leaked = forbidden.find((token) => source.includes(token))
	if (leaked !== undefined) {
		throw new Error(`${path} contains private extraction token ${leaked}.`)
	}
	for (const match of source.matchAll(localLinkPattern)) {
		const target = match[1]
		if (target === undefined || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
			continue
		}
		const fileTarget = decodeURIComponent(target.split('#')[0] ?? '')
		await access(resolve(root, dirname(path), fileTarget)).catch(() => {
			throw new Error(`${path} links to missing local target ${fileTarget}.`)
		})
	}
}
const schema: unknown = JSON.parse(
	await readFile(resolve(root, 'schemas/work.schema.json'), 'utf8'),
)
if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
	throw new TypeError('schemas/work.schema.json must contain one JSON object.')
}
if (
	!('$id' in schema) ||
	schema.$id !== WORK_SCHEMA_URL ||
	!('$schema' in schema) ||
	schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
	!('$defs' in schema) ||
	typeof schema.$defs !== 'object' ||
	schema.$defs === null ||
	Array.isArray(schema.$defs)
) {
	throw new Error('Public hook schema identity or draft declaration is invalid.')
}
const schemaSource = JSON.stringify(schema)
for (const match of schemaSource.matchAll(/"\$ref":"#\/\$defs\/([^"/]+)"/gu)) {
	const definition = match[1]
	if (definition === undefined || !(definition in schema.$defs)) {
		throw new Error(`Public hook schema has an unresolved local definition: ${definition ?? ''}.`)
	}
}
process.stdout.write(`Validated ${publicSources.length} public documentation files.\n`)
