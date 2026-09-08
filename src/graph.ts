/**
 * @description Produces bounded descendant projections from compiled work graphs.
 *
 * @module work/graph
 * @file Graph.ts
 */

import type { CompiledWorkGraph, WorkArtifact, WorkGraphProjection, WorkResult } from './contracts'

const findItem = (graph: CompiledWorkGraph, id: string): WorkArtifact | undefined =>
	graph.items.find((item) => item.id === id)

/** @description Projects a bounded deterministic descendant view from one graph node. */
export const projectGraph = (input: {
	readonly graph: CompiledWorkGraph
	readonly rootId: string
	readonly depth: number
}): WorkResult<WorkGraphProjection> => {
	if (!Number.isSafeInteger(input.depth) || input.depth < 0 || input.depth > 20) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_depth',
				message: 'Graph depth must be an integer between 0 and 20.',
			},
		}
	}
	if (findItem(input.graph, input.rootId) === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_not_found',
				message: 'Unknown work item.',
			},
		}
	}

	const selected = new Set([input.rootId])
	let frontier = [input.rootId]
	for (let level = 0; level < input.depth; level += 1) {
		const parents = new Set(frontier)
		const next = input.graph.items
			.filter((item) => item.parentId !== undefined && parents.has(item.parentId))
			.map(({ id }) => id)
			.toSorted()
		for (const id of next) {
			selected.add(id)
		}
		frontier = next
	}
	return {
		ok: true,
		value: {
			rootId: input.rootId,
			depth: input.depth,
			items: input.graph.items.filter(({ id }) => selected.has(id)),
		},
	}
}
