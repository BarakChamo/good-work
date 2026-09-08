/**
 * @description Verifies multi-file proposal rollback after a mid-commit filesystem failure.
 *
 * @module work/proposals
 * @file Proposals-rollback.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions, typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed Vitest built-in-module interception is required to inject a mid-commit rename failure. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'
import { applyPlanningProposal, validatePlanningProposal } from './proposals'

const renameFailure = vi.hoisted(() => ({ count: 0, failAt: Number.POSITIVE_INFINITY }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		rename: async (...arguments_: Parameters<typeof actual.rename>): Promise<void> => {
			renameFailure.count += 1
			if (renameFailure.count === renameFailure.failAt) {
				throw new Error('injected second-rename failure')
			}
			await actual.rename(...arguments_)
		},
	}
})

let root: string

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

const manifestFile = JSON.stringify({
	version: 1,
	project: { id: 'example' },
	sources: manifest.sources,
	policies: manifest.policies,
})

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

beforeEach(async () => {
	renameFailure.count = 0
	renameFailure.failAt = Number.POSITIVE_INFINITY
	root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-rollback-'))
	await mkdir(join(root, '.work'), { recursive: true })
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), manifestFile)
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('planning proposal rollback', () => {
	it('restores every prior file and removes staging artifacts after a mid-commit failure', async () => {
		const first = '# ISSUE-1 First old\n'
		const second = '# ISSUE-2 Second old\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), first)
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), second)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		const plan = await validatePlanningProposal({
			root,
			graph: graph.value,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.value.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash(first),
						content: '# ISSUE-1 First new\n',
					},
					{
						type: 'update',
						path: 'docs/issues/ISSUE-2.md',
						expectedHash: hash(second),
						content: '# ISSUE-2 Second new\n',
					},
				],
			},
		})
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		renameFailure.failAt = 2

		await expect(
			applyPlanningProposal({
				root,
				plan: plan.value,
				approvedFingerprint: plan.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_apply_failed' },
		})
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), 'utf8')).resolves.toBe(first)
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), 'utf8')).resolves.toBe(second)
		await expect(
			readdir(join(root, 'docs', 'issues')).then((entries) => entries.toSorted()),
		).resolves.toStrictEqual(['ISSUE-1.md', 'ISSUE-2.md'])
		await expect(readdir(join(root, '.work'))).resolves.toStrictEqual([])
	})
})
