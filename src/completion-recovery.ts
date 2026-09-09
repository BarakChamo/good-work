/**
 * @description Reconstructs disposable provider status from repository completion records.
 *
 * @module work/completion-recovery
 * @file Completion-recovery.ts
 */

import { buildCompletionRecord } from './completion-ledger'
import type { CompletionRecord } from './completion-ledger'
import type { CanonicalDefinitionRevision, CompiledWorkGraph, WorkResult } from './contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY } from './contracts'
import type { CollaborativeLedgerProvider, LedgerEvidence, LedgerItem } from './provider'
import { createWorkContractService } from './service'
import { loadReviewReceipt } from './review'

const deferrable = new Set(['work_not_ready', 'aggregate_not_ready'])

const sameEvidence = (
	actual: readonly LedgerEvidence[],
	expected: CompletionRecord['evidence'],
): boolean =>
	actual.length === expected.length &&
	expected.every((entry) =>
		actual.some(
			(candidate) =>
				candidate.kind === entry.kind &&
				candidate.reference === entry.reference &&
				candidate.digest === entry.digest,
		),
	)

const matchesClosedRecord = (item: LedgerItem, record: CompletionRecord): boolean => {
	const recordedActor = item.activity?.actor ?? item.evidence[0]?.actor
	return (
		item.status === 'closed' &&
		recordedActor === record.actor &&
		(record.role === undefined || item.activity?.role === record.role) &&
		(record.session === undefined || item.activity?.session === record.session) &&
		sameEvidence(item.evidence, record.evidence)
	)
}

const drift = (message: string): WorkResult<never> => ({
	ok: false,
	error: { type: 'work_contract_error', code: 'invalid_completion_record', message },
})

const applyRecord = async (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly record: CompletionRecord
	readonly current: LedgerItem
	readonly items: readonly LedgerItem[]
	readonly provider: CollaborativeLedgerProvider
	readonly definitionRevision?: CanonicalDefinitionRevision
}): Promise<WorkResult<unknown>> => {
	const { record } = input
	const service = createWorkContractService({
		root: input.root,
		graph: input.graph,
		provider: input.provider,
		initialLedgerItems: input.items,
		deliveryPolicy: EVIDENCE_ONLY_DELIVERY_POLICY,
		historicalReviewRecovery: true,
		clock: () => new Date(record.completedAt ?? record.reopenedAt ?? new Date().toISOString()),
		...(input.definitionRevision === undefined
			? {}
			: { definitionRevision: input.definitionRevision }),
	})
	if (record.state === 'open') {
		return service.reopen({
			workId: record.workId,
			actor: record.actor,
			...(record.role === undefined ? {} : { role: record.role }),
			...(record.session === undefined ? {} : { session: record.session }),
			reason: record.reason ?? 'Repository completion record reopened this work.',
		})
	}
	const artifact = input.graph.items.find(({ id }) => id === record.workId)
	const restoreReview = async (): Promise<WorkResult<unknown>> => {
		if (artifact?.execution !== 'task' || !artifact.evidenceRequirements.includes('review')) {
			return { ok: true, value: undefined }
		}
		if (input.current.review !== undefined) {
			return { ok: true, value: undefined }
		}
		const receipt = await loadReviewReceipt({ root: input.root, workId: record.workId })
		if (!receipt.ok) {
			return receipt
		}
		if (receipt.value?.disposition !== 'approved') {
			return drift(`${record.workId} has no approved repository review receipt.`)
		}
		return service.recordReview({
			workId: record.workId,
			reviewerActor: receipt.value.reviewer.actor,
			...(receipt.value.reviewer.session === undefined
				? {}
				: { reviewerSession: receipt.value.reviewer.session }),
			evaluator: receipt.value.reviewer.evaluator,
			disposition: receipt.value.disposition,
			reportReference: receipt.value.report.reference,
			reviewedHead: receipt.value.subject.headSha,
		})
	}
	if (artifact?.execution === 'aggregate' || input.current.status !== 'open') {
		const reviewed = await restoreReview()
		return reviewed.ok
			? service.complete({
					workId: record.workId,
					actor: record.actor,
					...(record.role === undefined ? {} : { role: record.role }),
					...(record.session === undefined ? {} : { session: record.session }),
					evidence: record.evidence,
				})
			: reviewed
	}
	const claimed = await service.claim({
		workId: record.workId,
		actor: record.actor,
		...(record.role === undefined ? {} : { role: record.role }),
		...(record.session === undefined ? {} : { session: record.session }),
	})
	if (!claimed.ok) {
		return claimed
	}
	const reviewed = await restoreReview()
	return reviewed.ok
		? service.complete({
				workId: record.workId,
				actor: record.actor,
				...(record.role === undefined ? {} : { role: record.role }),
				...(record.session === undefined ? {} : { session: record.session }),
				evidence: record.evidence,
			})
		: reviewed
}

/** @description Applies current repository completion state to a disposable provider store. */
export const restoreCompletionLedger = async (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly records: readonly CompletionRecord[]
	readonly provider: CollaborativeLedgerProvider
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly workId?: string
}): Promise<WorkResult<{ readonly restored: number }>> => {
	const graphWorkIds = new Set(input.graph.items.map(({ id }) => id))
	const scopedWorkIds = input.workId === undefined ? graphWorkIds : new Set([input.workId])
	const pending = input.records.filter(
		({ workId }) => graphWorkIds.has(workId) && scopedWorkIds.has(workId),
	)
	for (const record of pending) {
		if (record.state !== 'closed') {
			continue
		}
		const artifact = input.graph.items.find(({ id }) => id === record.workId)
		if (artifact === undefined) {
			return drift(`${record.workId} has no active definition.`)
		}
		const verified = await buildCompletionRecord({
			root: input.root,
			workId: record.workId,
			actor: record.actor,
			...(record.role === undefined ? {} : { role: record.role }),
			...(record.session === undefined ? {} : { session: record.session }),
			...(record.implementation === undefined ? {} : { implementation: record.implementation }),
			...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
			requiredEvidence: artifact.evidenceRequirements,
			evidence: record.evidence,
		})
		if (!verified.ok) {
			return verified
		}
	}
	let restored = 0
	const initial = await input.provider.list()
	if (!initial.ok) {
		return initial
	}
	let items = initial.value
	const recordsByWorkId = new Map(pending.map((record) => [record.workId, record]))
	for (const item of items) {
		if (
			item.projectId === input.graph.projectId &&
			scopedWorkIds.has(item.workId) &&
			item.status === 'closed' &&
			!recordsByWorkId.has(item.workId)
		) {
			return drift(
				`${item.workId} is closed only in disposable state; restore or add its repository completion record.`,
			)
		}
	}
	while (pending.length > 0) {
		let progressed = false
		let deferredError: WorkResult<never> | undefined
		for (let index = 0; index < pending.length;) {
			const record = pending[index]
			if (record === undefined) {
				break
			}
			const current = items.find(
				({ projectId, workId }) => projectId === input.graph.projectId && workId === record.workId,
			)
			if (current === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: `${record.workId} has no disposable provider binding.`,
					},
				}
			}
			if (record.state === 'closed' && current.status === 'closed') {
				if (!matchesClosedRecord(current, record)) {
					return drift(`${record.workId} disposable completion differs from its repository record.`)
				}
				pending.splice(index, 1)
				progressed = true
				continue
			}
			if (record.state === 'open' && current.status !== 'closed') {
				pending.splice(index, 1)
				progressed = true
				continue
			}
			const result = await applyRecord({
				root: input.root,
				graph: input.graph,
				record,
				current,
				items,
				provider: input.provider,
				...(input.definitionRevision === undefined
					? {}
					: { definitionRevision: input.definitionRevision }),
			})
			if (!result.ok) {
				if (deferrable.has(result.error.code)) {
					deferredError = result
					index += 1
					continue
				}
				return result
			}
			pending.splice(index, 1)
			restored += 1
			progressed = true
			const refreshed = await input.provider.list()
			if (!refreshed.ok) {
				return refreshed
			}
			items = refreshed.value
		}
		if (!progressed) {
			return (
				deferredError ?? {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_completion_record',
						message: 'Completion ledger could not be reconstructed.',
					},
				}
			)
		}
	}
	return { ok: true, value: { restored } }
}
