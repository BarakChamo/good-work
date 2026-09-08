/**
 * @description Evaluates candidate-bound delivery gates using read-only repository observations.
 *
 * @module work/delivery
 * @file Delivery.ts
 */

import { createHash } from 'node:crypto'

import { safeParse } from 'valibot'

import type { WorkDeliveryPolicy, WorkResult } from './contracts'
import { observeGitWorkspace } from './git-observer'
import type { LedgerCandidate, LedgerGateReceipt, LedgerItem } from './provider'
import { LedgerGateReceiptSchema } from './provider'
import { readBoundedContainedUtf8 } from './files'
import { executeFile } from './subprocess'

const gitOutput = async (root: string, args: readonly string[]): Promise<string> => {
	const result = await executeFile('git', args, {
		cwd: root,
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	})
	return result.stdout.trim()
}

const receiptMatches = (receipt: LedgerGateReceipt, candidate: LedgerCandidate): boolean =>
	receipt.candidateGeneration === candidate.generation &&
	receipt.projectId === candidate.projectId &&
	receipt.workId === candidate.workId &&
	receipt.graphFingerprint === candidate.graphFingerprint &&
	receipt.repositoryId === candidate.repositoryId &&
	receipt.headSha === candidate.headSha &&
	receipt.treeSha === candidate.treeSha

const createLandingReceipt = (input: {
	readonly candidate: LedgerCandidate
	readonly targetRef: string
	readonly targetSha: string
}): LedgerGateReceipt => ({
	schemaVersion: 1,
	gate: 'landing',
	result: 'passed',
	candidateGeneration: input.candidate.generation,
	projectId: input.candidate.projectId,
	workId: input.candidate.workId,
	graphFingerprint: input.candidate.graphFingerprint,
	repositoryId: input.candidate.repositoryId,
	headSha: input.candidate.headSha,
	treeSha: input.candidate.treeSha,
	issuer: { kind: 'adapter', id: 'work-contract:git' },
	reference: `git:${input.targetRef}@${input.targetSha}`,
	digest: createHash('sha256')
		.update(`${input.candidate.headSha}\0${input.targetRef}\0${input.targetSha}`)
		.digest('hex'),
	observedAt: new Date().toISOString(),
})

/** @description Validates candidate freshness and returns the exact accepted gate set. */
export const evaluateDeliveryCompletion = async (input: {
	readonly root: string
	readonly graphFingerprint: string
	readonly item: LedgerItem
	readonly policy: WorkDeliveryPolicy
	readonly receipts?: readonly LedgerGateReceipt[]
}): Promise<
	WorkResult<{ readonly candidate: LedgerCandidate; readonly gates: readonly LedgerGateReceipt[] }>
> => {
	const candidate = input.item.candidate
	if (candidate === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'candidate_missing',
				message: `${input.item.workId} has no submitted candidate.`,
			},
		}
	}
	const continuedAcrossUnrelatedCanonicalChange =
		input.item.definitionSchemaVersion === 3 &&
		input.item.definitionRevision?.graphFingerprint === candidate.graphFingerprint &&
		(input.policy.targetRef === undefined ||
			input.item.definitionRevision.targetRef === input.policy.targetRef)
	if (
		candidate.graphFingerprint !== input.graphFingerprint &&
		!continuedAcrossUnrelatedCanonicalChange
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'candidate_stale',
				message: 'The submitted candidate targets an earlier work definition.',
			},
		}
	}
	const workspace = await observeGitWorkspace({ root: input.root })
	if (
		!workspace.ok ||
		!workspace.value.available ||
		workspace.value.repositoryId !== candidate.repositoryId
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'candidate_stale',
				message: 'The submitted candidate does not belong to the current repository.',
			},
		}
	}
	try {
		const candidateTree = await gitOutput(input.root, ['rev-parse', `${candidate.headSha}^{tree}`])
		if (candidateTree !== candidate.treeSha) {
			throw new Error('candidate tree mismatch')
		}
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'candidate_stale',
				message: 'The submitted candidate revision is unavailable or inconsistent.',
			},
		}
	}
	const gates = [...(input.item.gates ?? []), ...(input.receipts ?? [])]
	if (gates.some((receipt) => !receiptMatches(receipt, candidate))) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_delivery_receipt',
				message: 'A delivery receipt is not bound to the active candidate generation.',
			},
		}
	}
	if (
		gates.some(
			(receipt) =>
				receipt.gate !== 'validation' &&
				receipt.gate !== 'landing' &&
				receipt.issuer.kind !== 'adapter',
		)
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_delivery_receipt',
				message: 'External delivery gates require an adapter-issued receipt.',
			},
		}
	}
	if (input.policy.integration === 'local' && input.policy.targetRef !== undefined) {
		try {
			const targetSha = await gitOutput(input.root, ['rev-parse', input.policy.targetRef])
			await executeFile('git', ['merge-base', '--is-ancestor', candidate.headSha, targetSha], {
				cwd: input.root,
				timeout: 10_000,
			})
			gates.push(createLandingReceipt({ candidate, targetRef: input.policy.targetRef, targetSha }))
		} catch {
			// Absence is reported below as a missing typed gate, without leaking Git diagnostics.
		}
	}
	const byKind = new Map(gates.map((receipt) => [receipt.gate, receipt]))
	const missing = input.policy.requiredGates.filter((gate) => byKind.get(gate)?.result !== 'passed')
	if (missing.length > 0) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'delivery_gates_incomplete',
				message: `Unsatisfied delivery gates: ${missing.join(', ')}.`,
				details: missing.map((gate) => `${gate}=${byKind.get(gate)?.result ?? 'missing'}`),
			},
		}
	}
	return { ok: true, value: { candidate, gates: [...byKind.values()] } }
}

/** @description Loads bounded repository-contained gate receipts without accepting raw output text. */
export const loadDeliveryReceipts = async (input: {
	readonly root: string
	readonly references: readonly string[]
}): Promise<WorkResult<readonly LedgerGateReceipt[]>> => {
	if (input.references.length > 32) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_delivery_receipt',
				message: 'At most 32 delivery receipt files may be loaded.',
			},
		}
	}
	const receipts: LedgerGateReceipt[] = []
	for (const reference of input.references) {
		const source = await readBoundedContainedUtf8({
			root: input.root,
			reference,
			maxBytes: 64 * 1024,
			unsafeCode: 'invalid_delivery_receipt',
			unavailableCode: 'invalid_delivery_receipt',
			tooLargeCode: 'invalid_delivery_receipt',
			label: 'Delivery receipt',
			unsafeMessage: 'Delivery receipt must remain within the repository.',
		})
		if (!source.ok) {
			return source
		}
		let document: unknown
		try {
			document = JSON.parse(source.value)
		} catch {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_delivery_receipt',
					message: 'Delivery receipt is not valid JSON.',
				},
			}
		}
		const parsed = safeParse(LedgerGateReceiptSchema, document)
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_delivery_receipt',
					message: 'Delivery receipt does not match the version-one schema.',
				},
			}
		}
		receipts.push(parsed.output)
	}
	return { ok: true, value: receipts }
}
