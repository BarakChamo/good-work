/**
 * @description Verifies sync rejects malformed or semantically incorrect provider success values.
 *
 * @module work/sync
 * @file Sync-provider-boundary.test.ts
 */

import { describe, expect, it } from 'vitest'

import type { CompiledWorkGraph, WorkArtifact } from './contracts'
import { WORK_DEFINITION_LIMITS } from './contracts'
import type {
	LedgerDefinitionBatchResult,
	LedgerDefinitionInput,
	LedgerItem,
	LedgerProvider,
	LedgerRelationsInput,
} from './provider'
import { applySyncPlan, planSync } from './sync'

const hash = 'a'.repeat(64)
const timestamp = '2026-09-03T00:00:00.000Z'

const artifact = (input: Partial<WorkArtifact> & Pick<WorkArtifact, 'id'>): WorkArtifact => ({
	id: input.id,
	title: input.title ?? input.id,
	kind: input.kind ?? 'issue',
	execution: input.execution ?? 'task',
	...(input.parentId === undefined ? {} : { parentId: input.parentId }),
	source: input.source ?? { path: `docs/${input.id}.md`, hash },
	dependencies: input.dependencies ?? [],
	acceptance: input.acceptance ?? [],
	owners: input.owners ?? [],
	roles: input.roles ?? ['coder'],
	evidenceRequirements: input.evidenceRequirements ?? ['test'],
	body: input.body ?? `Definition for ${input.id}.`,
})

const graphFor = (...items: readonly WorkArtifact[]): CompiledWorkGraph => ({
	schemaVersion: 1,
	projectId: 'example',
	fingerprint: hash,
	items,
})

const itemFor = (input: {
	readonly artifact: WorkArtifact
	readonly projectId?: string
	readonly workId?: string
	readonly status?: LedgerItem['status']
	readonly parentId?: string
	readonly dependencies?: readonly string[]
}): LedgerItem => ({
	definitionSchemaVersion: 2,
	providerId: `provider-${input.workId ?? input.artifact.id}`,
	projectId: input.projectId ?? 'example',
	workId: input.workId ?? input.artifact.id,
	title: input.artifact.title,
	kind: input.artifact.kind,
	status: input.status ?? 'open',
	parentId: input.parentId,
	dependencies: input.dependencies ?? [],
	roles: input.artifact.roles,
	evidenceRequirements: input.artifact.evidenceRequirements,
	source: input.artifact.source,
	graphFingerprint: hash,
	assignee: undefined,
	activity: undefined,
	handoff: undefined,
	evidence: [],
	blockReason: undefined,
	updatedAt: timestamp,
})

const providerWith = (overrides: Partial<LedgerProvider>): LedgerProvider => ({
	doctor: async () => ({ ok: true, value: { provider: 'malicious', version: '1' } }),
	list: async () => ({ ok: true, value: [] }),
	createDefinition: async (input) => ({
		ok: true,
		value: itemFor({ artifact: input.artifact }),
	}),
	updateDefinition: async (input) => ({
		ok: true,
		value: itemFor({ artifact: input.artifact }),
	}),
	setRelations: async (input) => ({
		ok: true,
		value: itemFor({
			artifact: artifact({ id: input.workId }),
			...(input.parentId === undefined ? {} : { parentId: input.parentId }),
			dependencies: input.dependencies,
		}),
	}),
	archive: async (workId) => ({
		ok: true,
		value: itemFor({ artifact: artifact({ id: workId }), status: 'archived' }),
	}),
	...overrides,
})

const applyCreate = async (provider: LedgerProvider, graph: CompiledWorkGraph) => {
	const plan = planSync({ graph, ledgerItems: [] })
	if (!plan.ok) {
		throw new Error(plan.error.message)
	}
	return applySyncPlan({ graph, plan: plan.value, provider })
}

const expectInvalidProviderSuccess = (result: Awaited<ReturnType<typeof applySyncPlan>>): void => {
	expect(result.ok).toBe(false)
	if (result.ok) {
		return
	}
	expect(result.error.code).toBe('sync_apply_failed')
	expect(result.error.details).toContain('providerCode=invalid_ledger_projection')
	expect(result.error.details).toContain('stateMayHaveChanged=true')
}

describe('applySyncPlan provider success boundary', () => {
	it.each([
		{ name: 'project', projectId: 'other', workId: 'ISSUE-1' },
		{ name: 'work ID', projectId: 'example', workId: 'ISSUE-2' },
	])('rejects a single create result for the wrong $name', async ({ projectId, workId }) => {
		expect.hasAssertions()
		const definition = artifact({ id: 'ISSUE-1' })
		const projectGraph = graphFor(definition)
		const provider = providerWith({
			createDefinition: async () => ({
				ok: true,
				value: itemFor({ artifact: definition, projectId, workId }),
			}),
		})

		const result = await applyCreate(provider, projectGraph)

		expectInvalidProviderSuccess(result)
	})

	it('rejects a single update result whose definition does not match the requested artifact', async () => {
		expect.hasAssertions()
		const previous = artifact({ id: 'ISSUE-1', title: 'Previous' })
		const revised = artifact({ id: 'ISSUE-1', title: 'Revised' })
		const projectGraph = graphFor(revised)
		const ledgerItem = itemFor({ artifact: previous })
		const plan = planSync({ graph: projectGraph, ledgerItems: [ledgerItem] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const provider = providerWith({
			updateDefinition: async () => ({ ok: true, value: ledgerItem }),
		})

		const result = await applySyncPlan({ graph: projectGraph, plan: plan.value, provider })

		expectInvalidProviderSuccess(result)
	})

	it('rejects a relation result that does not contain the requested exact relation set', async () => {
		expect.hasAssertions()
		const parent = artifact({ id: 'PRD-1', kind: 'prd' })
		const dependency = artifact({ id: 'ISSUE-0' })
		const child = artifact({
			id: 'ISSUE-1',
			parentId: parent.id,
			dependencies: [dependency.id],
		})
		const projectGraph = graphFor(parent, dependency, child)
		const ledgerItems = [parent, dependency, child].map((entry) => itemFor({ artifact: entry }))
		const plan = planSync({ graph: projectGraph, ledgerItems })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const provider = providerWith({
			setRelations: async (input: LedgerRelationsInput) => ({
				ok: true,
				value: itemFor({
					artifact: child,
					...(input.parentId === undefined ? {} : { parentId: input.parentId }),
					dependencies: [],
				}),
			}),
		})

		const result = await applySyncPlan({ graph: projectGraph, plan: plan.value, provider })

		expectInvalidProviderSuccess(result)
	})

	it('rejects an archive result that did not reach archived status', async () => {
		expect.hasAssertions()
		const removed = artifact({ id: 'ISSUE-OLD' })
		const projectGraph = graphFor()
		const plan = planSync({
			graph: projectGraph,
			ledgerItems: [itemFor({ artifact: removed })],
			archiveMissing: true,
		})
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const provider = providerWith({
			archive: async () => ({
				ok: true,
				value: itemFor({ artifact: removed, status: 'closed' }),
			}),
		})

		const result = await applySyncPlan({ graph: projectGraph, plan: plan.value, provider })

		expectInvalidProviderSuccess(result)
	})

	it.each([
		{
			name: 'wrong ordered work ID',
			mutate: (items: readonly LedgerItem[]) => [items[1], items[0]],
		},
		{
			name: 'duplicate work ID',
			mutate: (items: readonly LedgerItem[]) => [items[0], items[0]],
		},
		{
			name: 'oversized item',
			mutate: (items: readonly LedgerItem[]) => [
				{ ...items[0], title: 'x'.repeat(WORK_DEFINITION_LIMITS.titleBytes + 1) },
				items[1],
			],
		},
		{
			name: 'wrong initial status',
			mutate: (items: readonly LedgerItem[]) => [
				{ ...items[0], status: 'in_progress' as const },
				items[1],
			],
		},
	])('rejects a batch success with $name', async ({ mutate }) => {
		expect.hasAssertions()
		const definitions = [artifact({ id: 'ISSUE-1' }), artifact({ id: 'ISSUE-2' })]
		const projectGraph = graphFor(...definitions)
		const provider = providerWith({
			createDefinitions: async (
				inputs: readonly LedgerDefinitionInput[],
			): Promise<LedgerDefinitionBatchResult> => {
				const items = inputs.map((input) => itemFor({ artifact: input.artifact }))
				return {
					ok: true,
					value: mutate(items).filter((item): item is LedgerItem => item !== undefined),
				}
			},
		})

		const result = await applyCreate(provider, projectGraph)

		expectInvalidProviderSuccess(result)
	})

	it.each([
		{ name: 'negative applied count', applied: -1, failedIndex: 0 },
		{ name: 'fractional applied count', applied: 0.5, failedIndex: 0 },
		{ name: 'non-finite applied count', applied: Number.NaN, failedIndex: 0 },
		{ name: 'applied count above batch size', applied: 3, failedIndex: undefined },
		{ name: 'negative failed index', applied: 0, failedIndex: -1 },
		{ name: 'failed index outside the batch', applied: 0, failedIndex: 2 },
		{ name: 'failed index after a fully applied batch', applied: 2, failedIndex: 1 },
	])('rejects a batch failure with $name', async ({ applied, failedIndex }) => {
		expect.hasAssertions()
		const definitions = [artifact({ id: 'ISSUE-1' }), artifact({ id: 'ISSUE-2' })]
		const projectGraph = graphFor(...definitions)
		const provider = providerWith({
			createDefinitions: async () => ({
				ok: false,
				applied,
				...(failedIndex === undefined ? {} : { failedIndex }),
				error: {
					type: 'work_contract_error',
					code: 'provider_failed',
					message: 'malicious failure envelope',
				},
			}),
		})

		const result = await applyCreate(provider, projectGraph)

		expectInvalidProviderSuccess(result)
		if (!result.ok) {
			expect(result.error.details).toContain('applied=0')
		}
	})
})

describe('planSync provider projection boundary', () => {
	it('rejects a schema-invalid provider item before planning mutations', () => {
		expect.hasAssertions()
		const definition = artifact({ id: 'ISSUE-1' })
		const malformed: LedgerItem = {
			...itemFor({ artifact: definition }),
			providerId: 'x'.repeat(2001),
		}

		const result = planSync({ graph: graphFor(definition), ledgerItems: [malformed] })

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid_ledger_projection' },
		})
	})

	it('rejects provider work from another project before planning mutations', () => {
		expect.hasAssertions()
		const definition = artifact({ id: 'ISSUE-1' })
		const foreign = itemFor({ artifact: definition, projectId: 'other' })

		const result = planSync({ graph: graphFor(definition), ledgerItems: [foreign] })

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'invalid_ledger_projection' },
		})
	})
})
