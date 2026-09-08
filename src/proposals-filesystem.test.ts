/**
 * @description Verifies proposal filesystem failures stay typed and cleanup does not mask primary errors.
 *
 * @module work/proposals
 * @file Proposals-filesystem.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed Vitest built-in-module interception is required to inject an overlay cleanup failure. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { WorkManifest } from './contracts'
import { applyPlanningProposal, validatePlanningProposal } from './proposals'

const filesystemFailure = vi.hoisted(() => ({
	lockCleanup: false,
	overlayCleanup: false,
	overlayWrite: false,
}))

const PRIVATE_CANARY = 'PRIVATE_FILESYSTEM_CANARY_/Users/operator/secret.md'

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		rm: async (...arguments_: Parameters<typeof actual.rm>): Promise<void> => {
			if (
				filesystemFailure.overlayCleanup &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('work-contract-proposal-graph-')
			) {
				throw new Error(PRIVATE_CANARY)
			}
			if (
				filesystemFailure.lockCleanup &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].endsWith('proposal-apply.lock')
			) {
				throw new Error(PRIVATE_CANARY)
			}
			await actual.rm(...arguments_)
		},
		writeFile: async (...arguments_: Parameters<typeof actual.writeFile>): Promise<void> => {
			if (
				filesystemFailure.overlayWrite &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('work-contract-proposal-graph-')
			) {
				throw new Error(PRIVATE_CANARY)
			}
			await actual.writeFile(...arguments_)
		},
	}
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

const manifestFile = JSON.stringify({
	version: 1,
	project: { id: 'example' },
	sources: manifest.sources,
	policies: manifest.policies,
})

let root: string

beforeEach(async () => {
	filesystemFailure.lockCleanup = false
	filesystemFailure.overlayCleanup = false
	filesystemFailure.overlayWrite = false
	root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-filesystem-'))
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), manifestFile)
})

afterEach(async () => {
	filesystemFailure.lockCleanup = false
	filesystemFailure.overlayCleanup = false
	filesystemFailure.overlayWrite = false
	await rm(root, { force: true, recursive: true })
})

describe('planning proposal filesystem failures', () => {
	it('keeps graph validation as the primary error when overlay cleanup also fails', async () => {
		expect.hasAssertions()
		const original = '# ISSUE-1 Original\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), original)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		const sourceHash = graph.value.items[0]?.source.hash
		if (sourceHash === undefined) {
			throw new Error('Missing proposal filesystem fixture source.')
		}
		filesystemFailure.overlayCleanup = true

		const result = await validatePlanningProposal({
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
						expectedHash: sourceHash,
						content: '# not_an_identifier Invalid\n',
					},
				],
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_proposed_work_graph',
			},
		})
		if (result.ok) {
			return
		}
		expect(result.error.details).toContain('Overlay cleanup failed.')
		expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
	})

	it('translates overlay write failures without rejecting its Result contract', async () => {
		expect.hasAssertions()
		const original = '# ISSUE-1 Original\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), original)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		const sourceHash = graph.value.items[0]?.source.hash
		if (sourceHash === undefined) {
			throw new Error('Missing proposal filesystem fixture source.')
		}
		filesystemFailure.overlayWrite = true

		const result = await validatePlanningProposal({
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
						expectedHash: sourceHash,
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})

		expect(result).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'proposal_overlay_failed',
			},
		})
		expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
	})

	it('keeps a stale source as the primary error when apply-lock cleanup also fails', async () => {
		expect.hasAssertions()
		const original = '# ISSUE-1 Original\n'
		const sourcePath = join(root, 'docs', 'issues', 'ISSUE-1.md')
		await writeFile(sourcePath, original)
		const graph = await compileWorkGraph({ root, manifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		const sourceHash = graph.value.items[0]?.source.hash
		if (sourceHash === undefined) {
			throw new Error('Missing proposal filesystem fixture source.')
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
						expectedHash: sourceHash,
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		await writeFile(sourcePath, '# ISSUE-1 Changed after validation\n')
		filesystemFailure.lockCleanup = true

		const result = await applyPlanningProposal({
			root,
			plan: plan.value,
			approvedFingerprint: plan.value.fingerprint,
		})

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'stale_proposal_graph_source' },
		})
		if (result.ok) {
			return
		}
		expect(result.error.details).toContain('Apply-lock cleanup failed.')
		expect(JSON.stringify(result)).not.toContain(PRIVATE_CANARY)
	})
})
