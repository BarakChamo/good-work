/**
 * @description Verifies projection publication remains typed and retryable across rename and cleanup failures.
 *
 * @module work/projections-failures
 * @file Projections-failures.test.ts
 */

/* oxlint-disable typescript/consistent-type-imports, vitest/prefer-import-in-mock -- Typed built-in-module interception injects publication boundary failures. */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompiledWorkGraph } from './contracts'
import type { LedgerItem } from './provider'
import { writeWorkSnapshot } from './projections'

const faults = vi.hoisted(() => ({ cleanup: false, publication: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		rename: async (...arguments_: Parameters<typeof actual.rename>): Promise<void> => {
			if (faults.publication) {
				throw new Error('injected projection rename failure')
			}
			await actual.rename(...arguments_)
		},
		rm: async (...arguments_: Parameters<typeof actual.rm>): Promise<void> => {
			if (faults.cleanup && typeof arguments_[0] === 'string' && arguments_[0].includes('.tmp')) {
				throw new Error('injected projection cleanup failure')
			}
			await actual.rm(...arguments_)
		},
	}
})

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'demo',
	fingerprint: 'graph-1',
	items: [
		{
			id: 'ISSUE-1',
			kind: 'issue',
			execution: 'task',
			title: 'One',
			source: { path: 'docs/ISSUE-1.md', hash: 'hash-1' },
			dependencies: [],
			acceptance: [],
			owners: [],
			roles: [],
			evidenceRequirements: [],
			body: '# One',
		},
	],
}

const item = (status: LedgerItem['status']): LedgerItem => ({
	definitionSchemaVersion: 2,
	providerId: 'bd-1',
	projectId: 'demo',
	workId: 'ISSUE-1',
	title: 'One',
	kind: 'issue',
	status,
	parentId: undefined,
	dependencies: [],
	roles: [],
	evidenceRequirements: [],
	source: { path: 'docs/ISSUE-1.md', hash: 'hash-1' },
	graphFingerprint: 'graph-1',
	assignee: 'agent-a',
	activity: undefined,
	handoff: undefined,
	evidence: [],
	blockReason: undefined,
	updatedAt: '2026-09-01T00:00:00.000Z',
})

let root: string

beforeEach(async () => {
	faults.cleanup = false
	faults.publication = false
	root = await mkdtemp(join(tmpdir(), 'work-contract-projection-failure-'))
})

afterEach(async () => {
	faults.cleanup = false
	faults.publication = false
	await rm(root, { force: true, recursive: true })
})

describe('projection publication failures', () => {
	it('preserves the prior projection and returns a typed retryable result when rename and cleanup fail', async () => {
		expect.hasAssertions()
		await expect(
			writeWorkSnapshot({ root, graph, ledgerItems: [item('in_progress')], generatedAt: 'before' }),
		).resolves.toMatchObject({ ok: true })
		faults.publication = true
		faults.cleanup = true

		await expect(
			writeWorkSnapshot({ root, graph, ledgerItems: [item('blocked')], generatedAt: 'failed' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'projection_write_failed' },
		})
		const preserved: unknown = JSON.parse(
			await readFile(join(root, '.work/snapshots/current.json'), 'utf8'),
		)
		expect(preserved).toMatchObject({ generatedAt: 'before', items: [{ status: 'in_progress' }] })
		await expect(readdir(join(root, '.work/snapshots'))).resolves.toHaveLength(2)

		faults.publication = false
		faults.cleanup = false
		await expect(
			writeWorkSnapshot({ root, graph, ledgerItems: [item('blocked')], generatedAt: 'retry' }),
		).resolves.toMatchObject({ ok: true })
		const recovered: unknown = JSON.parse(
			await readFile(join(root, '.work/snapshots/current.json'), 'utf8'),
		)
		expect(recovered).toMatchObject({ generatedAt: 'retry', items: [{ status: 'blocked' }] })
	})
})
