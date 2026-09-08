/**
 * @description Verifies generated lock and non-authoritative snapshot filesystem projections.
 *
 * @module work/projections
 * @file Projections.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Projection tests combine filesystem and Result assertions. */

import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CompiledWorkGraph } from './contracts'
import type { LedgerItem } from './provider'
import { writeWorkLock, writeWorkSnapshot } from './projections'

let root: string
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-projection-'))
})
afterEach(async () => {
	await rm(root, { force: true, recursive: true })
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
const item: LedgerItem = {
	definitionSchemaVersion: 2,
	providerId: 'bd-1',
	projectId: 'demo',
	workId: 'ISSUE-1',
	title: 'One',
	kind: 'issue',
	status: 'in_progress',
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
}

describe('generated projections', () => {
	it('projects aggregate execution and evidence-bound direct-child progress', async () => {
		const sourceItem = graph.items[0]
		if (sourceItem === undefined) {
			throw new Error('Missing fixture item.')
		}
		const aggregate = {
			...sourceItem,
			id: 'ISSUE-10',
			title: 'Program',
			execution: 'aggregate' as const,
		}
		const child = {
			...sourceItem,
			id: 'ISSUE-11',
			title: 'Checkpoint',
			parentId: aggregate.id,
			evidenceRequirements: ['artifact' as const],
		}
		const aggregateGraph = { ...graph, items: [aggregate, child] }
		const aggregateItems: LedgerItem[] = [
			{
				...item,
				providerId: 'bd-10',
				workId: aggregate.id,
				title: aggregate.title,
				execution: 'aggregate',
				status: 'open',
				assignee: undefined,
			},
			{
				...item,
				providerId: 'bd-11',
				workId: child.id,
				title: child.title,
				parentId: aggregate.id,
				status: 'closed',
				assignee: undefined,
				evidenceRequirements: ['artifact'],
				evidence: [
					{
						kind: 'artifact',
						reference: 'checkpoint.md',
						digest: 'a'.repeat(64),
						recordedAt: '2026-09-01T00:00:00.000Z',
						actor: 'agent-a',
					},
				],
			},
		]

		await expect(
			writeWorkLock({ root, graph: aggregateGraph, ledgerItems: aggregateItems }),
		).resolves.toMatchObject({ ok: true })
		await expect(
			writeWorkSnapshot({ root, graph: aggregateGraph, ledgerItems: aggregateItems }),
		).resolves.toMatchObject({ ok: true })
		const lockFile: unknown = JSON.parse(await readFile(join(root, '.work', 'lock.json'), 'utf8'))
		const snapshotFile: unknown = JSON.parse(
			await readFile(join(root, '.work', 'snapshots', 'current.json'), 'utf8'),
		)

		expect(lockFile).toMatchObject({
			bindings: [
				{ workId: aggregate.id, execution: 'aggregate' },
				{ workId: child.id, execution: 'task' },
			],
		})
		expect(snapshotFile).toMatchObject({
			items: [
				{
					workId: aggregate.id,
					execution: 'aggregate',
					aggregate: {
						total: 1,
						open: 0,
						active: 0,
						blocked: 0,
						terminal: 1,
						completionReady: true,
					},
				},
				{ workId: child.id, execution: 'task', status: 'closed' },
			],
		})
	})

	it('writes a stable definition binding lock and a non-authoritative operational snapshot', async () => {
		const lock = await writeWorkLock({
			root,
			graph,
			ledgerItems: [item],
			generatedAt: '2026-09-01T01:00:00.000Z',
		})
		const snapshot = await writeWorkSnapshot({
			root,
			graph,
			ledgerItems: [item],
			generatedAt: '2026-09-01T01:00:00.000Z',
		})
		expect(lock.ok).toBe(true)
		expect(snapshot.ok).toBe(true)
		const lockSource = await readFile(join(root, '.work', 'lock.json'), 'utf8')
		const snapshotSource = await readFile(join(root, '.work', 'snapshots', 'current.json'), 'utf8')
		expect(lockSource).toContain('\n\t"schemaVersion"')
		expect(snapshotSource).toContain('\n\t"schemaVersion"')
		const lockFile: unknown = JSON.parse(lockSource)
		const snapshotFile: unknown = JSON.parse(snapshotSource)
		expect(lockFile).toMatchObject({
			graphFingerprint: 'graph-1',
			bindings: [{ workId: 'ISSUE-1', providerId: 'bd-1' }],
		})
		expect(snapshotFile).toMatchObject({
			authoritative: false,
			items: [{ workId: 'ISSUE-1', status: 'in_progress', assignee: 'agent-a' }],
		})
	})

	it('rejects incomplete and duplicate ledger bindings', async () => {
		await expect(
			writeWorkLock({ root, graph, ledgerItems: [], generatedAt: 'now' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'ledger_not_synchronized' },
		})
		await expect(
			writeWorkLock({ root, graph, ledgerItems: [item, item], generatedAt: 'now' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})
	})

	it('does not create projection directories through a repository symlink', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-projection-outside-'))
		await symlink(outside, join(root, '.work'))

		await expect(writeWorkSnapshot({ root, graph, ledgerItems: [item] })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_projection_path' },
		})
		await expect(access(join(outside, 'snapshots'))).rejects.toThrow('no such file')
		await rm(outside, { force: true, recursive: true })
	})
})
