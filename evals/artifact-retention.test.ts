/**
 * @description Verifies bounded retained-artifact traversal for the live evaluation driver.
 *
 * @module work/evals/artifact-retention
 * @file Artifact-retention.test.ts
 */

import { chmod, link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	closeDirectoryBestEffort,
	EvalArtifactBoundaryError,
	secureArtifactTree,
} from './artifact-retention'

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-eval-retention-'))
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('live eval artifact retention', () => {
	it('accepts runtimes whose directory close completes synchronously', async () => {
		expect.hasAssertions()
		let closed = false
		await expect(
			closeDirectoryBestEffort({
				close: () => {
					closed = true
				},
			}),
		).resolves.toBeUndefined()
		expect(closed).toBe(true)
	})

	it('hardens a bounded tree iteratively', async () => {
		expect.hasAssertions()
		await mkdir(join(root, 'nested'))
		await writeFile(join(root, 'nested', 'result.json'), '{}\n')

		await expect(
			secureArtifactTree(root, { entries: 3, depth: 2, bytes: 3 }),
		).resolves.toBeUndefined()
	})

	it('rejects excessive depth, fanout, bytes, and symlinks with one sanitized error', async () => {
		expect.hasAssertions()
		await mkdir(join(root, 'deep', 'deeper'), { recursive: true })
		await writeFile(join(root, 'deep', 'deeper', 'file'), 'x')
		await expect(
			secureArtifactTree(root, { entries: 10, depth: 1, bytes: 10 }),
		).rejects.toBeInstanceOf(EvalArtifactBoundaryError)

		await rm(join(root, 'deep'), { recursive: true })
		await Promise.all(['a', 'b', 'c'].map(async (name) => writeFile(join(root, name), name)))
		await expect(
			secureArtifactTree(root, { entries: 3, depth: 1, bytes: 10 }),
		).rejects.toBeInstanceOf(EvalArtifactBoundaryError)
		await expect(
			secureArtifactTree(root, { entries: 10, depth: 1, bytes: 2 }),
		).rejects.toBeInstanceOf(EvalArtifactBoundaryError)

		await rm(join(root, 'c'))
		await symlink(join(root, 'a'), join(root, 'link'))
		await expect(
			secureArtifactTree(root, { entries: 10, depth: 1, bytes: 10 }),
		).rejects.toBeInstanceOf(EvalArtifactBoundaryError)
	})

	it('rejects hard-linked files without changing the external inode permissions', async () => {
		expect.hasAssertions()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-eval-external-'))
		const canary = join(outside, 'canary')
		await writeFile(canary, 'do not mutate\n')
		await chmod(canary, 0o755)
		await link(canary, join(root, 'hard-link'))
		try {
			await expect(
				secureArtifactTree(root, { entries: 3, depth: 1, bytes: 1024 }),
			).rejects.toBeInstanceOf(EvalArtifactBoundaryError)
			const details = await stat(canary)
			expect(details.mode.toString(8).endsWith('755')).toBe(true)
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})
})
