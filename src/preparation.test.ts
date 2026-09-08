/**
 * @description Proves safe ID/path resolution and startability for agent launch packets.
 *
 * @module work/preparation
 * @file Preparation.test.ts
 */

import { describe, expect, it } from 'vitest'

import type { CompiledWorkGraph } from './contracts'
import { prepareWorkLaunch } from './preparation'
import type { LedgerItem } from './provider'

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'demo',
	fingerprint: 'a'.repeat(64),
	items: [
		{
			id: 'ISSUE-1',
			kind: 'issue',
			execution: 'task',
			title: 'Dependency',
			source: { path: 'docs/work/ISSUE-1.md', hash: 'b'.repeat(64) },
			dependencies: [],
			acceptance: ['Done'],
			owners: [],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
			body: '# ISSUE-1 Dependency',
		},
		{
			id: 'ISSUE-2',
			kind: 'issue',
			execution: 'task',
			title: 'Target',
			source: { path: 'docs/work/ISSUE-2.md', hash: 'c'.repeat(64) },
			dependencies: ['ISSUE-1'],
			acceptance: ['Done'],
			owners: [],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
			body: '# ISSUE-2 Target',
		},
	],
}

const artifactAt = (index: number) => {
	const artifact = graph.items[index]
	if (artifact === undefined) {
		throw new Error(`Missing graph fixture at ${index}`)
	}
	return artifact
}

const ledgerItem = (workId: string, status: LedgerItem['status']): LedgerItem => ({
	definitionSchemaVersion: 2,
	providerId: `provider-${workId}`,
	projectId: 'demo',
	workId,
	title: graph.items.find(({ id }) => id === workId)?.title ?? workId,
	kind: 'issue',
	status,
	parentId: undefined,
	dependencies: workId === 'ISSUE-2' ? ['ISSUE-1'] : [],
	roles: graph.items.find(({ id }) => id === workId)?.roles ?? [],
	evidenceRequirements: graph.items.find(({ id }) => id === workId)?.evidenceRequirements ?? [],
	source: graph.items.find(({ id }) => id === workId)?.source ?? {
		path: `docs/work/${workId}.md`,
		hash: 'd'.repeat(64),
	},
	graphFingerprint: graph.fingerprint,
	assignee: undefined,
	activity: undefined,
	handoff: undefined,
	evidence: [],
	blockReason: undefined,
	updatedAt: '2026-09-02T00:00:00.000Z',
})

describe('agent work preparation', () => {
	it('rejects aggregate definitions as non-executable', () => {
		expect.hasAssertions()
		const aggregate = {
			...artifactAt(0),
			id: 'ISSUE-10',
			title: 'Program',
			execution: 'aggregate' as const,
		}
		const aggregateGraph = { ...graph, items: [...graph.items, aggregate] }
		const aggregateLedger = {
			...ledgerItem(aggregate.id, 'open'),
			title: aggregate.title,
			source: aggregate.source,
			roles: aggregate.roles,
			evidenceRequirements: aggregate.evidenceRequirements,
			execution: 'aggregate' as const,
		}

		expect(
			prepareWorkLaunch({
				graph: aggregateGraph,
				ledgerItems: [
					ledgerItem('ISSUE-1', 'open'),
					ledgerItem('ISSUE-2', 'open'),
					aggregateLedger,
				],
				maxBytes: 1200,
				reference: aggregate.id,
			}),
		).toMatchObject({ ok: false, error: { code: 'aggregate_not_executable' } })
	})

	it('should produce the same bounded launch packet for a canonical ID or registered source path', () => {
		expect.hasAssertions()
		const ledgerItems = [ledgerItem('ISSUE-1', 'open'), ledgerItem('ISSUE-2', 'open')]
		const byId = prepareWorkLaunch({ graph, ledgerItems, maxBytes: 1200, reference: 'ISSUE-1' })
		const byPath = prepareWorkLaunch({
			graph,
			ledgerItems,
			maxBytes: 1200,
			reference: 'docs/work/ISSUE-1.md',
		})

		expect(byId).toMatchObject({
			ok: true,
			value: {
				workId: 'ISSUE-1',
				sourcePath: 'docs/work/ISSUE-1.md',
				startable: true,
				nextActions: [{ action: 'start' }],
			},
		})
		expect(byPath).toMatchObject({
			ok: true,
			value: { workId: 'ISSUE-1', sourcePath: 'docs/work/ISSUE-1.md', startable: true },
		})
	})

	it('returns an opaque shared-state observation and layer-owned start action', () => {
		expect.hasAssertions()
		const result = prepareWorkLaunch({
			graph,
			ledgerItems: [ledgerItem('ISSUE-1', 'open')],
			maxBytes: 1200,
			reference: 'ISSUE-1',
			providerState: {
				identity: 'a'.repeat(64),
				scope: 'repository',
				shared: true,
			},
		})

		expect(result).toMatchObject({
			ok: true,
			value: {
				providerState: {
					identity: 'a'.repeat(64),
					scope: 'repository',
					shared: true,
				},
				nextActions: [{ action: 'start', owner: 'work', command: 'work start' }],
			},
		})
		expect(JSON.stringify(result)).not.toContain('/Users/')
	})

	it('returns a non-mutating workspace action when policy admission fails', () => {
		expect.hasAssertions()
		const result = prepareWorkLaunch({
			graph,
			ledgerItems: [ledgerItem('ISSUE-1', 'open')],
			maxBytes: 1200,
			reference: 'ISSUE-1',
			deliveryPolicy: {
				profile: 'local-direct',
				isolation: 'worktree',
				integration: 'local',
				terminal: 'landed',
				targetRef: 'refs/heads/main',
				requiredGates: ['validation', 'landing'],
			},
			workspace: {
				available: true,
				repositoryId: 'a'.repeat(64),
				headSha: 'b'.repeat(40),
				treeSha: 'c'.repeat(40),
				ref: 'refs/heads/main',
				isolation: 'main',
				dirty: false,
			},
		})

		expect(result).toMatchObject({
			ok: true,
			value: {
				startable: false,
				admission: { admitted: false, reasons: ['linked_worktree_required'] },
				nextActions: [
					{ action: 'provision_workspace', owner: 'integration', isolation: 'worktree' },
				],
			},
		})
	})

	it.each(['../outside.md', '/absolute.md', 'docs/work/../ISSUE-1.md'])(
		'should reject unsafe work reference %s',
		(reference) => {
			expect.hasAssertions()
			expect(
				prepareWorkLaunch({
					graph,
					ledgerItems: [ledgerItem('ISSUE-1', 'open')],
					maxBytes: 1200,
					reference,
				}),
			).toMatchObject({ error: { code: 'unsafe_work_reference' }, ok: false })
		},
	)

	it('should reject unknown, active, terminal, and dependency-incomplete work', () => {
		expect.hasAssertions()
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [ledgerItem('ISSUE-1', 'open')],
				maxBytes: 1200,
				reference: 'missing.md',
			}),
		).toMatchObject({ error: { code: 'work_not_found' }, ok: false })
		for (const status of ['in_progress', 'blocked', 'closed', 'archived', 'deferred'] as const) {
			expect(
				prepareWorkLaunch({
					graph,
					ledgerItems: [ledgerItem('ISSUE-1', status)],
					maxBytes: 1200,
					reference: 'ISSUE-1',
				}),
			).toMatchObject({ error: { code: 'work_not_ready' }, ok: false })
		}
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [ledgerItem('ISSUE-1', 'open'), ledgerItem('ISSUE-2', 'open')],
				maxBytes: 1200,
				reference: 'ISSUE-2',
			}),
		).toMatchObject({ error: { code: 'work_not_ready' }, ok: false })
	})

	it('should require closed dependencies with all graph-required evidence', () => {
		expect.hasAssertions()
		const closedDependency = ledgerItem('ISSUE-1', 'closed')
		const target = ledgerItem('ISSUE-2', 'open')
		const dependencyEvidence = {
			kind: 'test' as const,
			reference: 'evidence/proof.json',
			digest: 'a'.repeat(64),
			recordedAt: '2026-09-02T00:00:00.000Z',
			actor: 'agent-a',
		}
		const successfulDependency = { ...closedDependency, evidence: [dependencyEvidence] }
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [closedDependency, target],
				maxBytes: 1200,
				reference: 'ISSUE-2',
			}),
		).toMatchObject({ error: { code: 'work_not_ready' }, ok: false })
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [successfulDependency, target],
				maxBytes: 1200,
				reference: 'ISSUE-2',
			}),
		).toMatchObject({ ok: true, value: { startable: true } })
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [{ ...successfulDependency, status: 'archived' }, target],
				maxBytes: 1200,
				reference: 'ISSUE-2',
			}),
		).toMatchObject({ error: { code: 'work_not_ready' }, ok: false })
	})

	it('should reject ambiguous and stale references before producing context', () => {
		expect.hasAssertions()
		const ambiguousArtifact = {
			...artifactAt(1),
			id: 'ISSUE-3',
			source: { path: 'ISSUE-1', hash: 'e'.repeat(64) },
			dependencies: [],
		}
		const ambiguousGraph = { ...graph, items: [...graph.items, ambiguousArtifact] }
		const ambiguousLedger = [
			ledgerItem('ISSUE-1', 'open'),
			{ ...ledgerItem('ISSUE-2', 'open'), workId: 'ISSUE-3', source: ambiguousArtifact.source },
		]
		expect(
			prepareWorkLaunch({
				graph: ambiguousGraph,
				ledgerItems: ambiguousLedger,
				maxBytes: 1200,
				reference: 'ISSUE-1',
			}),
		).toMatchObject({ error: { code: 'ambiguous_work_reference' }, ok: false })

		const synchronized = ledgerItem('ISSUE-1', 'open')
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [{ ...synchronized, graphFingerprint: 'f'.repeat(64) }],
				maxBytes: 1200,
				reference: 'ISSUE-1',
			}),
		).toMatchObject({ ok: true })
		expect(
			prepareWorkLaunch({
				graph,
				ledgerItems: [
					{ ...synchronized, source: { ...synchronized.source, hash: 'f'.repeat(64) } },
				],
				maxBytes: 1200,
				reference: 'ISSUE-1',
			}),
		).toMatchObject({ error: { code: 'definition_drift' }, ok: false })
	})

	it('should reject a launch packet whose serialized envelope exceeds its bound', () => {
		expect.hasAssertions()
		const oversizedGraph: CompiledWorkGraph = {
			...graph,
			items: [
				{
					...artifactAt(0),
					roles: Array.from({ length: 100 }, (_, index) => `${index}-${'r'.repeat(120)}`),
					body: 'body '.repeat(20_000),
				},
			],
		}
		const item = { ...ledgerItem('ISSUE-1', 'open'), roles: oversizedGraph.items[0]?.roles ?? [] }
		expect(
			prepareWorkLaunch({
				graph: oversizedGraph,
				ledgerItems: [item],
				maxBytes: 60_000,
				reference: 'ISSUE-1',
			}),
		).toMatchObject({ error: { code: 'invalid_context_budget' }, ok: false })
	})
})
