/**
 * @description Verifies the narrow schema-owned public work-project facade.
 *
 * @module work/facade
 * @file Facade.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Facade tests perform filesystem setup before public Result assertions. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadWorkProject } from './facade'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('public work-project facade', () => {
	it('parses operation input and returns a complete compiled project', async () => {
		const root = await mkdtemp(join(tmpdir(), 'work-contract-facade-'))
		roots.push(root)
		await mkdir(join(root, 'docs'), { recursive: true })
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/*.md }]\n',
		)
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Public facade\n')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: true,
			value: { manifest: { projectId: 'example' }, graph: { projectId: 'example' } },
		})
	})

	it('rejects unknown or unbounded operation fields before filesystem access', async () => {
		await expect(loadWorkProject({ root: '', path: 'work.yaml' })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_operation_input' },
		})
		const unknownFieldInput = { root: '/missing', path: 'work.yaml', typo: true }
		await expect(loadWorkProject(unknownFieldInput)).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_operation_input' },
		})
	})
})
