/**
 * @description Verifies deterministic bounded graph projections.
 *
 * @module work/graph
 * @file Graph.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Graph tests assert after Result narrowing. */

import { describe, expect, it } from 'vitest'

import { projectGraph } from './graph'
import type { CompiledWorkGraph } from './contracts'

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'example',
	fingerprint: 'fingerprint',
	items: [
		{
			id: 'INIT-1',
			kind: 'initiative',
			execution: 'task',
			title: 'Initiative',
			source: { path: 'docs/initiatives/INIT-1.md', hash: 'a' },
			dependencies: [],
			acceptance: [],
			owners: [],
			roles: [],
			evidenceRequirements: [],
			body: 'Top-level outcome.',
		},
		{
			id: 'PRD-1',
			kind: 'prd',
			execution: 'task',
			title: 'PRD',
			parentId: 'INIT-1',
			source: { path: 'docs/prds/PRD-1.md', hash: 'b' },
			dependencies: [],
			acceptance: ['Deliver work.'],
			owners: [],
			roles: [],
			evidenceRequirements: [],
			body: 'Product detail '.repeat(100),
		},
		{
			id: 'ISSUE-1',
			kind: 'issue',
			execution: 'task',
			title: 'Issue',
			parentId: 'PRD-1',
			source: { path: 'docs/issues/ISSUE-1.md', hash: 'c' },
			dependencies: [],
			acceptance: ['Tests pass.'],
			owners: ['src'],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
			body: 'Issue detail '.repeat(100),
		},
	],
}

describe('work graph projections', () => {
	it('projects bounded descendants without treating containment as a blocking dependency', () => {
		const projection = projectGraph({ graph, rootId: 'INIT-1', depth: 1 })

		expect(projection.ok).toBe(true)
		if (!projection.ok) {
			return
		}
		expect(projection.value.items.map(({ id }) => id)).toStrictEqual(['INIT-1', 'PRD-1'])
	})
})
