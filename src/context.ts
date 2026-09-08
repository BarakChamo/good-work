/**
 * @description Builds bounded agent context from authoritative definitions and current ledger state.
 *
 * @module work/context
 * @file Context.ts
 */

import type { CompiledWorkGraph, ContextPacket, WorkArtifact, WorkResult } from './contracts'
import type { LedgerItem } from './provider'
import { StringDecoder } from 'node:string_decoder'

const truncateUtf8 = (source: string, maxBytes: number): string => {
	const encoded = Buffer.from(source, 'utf8')
	if (encoded.byteLength <= maxBytes) {
		return source
	}
	const suffix = '\n\n[context truncated]\n'
	const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
	const decoder = new StringDecoder('utf8')
	const prefix = decoder.write(encoded.subarray(0, available)).trimEnd()
	return `${prefix}${suffix}`
}

const ancestors = (graph: CompiledWorkGraph, item: WorkArtifact): readonly WorkArtifact[] => {
	const byId = new Map(graph.items.map((entry) => [entry.id, entry]))
	const result: WorkArtifact[] = []
	const seen = new Set([item.id])
	let parentId = item.parentId
	while (parentId !== undefined && !seen.has(parentId)) {
		seen.add(parentId)
		const parent = byId.get(parentId)
		if (parent === undefined) {
			break
		}
		result.push(parent)
		parentId = parent.parentId
	}
	return result.toReversed()
}

const renderLedger = (item: LedgerItem): readonly string[] => {
	const lines = [`Status: ${item.status}`]
	if (item.assignee !== undefined) {
		lines.push(`Assignee: ${item.assignee}`)
	}
	if (item.activity?.role !== undefined) {
		lines.push(`Role: ${item.activity.role}`)
	}
	if (item.activity?.session !== undefined) {
		lines.push(`Session: ${item.activity.session}`)
	}
	if (item.activity !== undefined) {
		lines.push(`Last activity: ${item.activity.touchedAt}`)
	}
	if (item.blockReason !== undefined) {
		lines.push(`Blocked: ${item.blockReason}`)
	}
	if (item.handoff !== undefined) {
		lines.push('', '### Latest handoff', item.handoff.summary)
		if (item.handoff.remaining.length > 0) {
			lines.push('Remaining:', ...item.handoff.remaining.map((entry) => `- ${entry}`))
		}
		if (item.handoff.references.length > 0) {
			lines.push('References:', ...item.handoff.references.map((entry) => `- ${entry}`))
		}
	}
	if (item.evidence.length > 0) {
		lines.push(
			'',
			'### Evidence',
			...item.evidence.map(({ kind, reference, digest }) => `- ${kind}: ${reference} (${digest})`),
		)
	}
	return lines
}

/** @description Builds bounded current-operation context from definition and ledger state. */
export const buildOperationalContext = (input: {
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
	readonly itemId: string
	readonly maxBytes: number
}): WorkResult<ContextPacket> => {
	if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 256 || input.maxBytes > 1_000_000) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_context_budget',
				message: 'Context budget must be between 256 and 1000000 bytes.',
			},
		}
	}
	const item = input.graph.items.find(({ id }) => id === input.itemId)
	if (item === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_not_found',
				message: 'Unknown work item.',
			},
		}
	}
	const ledgerById = new Map<string, LedgerItem>()
	for (const ledgerItem of input.ledgerItems) {
		if (ledgerById.has(ledgerItem.workId)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: `Ledger contains duplicate work ID ${ledgerItem.workId}.`,
				},
			}
		}
		ledgerById.set(ledgerItem.workId, ledgerItem)
	}
	const current = ledgerById.get(item.id)
	if (current === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'ledger_not_synchronized',
				message: `${item.id} has not been synchronized to the ledger.`,
			},
		}
	}
	const lineage = ancestors(input.graph, item)
	const dependencyState = item.dependencies.map(
		(id) => `${id}: ${ledgerById.get(id)?.status ?? 'missing'}`,
	)
	const directChildren = input.graph.items.filter(({ parentId }) => parentId === item.id)
	const aggregateState =
		item.execution === 'aggregate'
			? directChildren.map(
					(child) => `${child.id}: ${ledgerById.get(child.id)?.status ?? 'missing'}`,
				)
			: []
	const full = [
		`# Work context: ${item.id}`,
		`Graph: ${input.graph.fingerprint}`,
		'',
		'## Current operation',
		...renderLedger(current),
		...(dependencyState.length === 0
			? []
			: ['', '## Dependency state', ...dependencyState.map((entry) => `- ${entry}`)]),
		...(item.execution === 'aggregate'
			? [
					'',
					'## Aggregate child state',
					...(aggregateState.length === 0
						? ['- No direct children are defined.']
						: aggregateState.map((entry) => `- ${entry}`)),
				]
			: []),
		...(lineage.length === 0
			? []
			: ['', '## Lineage', ...lineage.map(({ id, title }) => `- ${id}: ${title}`)]),
		'',
		`## Definition: ${item.id}: ${item.title}`,
		`Kind: ${item.kind}`,
		`Execution: ${item.execution}`,
		`Source: ${item.source.path}`,
		...(item.parentId === undefined ? [] : [`Parent: ${item.parentId}`]),
		...(item.roles.length === 0 ? [] : [`Roles: ${item.roles.join(', ')}`]),
		...(item.acceptance.length === 0
			? []
			: ['Acceptance:', ...item.acceptance.map((entry) => `- ${entry}`)]),
		...(item.evidenceRequirements.length === 0
			? []
			: [`Required evidence: ${item.evidenceRequirements.join(', ')}`]),
		'',
		item.body,
		'',
	].join('\n')
	const markdown = truncateUtf8(full, input.maxBytes)
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			itemId: item.id,
			graphFingerprint: input.graph.fingerprint,
			markdown,
			truncated: markdown !== full,
		},
	}
}
