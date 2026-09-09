/** @description Verifies release evidence is reproducible for safe workflow recovery. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'dist')

const build = () => {
	const result = spawnSync('bun', ['run', 'scripts/build-release-artifacts.ts'], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, RELEASE_VERSION: '0.1.0' },
	})
	if (result.status !== 0) throw new Error(result.stderr.trim() || 'Release build failed.')
}

const digests = async () => {
	const entries = (await readdir(output)).toSorted()
	return Object.fromEntries(
		await Promise.all(
			entries.map(async (entry) => [
				entry,
				createHash('sha256')
					.update(await readFile(resolve(output, entry)))
					.digest('hex'),
			]),
		),
	)
}

afterAll(async () => {
	await rm(output, { force: true, recursive: true })
})

describe('release artifacts', () => {
	it('rebuilds byte-identical package, checksum, and SBOM evidence', async () => {
		build()
		const first = await digests()
		build()

		expect(await digests()).toEqual(first)
	})
})
