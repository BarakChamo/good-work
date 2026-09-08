/**
 * @description Provider-neutral ledger boundary used by the work-contract service.
 *
 * @module work/provider
 * @file Provider.ts
 */

import {
	array,
	boolean,
	check,
	custom,
	isoTimestamp,
	literal,
	maxLength,
	number,
	optional,
	picklist,
	pipe,
	regex,
	safeParse,
	strictObject,
	string,
	variant,
} from 'valibot'

import type {
	CompiledWorkGraph,
	CanonicalDefinitionRevision,
	EvidenceKind,
	WorkArtifact,
	WorkArtifactKind,
	WorkExecution,
	WorkError,
	WorkErrorCode,
	WorkDeliveryGate,
	WorkGateDisposition,
	WorkResult,
	WorkSourceReference,
} from './contracts'
import {
	CanonicalDefinitionRevisionSchema,
	WORK_DEFINITION_LIMITS,
	WORK_ERROR_CODES,
	WORK_ID_PATTERN,
} from './contracts'
import { INPUT_LIMITS } from './files'

const containsControlCharacter = (value: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
const containsUnsafeMultilineControlCharacter = (value: string): boolean => {
	for (const character of value) {
		const codePoint = character.codePointAt(0)
		if (character === '\u2028' || character === '\u2029') {
			return true
		}
		if (
			codePoint !== undefined &&
			(codePoint <= 8 ||
				codePoint === 11 ||
				codePoint === 12 ||
				(codePoint >= 14 && codePoint <= 31) ||
				(codePoint >= 127 && codePoint <= 159))
		) {
			return true
		}
	}
	return false
}
const boundedString = (maximumBytes: number) =>
	pipe(
		string(),
		check((value) => value.trim().length > 0, 'Value must not be empty or whitespace.'),
		check(
			(value) => !containsControlCharacter(value),
			'Value must not contain control characters.',
		),
		check(
			(value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
			`Value must not exceed ${maximumBytes} UTF-8 bytes.`,
		),
	)
const byteBoundedString = (maximumBytes: number) =>
	pipe(
		string(),
		check(
			(value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
			`Value must not exceed ${maximumBytes} UTF-8 bytes.`,
		),
	)
const boundedMultilineString = (maximumBytes: number) =>
	pipe(
		string(),
		check((value) => value.trim().length > 0, 'Value must not be empty or whitespace.'),
		check(
			(value) => !containsUnsafeMultilineControlCharacter(value),
			'Value must not contain unsafe control characters.',
		),
		check(
			(value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
			`Value must not exceed ${maximumBytes} UTF-8 bytes.`,
		),
	)
const WorkIdSchema = pipe(
	boundedString(WORK_DEFINITION_LIMITS.identityBytes),
	regex(WORK_ID_PATTERN),
)
const HashSchema = pipe(string(), regex(/^[a-f0-9]{64}$/))
const TimestampSchema = pipe(boundedString(40), isoTimestamp())
const WorkArtifactKindSchema = custom<WorkArtifactKind>(
	(value) =>
		typeof value === 'string' &&
		Buffer.byteLength(value, 'utf8') <= WORK_DEFINITION_LIMITS.kindBytes &&
		(['initiative', 'prd', 'issue', 'task', 'eval'].includes(value) ||
			/^custom:[a-z][a-z0-9-]*$/.test(value)),
)
const WorkExecutionSchema = picklist(['task', 'aggregate'])
const EvidenceKindSchema = custom<EvidenceKind>(
	(value) =>
		typeof value === 'string' &&
		Buffer.byteLength(value, 'utf8') <= WORK_DEFINITION_LIMITS.identityBytes &&
		(['test', 'review', 'build', 'ci', 'security', 'artifact'].includes(value) ||
			/^custom:[a-z][a-z0-9-]*$/.test(value)),
)
const AcceptanceListSchema = pipe(
	array(boundedString(WORK_DEFINITION_LIMITS.definitionListEntryBytes)),
	maxLength(WORK_DEFINITION_LIMITS.acceptanceItems),
	check(
		(values) =>
			values.reduce(
				(total, value, index) => total + Buffer.byteLength(value, 'utf8') + (index === 0 ? 0 : 1),
				0,
			) <= WORK_DEFINITION_LIMITS.acceptanceBytes,
		`Acceptance must not exceed ${WORK_DEFINITION_LIMITS.acceptanceBytes} UTF-8 bytes in aggregate.`,
	),
)
const WorkSourceReferenceSchema = strictObject({
	path: pipe(
		boundedString(WORK_DEFINITION_LIMITS.sourcePathBytes),
		check(
			(value) =>
				!value.startsWith('/') &&
				!value.startsWith('\\') &&
				!/^[A-Za-z]:/.test(value) &&
				!value.split(/[\\/]/u).includes('..'),
			'Repository source paths must be relative and must not traverse parent directories.',
		),
	),
	hash: HashSchema,
})
const WorkArtifactSchema = strictObject({
	id: WorkIdSchema,
	kind: WorkArtifactKindSchema,
	execution: WorkExecutionSchema,
	title: boundedString(WORK_DEFINITION_LIMITS.titleBytes),
	parentId: optional(WorkIdSchema),
	source: WorkSourceReferenceSchema,
	dependencies: pipe(array(WorkIdSchema), maxLength(WORK_DEFINITION_LIMITS.dependencies)),
	acceptance: AcceptanceListSchema,
	owners: pipe(
		array(boundedString(WORK_DEFINITION_LIMITS.identityBytes)),
		maxLength(WORK_DEFINITION_LIMITS.workIdentities),
	),
	roles: pipe(
		array(boundedString(WORK_DEFINITION_LIMITS.identityBytes)),
		maxLength(WORK_DEFINITION_LIMITS.workIdentities),
	),
	evidenceRequirements: pipe(
		array(EvidenceKindSchema),
		maxLength(WORK_DEFINITION_LIMITS.evidenceRequirements),
	),
	body: byteBoundedString(WORK_DEFINITION_LIMITS.bodyBytes),
})
const LedgerEvidenceSchema = strictObject({
	kind: EvidenceKindSchema,
	reference: boundedString(2000),
	digest: HashSchema,
	recordedAt: TimestampSchema,
	actor: boundedString(128),
})
const PositiveGenerationSchema = pipe(
	number(),
	check((value) => Number.isSafeInteger(value) && value > 0, 'Generation must be positive.'),
)
const CommitHashSchema = pipe(string(), regex(/^[a-f0-9]{40,64}$/))
const DeliveryGateSchema = picklist([
	'validation',
	'pull-request',
	'review',
	'ci',
	'security',
	'landing',
	'merge',
	'deployment',
])
const LedgerCandidateSchema = strictObject({
	schemaVersion: literal(1),
	generation: PositiveGenerationSchema,
	projectId: boundedString(WORK_DEFINITION_LIMITS.projectIdBytes),
	workId: WorkIdSchema,
	graphFingerprint: boundedString(128),
	repositoryId: HashSchema,
	headSha: CommitHashSchema,
	treeSha: CommitHashSchema,
	ref: optional(boundedString(256)),
	isolation: picklist(['main', 'worktree', 'container']),
	submittedAt: TimestampSchema,
	actor: boundedString(128),
	evidence: pipe(array(LedgerEvidenceSchema), maxLength(100)),
})
export const LedgerGateReceiptSchema = strictObject({
	schemaVersion: literal(1),
	gate: DeliveryGateSchema,
	result: picklist(['passed', 'failed', 'unavailable', 'stale', 'waived']),
	candidateGeneration: PositiveGenerationSchema,
	projectId: boundedString(WORK_DEFINITION_LIMITS.projectIdBytes),
	workId: WorkIdSchema,
	graphFingerprint: boundedString(128),
	repositoryId: HashSchema,
	headSha: CommitHashSchema,
	treeSha: CommitHashSchema,
	issuer: strictObject({ kind: picklist(['self', 'adapter']), id: boundedString(128) }),
	reference: boundedString(2000),
	digest: HashSchema,
	observedAt: TimestampSchema,
})
const LedgerActivitySchema = strictObject({
	actor: boundedString(128),
	role: optional(boundedString(128)),
	session: optional(boundedString(256)),
	startedAt: TimestampSchema,
	touchedAt: TimestampSchema,
})
const LedgerHandoffSchema = strictObject({
	actor: boundedString(128),
	summary: boundedMultilineString(4000),
	remaining: pipe(array(boundedString(2000)), maxLength(100)),
	references: pipe(array(boundedString(2000)), maxLength(100)),
	createdAt: TimestampSchema,
	fromSession: optional(boundedString(256)),
	toActor: optional(boundedString(128)),
})
const LedgerStatusSchema = picklist([
	'open',
	'in_progress',
	'blocked',
	'closed',
	'deferred',
	'archived',
])
const LedgerProjectionSourceSchema = strictObject({
	path: pipe(
		boundedString(WORK_DEFINITION_LIMITS.sourcePathBytes),
		check(
			(value) =>
				!value.startsWith('/') &&
				!value.startsWith('\\') &&
				!/^[A-Za-z]:/.test(value) &&
				!value.split(/[\\/]/u).includes('..'),
			'Repository source paths must be relative and must not traverse parent directories.',
		),
	),
	hash: boundedString(128),
})
const LedgerDefinitionExpectationFields = {
	title: boundedString(WORK_DEFINITION_LIMITS.titleBytes),
	kind: WorkArtifactKindSchema,
	execution: optional(WorkExecutionSchema),
	source: WorkSourceReferenceSchema,
	parentId: optional(WorkIdSchema),
	dependencies: pipe(
		array(WorkIdSchema),
		maxLength(WORK_DEFINITION_LIMITS.dependencies),
		check(
			(dependencies) => new Set(dependencies).size === dependencies.length,
			'Dependencies must use unique work IDs.',
		),
	),
	roles: pipe(
		array(boundedString(WORK_DEFINITION_LIMITS.identityBytes)),
		maxLength(WORK_DEFINITION_LIMITS.workIdentities),
	),
	evidenceRequirements: pipe(
		array(EvidenceKindSchema),
		maxLength(WORK_DEFINITION_LIMITS.evidenceRequirements),
	),
}
const LedgerDefinitionExpectationV2Entries = {
	schemaVersion: literal(2),
	// Accepted and ignored for compatibility with schema-v1 callers; graph identity is plan provenance.
	graphFingerprint: optional(HashSchema),
	...LedgerDefinitionExpectationFields,
}
const LedgerDefinitionExpectationV3Entries = {
	schemaVersion: literal(3),
	graphFingerprint: HashSchema,
	definitionRevision: CanonicalDefinitionRevisionSchema,
	...LedgerDefinitionExpectationFields,
}
const LedgerDefinitionExpectationSchema = pipe(
	variant('schemaVersion', [
		strictObject(LedgerDefinitionExpectationV2Entries),
		strictObject(LedgerDefinitionExpectationV3Entries),
	]),
	check(
		(input) =>
			input.schemaVersion === 2 ||
			input.graphFingerprint === input.definitionRevision.graphFingerprint,
		'Expected definition graph fingerprint must match its canonical revision.',
	),
)
const LedgerScopedDefinitionExpectationSchema = pipe(
	variant('schemaVersion', [
		strictObject({ workId: WorkIdSchema, ...LedgerDefinitionExpectationV2Entries }),
		strictObject({ workId: WorkIdSchema, ...LedgerDefinitionExpectationV3Entries }),
	]),
	check(
		(input) =>
			input.schemaVersion === 2 ||
			input.graphFingerprint === input.definitionRevision.graphFingerprint,
		'Expected definition graph fingerprint must match its canonical revision.',
	),
)
const LedgerDependencyExpectationsSchema = pipe(
	array(LedgerScopedDefinitionExpectationSchema),
	maxLength(WORK_DEFINITION_LIMITS.dependencies),
	check(
		(expectations) =>
			new Set(expectations.map(({ workId }) => workId)).size === expectations.length,
		'Dependency expectations must use unique work IDs.',
	),
)
const LedgerDefinitionClosureExpectationsSchema = pipe(
	array(LedgerScopedDefinitionExpectationSchema),
	maxLength(INPUT_LIMITS.sourceItems),
	check(
		(expectations) =>
			new Set(expectations.map(({ workId }) => workId)).size === expectations.length,
		'Definition closure expectations must use unique work IDs.',
	),
)

/** @description Runtime schema for definition create/update operations. */
export const LedgerDefinitionInputSchema = pipe(
	strictObject({
		projectId: boundedString(WORK_DEFINITION_LIMITS.projectIdBytes),
		graphFingerprint: HashSchema,
		definitionRevision: optional(CanonicalDefinitionRevisionSchema),
		artifact: WorkArtifactSchema,
	}),
	check(
		(input) =>
			input.definitionRevision === undefined ||
			input.definitionRevision.graphFingerprint === input.graphFingerprint,
		'Canonical revision graph fingerprint must match the definition graph fingerprint.',
	),
)

/** @description Runtime schema for exact relation reconciliation. */
export const LedgerRelationsInputSchema = strictObject({
	workId: WorkIdSchema,
	parentId: optional(WorkIdSchema),
	dependencies: pipe(array(WorkIdSchema), maxLength(WORK_DEFINITION_LIMITS.dependencies)),
})

/** @description Runtime schema for one work-ID operation. */
export const LedgerWorkIdInputSchema = strictObject({ workId: WorkIdSchema })

/** @description Runtime schema for compare-and-set claims. */
export const LedgerClaimInputSchema = pipe(
	strictObject({
		workId: WorkIdSchema,
		actor: boundedString(128),
		role: optional(boundedString(128)),
		session: optional(boundedString(256)),
		timestamp: TimestampSchema,
		expectedDefinition: LedgerDefinitionExpectationSchema,
		expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
		expectedDependencies: LedgerDependencyExpectationsSchema,
	}),
	check(
		(input) => input.expectedDefinitionClosure.some(({ workId }) => workId === input.workId),
		'Definition closure expectations must include the guarded work ID.',
	),
)

/** @description Runtime schema for owned liveness records. */
export const LedgerActivityInputSchema = pipe(
	strictObject({
		workId: WorkIdSchema,
		actor: boundedString(128),
		role: optional(boundedString(128)),
		session: optional(boundedString(256)),
		activity: LedgerActivitySchema,
		replaceSession: boolean(),
		expectedDefinition: LedgerDefinitionExpectationSchema,
		expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
	}),
	check(
		(input) => input.expectedDefinitionClosure.some(({ workId }) => workId === input.workId),
		'Definition closure expectations must include the guarded work ID.',
	),
)

/** @description Runtime schema for owned bounded handoffs. */
export const LedgerHandoffInputSchema = pipe(
	strictObject({
		workId: WorkIdSchema,
		actor: boundedString(128),
		role: optional(boundedString(128)),
		session: optional(boundedString(256)),
		handoff: LedgerHandoffSchema,
		release: boolean(),
		expectedDefinition: LedgerDefinitionExpectationSchema,
		expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
	}),
	check(
		(input) => input.expectedDefinitionClosure.some(({ workId }) => workId === input.workId),
		'Definition closure expectations must include the guarded work ID.',
	),
)

/** @description Runtime schema for one durable candidate submission. */
export const LedgerSubmissionInputSchema = pipe(
	strictObject({
		workId: WorkIdSchema,
		actor: boundedString(128),
		role: optional(boundedString(128)),
		session: optional(boundedString(256)),
		candidate: LedgerCandidateSchema,
		gates: pipe(array(LedgerGateReceiptSchema), maxLength(32)),
		expectedDefinition: LedgerDefinitionExpectationSchema,
		expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
	}),
	check(
		(input) => input.expectedDefinitionClosure.some(({ workId }) => workId === input.workId),
		'Definition closure expectations must include the guarded work ID.',
	),
)

const LedgerGateReceiptsSchema = pipe(array(LedgerGateReceiptSchema), maxLength(32))
const LedgerBlockTransitionInputSchema = strictObject({
	type: literal('block'),
	workId: WorkIdSchema,
	actor: boundedString(128),
	role: optional(boundedString(128)),
	session: optional(boundedString(256)),
	reason: boundedString(2000),
	expectedDefinition: LedgerDefinitionExpectationSchema,
	expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
})
const LedgerReleaseTransitionInputSchema = strictObject({
	type: literal('release'),
	workId: WorkIdSchema,
	actor: boundedString(128),
	role: optional(boundedString(128)),
	session: optional(boundedString(256)),
	reason: boundedString(2000),
	expectedDefinition: LedgerDefinitionExpectationSchema,
	expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
})
const LedgerCompleteTransitionInputSchema = pipe(
	strictObject({
		type: literal('complete'),
		workId: WorkIdSchema,
		actor: boundedString(128),
		role: optional(boundedString(128)),
		session: optional(boundedString(256)),
		evidence: pipe(array(LedgerEvidenceSchema), maxLength(100)),
		candidate: optional(LedgerCandidateSchema),
		gates: optional(LedgerGateReceiptsSchema),
		timestamp: TimestampSchema,
		expectedDefinition: LedgerDefinitionExpectationSchema,
		expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
		expectedDependencies: LedgerDependencyExpectationsSchema,
		expectedChildren: optional(LedgerDependencyExpectationsSchema),
	}),
	check(
		(input) =>
			input.expectedDefinition.execution !== 'aggregate' ||
			(input.expectedChildren !== undefined && input.expectedChildren.length > 0),
		'Aggregate completion requires at least one direct-child expectation.',
	),
)
const LedgerReopenTransitionInputSchema = strictObject({
	type: literal('reopen'),
	workId: WorkIdSchema,
	actor: boundedString(128),
	role: optional(boundedString(128)),
	session: optional(boundedString(256)),
	reason: boundedString(2000),
	expectedDefinition: LedgerDefinitionExpectationSchema,
	expectedDefinitionClosure: LedgerDefinitionClosureExpectationsSchema,
	expectedAggregateParents: optional(LedgerDependencyExpectationsSchema),
})

/** @description Runtime schema for explicit owned lifecycle transitions. */
export const LedgerTransitionInputSchema = pipe(
	variant('type', [
		LedgerBlockTransitionInputSchema,
		LedgerReleaseTransitionInputSchema,
		LedgerCompleteTransitionInputSchema,
		LedgerReopenTransitionInputSchema,
	]),
	check(
		(input) => input.expectedDefinitionClosure.some(({ workId }) => workId === input.workId),
		'Definition closure expectations must include the guarded work ID.',
	),
)

const LedgerItemEntries = {
	providerId: boundedString(2000),
	projectId: boundedString(WORK_DEFINITION_LIMITS.projectIdBytes),
	workId: WorkIdSchema,
	title: boundedString(WORK_DEFINITION_LIMITS.titleBytes),
	kind: WorkArtifactKindSchema,
	execution: optional(WorkExecutionSchema),
	status: LedgerStatusSchema,
	parentId: optional(WorkIdSchema),
	dependencies: pipe(array(WorkIdSchema), maxLength(WORK_DEFINITION_LIMITS.dependencies)),
	roles: pipe(
		array(boundedString(WORK_DEFINITION_LIMITS.identityBytes)),
		maxLength(WORK_DEFINITION_LIMITS.workIdentities),
	),
	evidenceRequirements: pipe(
		array(EvidenceKindSchema),
		maxLength(WORK_DEFINITION_LIMITS.evidenceRequirements),
	),
	source: LedgerProjectionSourceSchema,
	assignee: optional(boundedString(128)),
	activity: optional(LedgerActivitySchema),
	handoff: optional(LedgerHandoffSchema),
	evidence: pipe(array(LedgerEvidenceSchema), maxLength(100)),
	candidate: optional(LedgerCandidateSchema),
	gates: optional(pipe(array(LedgerGateReceiptSchema), maxLength(32))),
	blockReason: optional(boundedString(2000)),
	updatedAt: TimestampSchema,
}

/** @description Runtime schema for one version-discriminated provider-neutral ledger item. */
export const LedgerItemSchema = pipe(
	variant('definitionSchemaVersion', [
		strictObject({
			definitionSchemaVersion: literal(1),
			...LedgerItemEntries,
			graphFingerprint: boundedString(128),
		}),
		strictObject({
			definitionSchemaVersion: literal(2),
			...LedgerItemEntries,
			graphFingerprint: boundedString(128),
		}),
		strictObject({
			definitionSchemaVersion: literal(3),
			...LedgerItemEntries,
			graphFingerprint: HashSchema,
			definitionRevision: CanonicalDefinitionRevisionSchema,
		}),
	]),
	check(
		(item) =>
			item.definitionSchemaVersion !== 3 ||
			item.graphFingerprint === item.definitionRevision.graphFingerprint,
		'Canonical ledger fingerprints must match their definition revision.',
	),
)

const providerProjectionItemBytes = INPUT_LIMITS.providerItemBytes
const providerProjectionItems = INPUT_LIMITS.providerItems
const providerProjectionAggregateBytes = INPUT_LIMITS.providerAggregateBytes

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const providerErrorCodes = new Set<string>(WORK_ERROR_CODES)
const isProviderErrorCode = (value: unknown): value is WorkErrorCode =>
	typeof value === 'string' && providerErrorCodes.has(value)

const providerCleanupFailures = new Set<string>([
	...WORK_ERROR_CODES,
	'temporary_metadata_cleanup_failed',
])

/** @description Redacts one untrusted adapter error while retaining safe retry semantics. */
export const sanitizeProviderError = (value: unknown): WorkError => {
	const code = isRecord(value) && isProviderErrorCode(value.code) ? value.code : 'provider_failed'
	const rawDetails =
		isRecord(value) && Array.isArray(value.details) ? value.details.slice(0, 16) : []
	const stateMayHaveChanged = rawDetails.includes('stateMayHaveChanged=true')
	const retrySafe = rawDetails.includes('retrySafe=true')
	const staleLock =
		rawDetails.includes('lockState=stale') && rawDetails.includes('automaticRecovery=false')
	const cleanupFailure = rawDetails.find(
		(detail): detail is string =>
			typeof detail === 'string' &&
			detail.startsWith('cleanupFailure=') &&
			providerCleanupFailures.has(detail.slice('cleanupFailure='.length)),
	)
	let recovery: string | undefined
	if (staleLock) {
		recovery = 'recovery=inspect provider lock ownership before manual removal'
	} else if (stateMayHaveChanged) {
		recovery = 'recovery=inspect provider state and reconcile before retrying'
	} else if (retrySafe) {
		recovery = 'recovery=retry the same command after restoring provider availability'
	}
	const details = [
		...(stateMayHaveChanged ? ['stateMayHaveChanged=true'] : []),
		...(retrySafe ? ['retrySafe=true'] : []),
		...(staleLock ? ['lockState=stale', 'automaticRecovery=false'] : []),
		...(cleanupFailure === undefined ? [] : [cleanupFailure]),
		...(recovery === undefined ? [] : [recovery]),
	]
	return {
		type: 'work_contract_error',
		code,
		message: 'Ledger provider operation failed.',
		...(details.length === 0 ? {} : { details }),
	}
}

/** @description Validates an untrusted provider list before service graph operations. */
export const validateLedgerProjection = (value: unknown): WorkResult<readonly LedgerItem[]> => {
	if (!Array.isArray(value) || value.length > providerProjectionItems) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: `Ledger projection must contain at most ${providerProjectionItems} items.`,
			},
		}
	}
	const items: LedgerItem[] = []
	let aggregateBytes = 2
	for (const candidate of value) {
		const parsed = safeParse(LedgerItemSchema, candidate)
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Ledger provider returned an invalid projection item.',
				},
			}
		}
		const itemBytes = Buffer.byteLength(JSON.stringify(parsed.output), 'utf8')
		aggregateBytes += itemBytes + (items.length === 0 ? 0 : 1)
		if (
			itemBytes > providerProjectionItemBytes ||
			aggregateBytes > providerProjectionAggregateBytes
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Ledger provider projection exceeds its bounded data contract.',
				},
			}
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Valibot validated the complete exported LedgerItem runtime schema.
		items.push(parsed.output as LedgerItem)
	}
	return { ok: true, value: items }
}

/** @description Provider-neutral operational status stored by the ledger. */
export type LedgerStatus = 'open' | 'in_progress' | 'blocked' | 'closed' | 'deferred' | 'archived'

/** @description Bounded current worker activity metadata. */
export interface LedgerActivity {
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly startedAt: string
	readonly touchedAt: string
}

/** @description Immutable verified evidence receipt. */
export interface LedgerEvidence {
	readonly kind: EvidenceKind
	readonly reference: string
	readonly digest: string
	readonly recordedAt: string
	readonly actor: string
}

/** @description Exact, immutable Git candidate currently submitted for one work item. */
export interface LedgerCandidate {
	readonly schemaVersion: 1
	readonly generation: number
	readonly projectId: string
	readonly workId: string
	readonly graphFingerprint: string
	readonly repositoryId: string
	readonly headSha: string
	readonly treeSha: string
	readonly ref?: string
	readonly isolation: 'main' | 'worktree' | 'container'
	readonly submittedAt: string
	readonly actor: string
	readonly evidence: readonly LedgerEvidence[]
}

/** @description Candidate-bound normalized delivery-gate receipt. */
export interface LedgerGateReceipt {
	readonly schemaVersion: 1
	readonly gate: WorkDeliveryGate
	readonly result: WorkGateDisposition
	readonly candidateGeneration: number
	readonly projectId: string
	readonly workId: string
	readonly graphFingerprint: string
	readonly repositoryId: string
	readonly headSha: string
	readonly treeSha: string
	readonly issuer: { readonly kind: 'self' | 'adapter'; readonly id: string }
	readonly reference: string
	readonly digest: string
	readonly observedAt: string
}

/** @description Bounded cross-session continuation summary. */
export interface LedgerHandoff {
	readonly actor: string
	readonly summary: string
	readonly remaining: readonly string[]
	readonly references: readonly string[]
	readonly createdAt: string
	readonly fromSession?: string
	readonly toActor?: string
}

/** @description Normalized provider-neutral ledger projection for one work item. */
export interface LedgerItem {
	readonly definitionSchemaVersion: 1 | 2 | 3
	readonly providerId: string
	readonly projectId: string
	readonly workId: string
	readonly title: string
	readonly kind: WorkArtifactKind
	readonly execution?: WorkExecution
	readonly status: LedgerStatus
	readonly parentId: string | undefined
	readonly dependencies: readonly string[]
	readonly roles: readonly string[]
	readonly evidenceRequirements: readonly EvidenceKind[]
	readonly source: WorkSourceReference
	readonly graphFingerprint: string
	readonly definitionRevision?: CanonicalDefinitionRevision | undefined
	readonly assignee: string | undefined
	readonly activity: LedgerActivity | undefined
	readonly handoff: LedgerHandoff | undefined
	readonly evidence: readonly LedgerEvidence[]
	readonly candidate?: LedgerCandidate
	readonly gates?: readonly LedgerGateReceipt[]
	readonly blockReason: string | undefined
	readonly updatedAt: string
}

/** @description Definition fields revalidated under an item mutation lock. */
interface LedgerDefinitionExpectationFields {
	readonly title: string
	readonly kind: WorkArtifactKind
	readonly execution?: WorkExecution
	readonly source: WorkSourceReference
	readonly parentId?: string | undefined
	readonly dependencies: readonly string[]
	readonly roles: readonly string[]
	readonly evidenceRequirements: readonly EvidenceKind[]
}

/** @description Exact file-owned definition binding revalidated under an item mutation lock. */
export type LedgerDefinitionExpectation = LedgerDefinitionExpectationFields &
	(
		| {
				readonly schemaVersion: 2
				readonly graphFingerprint?: string | undefined
				readonly definitionRevision?: never
		  }
		| {
				readonly schemaVersion: 3
				readonly graphFingerprint: string
				readonly definitionRevision: CanonicalDefinitionRevision
		  }
	)

/** @description File-owned dependency definition and evidence policy guarded with a mutation. */
export type LedgerDependencyExpectation = LedgerDefinitionExpectation & { readonly workId: string }

/** @description One member of the full definition closure guarded with an actor mutation. */
export type LedgerDefinitionClosureExpectation = LedgerDefinitionExpectation & {
	readonly workId: string
}

/** @description File-owned definition fields accepted by a ledger adapter. */
export interface LedgerDefinitionInput {
	readonly projectId: string
	readonly graphFingerprint: string
	readonly definitionRevision?: CanonicalDefinitionRevision | undefined
	readonly artifact: WorkArtifact
}

/** @description Structured result of a serialized bulk definition admission. */
export type LedgerDefinitionBatchResult =
	| { readonly ok: true; readonly value: readonly LedgerItem[] }
	| {
			readonly ok: false
			readonly error: WorkError
			readonly applied: number
			readonly failedIndex?: number
	  }

/** @description Exact hierarchy and dependency relations accepted by a ledger adapter. */
export interface LedgerRelationsInput {
	readonly workId: string
	readonly parentId: string | undefined
	readonly dependencies: readonly string[]
}

/** @description Minimal provider contract required for deterministic definition reconciliation. */
export interface LedgerProvider {
	readonly doctor: () => Promise<
		WorkResult<{ readonly provider: string; readonly version: string }>
	>
	readonly list: () => Promise<WorkResult<readonly LedgerItem[]>>
	readonly createDefinition: (input: LedgerDefinitionInput) => Promise<WorkResult<LedgerItem>>
	readonly createDefinitions?: (
		inputs: readonly LedgerDefinitionInput[],
	) => Promise<LedgerDefinitionBatchResult>
	readonly updateDefinition: (input: LedgerDefinitionInput) => Promise<WorkResult<LedgerItem>>
	readonly setRelations: (input: LedgerRelationsInput) => Promise<WorkResult<LedgerItem>>
	readonly archive: (workId: string) => Promise<WorkResult<LedgerItem>>
	readonly discoverLegacyDefinitions?: () => Promise<WorkResult<readonly LedgerItem[]>>
	readonly finalizeLegacyMigration?: () => Promise<WorkResult<void>>
	readonly inspectCoordinationHealth?: () => Promise<WorkResult<void>>
}

/** @description Atomic actor-claim request with optional role and session audit metadata. */
export interface LedgerClaimInput {
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly timestamp: string
	readonly expectedDefinition: LedgerDefinitionExpectation
	readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
	readonly expectedDependencies: readonly LedgerDependencyExpectation[]
}

/** @description Owned liveness update request. */
export interface LedgerActivityInput {
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly activity: LedgerActivity
	readonly replaceSession: boolean
	readonly expectedDefinition: LedgerDefinitionExpectation
	readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
}

/** @description Owned structured handoff request. */
export interface LedgerHandoffInput {
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly handoff: LedgerHandoff
	readonly release: boolean
	readonly expectedDefinition: LedgerDefinitionExpectation
	readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
}

/** @description Owned candidate persistence request guarded by the current file definition. */
export interface LedgerSubmissionInput {
	readonly workId: string
	readonly actor: string
	readonly role?: string
	readonly session?: string
	readonly candidate: LedgerCandidate
	readonly gates: readonly LedgerGateReceipt[]
	readonly expectedDefinition: LedgerDefinitionExpectation
	readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
}

/** @description Explicit owned lifecycle transition accepted by a collaborative ledger. */
export type LedgerTransitionInput =
	| {
			readonly type: 'block'
			readonly workId: string
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly reason: string
			readonly expectedDefinition: LedgerDefinitionExpectation
			readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
	  }
	| {
			readonly type: 'release'
			readonly workId: string
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly reason: string
			readonly expectedDefinition: LedgerDefinitionExpectation
			readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
	  }
	| {
			readonly type: 'complete'
			readonly workId: string
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly evidence: readonly LedgerEvidence[]
			readonly candidate?: LedgerCandidate
			readonly gates?: readonly LedgerGateReceipt[]
			readonly timestamp: string
			readonly expectedDefinition: LedgerDefinitionExpectation
			readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
			readonly expectedDependencies: readonly LedgerDependencyExpectation[]
			readonly expectedChildren?: readonly LedgerDependencyExpectation[]
	  }
	| {
			readonly type: 'reopen'
			readonly workId: string
			readonly actor: string
			readonly role?: string
			readonly session?: string
			readonly reason: string
			readonly expectedDefinition: LedgerDefinitionExpectation
			readonly expectedDefinitionClosure: readonly LedgerDefinitionClosureExpectation[]
			readonly expectedAggregateParents?: readonly LedgerDependencyExpectation[]
	  }

/** @description Ledger provider that additionally supports human/agent lifecycle coordination. */
export interface CollaborativeLedgerProvider extends LedgerProvider {
	readonly claim: (input: LedgerClaimInput) => Promise<WorkResult<LedgerItem>>
	readonly recordActivity: (input: LedgerActivityInput) => Promise<WorkResult<LedgerItem>>
	readonly recordHandoff: (input: LedgerHandoffInput) => Promise<WorkResult<LedgerItem>>
	readonly recordSubmission: (input: LedgerSubmissionInput) => Promise<WorkResult<LedgerItem>>
	readonly transition: (input: LedgerTransitionInput) => Promise<WorkResult<LedgerItem>>
}

/** @description Replaceable operational projection of one project ledger revision. */
export interface WorkContractSnapshot {
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
}
