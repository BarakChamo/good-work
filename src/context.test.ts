/**
 * @description Verifies bounded definition and current-operation context for agent session startup.
 *
 * @module work/context
 * @file Context.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Context tests assert after Result narrowing. */

import { describe, expect, it } from 'vitest'

import type { CompiledWorkGraph } from './contracts'
import { buildOperationalContext } from './context'
import type { LedgerItem } from './provider'

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'demo',
	fingerprint: 'graph-1',
	items: [
		{
			id: 'ISSUE-1',
			kind: 'issue',
			execution: 'task',
			title: 'Dependency',
			source: { path: 'docs/ISSUE-1.md', hash: 'a' },
			dependencies: [],
			acceptance: [],
			owners: [],
			roles: ['coder'],
			evidenceRequirements: [],
			body: '# ISSUE-1 Dependency',
		},
		{
			id: 'ISSUE-2',
			kind: 'issue',
			execution: 'task',
			title: 'Target',
			source: { path: 'docs/ISSUE-2.md', hash: 'b' },
			dependencies: ['ISSUE-1'],
			acceptance: ['It works'],
			owners: [],
			roles: ['coder'],
			evidenceRequirements: ['test'],
			body: '# ISSUE-2 Target\n\nDetails.',
		},
	],
}

const ledger = (input: Partial<LedgerItem> & Pick<LedgerItem, 'workId'>): LedgerItem => ({
	definitionSchemaVersion: 2,
	providerId: `bd-${input.workId}`,
	projectId: 'demo',
	title: input.workId,
	kind: 'issue',
	status: 'open',
	parentId: undefined,
	dependencies: [],
	roles: [],
	evidenceRequirements: [],
	source: { path: 'x', hash: 'x' },
	graphFingerprint: 'graph-1',
	assignee: undefined,
	activity: undefined,
	handoff: undefined,
	evidence: [],
	blockReason: undefined,
	updatedAt: '2026-09-01T00:00:00.000Z',
	...input,
})

describe('operational context', () => {
	it('renders aggregate execution and direct-child state', () => {
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
		}
		const result = buildOperationalContext({
			graph: { ...graph, items: [aggregate, child] },
			itemId: aggregate.id,
			maxBytes: 1200,
			ledgerItems: [
				ledger({ workId: aggregate.id, execution: 'aggregate' }),
				ledger({ workId: child.id, parentId: aggregate.id, status: 'blocked' }),
			],
		})

		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.markdown).toContain('Execution: aggregate')
		expect(result.value.markdown).toContain('## Aggregate child state')
		expect(result.value.markdown).toContain('ISSUE-11: blocked')
	})

	it('combines bounded file definitions with current claims, handoffs, and dependency state', () => {
		const result = buildOperationalContext({
			graph,
			itemId: 'ISSUE-2',
			maxBytes: 1200,
			ledgerItems: [
				ledger({ workId: 'ISSUE-1', status: 'closed' }),
				ledger({
					workId: 'ISSUE-2',
					status: 'in_progress',
					assignee: 'agent-a',
					activity: {
						actor: 'agent-a',
						session: 'session-7',
						startedAt: '2026-09-01T00:00:00.000Z',
						touchedAt: '2026-09-01T00:10:00.000Z',
					},
					handoff: {
						actor: 'agent-z',
						summary: 'Parser complete',
						remaining: ['Add CLI'],
						references: ['src/parser.ts'],
						createdAt: '2026-09-01T00:00:00.000Z',
					},
				}),
			],
		})
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(result.value.markdown).toContain('Status: in_progress')
		expect(result.value.markdown).toContain('Assignee: agent-a')
		expect(result.value.markdown).toContain('Session: session-7')
		expect(result.value.markdown).toContain('ISSUE-1: closed')
		expect(result.value.markdown).toContain('Parser complete')
		expect(Buffer.byteLength(result.value.markdown)).toBeLessThanOrEqual(1200)
	})

	it('fails closed when the compiled item has no synchronized ledger record', () => {
		expect(
			buildOperationalContext({ graph, itemId: 'ISSUE-2', maxBytes: 500, ledgerItems: [] }),
		).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'ledger_not_synchronized' },
		})
	})

	it('truncates a maximum-size multibyte definition in linear time at a UTF-8 boundary', () => {
		const sourceItem = graph.items[0]
		if (sourceItem === undefined) {
			throw new Error('Missing fixture item.')
		}
		const largeGraph: CompiledWorkGraph = {
			...graph,
			items: [
				{
					...sourceItem,
					body: '界'.repeat(1_666_666),
				},
			],
		}
		const startedAt = performance.now()

		const result = buildOperationalContext({
			graph: largeGraph,
			itemId: 'ISSUE-1',
			maxBytes: 12_000,
			ledgerItems: [ledger({ workId: 'ISSUE-1' })],
		})

		expect(performance.now() - startedAt).toBeLessThan(2000)
		expect(result.ok).toBe(true)
		if (!result.ok) {
			return
		}
		expect(Buffer.byteLength(result.value.markdown, 'utf8')).toBeLessThanOrEqual(12_000)
		expect(result.value.markdown).toContain('[context truncated]')
		expect(result.value.markdown).not.toContain('\uFFFD')
	})

	it('renders maximum-depth lineage without quadratic front insertion', () => {
		const items = Array.from({ length: 10_000 }, (_, index) => ({
			id: `ISSUE-${index}`,
			kind: 'issue' as const,
			execution: 'task' as const,
			title: `Issue ${index}`,
			...(index === 0 ? {} : { parentId: `ISSUE-${index - 1}` }),
			source: { path: `docs/ISSUE-${index}.md`, hash: 'a' },
			dependencies: [],
			acceptance: [],
			owners: [],
			roles: [],
			evidenceRequirements: [],
			body: `# ISSUE-${index}`,
		}))
		const startedAt = performance.now()

		const result = buildOperationalContext({
			graph: { ...graph, items },
			itemId: 'ISSUE-9999',
			maxBytes: 12_000,
			ledgerItems: [ledger({ workId: 'ISSUE-9999' })],
		})

		expect(performance.now() - startedAt).toBeLessThan(2000)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(Buffer.byteLength(result.value.markdown, 'utf8')).toBeLessThanOrEqual(12_000)
		}
	})
})
