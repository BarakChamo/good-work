/**
 * @description Verifies compiler discovery stops at its real-filesystem sentinel.
 *
 * @module work/compiler
 * @file Compiler-boundary.test.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'
import { INPUT_LIMITS } from './files'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

const manifest: WorkManifest = {
	schemaVersion: 1,
	projectId: 'example',
	sources: [
		{
			kind: 'issue',
			include: ['docs/issues/*.md'],
			parentFields: ['parent'],
			dependencyFields: ['dependencies'],
		},
	],
	policies: { contextMaxBytes: 12_000, staleClaimMinutes: 90, terminalEvidence: [] },
}

describe('work definition compiler discovery boundary', () => {
	it('stops real filesystem discovery at one sentinel beyond the source limit', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-discovery-limit-'))
		roots.push(root)
		const directory = join(root, 'docs', 'issues')
		await mkdir(directory, { recursive: true })
		for (let start = 0; start <= INPUT_LIMITS.sourceItems; start += 250) {
			await Promise.all(
				Array.from(
					{ length: Math.min(250, INPUT_LIMITS.sourceItems + 1 - start) },
					async (_, offset) =>
						writeFile(join(directory, `ISSUE-${start + offset}.md`), 'not parsed'),
				),
			)
		}

		await expect(compileWorkGraph({ root, manifest })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_item_limit_exceeded' },
		})
	}, 30_000)

	it('shares one source-item budget across multiple manifest source declarations', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-multi-source-limit-'))
		roots.push(root)
		const first = join(root, 'docs', 'first')
		const second = join(root, 'docs', 'second')
		await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
		await Promise.all(
			Array.from({ length: INPUT_LIMITS.sourceItems + 1 }, async (_, index) =>
				writeFile(join(index % 2 === 0 ? first : second, `ISSUE-${index}.md`), 'not parsed'),
			),
		)
		const source = manifest.sources[0]
		if (source === undefined) {
			throw new Error('Compiler boundary fixture source is missing.')
		}
		const multipleSources: WorkManifest = {
			...manifest,
			sources: [
				{ ...source, include: ['docs/first/*.md'] },
				{ ...source, include: ['docs/second/*.md'] },
			],
		}

		await expect(compileWorkGraph({ root, manifest: multipleSources })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_item_limit_exceeded' },
		})
	}, 30_000)

	it('translates crawler failures without rejecting the recoverable Result contract', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-discovery-error-'))
		roots.push(root)
		const notDirectory = join(root, 'not-a-directory')
		await writeFile(notDirectory, 'file')

		const result = await compileWorkGraph({ root: notDirectory, manifest })

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_work_graph' },
		})
		expect(JSON.stringify(result)).not.toContain(notDirectory)
	})
})
