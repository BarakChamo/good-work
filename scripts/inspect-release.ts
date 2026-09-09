#!/usr/bin/env bun
/** @description Validates the checked-out release candidate and reports registry state. */

import { spawnSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const classifyRegistryStatus = (status: number): { published: boolean } => {
	if (status === 200) return { published: true }
	if (status === 404) return { published: false }
	throw new Error(`npm registry version check failed with status ${status}.`)
}

const main = async () => {
	const root = resolve(import.meta.dirname, '..')
	if (process.env.GITHUB_REF_NAME !== undefined && process.env.GITHUB_REF_NAME !== 'main') {
		throw new Error('Releases may run only from main.')
	}
	const packageDocument: unknown = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
	if (
		typeof packageDocument !== 'object' ||
		packageDocument === null ||
		Array.isArray(packageDocument)
	) {
		throw new TypeError('package.json must contain one JSON object.')
	}
	const name = 'name' in packageDocument ? packageDocument.name : undefined
	const version = 'version' in packageDocument ? packageDocument.version : undefined
	if (
		typeof name !== 'string' ||
		typeof version !== 'string' ||
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
	) {
		throw new Error('The release package must have a valid name and exact semantic version.')
	}
	const identity = spawnSync('bun', ['run', 'check:identity'], { cwd: root, encoding: 'utf8' })
	if (identity.status !== 0) {
		throw new Error(identity.stderr.trim() || 'Release identity validation failed.')
	}
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`)
	const { published } = classifyRegistryStatus(response.status)
	const output = process.env.GITHUB_OUTPUT
	if (output !== undefined && output.length > 0) {
		await appendFile(output, `version=${version}\npublished=${String(published)}\n`)
	}
	process.stdout.write(
		`${name}@${version} is ${published ? 'public and eligible for recovery' : 'eligible for publication'}.\n`,
	)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main()
}
