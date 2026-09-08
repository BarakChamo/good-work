/**
 * @description Verifies proposal validation translates overlay filesystem failures into typed results.
 *
 * @module work/proposals
 * @file Proposals-validation-failures.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions, typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in-module fault injection verifies Result boundaries. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { CompiledWorkGraph, WorkManifest } from './contracts'
import { validatePlanningProposal } from './proposals'

const faults = vi.hoisted(() => ({
	read: false,
	temporary: false,
	write: false,
	cleanup: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		open: async (...arguments_: Parameters<typeof actual.open>) => {
			if (
				faults.read &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].endsWith('ISSUE-1.md')
			) {
				throw new Error('injected proposal source read failure')
			}
			return actual.open(...arguments_)
		},
		mkdtemp: async (...arguments_: Parameters<typeof actual.mkdtemp>) => {
			if (faults.temporary && arguments_[0].includes('work-contract-proposal-graph-')) {
				throw new Error('injected overlay creation failure')
			}
			return actual.mkdtemp(...arguments_)
		},
		writeFile: async (...arguments_: Parameters<typeof actual.writeFile>): Promise<void> => {
			if (
				faults.write &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('work-contract-proposal-graph-')
			) {
				throw new Error('injected overlay write failure')
			}
			await actual.writeFile(...arguments_)
		},
		rm: async (...arguments_: Parameters<typeof actual.rm>): Promise<void> => {
			if (
				faults.cleanup &&
				typeof arguments_[0] === 'string' &&
				arguments_[0].includes('work-contract-proposal-graph-')
			) {
				throw new Error('injected overlay cleanup failure')
			}
			await actual.rm(...arguments_)
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
let graph: CompiledWorkGraph
const source = '# ISSUE-1 Existing\n'

beforeEach(async () => {
	Object.assign(faults, { read: false, temporary: false, write: false, cleanup: false })
	root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-failures-'))
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), manifestFile)
	await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), source)
	const compiled = await compileWorkGraph({ root, manifest })
	if (!compiled.ok) {
		throw new Error(compiled.error.message)
	}
	graph = compiled.value
})

afterEach(async () => {
	Object.assign(faults, { read: false, temporary: false, write: false, cleanup: false })
	await rm(root, { force: true, recursive: true })
})

const validate = async () =>
	validatePlanningProposal({
		root,
		graph,
		manifest,
		manifestPath: 'work.yaml',
		proposal: {
			schemaVersion: 1,
			id: 'PROPOSAL-1',
			baseGraphFingerprint: graph.fingerprint,
			changes: [
				{
					type: 'update',
					path: 'docs/issues/ISSUE-1.md',
					expectedHash: createHash('sha256').update(source).digest('hex'),
					content: '# ISSUE-1 Updated\n',
				},
			],
		},
	})

describe('proposal validation filesystem boundary', () => {
	it.each([
		['read', 'proposal_source_unavailable'],
		['temporary', 'proposal_overlay_failed'],
		['write', 'proposal_overlay_failed'],
		['cleanup', 'proposal_cleanup_failed'],
	] as const)('returns a typed result for %s failures', async (fault, code) => {
		faults[fault] = true
		await expect(validate()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code },
		})
	})
})
