/**
 * @description Verifies deterministic file-to-ledger reconciliation and stale plan rejection.
 *
 * @module work/sync
 * @file Sync.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Sync tests assert after Result narrowing. */

import { describe, expect, it } from 'vitest'

import type { CompiledWorkGraph, WorkArtifact, WorkResult } from './contracts'
import { INPUT_LIMITS } from './files'
import type {
	LedgerDefinitionInput,
	LedgerItem,
	LedgerProvider,
	LedgerRelationsInput,
} from './provider'
import { prepareWorkLaunch } from './preparation'
import { applySyncPlan, planSync } from './sync'

const artifact = (
	input: Partial<WorkArtifact> & Pick<WorkArtifact, 'id' | 'kind' | 'title'>,
): WorkArtifact => ({
	...input,
	execution: input.execution ?? 'task',
	source: input.source ?? { path: `docs/${input.id}.md`, hash: `hash-${input.id}` },
	dependencies: input.dependencies ?? [],
	acceptance: input.acceptance ?? [],
	owners: input.owners ?? [],
	roles: input.roles ?? [],
	evidenceRequirements: input.evidenceRequirements ?? [],
	body: input.body ?? `Definition for ${input.id}.`,
})

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'example',
	fingerprint: 'graph-1',
	items: [
		artifact({ id: 'INIT-1', kind: 'initiative', title: 'Initiative' }),
		artifact({
			id: 'ISSUE-1',
			kind: 'issue',
			title: 'Implement',
			parentId: 'PRD-1',
			dependencies: ['ISSUE-0'],
		}),
		artifact({ id: 'ISSUE-0', kind: 'issue', title: 'Design', parentId: 'PRD-1' }),
		artifact({ id: 'PRD-1', kind: 'prd', title: 'Product', parentId: 'INIT-1' }),
	],
}

class MemoryProvider implements LedgerProvider {
	public readonly items = new Map<string, LedgerItem>()
	public readonly calls: string[] = []

	public async doctor(): Promise<
		WorkResult<{ readonly provider: string; readonly version: string }>
	> {
		return { ok: true, value: { provider: 'memory', version: '1' } }
	}

	public async list(): Promise<WorkResult<readonly LedgerItem[]>> {
		return { ok: true, value: [...this.items.values()] }
	}

	public async createDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		this.calls.push(`create:${input.artifact.id}`)
		const item: LedgerItem = {
			definitionSchemaVersion: 2,
			providerId: `provider-${input.artifact.id}`,
			projectId: input.projectId,
			workId: input.artifact.id,
			title: input.artifact.title,
			kind: input.artifact.kind,
			execution: input.artifact.execution,
			status: 'open',
			parentId: undefined,
			dependencies: [],
			roles: input.artifact.roles,
			evidenceRequirements: input.artifact.evidenceRequirements,
			source: input.artifact.source,
			graphFingerprint: input.graphFingerprint,
			assignee: undefined,
			activity: undefined,
			handoff: undefined,
			evidence: [],
			blockReason: undefined,
			updatedAt: '2026-09-01T00:00:00.000Z',
		}
		this.items.set(item.workId, item)
		return { ok: true, value: item }
	}

	public async updateDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		this.calls.push(`update:${input.artifact.id}`)
		const previous = this.items.get(input.artifact.id)
		if (previous === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const item: LedgerItem = {
			...previous,
			title: input.artifact.title,
			kind: input.artifact.kind,
			execution: input.artifact.execution,
			roles: input.artifact.roles,
			evidenceRequirements: input.artifact.evidenceRequirements,
			source: input.artifact.source,
			graphFingerprint: input.graphFingerprint,
		}
		this.items.set(item.workId, item)
		return { ok: true, value: item }
	}

	public async setRelations(input: LedgerRelationsInput): Promise<WorkResult<LedgerItem>> {
		this.calls.push(`relations:${input.workId}`)
		const previous = this.items.get(input.workId)
		if (previous === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const item = { ...previous, parentId: input.parentId, dependencies: [...input.dependencies] }
		this.items.set(item.workId, item)
		return { ok: true, value: item }
	}

	public async archive(workId: string): Promise<WorkResult<LedgerItem>> {
		this.calls.push(`archive:${workId}`)
		const previous = this.items.get(workId)
		if (previous === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const item: LedgerItem = { ...previous, status: 'archived' }
		this.items.set(workId, item)
		return { ok: true, value: item }
	}
}

describe('definition synchronization', () => {
	it('plans parent-first creates followed by exact relation reconciliation', () => {
		const result = planSync({ graph, ledgerItems: [] })

		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.actions.map(({ type, workId }) => `${type}:${workId}`)).toStrictEqual([
			'create:INIT-1',
			'create:PRD-1',
			'create:ISSUE-0',
			'create:ISSUE-1',
			'relations:PRD-1',
			'relations:ISSUE-0',
			'relations:ISSUE-1',
		])
	})

	it('plans a maximum-size deep hierarchy without recursive depth amplification', () => {
		const items = Array.from({ length: INPUT_LIMITS.sourceItems }, (_, index) =>
			artifact({
				id: `NODE-${index}`,
				kind: 'issue',
				title: `Node ${index}`,
				...(index === 0 ? {} : { parentId: `NODE-${index - 1}` }),
			}),
		)
		const startedAt = performance.now()

		const result = planSync({
			graph: { ...graph, fingerprint: 'deep-graph', items },
			ledgerItems: [],
		})

		expect(performance.now() - startedAt).toBeLessThan(2000)
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.actions).toHaveLength(INPUT_LIMITS.sourceItems * 2 - 1)
		expect(result.value.actions[0]).toStrictEqual({ type: 'create', workId: 'NODE-0' })
		expect(result.value.actions[INPUT_LIMITS.sourceItems - 1]).toStrictEqual({
			type: 'create',
			workId: `NODE-${INPUT_LIMITS.sourceItems - 1}`,
		})
	})

	it('applies a plan idempotently through the provider boundary', async () => {
		const provider = new MemoryProvider()
		const plan = planSync({ graph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error('fixture plan failed')
		}

		const applied = await applySyncPlan({ graph, plan: plan.value, provider })
		expect(applied.ok).toBe(true)
		const secondPlan = planSync({ graph, ledgerItems: [...provider.items.values()] })
		expect(secondPlan).toStrictEqual({
			ok: true,
			value: {
				schemaVersion: 1,
				graphFingerprint: 'graph-1',
				actions: [],
				drift: [],
			},
		})
	})

	it('updates only the changed definition while unchanged work stays launchable', async () => {
		const provider = new MemoryProvider()
		const initial = planSync({ graph, ledgerItems: [] })
		if (!initial.ok) {
			throw new Error('fixture plan failed')
		}
		await applySyncPlan({ graph, plan: initial.value, provider })
		const revisedGraph: CompiledWorkGraph = {
			...graph,
			fingerprint: 'graph-2',
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1'
					? { ...item, title: 'Revised sibling', source: { ...item.source, hash: 'revised' } }
					: item,
			),
		}

		const plan = planSync({ graph: revisedGraph, ledgerItems: [...provider.items.values()] })
		expect(plan.ok && plan.value.actions).toStrictEqual([{ type: 'update', workId: 'ISSUE-1' }])
		expect(
			prepareWorkLaunch({
				graph: revisedGraph,
				ledgerItems: [...provider.items.values()],
				maxBytes: 1200,
				reference: 'ISSUE-0',
			}),
		).toMatchObject({ ok: true, value: { workId: 'ISSUE-0', graphFingerprint: 'graph-2' } })
	})

	it('plans definition updates when persisted roles or evidence requirements drift', async () => {
		const provider = new MemoryProvider()
		const initial = planSync({ graph, ledgerItems: [] })
		if (!initial.ok) {
			throw new Error('fixture plan failed')
		}
		await applySyncPlan({ graph, plan: initial.value, provider })
		const issueZero = provider.items.get('ISSUE-0')
		const issueOne = provider.items.get('ISSUE-1')
		if (issueZero === undefined || issueOne === undefined) {
			throw new Error('fixture sync failed')
		}
		provider.items.set('ISSUE-0', { ...issueZero, roles: ['reviewer'] })
		provider.items.set('ISSUE-1', { ...issueOne, evidenceRequirements: ['test'] })

		const result = planSync({ graph, ledgerItems: [...provider.items.values()] })

		expect(result.ok && result.value.actions).toStrictEqual([
			{ type: 'update', workId: 'ISSUE-0' },
			{ type: 'update', workId: 'ISSUE-1' },
		])
	})

	it('rejects canonical definition changes for active work before producing an apply plan', async () => {
		const provider = new MemoryProvider()
		const initial = planSync({ graph, ledgerItems: [] })
		if (!initial.ok) {
			throw new Error('fixture plan failed')
		}
		await applySyncPlan({ graph, plan: initial.value, provider })
		const active = provider.items.get('ISSUE-1')
		if (active === undefined) {
			throw new Error('fixture item missing')
		}
		provider.items.set('ISSUE-1', { ...active, status: 'in_progress', assignee: 'agent-a' })
		const revised: CompiledWorkGraph = {
			...graph,
			fingerprint: 'graph-2',
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1'
					? { ...item, title: 'Changed while claimed', source: { ...item.source, hash: 'changed' } }
					: item,
			),
		}

		expect(planSync({ graph: revised, ledgerItems: [...provider.items.values()] })).toMatchObject({
			ok: false,
			error: { code: 'active_definition_conflict' },
		})
	})

	it('plans an update for a readable legacy definition binding', async () => {
		const provider = new MemoryProvider()
		const initial = planSync({ graph, ledgerItems: [] })
		if (!initial.ok) {
			throw new Error('fixture plan failed')
		}
		await applySyncPlan({ graph, plan: initial.value, provider })
		const legacy = provider.items.get('ISSUE-0')
		if (legacy === undefined) {
			throw new Error('fixture sync failed')
		}

		const result = planSync({
			graph,
			ledgerItems: [
				...provider.items.values().filter(({ workId }) => workId !== 'ISSUE-0'),
				{ ...legacy, definitionSchemaVersion: 1 },
			],
		})

		expect(result.ok && result.value.actions).toContainEqual({
			type: 'update',
			workId: 'ISSUE-0',
		})
	})

	it('reports definition drift and requires explicit permission to archive removed definitions', () => {
		const provider = new MemoryProvider()
		provider.items.set('ISSUE-OLD', {
			definitionSchemaVersion: 2,
			providerId: 'provider-old',
			projectId: 'example',
			workId: 'ISSUE-OLD',
			title: 'Removed',
			kind: 'issue',
			status: 'open',
			parentId: undefined,
			dependencies: [],
			roles: [],
			evidenceRequirements: [],
			source: { path: 'docs/ISSUE-OLD.md', hash: 'old' },
			graphFingerprint: 'old-graph',
			assignee: undefined,
			activity: undefined,
			handoff: undefined,
			evidence: [],
			blockReason: undefined,
			updatedAt: '2026-09-01T00:00:00.000Z',
		})

		const safe = planSync({
			graph: { ...graph, items: [] },
			ledgerItems: [...provider.items.values()],
		})
		const destructive = planSync({
			graph: { ...graph, items: [] },
			ledgerItems: [...provider.items.values()],
			archiveMissing: true,
		})

		expect(safe.ok).toBe(true)
		if (!safe.ok || !destructive.ok) {
			return
		}
		expect(safe.value.actions).toStrictEqual([])
		expect(safe.value.drift).toStrictEqual([
			{
				code: 'orphaned_ledger_item',
				workId: 'ISSUE-OLD',
				message: 'Ledger item has no source definition.',
			},
		])
		expect(destructive.value.actions).toStrictEqual([{ type: 'archive', workId: 'ISSUE-OLD' }])
	})

	it('clears removed relations without rewriting unchanged definitions for a graph revision', () => {
		const current = graph.items.map(
			(entry): LedgerItem => ({
				definitionSchemaVersion: 2,
				providerId: `provider-${entry.id}`,
				projectId: graph.projectId,
				workId: entry.id,
				title: entry.title,
				kind: entry.kind,
				status: 'open',
				parentId: entry.id === 'INIT-1' ? 'OLD-PARENT' : entry.parentId,
				dependencies: entry.id === 'INIT-1' ? ['OLD-DEPENDENCY'] : entry.dependencies,
				roles: entry.roles,
				evidenceRequirements: entry.evidenceRequirements,
				source: entry.source,
				graphFingerprint: 'graph-old',
				assignee: undefined,
				activity: undefined,
				handoff: undefined,
				evidence: [],
				blockReason: undefined,
				updatedAt: '2026-09-01T00:00:00.000Z',
			}),
		)

		const result = planSync({ graph, ledgerItems: current })

		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.actions.filter(({ type }) => type === 'update')).toHaveLength(0)
		expect(result.value.actions).toContainEqual({ type: 'relations', workId: 'INIT-1' })
	})

	it('preserves an active claim-bound v3 revision across an unrelated canonical advance', () => {
		const claimRevision = {
			targetRef: 'refs/heads/main',
			targetSha: '1'.repeat(40),
			graphFingerprint: 'a'.repeat(64),
		}
		const nextRevision = {
			targetRef: 'refs/heads/main',
			targetSha: '2'.repeat(40),
			graphFingerprint: 'b'.repeat(64),
		}
		const current = graph.items.map(
			(entry): LedgerItem => ({
				definitionSchemaVersion: 3,
				providerId: `provider-${entry.id}`,
				projectId: graph.projectId,
				workId: entry.id,
				title: entry.title,
				kind: entry.kind,
				status: entry.id === 'ISSUE-1' ? 'in_progress' : 'open',
				parentId: entry.parentId,
				dependencies: entry.dependencies,
				roles: entry.roles,
				evidenceRequirements: entry.evidenceRequirements,
				source: entry.source,
				graphFingerprint: claimRevision.graphFingerprint,
				definitionRevision: claimRevision,
				assignee: entry.id === 'ISSUE-1' ? 'agent-a' : undefined,
				activity:
					entry.id === 'ISSUE-1'
						? {
								actor: 'agent-a',
								startedAt: '2026-09-01T00:00:00.000Z',
								touchedAt: '2026-09-01T00:00:00.000Z',
							}
						: undefined,
				handoff: undefined,
				evidence: [],
				blockReason: undefined,
				updatedAt: '2026-09-01T00:00:00.000Z',
			}),
		)

		const result = planSync({
			graph: { ...graph, fingerprint: nextRevision.graphFingerprint },
			ledgerItems: current,
			definitionRevision: nextRevision,
		})

		expect(result).toMatchObject({ ok: true })
		if (!result.ok) {
			return
		}
		expect(result.value.actions).not.toContainEqual({ type: 'update', workId: 'ISSUE-1' })
		expect(result.value.drift).not.toContainEqual(expect.objectContaining({ workId: 'ISSUE-1' }))
	})

	it('rejects caller-constructed plans and reports the applied prefix on provider failure', async () => {
		const canary = `PRIVATE_PROVIDER_${'x'.repeat(100_000)}`
		const provider = new MemoryProvider()
		const forged = {
			schemaVersion: 1,
			graphFingerprint: graph.fingerprint,
			actions: [{ type: 'archive', workId: 'UNRELATED-1' }],
			drift: [],
		}
		await expect(applySyncPlan({ graph, plan: forged, provider })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unvalidated_sync_plan' },
		})
		expect(provider.calls).toStrictEqual([])

		const plan = planSync({ graph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		provider.createDefinition = async (input) => {
			if (input.artifact.id === 'PRD-1') {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'provider_failed',
						message: canary,
						details: [canary],
					},
				}
			}
			return MemoryProvider.prototype.createDefinition.call(provider, input)
		}
		const failed = await applySyncPlan({ graph, plan: plan.value, provider })
		expect(failed.ok).toBe(false)
		if (failed.ok) {
			return
		}
		expect(failed.error.code).toBe('sync_apply_failed')
		expect(failed.error.details).toContain('applied=1')
		expect(failed.error.details).toContain('providerCode=provider_failed')
		expect(JSON.stringify(failed)).not.toContain(canary)
	})

	it('redacts a batch provider failure from sync diagnostics', async () => {
		const canary = `PRIVATE_BATCH_${'x'.repeat(100_000)}`
		const provider = Object.assign(new MemoryProvider(), {
			createDefinitions: async () => ({
				ok: false as const,
				applied: 0,
				failedIndex: 0,
				error: {
					type: 'work_contract_error' as const,
					code: 'provider_busy' as const,
					message: canary,
					details: ['lockState=stale', 'automaticRecovery=false', canary],
				},
			}),
		})
		const plan = planSync({ graph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}

		const result = await applySyncPlan({ graph, plan: plan.value, provider })

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'sync_apply_failed',
				details: [
					'applied=0',
					'providerCode=provider_busy',
					'lockState=stale',
					'automaticRecovery=false',
					'recovery=inspect provider lock ownership before manual removal',
				],
			},
		})
		expect(JSON.stringify(result)).not.toContain(canary)
	})

	it('batches only consecutive creates so mixed plans retain ordered-prefix failure semantics', async () => {
		const mixedGraph: CompiledWorkGraph = {
			...graph,
			fingerprint: 'graph-mixed',
			items: [
				artifact({ id: 'PRD-1', kind: 'prd', title: 'Updated parent' }),
				artifact({ id: 'ISSUE-1', kind: 'issue', title: 'New child', parentId: 'PRD-1' }),
			],
		}
		const provider = new MemoryProvider()
		provider.items.set('PRD-1', {
			definitionSchemaVersion: 2,
			providerId: 'provider-PRD-1',
			projectId: 'example',
			workId: 'PRD-1',
			title: 'Stale parent',
			kind: 'prd',
			status: 'open',
			parentId: undefined,
			dependencies: [],
			roles: [],
			evidenceRequirements: [],
			source: mixedGraph.items[0]?.source ?? { path: 'docs/PRD-1.md', hash: 'hash' },
			graphFingerprint: 'graph-old',
			assignee: undefined,
			activity: undefined,
			handoff: undefined,
			evidence: [],
			blockReason: undefined,
			updatedAt: '2026-09-01T00:00:00.000Z',
		})
		provider.updateDefinition = async (input) => {
			provider.calls.push(`update:${input.artifact.id}`)
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'provider_failed', message: 'injected' },
			}
		}
		const providerWithBatch: LedgerProvider = Object.assign(provider, {
			createDefinitions: async (definitions: readonly LedgerDefinitionInput[]) => {
				provider.calls.push(`batch:${definitions.map(({ artifact: item }) => item.id).join(',')}`)
				return { ok: true as const, value: [] }
			},
		})
		const plan = planSync({ graph: mixedGraph, ledgerItems: [...provider.items.values()] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		expect(plan.value.actions.slice(0, 2)).toStrictEqual([
			{ type: 'update', workId: 'PRD-1' },
			{ type: 'create', workId: 'ISSUE-1' },
		])

		const applied = await applySyncPlan({
			graph: mixedGraph,
			plan: plan.value,
			provider: providerWithBatch,
		})
		expect(applied).toMatchObject({ ok: false, error: { code: 'sync_apply_failed' } })
		if (!applied.ok) {
			expect(applied.error.details).toContain('applied=0')
		}
		expect(provider.calls).toStrictEqual(['update:PRD-1'])
	})
})
