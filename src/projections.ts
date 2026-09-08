/**
 * @description Writes generated, replaceable file projections without treating them as work-state authority.
 *
 * @module work/projections
 * @file Projections.ts
 */

import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

import type { CompiledWorkGraph, WorkErrorCode, WorkResult } from './contracts'
import { prepareSafeOutputPath } from './paths'
import type { LedgerItem } from './provider'

const projectionError = (
	code: WorkErrorCode,
	message: string,
	details?: readonly string[],
): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code,
		message,
		...(details === undefined ? {} : { details }),
	},
})

const bindingMap = (
	graph: CompiledWorkGraph,
	ledgerItems: readonly LedgerItem[],
): WorkResult<ReadonlyMap<string, LedgerItem>> => {
	const byId = new Map<string, LedgerItem>()
	for (const item of ledgerItems.filter(({ projectId }) => projectId === graph.projectId)) {
		if (byId.has(item.workId)) {
			return projectionError(
				'invalid_ledger_projection',
				`Ledger contains duplicate work ID ${item.workId}.`,
			)
		}
		byId.set(item.workId, item)
	}
	for (const artifact of graph.items) {
		if (!byId.has(artifact.id)) {
			return projectionError('ledger_not_synchronized', `${artifact.id} has no ledger binding.`)
		}
	}
	return { ok: true, value: byId }
}

const writeProjection = async (
	root: string,
	path: string,
	value: unknown,
): Promise<WorkResult<{ readonly path: string }>> => {
	let temporary: string | undefined
	try {
		const safeTarget = await prepareSafeOutputPath({
			root,
			path,
			errorCode: 'unsafe_projection_path',
		})
		if (!safeTarget.ok) {
			return safeTarget
		}
		temporary = `${safeTarget.value}.${randomUUID()}.tmp`
		await writeFile(temporary, `${JSON.stringify(value, null, '\t')}\n`, { flag: 'wx' })
		await rename(temporary, safeTarget.value)
		return { ok: true, value: { path } }
	} catch {
		if (temporary !== undefined) {
			await rm(temporary, { force: true }).catch(() => false)
		}
		return projectionError('projection_write_failed', `Unable to write ${path}.`)
	}
}

/** @description Atomically writes the generated graph-to-provider binding lock. */
export const writeWorkLock = async (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
	readonly generatedAt?: string
}): Promise<WorkResult<{ readonly path: string }>> => {
	const byId = bindingMap(input.graph, input.ledgerItems)
	if (!byId.ok) {
		return byId
	}
	return writeProjection(input.root, '.work/lock.json', {
		schemaVersion: 1,
		projectId: input.graph.projectId,
		graphFingerprint: input.graph.fingerprint,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		bindings: input.graph.items.map((artifact) => ({
			workId: artifact.id,
			execution: artifact.execution,
			providerId: byId.value.get(artifact.id)?.providerId,
			source: artifact.source,
		})),
	})
}

/** @description Atomically writes a replaceable non-authoritative operational snapshot. */
export const writeWorkSnapshot = async (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
	readonly generatedAt?: string
}): Promise<WorkResult<{ readonly path: string }>> => {
	const byId = bindingMap(input.graph, input.ledgerItems)
	if (!byId.ok) {
		return byId
	}
	return writeProjection(input.root, '.work/snapshots/current.json', {
		schemaVersion: 1,
		authoritative: false,
		projectId: input.graph.projectId,
		graphFingerprint: input.graph.fingerprint,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		items: input.graph.items.map((artifact) => {
			const item = byId.value.get(artifact.id)
			const children =
				artifact.execution === 'aggregate'
					? input.graph.items.filter(({ parentId }) => parentId === artifact.id)
					: []
			const terminal = children.filter((child) => {
				const childItem = byId.value.get(child.id)
				const kinds = new Set(childItem?.evidence.map(({ kind }) => kind))
				return (
					childItem?.status === 'closed' &&
					child.evidenceRequirements.every((kind) => kinds.has(kind))
				)
			}).length
			return {
				workId: artifact.id,
				execution: artifact.execution,
				status: item?.status,
				...(item?.assignee === undefined ? {} : { assignee: item.assignee }),
				...(item?.activity === undefined ? {} : { activity: item.activity }),
				...(item?.handoff === undefined ? {} : { handoff: item.handoff }),
				evidence: item?.evidence ?? [],
				...(item?.blockReason === undefined ? {} : { blockReason: item.blockReason }),
				updatedAt: item?.updatedAt,
				...(artifact.execution === 'aggregate'
					? {
							aggregate: {
								total: children.length,
								open: children.filter(({ id }) => byId.value.get(id)?.status === 'open').length,
								active: children.filter(({ id }) => byId.value.get(id)?.status === 'in_progress')
									.length,
								blocked: children.filter(({ id }) => byId.value.get(id)?.status === 'blocked')
									.length,
								terminal,
								completionReady: children.length > 0 && terminal === children.length,
							},
						}
					: {}),
			}
		}),
	})
}
