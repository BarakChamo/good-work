/**
 * @description Owns human and agent work coordination above a provider ledger without supervising runtimes.
 *
 * @module work/service
 * @file Service.ts
 */

import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
	CanonicalDefinitionRevision,
	CompiledWorkGraph,
	EvidenceKind,
	WorkArtifact,
	WorkDeliveryPolicy,
	WorkResult,
} from './contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY, WORK_ID_PATTERN } from './contracts'
import { INPUT_LIMITS, readBoundedContainedFile } from './files'
import type {
	CollaborativeLedgerProvider,
	LedgerActivity,
	LedgerDefinitionExpectation,
	LedgerDependencyExpectation,
	LedgerEvidence,
	LedgerCandidate,
	LedgerGateReceipt,
	LedgerHandoff,
	LedgerItem,
	LedgerStatus,
} from './provider'
import { sanitizeProviderError, validateLedgerProjection } from './provider'
import { observeGitWorkspace } from './git-observer'
import { evaluateDeliveryCompletion, loadDeliveryReceipts } from './delivery'

/** @description Human/agent read model for one synchronized work item. */
interface WorkItemView {
	readonly id: string
	readonly title: string
	readonly kind: WorkArtifact['kind']
	readonly execution: WorkArtifact['execution']
	readonly status: LedgerStatus
	readonly parentId?: string
	readonly dependencies: readonly string[]
	readonly roles: readonly string[]
	readonly assignee?: string
	readonly activity?: LedgerActivity
	readonly handoff?: LedgerHandoff
	readonly evidence: readonly LedgerEvidence[]
	readonly candidate?: LedgerCandidate
	readonly gates: readonly LedgerGateReceipt[]
	readonly blockReason?: string
	readonly stale: boolean
	readonly ready: boolean
	readonly aggregate?: WorkAggregateProgress
}

/** @description Direct-child progress for one non-executable aggregate definition. */
interface WorkAggregateProgress {
	readonly total: number
	readonly open: number
	readonly active: number
	readonly blocked: number
	readonly terminal: number
	readonly completionReady: boolean
	readonly blockers: readonly string[]
}

/** @description Auditable receipt returned by a lifecycle command. */
interface WorkCommandReceipt {
	readonly schemaVersion: 1
	readonly command:
		| 'block'
		| 'claim'
		| 'complete'
		| 'handoff'
		| 'release'
		| 'reopen'
		| 'resume'
		| 'submit'
		| 'touch'
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly previousStatus: LedgerStatus
	readonly newStatus: LedgerStatus
	readonly timestamp: string
	readonly evidence: readonly LedgerEvidence[]
	readonly candidate?: LedgerCandidate
	readonly gates?: readonly LedgerGateReceipt[]
}

/** @description Successful submission receipt with the immutable candidate binding made explicit. */
interface WorkSubmissionReceipt extends WorkCommandReceipt {
	readonly candidate: LedgerCandidate
	readonly gates: readonly LedgerGateReceipt[]
}

/** @description Descendant progress and evidence aggregate for a hierarchy node. */
interface WorkRollup {
	readonly schemaVersion: 1
	readonly workId: string
	readonly total: number
	readonly completed: number
	readonly active: number
	readonly blocked: number
	readonly ready: number
	readonly evidenceSatisfied: number
	readonly status: 'open' | 'ready' | 'in_progress' | 'blocked' | 'completed'
	readonly reasons: readonly string[]
}

/** @description Provider-neutral coordination operations that never launch or supervise agents. */
export interface WorkContractService {
	readonly validateDefinition: (workId: string) => Promise<WorkResult<void>>
	readonly inspect: (workId: string) => Promise<WorkResult<WorkItemView>>
	readonly ready: (input?: {
		readonly role?: string
		readonly limit?: number
	}) => Promise<WorkResult<readonly WorkItemView[]>>
	readonly active: () => Promise<WorkResult<readonly WorkItemView[]>>
	readonly submit: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly evidence: readonly {
			readonly kind: EvidenceKind
			readonly reference: string
			readonly digest?: string
		}[]
	}) => Promise<WorkResult<WorkSubmissionReceipt>>
	readonly claim: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly touch: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly resume: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly handoff: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly summary: string
		readonly remaining?: readonly string[]
		readonly references?: readonly string[]
		readonly toActor?: string
		readonly release?: boolean
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly block: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly reason: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly release: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly reason: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly reopen: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly reason: string
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly complete: (input: {
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly evidence: readonly {
			readonly kind: EvidenceKind
			readonly reference: string
			readonly digest?: string
		}[]
		readonly receiptFiles?: readonly string[]
	}) => Promise<WorkResult<WorkCommandReceipt>>
	readonly rollup: (workId: string) => Promise<WorkResult<WorkRollup>>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const boundedScalar = (value: unknown, maximumBytes: number): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	Buffer.byteLength(value, 'utf8') <= maximumBytes &&
	!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)

const boundedMultiline = (value: unknown, maximumBytes: number): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	Buffer.byteLength(value, 'utf8') <= maximumBytes &&
	// oxlint-disable-next-line eslint/no-control-regex -- Multiline text permits newline/tab but rejects every other control byte.
	!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)

const validEvidenceKind = (value: unknown): value is EvidenceKind =>
	typeof value === 'string' &&
	(['test', 'review', 'build', 'ci', 'security', 'artifact'].includes(value) ||
		/^custom:[a-z][a-z0-9-]*$/u.test(value)) &&
	Buffer.byteLength(value, 'utf8') <= 128

const operationInputError = (message: string): WorkResult<never> => ({
	ok: false,
	error: { type: 'work_contract_error', code: 'invalid_operation_input', message },
})

const sanitizeProviderFailure = (error: unknown): WorkResult<never> => ({
	ok: false,
	error: sanitizeProviderError(error),
})

const validateReadyRequest = (
	value: unknown,
): WorkResult<{ readonly role?: string; readonly limit: number }> => {
	if (value === undefined) {
		return { ok: true, value: { limit: 20 } }
	}
	if (!isRecord(value) || (value.role !== undefined && !boundedScalar(value.role, 128))) {
		return operationInputError('Ready filter input is invalid.')
	}
	const limit = value.limit ?? 20
	if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_limit',
				message: 'Ready limit must be between 1 and 100.',
			},
		}
	}
	return {
		ok: true,
		value: {
			limit,
			...(value.role === undefined ? {} : { role: value.role }),
		},
	}
}

const validateActorRequest = (value: unknown): WorkResult<void> => {
	if (!isRecord(value) || !boundedScalar(value.actor, 128)) {
		return {
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_actor', message: 'Actor is required.' },
		}
	}
	if (
		typeof value.workId !== 'string' ||
		!WORK_ID_PATTERN.test(value.workId) ||
		(value.role !== undefined && !boundedScalar(value.role, 128)) ||
		(value.session !== undefined && !boundedScalar(value.session, 256))
	) {
		return operationInputError('Work operation input is invalid.')
	}
	return { ok: true, value: undefined }
}

const validateHandoffRequest = (value: unknown): WorkResult<void> => {
	const actor = validateActorRequest(value)
	if (!actor.ok || !isRecord(value)) {
		return actor
	}
	const validList = (candidate: unknown): boolean =>
		candidate === undefined ||
		(Array.isArray(candidate) &&
			candidate.length <= 100 &&
			candidate.every((entry) => boundedScalar(entry, 2000)))
	return boundedMultiline(value.summary, 4000) &&
		validList(value.remaining) &&
		validList(value.references) &&
		(value.toActor === undefined || boundedScalar(value.toActor, 128)) &&
		(value.release === undefined || typeof value.release === 'boolean')
		? actor
		: operationInputError('Handoff input is invalid.')
}

const validateTransitionRequest = (value: unknown): WorkResult<void> => {
	const actor = validateActorRequest(value)
	if (!actor.ok) {
		return actor
	}
	return isRecord(value) && boundedScalar(value.reason, 2000)
		? actor
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_reason',
					message: 'A bounded reason is required.',
				},
			}
}

const validateCompleteRequest = (value: unknown): WorkResult<void> => {
	const actor = validateActorRequest(value)
	if (!actor.ok || !isRecord(value)) {
		return actor
	}
	if (
		!Array.isArray(value.evidence) ||
		value.evidence.length > 100 ||
		!value.evidence.every(
			(entry) =>
				isRecord(entry) &&
				validEvidenceKind(entry.kind) &&
				boundedScalar(entry.reference, 2000) &&
				(entry.digest === undefined ||
					(typeof entry.digest === 'string' && /^[a-f0-9]{64}$/u.test(entry.digest))),
		)
	) {
		return operationInputError('Completion evidence input is invalid.')
	}
	if (
		value.receiptFiles !== undefined &&
		(!Array.isArray(value.receiptFiles) ||
			value.receiptFiles.length > 32 ||
			!value.receiptFiles.every((reference) => boundedScalar(reference, 2000)))
	) {
		return operationInputError('Delivery receipt input is invalid.')
	}
	return actor
}

const isActiveStatus = (status: LedgerStatus): boolean =>
	status === 'in_progress' || status === 'blocked'

const definitionDriftFields = (input: {
	readonly artifact: WorkArtifact
	readonly item: LedgerItem
	readonly definitionRevision?: CanonicalDefinitionRevision
}): readonly string[] => [
	...(input.item.definitionSchemaVersion === (input.definitionRevision === undefined ? 2 : 3)
		? []
		: ['definitionSchemaVersion']),
	...(input.definitionRevision === undefined ||
	input.item.definitionRevision?.targetRef === input.definitionRevision.targetRef
		? []
		: ['definitionRevision']),
	...(input.item.title === input.artifact.title ? [] : ['title']),
	...(input.item.kind === input.artifact.kind ? [] : ['kind']),
	...((input.item.execution ?? 'task') === input.artifact.execution ? [] : ['execution']),
	...(input.item.source.path === input.artifact.source.path ? [] : ['source.path']),
	...(input.item.source.hash === input.artifact.source.hash ? [] : ['source.hash']),
	...(input.item.parentId === input.artifact.parentId ? [] : ['parentId']),
	...(JSON.stringify([...input.item.dependencies].toSorted()) ===
	JSON.stringify([...input.artifact.dependencies].toSorted())
		? []
		: ['dependencies']),
	...(JSON.stringify([...input.item.roles].toSorted()) ===
	JSON.stringify([...input.artifact.roles].toSorted())
		? []
		: ['roles']),
	...(JSON.stringify([...input.item.evidenceRequirements].toSorted()) ===
	JSON.stringify([...input.artifact.evidenceRequirements].toSorted())
		? []
		: ['evidenceRequirements']),
]

const evidenceSatisfied = (artifact: WorkArtifact, item: LedgerItem): boolean => {
	const providedKinds = new Set(item.evidence.map(({ kind }) => kind))
	return artifact.evidenceRequirements.every((kind) => providedKinds.has(kind))
}

const isSuccessful = (artifact: WorkArtifact, item: LedgerItem): boolean =>
	item.status === 'closed' && evidenceSatisfied(artifact, item)

const definitionExpectation = (
	artifact: WorkArtifact,
	item?: LedgerItem,
): LedgerDefinitionExpectation => {
	const fields = {
		title: artifact.title,
		kind: artifact.kind,
		execution: artifact.execution,
		source: artifact.source,
		parentId: artifact.parentId,
		dependencies: artifact.dependencies,
		roles: artifact.roles,
		evidenceRequirements: artifact.evidenceRequirements,
	}
	return item?.definitionSchemaVersion === 3 && item.definitionRevision !== undefined
		? {
				schemaVersion: 3,
				graphFingerprint: item.definitionRevision.graphFingerprint,
				definitionRevision: item.definitionRevision,
				...fields,
			}
		: { schemaVersion: 2, ...fields }
}

const dependencyExpectations = (
	artifact: WorkArtifact,
	artifacts: ReadonlyMap<string, WorkArtifact>,
	items: ReadonlyMap<string, LedgerItem>,
): readonly LedgerDependencyExpectation[] =>
	artifact.dependencies.flatMap((dependencyId) => {
		const dependency = artifacts.get(dependencyId)
		return dependency === undefined
			? []
			: [
					{
						workId: dependencyId,
						...definitionExpectation(dependency, items.get(dependencyId)),
					},
				]
	})

const unsuccessfulDependencies = (
	artifact: WorkArtifact,
	byId: ReadonlyMap<string, LedgerItem>,
	artifacts: ReadonlyMap<string, WorkArtifact>,
): readonly string[] =>
	artifact.dependencies.filter((dependencyId) => {
		const dependencyArtifact = artifacts.get(dependencyId)
		const dependencyItem = byId.get(dependencyId)
		return (
			dependencyArtifact === undefined ||
			dependencyItem === undefined ||
			!isSuccessful(dependencyArtifact, dependencyItem)
		)
	})

const itemReady = (
	artifact: WorkArtifact,
	item: LedgerItem,
	byId: ReadonlyMap<string, LedgerItem>,
	artifacts: ReadonlyMap<string, WorkArtifact>,
): boolean =>
	(artifact.kind === 'issue' || artifact.kind === 'task' || artifact.kind === 'eval') &&
	artifact.execution === 'task' &&
	item.status === 'open' &&
	unsuccessfulDependencies(artifact, byId, artifacts).length === 0

const staleActivity = (input: {
	readonly item: LedgerItem
	readonly now: Date
	readonly staleClaimMinutes: number
}): boolean => {
	if (input.item.status !== 'in_progress' && input.item.status !== 'blocked') {
		return false
	}
	if (input.item.activity === undefined) {
		return true
	}
	const touchedAt = Date.parse(input.item.activity.touchedAt)
	return (
		!Number.isFinite(touchedAt) ||
		input.now.getTime() - touchedAt > input.staleClaimMinutes * 60_000
	)
}

const makeView = (input: {
	readonly artifact: WorkArtifact
	readonly item: LedgerItem
	readonly byId: ReadonlyMap<string, LedgerItem>
	readonly artifacts: ReadonlyMap<string, WorkArtifact>
	readonly now: Date
	readonly staleClaimMinutes: number
}): WorkItemView => ({
	id: input.artifact.id,
	title: input.artifact.title,
	kind: input.artifact.kind,
	execution: input.artifact.execution,
	status: input.item.status,
	...(input.artifact.parentId === undefined ? {} : { parentId: input.artifact.parentId }),
	dependencies: input.artifact.dependencies,
	roles: input.artifact.roles,
	...(input.item.assignee === undefined ? {} : { assignee: input.item.assignee }),
	...(input.item.activity === undefined ? {} : { activity: input.item.activity }),
	...(input.item.handoff === undefined ? {} : { handoff: input.item.handoff }),
	evidence: input.item.evidence,
	...(input.item.candidate === undefined ? {} : { candidate: input.item.candidate }),
	gates: input.item.gates ?? [],
	...(input.item.blockReason === undefined ? {} : { blockReason: input.item.blockReason }),
	stale: staleActivity({
		item: input.item,
		now: input.now,
		staleClaimMinutes: input.staleClaimMinutes,
	}),
	ready: itemReady(input.artifact, input.item, input.byId, input.artifacts),
	...(input.artifact.execution === 'aggregate'
		? {
				aggregate: aggregateProgress(input.artifact.id, input.byId, input.artifacts),
			}
		: {}),
})

const aggregateProgress = (
	workId: string,
	byId: ReadonlyMap<string, LedgerItem>,
	artifacts: ReadonlyMap<string, WorkArtifact>,
): WorkAggregateProgress => {
	const children = [...artifacts.values()].filter(({ parentId }) => parentId === workId)
	const childItems = children.map((child) => ({ child, item: byId.get(child.id) }))
	const terminal = childItems.filter(
		({ child, item }) => item !== undefined && isSuccessful(child, item),
	).length
	return {
		total: children.length,
		open: childItems.filter(({ item }) => item?.status === 'open').length,
		active: childItems.filter(({ item }) => item?.status === 'in_progress').length,
		blocked: childItems.filter(({ item }) => item?.status === 'blocked').length,
		terminal,
		completionReady: children.length > 0 && terminal === children.length,
		blockers: childItems.flatMap(({ child, item }) => {
			if (item === undefined) {
				return [`${child.id}: missing ledger projection`]
			}
			if (isSuccessful(child, item)) {
				return []
			}
			return [
				`${child.id}: ${item.status === 'blocked' ? (item.blockReason ?? 'blocked') : item.status}`,
			]
		}),
	}
}

const verifyOperationContext = (input: {
	readonly item: LedgerItem
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly shouldAssertSession?: boolean
}): WorkResult<void> => {
	if (input.item.assignee !== input.actor) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'ownership_conflict',
				message: `${input.item.workId} is assigned to another actor.`,
			},
		}
	}
	if (input.role !== undefined && input.item.activity?.role !== input.role) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'role_conflict',
				message: `${input.item.workId} is active under another role.`,
			},
		}
	}
	if (
		input.shouldAssertSession !== false &&
		input.session !== undefined &&
		input.item.activity?.session !== input.session
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'session_conflict',
				message: `${input.item.workId} is active in another session.`,
			},
		}
	}
	return { ok: true, value: undefined }
}

const commandReceipt = (input: {
	readonly command: WorkCommandReceipt['command']
	readonly workId: string
	readonly actor: string
	readonly previousStatus: LedgerStatus
	readonly item: LedgerItem
	readonly activity?: LedgerActivity
	readonly timestamp: string
}): WorkCommandReceipt => {
	const activity = input.activity ?? input.item.activity
	return {
		schemaVersion: 1,
		command: input.command,
		workId: input.workId,
		actor: input.actor,
		...(activity?.role === undefined ? {} : { role: activity.role }),
		...(activity?.session === undefined ? {} : { session: activity.session }),
		previousStatus: input.previousStatus,
		newStatus: input.item.status,
		timestamp: input.timestamp,
		evidence: input.item.evidence,
		...(input.item.candidate === undefined ? {} : { candidate: input.item.candidate }),
		...(input.item.gates === undefined ? {} : { gates: input.item.gates }),
	}
}

const sameActivity = (
	left: LedgerActivity | undefined,
	right: LedgerActivity | undefined,
): boolean =>
	left === undefined
		? right === undefined
		: right !== undefined &&
			left.actor === right.actor &&
			left.role === right.role &&
			left.session === right.session &&
			left.startedAt === right.startedAt &&
			left.touchedAt === right.touchedAt

const sameHandoff = (left: LedgerHandoff | undefined, right: LedgerHandoff): boolean =>
	left !== undefined &&
	left.actor === right.actor &&
	left.summary === right.summary &&
	left.createdAt === right.createdAt &&
	left.fromSession === right.fromSession &&
	left.toActor === right.toActor &&
	left.remaining.length === right.remaining.length &&
	left.remaining.every((value, index) => value === right.remaining[index]) &&
	left.references.length === right.references.length &&
	left.references.every((value, index) => value === right.references[index])

const sameEvidence = (left: readonly LedgerEvidence[], right: readonly LedgerEvidence[]): boolean =>
	left.length === right.length &&
	left.every((value, index) => {
		const expected = right[index]
		return (
			expected !== undefined &&
			value.kind === expected.kind &&
			value.reference === expected.reference &&
			value.digest === expected.digest &&
			value.recordedAt === expected.recordedAt &&
			value.actor === expected.actor
		)
	})

const sameCandidate = (left: LedgerCandidate | undefined, right: LedgerCandidate): boolean =>
	left !== undefined && isDeepStrictEqual(left, right)

const sameGates = (
	left: readonly LedgerGateReceipt[] | undefined,
	right: readonly LedgerGateReceipt[],
): boolean => isDeepStrictEqual(left ?? [], right)

const invalidLifecycleProjection = (): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'invalid_ledger_projection',
		message: 'Ledger provider returned a lifecycle item that violates its postcondition.',
		details: [
			'stateMayHaveChanged=true',
			'recovery=inspect provider state and reconcile before retrying',
		],
	},
})

const validateLifecycleItem = (input: {
	readonly value: unknown
	readonly projectId: string
	readonly artifact: WorkArtifact
	readonly workId: string
	readonly status: LedgerStatus
	readonly assignee: string | undefined
	readonly activity: LedgerActivity | undefined
	readonly handoff?: LedgerHandoff
	readonly evidence?: readonly LedgerEvidence[]
	readonly candidate?: LedgerCandidate
	readonly gates?: readonly LedgerGateReceipt[]
	readonly blockReason?: { readonly value: string | undefined }
	readonly definitionRevision?: CanonicalDefinitionRevision
}): WorkResult<LedgerItem> => {
	const projection = validateLedgerProjection([input.value])
	if (!projection.ok) {
		return invalidLifecycleProjection()
	}
	const item = projection.value[0]
	if (
		item === undefined ||
		item.projectId !== input.projectId ||
		item.workId !== input.workId ||
		definitionDriftFields({
			artifact: input.artifact,
			item,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		}).length > 0 ||
		item.status !== input.status ||
		item.assignee !== input.assignee ||
		!sameActivity(item.activity, input.activity) ||
		(input.handoff !== undefined && !sameHandoff(item.handoff, input.handoff)) ||
		(input.evidence !== undefined && !sameEvidence(item.evidence, input.evidence)) ||
		(input.candidate !== undefined && !sameCandidate(item.candidate, input.candidate)) ||
		(input.gates !== undefined && !sameGates(item.gates, input.gates)) ||
		(input.blockReason !== undefined && item.blockReason !== input.blockReason.value)
	) {
		return invalidLifecycleProjection()
	}
	return { ok: true, value: item }
}

const safeLocalEvidence = async (input: {
	readonly root: string
	readonly reference: string
	readonly kind: EvidenceKind
	readonly actor: string
	readonly timestamp: string
	readonly digest?: string
}): Promise<WorkResult<LedgerEvidence>> => {
	if (input.reference.startsWith('https://')) {
		if (input.digest === undefined || !/^[a-f0-9]{64}$/.test(input.digest)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_external_evidence',
					message: 'External evidence requires an explicit lowercase SHA-256 digest.',
				},
			}
		}
		return {
			ok: true,
			value: {
				kind: input.kind,
				reference: input.reference,
				digest: input.digest,
				recordedAt: input.timestamp,
				actor: input.actor,
			},
		}
	}
	const normalizedReference = relative(resolve(input.root), resolve(input.root, input.reference))
	if (
		isAbsolute(input.reference) ||
		normalizedReference === '' ||
		normalizedReference.startsWith('..') ||
		isAbsolute(normalizedReference)
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'unsafe_evidence_path',
				message: 'Evidence path must be repository-relative.',
			},
		}
	}
	try {
		const content = await readBoundedContainedFile({
			root: input.root,
			reference: input.reference,
			maxBytes: INPUT_LIMITS.evidenceBytes,
			unsafeCode: 'unsafe_evidence_path',
			unavailableCode: 'evidence_unavailable',
			tooLargeCode: 'evidence_too_large',
			label: 'Evidence file',
			unsafeMessage: 'Evidence path must remain within the repository.',
		})
		if (!content.ok) {
			return content
		}
		const digest = createHash('sha256').update(content.value).digest('hex')
		if (input.digest !== undefined && input.digest !== digest) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'evidence_digest_mismatch',
					message: 'Evidence digest does not match the current file.',
				},
			}
		}
		return {
			ok: true,
			value: {
				kind: input.kind,
				reference: normalizedReference.replaceAll('\\', '/'),
				digest,
				recordedAt: input.timestamp,
				actor: input.actor,
			},
		}
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'evidence_unavailable',
				message: 'Evidence file cannot be read.',
			},
		}
	}
}

/** @description Creates a bounded coordination service over a compiled graph and collaborative ledger. */
/* oxlint-disable-next-line eslint/max-lines-per-function -- The factory hides lifecycle helpers and provider access behind one small public API. */
export const createWorkContractService = (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly provider: CollaborativeLedgerProvider
	readonly initialLedgerItems?: readonly LedgerItem[]
	readonly clock?: () => Date
	readonly staleClaimMinutes?: number
	readonly deliveryPolicy?: WorkDeliveryPolicy
	readonly definitionRevision?: CanonicalDefinitionRevision
}): WorkContractService => {
	const clock = input.clock ?? (() => new Date())
	const staleClaimMinutes = input.staleClaimMinutes ?? 90
	const deliveryPolicy = input.deliveryPolicy ?? EVIDENCE_ONLY_DELIVERY_POLICY
	const artifacts = new Map(input.graph.items.map((artifact) => [artifact.id, artifact]))
	const childrenByParent = new Map<string, string[]>()
	for (const artifact of input.graph.items) {
		if (artifact.parentId === undefined) {
			continue
		}
		const children = childrenByParent.get(artifact.parentId) ?? []
		children.push(artifact.id)
		childrenByParent.set(artifact.parentId, children)
	}
	for (const children of childrenByParent.values()) {
		children.sort()
	}
	let initialLedgerItems = input.initialLedgerItems

	const requiredDefinitionClosure = (workId: string): ReadonlySet<string> => {
		const required = new Set<string>()
		const pending = [workId]
		while (pending.length > 0) {
			const current = pending.pop()
			if (current === undefined || required.has(current)) {
				continue
			}
			required.add(current)
			const artifact = artifacts.get(current)
			if (artifact === undefined) {
				continue
			}
			pending.push(...artifact.dependencies)
			if (artifact.parentId !== undefined) {
				pending.push(artifact.parentId)
			}
			if (artifact.execution === 'aggregate') {
				pending.push(...(childrenByParent.get(artifact.id) ?? []))
			}
		}
		return required
	}
	const definitionClosureExpectations = (workId: string, items: ReadonlyMap<string, LedgerItem>) =>
		[...requiredDefinitionClosure(workId)].toSorted().flatMap((requiredId) => {
			const artifact = artifacts.get(requiredId)
			return artifact === undefined
				? []
				: [
						{
							workId: requiredId,
							...definitionExpectation(artifact, items.get(requiredId)),
						},
					]
		})

	const snapshot = async (
		requiredIds?: ReadonlySet<string>,
	): Promise<
		WorkResult<{
			readonly items: readonly LedgerItem[]
			readonly byId: ReadonlyMap<string, LedgerItem>
		}>
	> => {
		const commandInitialLedgerItems = initialLedgerItems
		initialLedgerItems = undefined
		const listed =
			commandInitialLedgerItems === undefined
				? await input.provider.list()
				: { ok: true as const, value: commandInitialLedgerItems }
		if (!listed.ok) {
			return sanitizeProviderFailure(listed.error)
		}
		const projection = validateLedgerProjection(listed.value)
		if (!projection.ok) {
			return projection
		}
		const items = projection.value.filter(
			({ projectId, workId }) => projectId === input.graph.projectId && artifacts.has(workId),
		)
		const byId = new Map<string, LedgerItem>()
		for (const item of items) {
			if (byId.has(item.workId)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Ledger contains duplicate owned work IDs.',
					},
				}
			}
			byId.set(item.workId, item)
		}
		for (const artifact of input.graph.items) {
			if (requiredIds !== undefined && !requiredIds.has(artifact.id)) {
				continue
			}
			const item = byId.get(artifact.id)
			if (item === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: `${artifact.id} has not been synchronized to the ledger.`,
					},
				}
			}
			const driftFields = definitionDriftFields({
				artifact,
				item,
				...(input.definitionRevision === undefined
					? {}
					: { definitionRevision: input.definitionRevision }),
			})
			if (driftFields.length > 0) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: `${artifact.id} ledger definition does not match the current graph; run sync --apply.`,
						details: [`Drifted fields: ${driftFields.join(', ')}`],
					},
				}
			}
		}
		return { ok: true, value: { items, byId } }
	}

	const find = async (
		workId: string,
	): Promise<
		WorkResult<{
			readonly artifact: WorkArtifact
			readonly item: LedgerItem
			readonly byId: ReadonlyMap<string, LedgerItem>
		}>
	> => {
		const artifact = artifacts.get(workId)
		if (artifact === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_found',
					message: 'Unknown work item.',
				},
			}
		}
		const current = await snapshot(requiredDefinitionClosure(workId))
		if (!current.ok) {
			return current
		}
		const item = current.value.byId.get(workId)
		return item === undefined
			? {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: `${workId} is missing from the ledger.`,
					},
				}
			: { ok: true, value: { artifact, item, byId: current.value.byId } }
	}

	const ready: WorkContractService['ready'] = async (request = {}) => {
		const parsedRequest = validateReadyRequest(request)
		if (!parsedRequest.ok) {
			return parsedRequest
		}
		const { limit, role } = parsedRequest.value
		const current = await snapshot()
		if (!current.ok) {
			return current
		}
		const now = clock()
		const views = input.graph.items.flatMap((artifact) => {
			const item = current.value.byId.get(artifact.id)
			if (item === undefined || !itemReady(artifact, item, current.value.byId, artifacts)) {
				return []
			}
			if (role !== undefined && !artifact.roles.includes(role)) {
				return []
			}
			return [
				makeView({ artifact, item, byId: current.value.byId, artifacts, now, staleClaimMinutes }),
			]
		})
		return {
			ok: true,
			value: views.toSorted((left, right) => left.id.localeCompare(right.id)).slice(0, limit),
		}
	}

	const inspect: WorkContractService['inspect'] = async (workId) => {
		const current = await find(workId)
		if (!current.ok) {
			return current
		}
		return {
			ok: true,
			value: makeView({
				artifact: current.value.artifact,
				item: current.value.item,
				byId: current.value.byId,
				artifacts,
				now: clock(),
				staleClaimMinutes,
			}),
		}
	}

	const validateDefinition: WorkContractService['validateDefinition'] = async (workId) => {
		const current = await find(workId)
		return current.ok ? { ok: true, value: undefined } : current
	}

	const active: WorkContractService['active'] = async () => {
		const current = await snapshot()
		if (!current.ok) {
			return current
		}
		const now = clock()
		return {
			ok: true,
			value: input.graph.items.flatMap((artifact) => {
				const item = current.value.byId.get(artifact.id)
				return item === undefined || (item.status !== 'in_progress' && item.status !== 'blocked')
					? []
					: [
							makeView({
								artifact,
								item,
								byId: current.value.byId,
								artifacts,
								now,
								staleClaimMinutes,
							}),
						]
			}),
		}
	}

	const claim: WorkContractService['claim'] = async (request) => {
		const validRequest = validateActorRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		const { artifact, item } = current.value
		if (artifact.execution === 'aggregate') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'aggregate_not_executable',
					message: `${request.workId} derives progress from its direct children and cannot be claimed.`,
				},
			}
		}
		if (item.assignee !== undefined && item.assignee !== request.actor) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ownership_conflict',
					message: `${request.workId} is already claimed.`,
				},
			}
		}
		const repairsIncompleteClaim =
			item.status === 'in_progress' &&
			item.assignee === request.actor &&
			item.activity === undefined
		const reclaimsActiveClaim =
			item.status === 'in_progress' &&
			item.assignee === request.actor &&
			item.activity !== undefined
		if (reclaimsActiveClaim) {
			if (item.activity?.session !== request.session) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'session_conflict',
						message: `${request.workId} is active in another session; use resume to transfer it explicitly.`,
					},
				}
			}
			if (item.activity?.role !== request.role) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'role_conflict',
						message: `${request.workId} is active under another role.`,
					},
				}
			}
		}
		if (request.role !== undefined && !artifact.roles.includes(request.role)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'role_not_allowed',
					message: `${request.workId} cannot be claimed under the requested role.`,
				},
			}
		}
		if (
			!itemReady(artifact, item, current.value.byId, artifacts) &&
			!(
				(repairsIncompleteClaim || reclaimsActiveClaim) &&
				unsuccessfulDependencies(artifact, current.value.byId, artifacts).length === 0
			)
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_ready',
					message: `${request.workId} is not dependency-ready.`,
				},
			}
		}
		const timestamp = clock().toISOString()
		const claimed = await input.provider.claim({
			workId: request.workId,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
			timestamp,
			expectedDefinition: definitionExpectation(artifact, item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
			expectedDependencies: dependencyExpectations(artifact, artifacts, current.value.byId),
		})
		if (!claimed.ok) {
			return sanitizeProviderFailure(claimed.error)
		}
		const expectedActivity = reclaimsActiveClaim
			? item.activity
			: {
					actor: request.actor,
					...(request.role === undefined ? {} : { role: request.role }),
					...(request.session === undefined ? {} : { session: request.session }),
					startedAt: timestamp,
					touchedAt: timestamp,
				}
		const validated = validateLifecycleItem({
			value: claimed.value,
			projectId: input.graph.projectId,
			artifact,
			workId: request.workId,
			status: 'in_progress',
			assignee: request.actor,
			activity: expectedActivity,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: commandReceipt({
						command: 'claim',
						workId: request.workId,
						actor: request.actor,
						previousStatus: item.status,
						item: validated.value,
						timestamp,
					}),
				}
			: validated
	}

	const updateActivity = async (request: {
		readonly command: 'resume' | 'touch'
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
	}): Promise<WorkResult<WorkCommandReceipt>> => {
		const validRequest = validateActorRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		if (!isActiveStatus(current.value.item.status)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${request.workId} cannot ${request.command} from ${current.value.item.status}.`,
				},
			}
		}
		const owned = verifyOperationContext({
			item: current.value.item,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
			shouldAssertSession: request.command !== 'resume',
		})
		if (!owned.ok) {
			return owned
		}
		if (current.value.item.activity === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'activity_missing',
					message: `${request.workId} has no active session.`,
				},
			}
		}
		const timestamp = clock().toISOString()
		const activity: LedgerActivity = {
			...current.value.item.activity,
			...(request.session === undefined ? {} : { session: request.session }),
			touchedAt: timestamp,
		}
		const updated = await input.provider.recordActivity({
			workId: request.workId,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.command === 'resume' || request.session === undefined
				? {}
				: { session: request.session }),
			activity,
			replaceSession: request.command === 'resume',
			expectedDefinition: definitionExpectation(current.value.artifact, current.value.item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
		})
		if (!updated.ok) {
			return sanitizeProviderFailure(updated.error)
		}
		const validated = validateLifecycleItem({
			value: updated.value,
			projectId: input.graph.projectId,
			artifact: current.value.artifact,
			workId: request.workId,
			status: current.value.item.status,
			assignee: request.actor,
			activity,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: commandReceipt({
						command: request.command,
						workId: request.workId,
						actor: request.actor,
						previousStatus: current.value.item.status,
						item: validated.value,
						timestamp,
					}),
				}
			: validated
	}

	const handoff: WorkContractService['handoff'] = async (request) => {
		const validRequest = validateHandoffRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		if (!isActiveStatus(current.value.item.status)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${request.workId} cannot handoff from ${current.value.item.status}.`,
				},
			}
		}
		const owned = verifyOperationContext({
			item: current.value.item,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
		})
		if (!owned.ok) {
			return owned
		}
		const timestamp = clock().toISOString()
		const handoffRecord: LedgerHandoff = {
			actor: request.actor,
			summary: request.summary.trim(),
			remaining: [...(request.remaining ?? [])],
			references: [...(request.references ?? [])],
			createdAt: timestamp,
			...(current.value.item.activity?.session === undefined
				? {}
				: { fromSession: current.value.item.activity.session }),
			...(request.toActor === undefined ? {} : { toActor: request.toActor }),
		}
		const updated = await input.provider.recordHandoff({
			workId: request.workId,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
			handoff: handoffRecord,
			release: request.release ?? false,
			expectedDefinition: definitionExpectation(current.value.artifact, current.value.item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
		})
		if (!updated.ok) {
			return sanitizeProviderFailure(updated.error)
		}
		const releasesOwnership = request.release ?? false
		const validated = validateLifecycleItem({
			value: updated.value,
			projectId: input.graph.projectId,
			artifact: current.value.artifact,
			workId: request.workId,
			status: releasesOwnership ? 'open' : current.value.item.status,
			assignee: releasesOwnership ? undefined : request.actor,
			activity: releasesOwnership ? undefined : current.value.item.activity,
			handoff: handoffRecord,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: commandReceipt({
						command: 'handoff',
						workId: request.workId,
						actor: request.actor,
						previousStatus: current.value.item.status,
						item: validated.value,
						...(current.value.item.activity === undefined
							? {}
							: { activity: current.value.item.activity }),
						timestamp,
					}),
				}
			: validated
	}

	const transition = async (request: {
		readonly type: 'block' | 'release' | 'reopen'
		readonly workId: string
		readonly actor: string
		readonly role?: string
		readonly session?: string
		readonly reason: string
	}): Promise<WorkResult<WorkCommandReceipt>> => {
		const validRequest = validateTransitionRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		const allowedStatuses: Readonly<Record<typeof request.type, readonly LedgerStatus[]>> = {
			block: ['in_progress'],
			release: ['in_progress', 'blocked'],
			reopen: ['blocked', 'closed'],
		}
		if (!allowedStatuses[request.type].includes(current.value.item.status)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${request.workId} cannot ${request.type} from ${current.value.item.status}.`,
				},
			}
		}
		const aggregateParent =
			request.type === 'reopen' && current.value.artifact.parentId !== undefined
				? artifacts.get(current.value.artifact.parentId)
				: undefined
		if (
			aggregateParent?.execution === 'aggregate' &&
			current.value.byId.get(aggregateParent.id)?.status === 'closed'
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'aggregate_not_ready',
					message: `Reopen ${aggregateParent.id} before reopening its required child.`,
				},
			}
		}
		if (!(request.type === 'reopen' && current.value.artifact.execution === 'aggregate')) {
			const owned = verifyOperationContext({
				item: current.value.item,
				actor: request.actor,
				...(request.role === undefined ? {} : { role: request.role }),
				...(request.session === undefined ? {} : { session: request.session }),
			})
			if (!owned.ok) {
				return owned
			}
		}
		const timestamp = clock().toISOString()
		const updated = await input.provider.transition({
			...request,
			reason: request.reason.trim(),
			expectedDefinition: definitionExpectation(current.value.artifact, current.value.item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
			...(request.type === 'reopen' && aggregateParent?.execution === 'aggregate'
				? {
						expectedAggregateParents: [
							{
								workId: aggregateParent.id,
								...definitionExpectation(
									aggregateParent,
									current.value.byId.get(aggregateParent.id),
								),
							},
						],
					}
				: {}),
		})
		if (!updated.ok) {
			return sanitizeProviderFailure(updated.error)
		}
		const retainsOwnership = request.type === 'block'
		const validated = validateLifecycleItem({
			value: updated.value,
			projectId: input.graph.projectId,
			artifact: current.value.artifact,
			workId: request.workId,
			status: retainsOwnership ? 'blocked' : 'open',
			assignee: retainsOwnership ? request.actor : undefined,
			activity: retainsOwnership ? current.value.item.activity : undefined,
			blockReason: { value: retainsOwnership ? request.reason.trim() : undefined },
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: commandReceipt({
						command: request.type,
						workId: request.workId,
						actor: request.actor,
						previousStatus: current.value.item.status,
						item: validated.value,
						...(current.value.item.activity === undefined
							? {}
							: { activity: current.value.item.activity }),
						timestamp,
					}),
				}
			: validated
	}

	const submit: WorkContractService['submit'] = async (request) => {
		const validRequest = validateCompleteRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		if (current.value.artifact.execution === 'aggregate') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'aggregate_not_executable',
					message: `${request.workId} is aggregate work and cannot submit a candidate.`,
				},
			}
		}
		if (current.value.item.status !== 'in_progress') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${request.workId} cannot submit from ${current.value.item.status}.`,
				},
			}
		}
		const owned = verifyOperationContext({
			item: current.value.item,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
		})
		if (!owned.ok) {
			return owned
		}
		const workspace = await observeGitWorkspace({ root: input.root })
		if (!workspace.ok) {
			return workspace
		}
		if (
			!workspace.value.available ||
			workspace.value.repositoryId === undefined ||
			workspace.value.headSha === undefined ||
			workspace.value.treeSha === undefined ||
			workspace.value.isolation === 'none'
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'workspace_required',
					message: 'Candidate submission requires a Git workspace.',
				},
			}
		}
		if (
			(deliveryPolicy.isolation === 'worktree' && workspace.value.isolation !== 'worktree') ||
			(deliveryPolicy.isolation === 'container' && workspace.value.isolation !== 'container')
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'workspace_required',
					message: `Candidate submission requires ${deliveryPolicy.isolation} isolation.`,
				},
			}
		}
		if (workspace.value.dirty) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'candidate_dirty',
					message: 'Commit candidate changes before submission.',
				},
			}
		}
		const timestamp = clock().toISOString()
		const evidence: LedgerEvidence[] = []
		for (const evidenceInput of request.evidence) {
			const verified = await safeLocalEvidence({
				root: input.root,
				reference: evidenceInput.reference,
				kind: evidenceInput.kind,
				actor: request.actor,
				timestamp,
				...(evidenceInput.digest === undefined ? {} : { digest: evidenceInput.digest }),
			})
			if (!verified.ok) {
				return verified
			}
			evidence.push(verified.value)
		}
		const providedKinds = new Set(evidence.map(({ kind }) => kind))
		const missing = current.value.artifact.evidenceRequirements.filter(
			(kind) => !providedKinds.has(kind),
		)
		if (missing.length > 0) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'evidence_incomplete',
					message: `Missing required evidence: ${missing.join(', ')}.`,
				},
			}
		}
		const previousCandidate = current.value.item.candidate
		const sameRevision =
			previousCandidate?.repositoryId === workspace.value.repositoryId &&
			previousCandidate.headSha === workspace.value.headSha &&
			previousCandidate.treeSha === workspace.value.treeSha
		const generation = sameRevision
			? previousCandidate.generation
			: (previousCandidate?.generation ?? 0) + 1
		const candidate: LedgerCandidate = sameRevision
			? {
					...previousCandidate,
					evidence,
				}
			: {
					schemaVersion: 1,
					generation,
					projectId: input.graph.projectId,
					workId: request.workId,
					graphFingerprint: input.graph.fingerprint,
					repositoryId: workspace.value.repositoryId,
					headSha: workspace.value.headSha,
					treeSha: workspace.value.treeSha,
					...(workspace.value.ref === undefined ? {} : { ref: workspace.value.ref }),
					isolation: workspace.value.isolation,
					submittedAt: timestamp,
					actor: request.actor,
					evidence,
				}
		const gateDigest = createHash('sha256')
			.update(
				JSON.stringify({
					generation,
					repositoryId: candidate.repositoryId,
					headSha: candidate.headSha,
					treeSha: candidate.treeSha,
					evidence: evidence.map(({ kind, digest }) => ({ kind, digest })),
				}),
			)
			.digest('hex')
		const gates: readonly LedgerGateReceipt[] = [
			{
				schemaVersion: 1,
				gate: 'validation',
				result: 'passed',
				candidateGeneration: generation,
				projectId: candidate.projectId,
				workId: candidate.workId,
				graphFingerprint: candidate.graphFingerprint,
				repositoryId: candidate.repositoryId,
				headSha: candidate.headSha,
				treeSha: candidate.treeSha,
				issuer: { kind: 'self', id: 'work-contract:evidence' },
				reference: 'work-contract:evidence',
				digest: gateDigest,
				observedAt: timestamp,
			},
		]
		const updated = await input.provider.recordSubmission({
			workId: request.workId,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
			candidate,
			gates,
			expectedDefinition: definitionExpectation(current.value.artifact, current.value.item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
		})
		if (!updated.ok) {
			return sanitizeProviderFailure(updated.error)
		}
		const validated = validateLifecycleItem({
			value: updated.value,
			projectId: input.graph.projectId,
			artifact: current.value.artifact,
			workId: request.workId,
			status: 'in_progress',
			assignee: request.actor,
			activity: current.value.item.activity,
			candidate,
			gates,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: {
						...commandReceipt({
							command: 'submit',
							workId: request.workId,
							actor: request.actor,
							previousStatus: current.value.item.status,
							item: validated.value,
							timestamp,
						}),
						candidate,
						gates,
					},
				}
			: validated
	}

	const complete: WorkContractService['complete'] = async (request) => {
		const validRequest = validateCompleteRequest(request)
		if (!validRequest.ok) {
			return validRequest
		}
		const current = await find(request.workId)
		if (!current.ok) {
			return current
		}
		const isAggregate = current.value.artifact.execution === 'aggregate'
		if (current.value.item.status === 'closed') {
			if (isAggregate) {
				return {
					ok: true,
					value: commandReceipt({
						command: 'complete',
						workId: request.workId,
						actor: current.value.item.evidence[0]?.actor ?? request.actor,
						previousStatus: 'closed',
						item: current.value.item,
						timestamp: current.value.item.updatedAt,
					}),
				}
			}
			const owned = verifyOperationContext({
				item: current.value.item,
				actor: request.actor,
				...(request.role === undefined ? {} : { role: request.role }),
				...(request.session === undefined ? {} : { session: request.session }),
			})
			return owned.ok
				? {
						ok: true,
						value: commandReceipt({
							command: 'complete',
							workId: request.workId,
							actor: current.value.item.activity?.actor ?? request.actor,
							previousStatus: 'closed',
							item: current.value.item,
							timestamp: current.value.item.updatedAt,
						}),
					}
				: owned
		}
		if (
			(!isAggregate && current.value.item.status !== 'in_progress') ||
			(isAggregate && current.value.item.status !== 'open')
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${request.workId} cannot complete from ${current.value.item.status}.`,
				},
			}
		}
		if (!isAggregate) {
			const owned = verifyOperationContext({
				item: current.value.item,
				actor: request.actor,
				...(request.role === undefined ? {} : { role: request.role }),
				...(request.session === undefined ? {} : { session: request.session }),
			})
			if (!owned.ok) {
				return owned
			}
		}
		const blockedBy = unsuccessfulDependencies(
			current.value.artifact,
			current.value.byId,
			artifacts,
		)
		if (blockedBy.length > 0) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_ready',
					message: `${request.workId} cannot complete until its dependencies succeed.`,
					details: [`Blocked by: ${blockedBy.join(', ')}`],
				},
			}
		}
		const progress = aggregateProgress(request.workId, current.value.byId, artifacts)
		if (isAggregate && !progress.completionReady) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'aggregate_not_ready',
					message: `${request.workId} cannot complete until every direct child is closed with its required evidence.`,
					details: progress.blockers.slice(0, 64),
				},
			}
		}
		const timestamp = clock().toISOString()
		let completionCandidate: LedgerCandidate | undefined
		let completionGates: readonly LedgerGateReceipt[] | undefined
		const evidence: LedgerEvidence[] = []
		if (isAggregate || deliveryPolicy.profile === 'evidence-only') {
			for (const candidate of request.evidence) {
				const verified = await safeLocalEvidence({
					root: input.root,
					reference: candidate.reference,
					kind: candidate.kind,
					actor: request.actor,
					timestamp,
					...(candidate.digest === undefined ? {} : { digest: candidate.digest }),
				})
				if (!verified.ok) {
					return verified
				}
				evidence.push(verified.value)
			}
		} else {
			const receipts = await loadDeliveryReceipts({
				root: input.root,
				references: request.receiptFiles ?? [],
			})
			if (!receipts.ok) {
				return receipts
			}
			const delivery = await evaluateDeliveryCompletion({
				root: input.root,
				graphFingerprint: input.graph.fingerprint,
				item: current.value.item,
				policy: deliveryPolicy,
				receipts: receipts.value,
			})
			if (!delivery.ok) {
				return delivery
			}
			completionCandidate = delivery.value.candidate
			completionGates = delivery.value.gates
			evidence.push(...delivery.value.candidate.evidence)
		}
		const providedKinds = new Set(evidence.map(({ kind }) => kind))
		const missing = current.value.artifact.evidenceRequirements.filter(
			(kind) => !providedKinds.has(kind),
		)
		if (missing.length > 0) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'evidence_incomplete',
					message: `Missing required evidence: ${missing.join(', ')}.`,
				},
			}
		}
		const updated = await input.provider.transition({
			type: 'complete',
			workId: request.workId,
			actor: request.actor,
			...(request.role === undefined ? {} : { role: request.role }),
			...(request.session === undefined ? {} : { session: request.session }),
			evidence,
			...(completionCandidate === undefined ? {} : { candidate: completionCandidate }),
			...(completionGates === undefined ? {} : { gates: completionGates }),
			timestamp,
			expectedDefinition: definitionExpectation(current.value.artifact, current.value.item),
			expectedDefinitionClosure: definitionClosureExpectations(request.workId, current.value.byId),
			expectedDependencies: dependencyExpectations(
				current.value.artifact,
				artifacts,
				current.value.byId,
			),
			expectedChildren: (isAggregate ? (childrenByParent.get(request.workId) ?? []) : []).flatMap(
				(childId) => {
					const child = artifacts.get(childId)
					return child === undefined
						? []
						: [
								{
									workId: childId,
									...definitionExpectation(child, current.value.byId.get(childId)),
								},
							]
				},
			),
		})
		if (!updated.ok) {
			return sanitizeProviderFailure(updated.error)
		}
		const validated = validateLifecycleItem({
			value: updated.value,
			projectId: input.graph.projectId,
			artifact: current.value.artifact,
			workId: request.workId,
			status: 'closed',
			assignee: isAggregate ? undefined : request.actor,
			activity: isAggregate ? undefined : current.value.item.activity,
			evidence,
			...(completionCandidate === undefined ? {} : { candidate: completionCandidate }),
			...(completionGates === undefined ? {} : { gates: completionGates }),
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		return validated.ok
			? {
					ok: true,
					value: commandReceipt({
						command: 'complete',
						workId: request.workId,
						actor: request.actor,
						previousStatus: current.value.item.status,
						item: validated.value,
						timestamp: validated.value.updatedAt,
					}),
				}
			: validated
	}

	const rollup: WorkContractService['rollup'] = async (workId) => {
		if (!artifacts.has(workId)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_found',
					message: 'Unknown work item.',
				},
			}
		}
		const current = await snapshot()
		if (!current.ok) {
			return current
		}
		const descendantIds = new Set<string>()
		const queue = [workId]
		let cursor = 0
		while (cursor < queue.length) {
			const parentId = queue[cursor]
			cursor += 1
			for (const id of parentId === undefined ? [] : (childrenByParent.get(parentId) ?? [])) {
				if (id === workId || descendantIds.has(id)) {
					continue
				}
				descendantIds.add(id)
				queue.push(id)
			}
		}
		const descendants = [...descendantIds].flatMap((id) => {
			const item = current.value.byId.get(id)
			const artifact = artifacts.get(id)
			return item === undefined || artifact === undefined ? [] : [{ item, artifact }]
		})
		const completed = descendants.filter(({ item, artifact }) =>
			isSuccessful(artifact, item),
		).length
		const activeCount = descendants.filter(({ item }) => item.status === 'in_progress').length
		const blockedCount = descendants.filter(({ item }) => item.status === 'blocked').length
		const readyCount = descendants.filter(({ item, artifact }) =>
			itemReady(artifact, item, current.value.byId, artifacts),
		).length
		const evidenceSatisfiedCount = descendants.filter(
			({ item, artifact }) => item.status === 'closed' && evidenceSatisfied(artifact, item),
		).length
		const reasons = descendants.flatMap(({ item }) =>
			item.status === 'blocked'
				? [`${item.workId}: ${item.blockReason ?? 'blocked without a recorded reason'}`]
				: [],
		)
		let status: WorkRollup['status'] = 'open'
		if (descendants.length > 0 && completed === descendants.length) {
			status = 'completed'
		} else if (blockedCount > 0) {
			status = 'blocked'
		} else if (activeCount > 0) {
			status = 'in_progress'
		} else if (readyCount > 0) {
			status = 'ready'
		}
		return {
			ok: true,
			value: {
				schemaVersion: 1,
				workId,
				total: descendants.length,
				completed,
				active: activeCount,
				blocked: blockedCount,
				ready: readyCount,
				evidenceSatisfied: evidenceSatisfiedCount,
				status,
				reasons,
			},
		}
	}

	return {
		validateDefinition,
		inspect,
		ready,
		active,
		submit,
		claim,
		touch: async (request) => updateActivity({ ...request, command: 'touch' }),
		resume: async (request) => updateActivity({ ...request, command: 'resume' }),
		handoff,
		block: async (request) => transition({ ...request, type: 'block' }),
		release: async (request) => transition({ ...request, type: 'release' }),
		reopen: async (request) => transition({ ...request, type: 'reopen' }),
		complete,
		rollup,
	}
}
