/**
 * @description Adapts the supported Beads CLI JSON contract without exposing Dolt or Beads internals.
 *
 * @module work/beads
 * @file Beads.ts
 */

import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { link, lstat, open, opendir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { env as processEnvironment, kill as signalProcess, pid as processId } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
	array,
	boolean,
	check,
	isoTimestamp,
	literal,
	maxLength,
	minLength,
	number,
	object,
	optional,
	picklist,
	pipe,
	regex,
	safeParse,
	strictObject,
	string,
	union,
	variant,
} from 'valibot'
import type { GenericSchema, InferOutput } from 'valibot'

import type { EvidenceKind, WorkArtifactKind, WorkError, WorkResult } from './contracts'
import { WORK_DEFINITION_LIMITS, WORK_ID_PATTERN } from './contracts'
import { resolveDefaultBeadsBinary } from './beads-binary'
import { measureCommandPhase, measureCommandPhaseSync } from './command-profile'
import { INPUT_LIMITS, readBoundedContainedFile, readBoundedUtf8, writeUtf8NoFollow } from './files'
import type {
	LedgerActivity,
	CollaborativeLedgerProvider,
	LedgerDefinitionInput,
	LedgerDefinitionExpectation,
	LedgerDefinitionBatchResult,
	LedgerDependencyExpectation,
	LedgerEvidence,
	LedgerHandoff,
	LedgerCandidate,
	LedgerGateReceipt,
	LedgerItem,
	LedgerRelationsInput,
	LedgerStatus,
	LedgerActivityInput,
	LedgerClaimInput,
	LedgerHandoffInput,
	LedgerSubmissionInput,
	LedgerTransitionInput,
} from './provider'
import {
	LedgerActivityInputSchema,
	LedgerClaimInputSchema,
	LedgerDefinitionInputSchema,
	LedgerHandoffInputSchema,
	LedgerSubmissionInputSchema,
	LedgerItemSchema,
	LedgerRelationsInputSchema,
	LedgerTransitionInputSchema,
	LedgerWorkIdInputSchema,
} from './provider'
import { prepareSafeOutputPath } from './paths'

const boundedString = (maximumBytes: number) =>
	pipe(
		string(),
		minLength(1),
		check((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), 'Value contains unsafe controls.'),
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
			(value) =>
				// oxlint-disable-next-line eslint/no-control-regex -- Handoffs permit newline/tab but reject every other control byte.
				!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u.test(value),
			'Value contains unsafe controls.',
		),
		check(
			(value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
			`Value must not exceed ${maximumBytes} UTF-8 bytes.`,
		),
	)
const TimestampSchema = pipe(boundedString(40), isoTimestamp())
const HashSchema = pipe(string(), regex(/^[a-f0-9]{64}$/))
const WorkIdSchema = pipe(
	boundedString(WORK_DEFINITION_LIMITS.identityBytes),
	regex(WORK_ID_PATTERN),
)
const SourcePathSchema = pipe(boundedString(500), regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/))
const EvidenceKindSchema = pipe(
	string(),
	regex(/^(?:test|review|build|ci|security|artifact|custom:[a-z][a-z0-9-]*)$/),
)

const ActivitySchema = strictObject({
	actor: boundedString(128),
	role: optional(boundedString(128)),
	session: optional(boundedString(256)),
	started_at: TimestampSchema,
	touched_at: TimestampSchema,
})

const EvidenceSchema = strictObject({
	kind: EvidenceKindSchema,
	reference: boundedString(2000),
	digest: HashSchema,
	recorded_at: TimestampSchema,
	actor: boundedString(128),
})

const CandidateSchema = strictObject({
	schema_version: literal(1),
	generation: pipe(
		number(),
		check((value) => Number.isSafeInteger(value) && value > 0),
	),
	project_id: boundedString(128),
	work_id: WorkIdSchema,
	graph_fingerprint: boundedString(128),
	repository_id: HashSchema,
	head_sha: pipe(string(), regex(/^[a-f0-9]{40,64}$/)),
	tree_sha: pipe(string(), regex(/^[a-f0-9]{40,64}$/)),
	ref: optional(boundedString(256)),
	isolation: picklist(['main', 'worktree', 'container']),
	submitted_at: TimestampSchema,
	actor: boundedString(128),
	evidence: pipe(array(EvidenceSchema), maxLength(100)),
})

const GateSchema = strictObject({
	schema_version: literal(1),
	gate: picklist([
		'validation',
		'pull-request',
		'review',
		'ci',
		'security',
		'landing',
		'merge',
		'deployment',
	]),
	result: picklist(['passed', 'failed', 'unavailable', 'stale', 'waived']),
	candidate_generation: pipe(
		number(),
		check((value) => Number.isSafeInteger(value) && value > 0),
	),
	project_id: boundedString(128),
	work_id: WorkIdSchema,
	graph_fingerprint: boundedString(128),
	repository_id: HashSchema,
	head_sha: pipe(string(), regex(/^[a-f0-9]{40,64}$/)),
	tree_sha: pipe(string(), regex(/^[a-f0-9]{40,64}$/)),
	issuer: strictObject({ kind: picklist(['self', 'adapter']), id: boundedString(128) }),
	reference: boundedString(2000),
	digest: HashSchema,
	observed_at: TimestampSchema,
})

const HandoffSchema = strictObject({
	actor: boundedString(128),
	summary: boundedMultilineString(4000),
	remaining: pipe(array(boundedString(2000)), maxLength(100)),
	references: pipe(array(boundedString(2000)), maxLength(100)),
	created_at: TimestampSchema,
	from_session: optional(boundedString(256)),
	to_actor: optional(boundedString(128)),
})

const commonWorkMetadataSchema = {
	project_id: boundedString(128),
	work_id: WorkIdSchema,
	kind: pipe(string(), regex(/^(?:initiative|prd|issue|task|eval|custom:[a-z][a-z0-9-]*)$/)),
	execution: optional(picklist(['task', 'aggregate'])),
	source_path: SourcePathSchema,
	source_hash: HashSchema,
	graph_fingerprint: HashSchema,
	activity: optional(ActivitySchema),
	handoff: optional(HandoffSchema),
	evidence: optional(pipe(array(EvidenceSchema), maxLength(100))),
	candidate: optional(CandidateSchema),
	gates: optional(pipe(array(GateSchema), maxLength(32))),
	block_reason: optional(boundedString(2000)),
	archived: optional(boolean()),
}
const RolesSchema = pipe(array(boundedString(128)), maxLength(100))
const EvidenceRequirementsSchema = pipe(array(EvidenceKindSchema), maxLength(100))

/* oxlint-disable unicorn/max-nested-calls -- The strict versioned metadata schema is clearer when structurally nested. */
const WorkMetadataSchema = variant('schema_version', [
	strictObject({ schema_version: literal(1), ...commonWorkMetadataSchema }),
	strictObject({
		schema_version: literal(2),
		...commonWorkMetadataSchema,
		roles: RolesSchema,
		evidence_requirements: EvidenceRequirementsSchema,
	}),
	strictObject({
		schema_version: literal(3),
		...commonWorkMetadataSchema,
		roles: RolesSchema,
		evidence_requirements: EvidenceRequirementsSchema,
		definition_revision: strictObject({
			target_ref: pipe(boundedString(256), regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u)),
			target_sha: optional(pipe(string(), regex(/^[a-f0-9]{40,64}$/))),
			graph_fingerprint: HashSchema,
		}),
	}),
])
/* oxlint-enable unicorn/max-nested-calls */

const LegacyMetadataSchema = strictObject({
	initiative: boundedString(128),
	prd: boundedString(128),
	revision: HashSchema,
	source: SourcePathSchema,
})

const MetadataSchema = object({
	work_contract_project_key: optional(HashSchema),
	work_contract: optional(WorkMetadataSchema),
	// Retained solely so existing pre-extraction provider records remain recoverable.
	symphony: optional(LegacyMetadataSchema),
})

const DependencySchema = object({
	id: optional(boundedString(512)),
	dependency_type: optional(boundedString(128)),
	issue_id: optional(boundedString(512)),
	depends_on_id: optional(boundedString(512)),
	type: optional(boundedString(128)),
	metadata: optional(union([boundedString(4096), MetadataSchema])),
})

const BeadsRecordSchema = object({
	id: boundedString(512),
	title: boundedString(WORK_DEFINITION_LIMITS.titleBytes),
	status: picklist(['open', 'in_progress', 'blocked', 'deferred', 'closed']),
	priority: number(),
	issue_type: boundedString(WORK_DEFINITION_LIMITS.kindBytes),
	created_at: TimestampSchema,
	started_at: optional(TimestampSchema),
	updated_at: TimestampSchema,
	closed_at: optional(TimestampSchema),
	external_ref: optional(boundedString(2000)),
	assignee: optional(boundedString(WORK_DEFINITION_LIMITS.identityBytes)),
	close_reason: optional(boundedString(2000)),
	notes: optional(boundedMultilineString(2000)),
	metadata: optional(MetadataSchema),
	dependencies: optional(
		pipe(array(DependencySchema), maxLength(WORK_DEFINITION_LIMITS.dependencies + 1)),
	),
})

const BeadsRecordsSchema = array(BeadsRecordSchema)

const MutationLockOwnerSchema = strictObject({
	pid: number(),
	startedAt: TimestampSchema,
	nonce: boundedString(128),
})

const LegacyMigrationMarkerSchema = strictObject({
	schemaVersion: literal(1),
	projectKey: HashSchema,
})

const recoveryProjectionMaxRecords = 10_000
const RecoveryProjectionStatusSchema = picklist([
	'open',
	'in_progress',
	'blocked',
	'closed',
	'deferred',
	'archived',
])
const RecoveryProjectionExpectationSchema = strictObject({
	workId: WorkIdSchema,
	status: optional(RecoveryProjectionStatusSchema),
})
const RecoveryProjectionExpectationsSchema = pipe(
	array(RecoveryProjectionExpectationSchema),
	maxLength(1024),
)
const RecoveryProviderRecordsSchema = pipe(
	array(object({ id: boundedString(512) })),
	maxLength(recoveryProjectionMaxRecords + 1),
)
const RecoveryProjectionPublicationInputSchema = strictObject({
	expected: optional(RecoveryProjectionExpectationsSchema),
})

/** @description Runtime schema for the public Beads adapter constructor. */
export const CreateBeadsProviderInputSchema = strictObject({
	root: boundedString(4096),
	projectId: boundedString(128),
	binary: optional(boundedString(4096)),
	actor: optional(boundedString(128)),
	stateDirectory: optional(boundedString(4096)),
	coordinationRoot: optional(boundedString(4096)),
})

type ActivityRecord = InferOutput<typeof ActivitySchema>
type EvidenceRecord = InferOutput<typeof EvidenceSchema>
type HandoffRecord = InferOutput<typeof HandoffSchema>
type CandidateRecord = InferOutput<typeof CandidateSchema>
type GateRecord = InferOutput<typeof GateSchema>
type BeadsRecord = InferOutput<typeof BeadsRecordSchema>
type MutationLockOwner = InferOutput<typeof MutationLockOwnerSchema>

interface CommandOutput {
	readonly status: number | null
	readonly stdout: string | null
	readonly stderr: string | null
	readonly error?: Error
}

/** @description Collaborative ledger plus explicit Beads initialization capability. */
export interface BeadsProvider extends CollaborativeLedgerProvider {
	readonly initialize: (input?: {
		readonly prefix?: string
	}) => Promise<WorkResult<{ readonly prefix: string }>>
	/** @description Adopt exact repository records created by the retired pre-extraction facade. */
	readonly adoptLegacyDefinitions: (inputs: readonly LedgerDefinitionInput[]) => Promise<
		WorkResult<{
			readonly adopted: number
			readonly skipped: number
			readonly items: readonly LedgerItem[]
		}>
	>
	/** @description Atomically refresh the ignored shared-state JSONL recovery export. */
	readonly publishRecoveryProjection: (input?: {
		readonly expected?: readonly {
			readonly workId: string
			readonly status?: LedgerStatus
		}[]
	}) => Promise<
		WorkResult<{ readonly path: '.beads/export-state/issues.jsonl'; readonly records: number }>
	>
}

/** @description Typed synchronous boundary failure for invalid adapter construction input. */
export class InvalidBeadsProviderInputError extends Error {
	public readonly type = 'invalid_beads_provider_input'
	public readonly issues: readonly string[]

	public constructor(issues: readonly string[]) {
		super('Beads provider input validation failed.')
		this.name = 'InvalidBeadsProviderInputError'
		this.issues = issues
	}
}

const diagnosticClassificationLimit = 4096
const inlineMetadataTransportBytes = 1024
const providerDefinitionProjectionBytes = 2048
const providerItemProjectionBytes = INPUT_LIMITS.providerItemBytes
const providerProjectItems = INPUT_LIMITS.providerItems
const providerProjectProjectionBytes = INPUT_LIMITS.providerAggregateBytes
// Beads emits fields outside the normalized projection, including verbose relation envelopes.
// Keep a separate hard child-output ceiling so a hostile or bloated local provider cannot make
// One CLI invocation retain hundreds of MiB. Projects that outgrow this v1 boundary need a paged
// Provider API or explicit archival compaction rather than a larger synchronous child buffer.
const providerRawRecordBytes =
	providerItemProjectionBytes +
	providerDefinitionProjectionBytes +
	WORK_DEFINITION_LIMITS.dependencies * 512 +
	4096
const providerListOutputLimitBytes = 96 * 1024 * 1024
const providerCommandOutputLimitBytes = 1024 * 1024
const legacyDiscoveryItems = 10_000

/** @description Fixed v1 adapter capacity limits for diagnostics and invariant tests. */
export const BEADS_PROVIDER_LIMITS = Object.freeze({
	items: providerProjectItems,
	itemProjectionBytes: providerItemProjectionBytes,
	definitionProjectionBytes: providerDefinitionProjectionBytes,
	rawRecordReserveBytes: providerRawRecordBytes,
	listOutputBytes: providerListOutputLimitBytes,
})

interface IndexedDefinition {
	readonly definition: LedgerDefinitionInput
	readonly index: number
}

const orderDefinitionsByPrerequisites = (
	definitions: readonly IndexedDefinition[],
): readonly IndexedDefinition[] | undefined => {
	const byWorkId = new Map(
		definitions.map((entry) => [entry.definition.artifact.id, entry] as const),
	)
	const remaining = new Map<string, number>()
	const dependents = new Map<string, IndexedDefinition[]>()
	for (const entry of definitions) {
		const prerequisites = new Set([
			...(entry.definition.artifact.parentId === undefined
				? []
				: [entry.definition.artifact.parentId]),
			...entry.definition.artifact.dependencies,
		])
		let count = 0
		for (const prerequisite of prerequisites) {
			if (!byWorkId.has(prerequisite)) {
				continue
			}
			count += 1
			const children = dependents.get(prerequisite) ?? []
			children.push(entry)
			dependents.set(prerequisite, children)
		}
		remaining.set(entry.definition.artifact.id, count)
	}
	const ready = definitions.filter((entry) => remaining.get(entry.definition.artifact.id) === 0)
	const ordered: IndexedDefinition[] = []
	for (const entry of ready) {
		ordered.push(entry)
		for (const dependent of dependents.get(entry.definition.artifact.id) ?? []) {
			const workId = dependent.definition.artifact.id
			const next = (remaining.get(workId) ?? 0) - 1
			remaining.set(workId, next)
			if (next === 0) {
				ready.push(dependent)
			}
		}
	}
	return ordered.length === definitions.length ? ordered : undefined
}

const mutationCommands = new Set(['close', 'comment', 'config', 'create', 'dep', 'init', 'update'])
const providerEnvironmentKeys = [
	'COMSPEC',
	'HOME',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'PATH',
	'PATHEXT',
	'SYSTEMROOT',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USERPROFILE',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
] as const

const providerSubprocessEnvironment = (): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = {}
	for (const key of providerEnvironmentKeys) {
		const value = processEnvironment[key]
		if (value !== undefined) {
			environment[key] = value
		}
	}
	return {
		...environment,
		BD_NON_INTERACTIVE: '1',
		BEADS_ACTOR: 'work-contract',
		BEADS_NO_DAEMON: '1',
		DO_NOT_TRACK: '1',
		NO_COLOR: '1',
	}
}

const indicatesOwnershipConflict = (output: CommandOutput): boolean =>
	[output.stderr, output.stdout]
		.filter((value): value is string => typeof value === 'string')
		.some((value) =>
			/already claimed|claimed by/i.test(value.slice(0, diagnosticClassificationLimit)),
		)

export { resolveDefaultBeadsBinary } from './beads-binary'

const parseAdapterInput = <TSchema extends GenericSchema>(
	schema: TSchema,
	input: unknown,
): WorkResult<InferOutput<TSchema>> => {
	const parsed = safeParse(schema, input)
	return parsed.success
		? { ok: true, value: parsed.output }
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_operation_input',
					message: 'Beads adapter operation input validation failed.',
					details: parsed.issues.map(
						({ message, path }) =>
							`${path?.map(({ key }) => String(key)).join('.') ?? 'input'}: ${message}`,
					),
				},
			}
}

const invalidAuditIdentity = (): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'invalid_operation_input',
		message: 'Beads adapter audit identity validation failed.',
	},
})

const isCustomKind = (value: string): value is `custom:${string}` =>
	/^custom:[a-z][a-z0-9-]*$/.test(value)

const parseKind = (value: string): WorkArtifactKind | undefined => {
	if (
		value === 'initiative' ||
		value === 'prd' ||
		value === 'issue' ||
		value === 'task' ||
		value === 'eval'
	) {
		return value
	}
	return isCustomKind(value) ? value : undefined
}

const parseEvidenceKind = (value: string): EvidenceKind | undefined => {
	if (
		value === 'test' ||
		value === 'review' ||
		value === 'build' ||
		value === 'ci' ||
		value === 'security' ||
		value === 'artifact'
	) {
		return value
	}
	return isCustomKind(value) ? value : undefined
}

const normalizeActivity = (value: ActivityRecord | undefined): LedgerActivity | undefined =>
	value === undefined
		? undefined
		: {
				actor: value.actor,
				...(value.role === undefined ? {} : { role: value.role }),
				...(value.session === undefined ? {} : { session: value.session }),
				startedAt: value.started_at,
				touchedAt: value.touched_at,
			}

const normalizeEvidence = (
	values: readonly EvidenceRecord[] | undefined,
): WorkResult<readonly LedgerEvidence[]> => {
	const evidence: LedgerEvidence[] = []
	for (const value of values ?? []) {
		const kind = parseEvidenceKind(value.kind)
		if (kind === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_beads_record',
					message: 'Unsupported evidence kind in Beads metadata.',
				},
			}
		}
		evidence.push({
			kind,
			reference: value.reference,
			digest: value.digest,
			recordedAt: value.recorded_at,
			actor: value.actor,
		})
	}
	return { ok: true, value: evidence }
}

const normalizeCandidate = (
	value: CandidateRecord | undefined,
): WorkResult<LedgerCandidate | undefined> => {
	if (value === undefined) {
		return { ok: true, value: undefined }
	}
	const evidence = normalizeEvidence(value.evidence)
	return evidence.ok
		? {
				ok: true,
				value: {
					schemaVersion: 1,
					generation: value.generation,
					projectId: value.project_id,
					workId: value.work_id,
					graphFingerprint: value.graph_fingerprint,
					repositoryId: value.repository_id,
					headSha: value.head_sha,
					treeSha: value.tree_sha,
					...(value.ref === undefined ? {} : { ref: value.ref }),
					isolation: value.isolation,
					submittedAt: value.submitted_at,
					actor: value.actor,
					evidence: evidence.value,
				},
			}
		: evidence
}

const normalizeGates = (values: readonly GateRecord[] | undefined): readonly LedgerGateReceipt[] =>
	(values ?? []).map((value) => ({
		schemaVersion: 1,
		gate: value.gate,
		result: 'passed',
		candidateGeneration: value.candidate_generation,
		projectId: value.project_id,
		workId: value.work_id,
		graphFingerprint: value.graph_fingerprint,
		repositoryId: value.repository_id,
		headSha: value.head_sha,
		treeSha: value.tree_sha,
		issuer: value.issuer,
		reference: value.reference,
		digest: value.digest,
		observedAt: value.observed_at,
	}))

const LegacyDispositionSchema = strictObject({
	evidence: pipe(array(SourcePathSchema), maxLength(100)),
	state: literal('completed'),
})

const parseLegacyDisposition = (
	value: string | undefined,
): WorkResult<InferOutput<typeof LegacyDispositionSchema>> => {
	const prefix = 'symphony:disposition:v1 '
	if (value === undefined || !value.startsWith(prefix)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: 'Legacy completion is missing its bounded disposition receipt.',
			},
		}
	}
	try {
		const parsed = safeParse(LegacyDispositionSchema, JSON.parse(value.slice(prefix.length)))
		return parsed.success
			? { ok: true, value: parsed.output }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Legacy completion disposition is unsupported.',
					},
				}
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: 'Legacy completion disposition cannot be parsed.',
			},
		}
	}
}

const normalizeHandoff = (value: HandoffRecord | undefined): LedgerHandoff | undefined =>
	value === undefined
		? undefined
		: {
				actor: value.actor,
				summary: value.summary,
				remaining: value.remaining,
				references: value.references,
				createdAt: value.created_at,
				...(value.from_session === undefined ? {} : { fromSession: value.from_session }),
				...(value.to_actor === undefined ? {} : { toActor: value.to_actor }),
			}

const sameActivity = (
	left: LedgerActivity | undefined,
	right: LedgerActivity | undefined,
): boolean =>
	left?.actor === right?.actor &&
	left?.role === right?.role &&
	left?.session === right?.session &&
	left?.startedAt === right?.startedAt &&
	left?.touchedAt === right?.touchedAt

const sameEvidence = (left: readonly LedgerEvidence[], right: readonly LedgerEvidence[]): boolean =>
	left.length === right.length &&
	left.every((entry, index) => {
		const expected = right[index]
		return (
			expected !== undefined &&
			entry.kind === expected.kind &&
			entry.reference === expected.reference &&
			entry.digest === expected.digest &&
			entry.recordedAt === expected.recordedAt &&
			entry.actor === expected.actor
		)
	})

const sameHandoff = (
	left: LedgerHandoff | undefined,
	right: LedgerHandoff | undefined,
): boolean => {
	if (left === undefined || right === undefined) {
		return left === right
	}
	return (
		left.actor === right.actor &&
		left.summary === right.summary &&
		left.createdAt === right.createdAt &&
		left.fromSession === right.fromSession &&
		left.toActor === right.toActor &&
		left.remaining.length === right.remaining.length &&
		left.remaining.every((entry, index) => entry === right.remaining[index]) &&
		left.references.length === right.references.length &&
		left.references.every((entry, index) => entry === right.references[index])
	)
}

const truncateJsonString = (value: string, maximumBytes: number): string => {
	if (serializedBytes(value) <= maximumBytes) {
		return value
	}
	const prefix: string[] = []
	let bytes = 2
	for (const character of value) {
		const characterBytes = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2
		if (bytes + characterBytes > maximumBytes) {
			break
		}
		prefix.push(character)
		bytes += characterBytes
	}
	return prefix.join('')
}

const definitionProjection = (
	input: LedgerDefinitionInput,
): { readonly acceptance: string; readonly body: string } => {
	const joinedAcceptance = input.artifact.acceptance.join('\n')
	const acceptance = truncateJsonString(joinedAcceptance, providerDefinitionProjectionBytes / 2)
	const emptyProjectionBytes = serializedBytes({ acceptance, body: '' })
	return {
		acceptance,
		body: truncateJsonString(
			input.artifact.body,
			Math.max(2, providerDefinitionProjectionBytes - emptyProjectionBytes + 2),
		),
	}
}

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const mapStatus = (input: {
	readonly status: 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed'
	readonly archived: boolean | undefined
}): LedgerStatus =>
	input.status === 'closed' && input.archived === true ? 'archived' : input.status

const normalizeRecord = (
	record: BeadsRecord,
	providerWorkIds: ReadonlyMap<string, string> = new Map(),
): WorkResult<LedgerItem | undefined> => {
	const metadata = record.metadata?.work_contract
	if (metadata === undefined) {
		return { ok: true, value: undefined }
	}
	const kind = parseKind(metadata.kind)
	if (kind === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_beads_record',
				message: 'Unsupported work kind in Beads metadata.',
			},
		}
	}
	const evidence = normalizeEvidence(metadata.evidence)
	if (!evidence.ok) {
		return evidence
	}
	const candidateMetadata = normalizeCandidate(metadata.candidate)
	if (!candidateMetadata.ok) {
		return candidateMetadata
	}
	const evidenceRequirements: EvidenceKind[] = []
	const activity = normalizeActivity(metadata.activity)
	const status = mapStatus({
		status: record.status,
		archived: metadata.archived,
	})
	if (
		activity !== undefined &&
		(record.assignee !== activity.actor ||
			(status !== 'in_progress' &&
				status !== 'blocked' &&
				status !== 'closed' &&
				status !== 'archived'))
	) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: 'Beads activity is inconsistent with assignment or lifecycle state.',
			},
		}
	}
	for (const value of metadata.schema_version === 1 ? [] : metadata.evidence_requirements) {
		const requirement = parseEvidenceKind(value)
		if (requirement === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_beads_record',
					message: 'Beads metadata contains an unsupported evidence requirement.',
				},
			}
		}
		evidenceRequirements.push(requirement)
	}
	const parentIds = new Set<string>()
	const dependencies: string[] = []
	for (const dependency of record.dependencies ?? []) {
		const relationType = dependency.dependency_type ?? dependency.type
		if (
			(relationType !== 'blocks' && relationType !== 'parent-child') ||
			(dependency.issue_id !== undefined && dependency.issue_id !== record.id)
		) {
			continue
		}
		const dependencyMetadata = safeParse(MetadataSchema, dependency.metadata)
		const providerResolvedWorkId =
			dependency.depends_on_id === undefined
				? undefined
				: providerWorkIds.get(dependency.depends_on_id)
		let dependencyWorkId = providerResolvedWorkId
		if (dependencyMetadata.success && dependencyMetadata.output.work_contract !== undefined) {
			const embedded = dependencyMetadata.output.work_contract
			const expectedProjectKey = createHash('sha256').update(metadata.project_id).digest('hex')
			if (
				embedded.project_id !== metadata.project_id ||
				dependencyMetadata.output.work_contract_project_key !== expectedProjectKey ||
				(providerResolvedWorkId !== undefined && embedded.work_id !== providerResolvedWorkId)
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads contains inconsistent embedded relation metadata.',
					},
				}
			}
			dependencyWorkId = embedded.work_id
		}
		if (dependencyWorkId === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Beads contains an unresolved outbound work relation.',
				},
			}
		}
		if (relationType === 'parent-child') {
			parentIds.add(dependencyWorkId)
		}
		if (relationType === 'blocks') {
			dependencies.push(dependencyWorkId)
		}
	}
	if (parentIds.size > 1 || new Set(dependencies).size > WORK_DEFINITION_LIMITS.dependencies) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: 'Beads contains an unsupported relation projection.',
			},
		}
	}
	const candidate: LedgerItem = {
		definitionSchemaVersion: metadata.schema_version,
		providerId: record.id,
		projectId: metadata.project_id,
		workId: metadata.work_id,
		title: record.title,
		kind,
		execution: metadata.execution ?? 'task',
		status,
		parentId: [...parentIds][0],
		dependencies: [...new Set(dependencies)].toSorted(),
		source: { path: metadata.source_path, hash: metadata.source_hash },
		graphFingerprint: metadata.graph_fingerprint,
		roles: metadata.schema_version === 1 ? [] : metadata.roles,
		evidenceRequirements,
		...(metadata.schema_version === 3
			? {
					definitionRevision: {
						targetRef: metadata.definition_revision.target_ref,
						graphFingerprint: metadata.definition_revision.graph_fingerprint,
					},
				}
			: {}),
		assignee: record.assignee,
		activity,
		handoff: normalizeHandoff(metadata.handoff),
		evidence: evidence.value,
		...(candidateMetadata.value === undefined ? {} : { candidate: candidateMetadata.value }),
		gates: normalizeGates(metadata.gates),
		blockReason: metadata.block_reason,
		updatedAt: record.updated_at,
	}
	const validated = safeParse(LedgerItemSchema, candidate)
	return validated.success
		? { ok: true, value: candidate }
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Beads returned a projection outside the provider contract.',
				},
			}
}

const metadataForDefinition = (
	input: LedgerDefinitionInput,
): Readonly<Record<string, unknown>> => ({
	work_contract_project_key: createHash('sha256').update(input.projectId).digest('hex'),
	work_contract: {
		schema_version: input.definitionRevision === undefined ? 2 : 3,
		project_id: input.projectId,
		work_id: input.artifact.id,
		kind: input.artifact.kind,
		execution: input.artifact.execution,
		source_path: input.artifact.source.path,
		source_hash: input.artifact.source.hash,
		graph_fingerprint: input.graphFingerprint,
		roles: input.artifact.roles,
		evidence_requirements: input.artifact.evidenceRequirements,
		...(input.definitionRevision === undefined
			? {}
			: {
					definition_revision: {
						target_ref: input.definitionRevision.targetRef,
						graph_fingerprint: input.definitionRevision.graphFingerprint,
					},
				}),
	},
})

const metadataForItem = (input: {
	readonly item: LedgerItem
	readonly activity?: LedgerActivity | null
	readonly handoff?: LedgerHandoff | null
	readonly evidence?: readonly LedgerEvidence[] | undefined
	readonly candidate?: LedgerCandidate | null
	readonly gates?: readonly LedgerGateReceipt[] | null
	readonly blockReason?: string | null
	readonly archived?: boolean | undefined
}): Readonly<Record<string, unknown>> => {
	let activity = input.item.activity
	if (input.activity === null) {
		activity = undefined
	} else if (input.activity !== undefined) {
		activity = input.activity
	}
	let handoff = input.item.handoff
	if (input.handoff === null) {
		handoff = undefined
	} else if (input.handoff !== undefined) {
		handoff = input.handoff
	}
	const evidence = input.evidence ?? input.item.evidence
	const candidate = input.candidate === null ? undefined : (input.candidate ?? input.item.candidate)
	const gates = input.gates === null ? [] : (input.gates ?? input.item.gates ?? [])
	const blockReason =
		input.blockReason === null ? undefined : (input.blockReason ?? input.item.blockReason)
	const archived = input.archived ?? (input.item.status === 'archived' ? true : undefined)
	return {
		work_contract_project_key: createHash('sha256').update(input.item.projectId).digest('hex'),
		work_contract: {
			schema_version: input.item.definitionRevision === undefined ? 2 : 3,
			project_id: input.item.projectId,
			work_id: input.item.workId,
			kind: input.item.kind,
			execution: input.item.execution ?? 'task',
			source_path: input.item.source.path,
			source_hash: input.item.source.hash,
			graph_fingerprint: input.item.graphFingerprint,
			roles: input.item.roles,
			evidence_requirements: input.item.evidenceRequirements,
			...(input.item.definitionRevision === undefined
				? {}
				: {
						definition_revision: {
							target_ref: input.item.definitionRevision.targetRef,
							graph_fingerprint: input.item.definitionRevision.graphFingerprint,
						},
					}),
			...(activity === undefined
				? {}
				: {
						activity: {
							actor: activity.actor,
							...(activity.role === undefined ? {} : { role: activity.role }),
							...(activity.session === undefined ? {} : { session: activity.session }),
							started_at: activity.startedAt,
							touched_at: activity.touchedAt,
						},
					}),
			...(handoff === undefined
				? {}
				: {
						handoff: {
							actor: handoff.actor,
							summary: handoff.summary,
							remaining: handoff.remaining,
							references: handoff.references,
							created_at: handoff.createdAt,
							...(handoff.fromSession === undefined ? {} : { from_session: handoff.fromSession }),
							...(handoff.toActor === undefined ? {} : { to_actor: handoff.toActor }),
						},
					}),
			evidence: evidence.map((entry) => ({
				kind: entry.kind,
				reference: entry.reference,
				digest: entry.digest,
				recorded_at: entry.recordedAt,
				actor: entry.actor,
			})),
			...(candidate === undefined
				? {}
				: {
						candidate: {
							schema_version: 1,
							generation: candidate.generation,
							project_id: candidate.projectId,
							work_id: candidate.workId,
							graph_fingerprint: candidate.graphFingerprint,
							repository_id: candidate.repositoryId,
							head_sha: candidate.headSha,
							tree_sha: candidate.treeSha,
							...(candidate.ref === undefined ? {} : { ref: candidate.ref }),
							isolation: candidate.isolation,
							submitted_at: candidate.submittedAt,
							actor: candidate.actor,
							evidence: candidate.evidence.map((entry) => ({
								kind: entry.kind,
								reference: entry.reference,
								digest: entry.digest,
								recorded_at: entry.recordedAt,
								actor: entry.actor,
							})),
						},
					}),
			gates: gates.map((gate) => ({
				schema_version: 1,
				gate: gate.gate,
				result: gate.result,
				candidate_generation: gate.candidateGeneration,
				project_id: gate.projectId,
				work_id: gate.workId,
				graph_fingerprint: gate.graphFingerprint,
				repository_id: gate.repositoryId,
				head_sha: gate.headSha,
				tree_sha: gate.treeSha,
				issuer: gate.issuer,
				reference: gate.reference,
				digest: gate.digest,
				observed_at: gate.observedAt,
			})),
			...(blockReason === undefined ? {} : { block_reason: blockReason }),
			...(archived === undefined ? {} : { archived }),
		},
	}
}

const providerType = (kind: WorkArtifactKind): 'epic' | 'task' =>
	kind === 'initiative' || kind === 'prd' ? 'epic' : 'task'

const deterministicProviderId = (projectId: string, workId: string): string =>
	`sw-${createHash('sha256').update(`${projectId}\0${workId}`).digest('hex').slice(0, 20)}`

type ParsedClaimInput = InferOutput<typeof LedgerClaimInputSchema>

const normalizeDefinitionExpectation = (
	input: ParsedClaimInput['expectedDefinition'],
): LedgerDefinitionExpectation => {
	const fields = {
		title: input.title,
		kind: input.kind,
		execution: input.execution ?? 'task',
		source: input.source,
		parentId: input.parentId,
		dependencies: input.dependencies,
		roles: input.roles,
		evidenceRequirements: input.evidenceRequirements,
	}
	return input.schemaVersion === 3
		? {
				schemaVersion: 3,
				graphFingerprint: input.graphFingerprint,
				definitionRevision: input.definitionRevision,
				...fields,
			}
		: { schemaVersion: 2, ...fields }
}

const normalizeDependencyExpectation = (
	input: ParsedClaimInput['expectedDependencies'][number],
): LedgerDependencyExpectation => ({
	workId: input.workId,
	...normalizeDefinitionExpectation(input),
})

const providerLockWaitMs = 10_000
const providerLockRetryMs = 25
const providerLockMaxBytes = 512
const definitionAdmissionLockId = '!work-contract-definition-capacity'
const recoveryProjectionLockId = '!work-contract-recovery-projection'
const recoveryProjectionMaxBytes = 64 * 1024 * 1024

const projectionPublicationFailure = (): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'projection_write_failed',
		message: 'The shared Beads recovery export could not be published safely.',
		details: [
			'Provider state may have changed.',
			'Rerun the original work command or sync --apply before committing.',
		],
	},
})

interface ValidatedRecoveryProjection {
	readonly records: number
	readonly providerIds: ReadonlySet<string>
	readonly workStates: ReadonlyMap<string, LedgerStatus>
}

const recoveryWorkKey = (projectId: string, workId: string): string => `${projectId}\0${workId}`

const validateRecoveryProjection = (source: string): WorkResult<ValidatedRecoveryProjection> => {
	let lines: readonly string[] = []
	if (source.length > 0) {
		lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
	}
	if (lines.length > recoveryProjectionMaxRecords || lines.some((line) => line.length === 0)) {
		return projectionPublicationFailure()
	}
	const ids = new Set<string>()
	const workStates = new Map<string, LedgerStatus>()
	for (const line of lines) {
		let value: unknown
		try {
			value = JSON.parse(line)
		} catch {
			return projectionPublicationFailure()
		}
		const parsed = safeParse(BeadsRecordSchema, value)
		if (!parsed.success || ids.has(parsed.output.id)) {
			return projectionPublicationFailure()
		}
		ids.add(parsed.output.id)
		const metadata = parsed.output.metadata?.work_contract
		if (metadata !== undefined) {
			const key = recoveryWorkKey(metadata.project_id, metadata.work_id)
			if (workStates.has(key)) {
				return projectionPublicationFailure()
			}
			workStates.set(key, metadata.archived === true ? 'archived' : parsed.output.status)
		}
	}
	return { ok: true, value: { records: lines.length, providerIds: ids, workStates } }
}

const isAlreadyExistsError = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'EEXIST'

const isMissingLockResult = (result: WorkResult<unknown>): boolean =>
	!result.ok && result.error.details?.includes('System error code: ENOENT.') === true

const isProcessAlive = (pid: number): boolean => {
	try {
		signalProcess(pid, 0)
		return true
	} catch (error: unknown) {
		return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
	}
}

interface AcquiredMutationLock {
	readonly content: string
	readonly path: string
}

const projectTransitionItem = (input: LedgerTransitionInput, current: LedgerItem): LedgerItem => {
	if (input.type === 'complete') {
		return {
			...current,
			status: 'closed',
			evidence: input.evidence,
			...(input.candidate === undefined ? {} : { candidate: input.candidate }),
			...(input.gates === undefined ? {} : { gates: input.gates }),
			blockReason: undefined,
		}
	}
	if (input.type === 'block') {
		return { ...current, status: 'blocked', blockReason: input.reason }
	}
	return {
		...current,
		status: 'open',
		assignee: undefined,
		activity: undefined,
		blockReason: undefined,
	}
}

const transitionIntentPayload = (
	input: LedgerTransitionInput,
	requestDigest: string,
): { readonly actor: string; readonly reason?: string; readonly request_digest: string } =>
	input.type === 'complete'
		? { actor: input.actor, request_digest: requestDigest }
		: { actor: input.actor, reason: input.reason, request_digest: requestDigest }

class BeadsCliProvider implements BeadsProvider {
	readonly #root: string
	readonly #stateDirectory: string
	readonly #coordinationRoot: string
	readonly #binary: string
	readonly #actor: string
	readonly #projectId: string
	readonly #projectKey: string
	readonly #providerIds = new Map<string, string>()
	#hasAuthoritativeListProjection = false

	public constructor(input: {
		readonly root: string
		readonly binary: string
		readonly actor: string
		readonly projectId: string
		readonly stateDirectory: string
		readonly coordinationRoot: string
	}) {
		this.#root = input.root
		this.#stateDirectory = input.stateDirectory
		this.#coordinationRoot = input.coordinationRoot
		this.#binary = input.binary
		this.#actor = input.actor
		this.#projectId = input.projectId
		this.#projectKey = createHash('sha256').update(input.projectId).digest('hex')
	}

	public async initialize(
		input: { readonly prefix?: string } = {},
	): Promise<WorkResult<{ readonly prefix: string }>> {
		const prefix = input.prefix ?? 'work'
		if (!/^[A-Za-z][A-Za-z0-9_-]{1,20}$/.test(prefix)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_prefix',
					message: 'Beads prefix must be 2-21 safe characters.',
				},
			}
		}
		const initialized = this.#run(
			[
				'init',
				'--quiet',
				'--non-interactive',
				'--skip-agents',
				'--skip-hooks',
				'--init-if-missing',
				'--prefix',
				prefix,
			],
			false,
		)
		if (!initialized.ok) {
			return initialized
		}
		const configured = this.#run([
			'config',
			'set-many',
			'export.auto=false',
			'export.path=export-state/issues.jsonl',
			'export.git-add=false',
			'import.path=export-state/issues.jsonl',
		])
		return configured.ok ? { ok: true, value: { prefix } } : configured
	}

	public async doctor(): Promise<
		WorkResult<{ readonly provider: string; readonly version: string }>
	> {
		const lockHealth = await this.#inspectMutationLockHealth()
		if (!lockHealth.ok) {
			return lockHealth
		}
		const result = this.#run(['version'], false)
		if (!result.ok) {
			return result
		}
		const version = /^bd version (\d{1,10}\.\d{1,10}\.\d{1,10})(?:\s|$)/.exec(
			result.value.slice(0, 64),
		)?.[1]
		if (version === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'unsupported_beads',
					message: 'Unable to parse Beads version.',
				},
			}
		}
		if (version !== '1.2.2') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'unsupported_beads',
					message: 'Beads version is unsupported; this adapter is verified against 1.2.2.',
				},
			}
		}
		return { ok: true, value: { provider: 'beads', version } }
	}

	public async adoptLegacyDefinitions(inputs: readonly LedgerDefinitionInput[]): Promise<
		WorkResult<{
			readonly adopted: number
			readonly skipped: number
			readonly items: readonly LedgerItem[]
		}>
	> {
		if (inputs.length === 0) {
			return { ok: true, value: { adopted: 0, skipped: 0, items: [] } }
		}
		if (inputs.length > providerProjectItems) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_capacity_exceeded',
					message: 'Legacy adoption exceeds the provider item limit.',
				},
			}
		}
		const definitions = new Map<string, LedgerDefinitionInput>()
		for (const input of inputs) {
			const parsed = parseAdapterInput(LedgerDefinitionInputSchema, input)
			if (!parsed.ok) {
				return parsed
			}
			const { parentId, ...artifact } = parsed.value.artifact
			const definition: LedgerDefinitionInput = {
				...parsed.value,
				artifact: {
					...artifact,
					...(parentId === undefined ? {} : { parentId }),
				},
			}
			if (definition.projectId !== this.#projectId || definitions.has(definition.artifact.id)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'project_mismatch',
						message: 'Legacy adoption contains another project or duplicate work ID.',
					},
				}
			}
			definitions.set(definition.artifact.id, definition)
		}

		this.#invalidateListProjection()
		const ids = [...definitions.keys()].toSorted()
		const shown = this.#run(
			['show', ...ids],
			true,
			undefined,
			true,
			ids.length * providerRawRecordBytes + 4096,
		)
		if (!shown.ok) {
			return shown
		}
		const parsedRecords = this.#parseRecords(shown.value)
		if (!parsedRecords.ok) {
			return parsedRecords
		}
		if (parsedRecords.value.length !== ids.length) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Legacy adoption requires one exact provider record per definition.',
				},
			}
		}
		const records = new Map<string, BeadsRecord>()
		for (const record of parsedRecords.value) {
			if (!definitions.has(record.id) || records.has(record.id)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Legacy adoption returned an unexpected or duplicate record.',
					},
				}
			}
			records.set(record.id, record)
			this.#providerIds.set(record.id, record.id)
		}

		const prepared: {
			readonly definition: LedgerDefinitionInput
			readonly item: LedgerItem
			readonly alreadyOwned: boolean
		}[] = []
		for (const id of ids) {
			const definition = definitions.get(id)
			const record = records.get(id)
			if (definition === undefined || record === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Legacy adoption lost an expected record during validation.',
					},
				}
			}
			if (record.metadata?.work_contract !== undefined) {
				const normalized = normalizeRecord(record, new Map(ids.map((workId) => [workId, workId])))
				if (
					!normalized.ok ||
					normalized.value === undefined ||
					normalized.value.projectId !== this.#projectId ||
					normalized.value.workId !== id
				) {
					return normalized.ok
						? {
								ok: false,
								error: {
									type: 'work_contract_error',
									code: 'invalid_ledger_projection',
									message: 'Existing work-contract ownership conflicts with adoption.',
								},
							}
						: normalized
				}
				prepared.push({ definition, item: normalized.value, alreadyOwned: true })
				continue
			}
			const legacy = await this.#prepareLegacyItem(record, definition)
			if (!legacy.ok) {
				return legacy
			}
			prepared.push({ definition, item: legacy.value, alreadyOwned: false })
		}

		const items: LedgerItem[] = []
		let adopted = 0
		let skipped = 0
		for (const entry of prepared) {
			if (entry.alreadyOwned) {
				items.push(entry.item)
				skipped += 1
				continue
			}
			const updated = await this.#withMutationLocks([entry.item.workId], async () =>
				this.#updateDefinitionItem(entry.item, entry.definition),
			)
			if (!updated.ok) {
				return {
					ok: false,
					error: {
						...updated.error,
						details: [...(updated.error.details ?? []), `adopted=${adopted}`],
					},
				}
			}
			items.push(updated.value)
			adopted += 1
		}
		return { ok: true, value: { adopted, skipped, items } }
	}

	#authoritativeRecoveryProviderIds(): WorkResult<ReadonlySet<string>> {
		const listed = this.#run(
			['list', '--all', '--limit', String(recoveryProjectionMaxRecords + 1)],
			true,
			undefined,
			false,
			recoveryProjectionMaxBytes,
		)
		if (!listed.ok) {
			return projectionPublicationFailure()
		}
		let document: unknown
		try {
			document = JSON.parse(listed.value)
		} catch {
			return projectionPublicationFailure()
		}
		const records = safeParse(RecoveryProviderRecordsSchema, document)
		if (!records.success || records.output.length > recoveryProjectionMaxRecords) {
			return projectionPublicationFailure()
		}
		const providerIds = new Set(records.output.map(({ id }) => id))
		return providerIds.size === records.output.length
			? { ok: true, value: providerIds }
			: projectionPublicationFailure()
	}

	public async publishRecoveryProjection(
		input: {
			readonly expected?: readonly {
				readonly workId: string
				readonly status?: LedgerStatus
			}[]
		} = {},
	): Promise<
		WorkResult<{ readonly path: '.beads/export-state/issues.jsonl'; readonly records: number }>
	> {
		return measureCommandPhase('recovery_publication', async () =>
			this.#publishRecoveryProjection(input),
		)
	}

	async #publishRecoveryProjection(
		input: {
			readonly expected?: readonly {
				readonly workId: string
				readonly status?: LedgerStatus
			}[]
		} = {},
	): Promise<
		WorkResult<{ readonly path: '.beads/export-state/issues.jsonl'; readonly records: number }>
	> {
		const parsedInput = parseAdapterInput(RecoveryProjectionPublicationInputSchema, input)
		if (!parsedInput.ok) {
			return parsedInput
		}
		return this.#withMutationLocks<{
			readonly path: '.beads/export-state/issues.jsonl'
			readonly records: number
		}>([recoveryProjectionLockId], async () => {
			const target = await prepareSafeOutputPath({
				root: this.#stateDirectory,
				path: 'export-state/issues.jsonl',
				errorCode: 'unsafe_projection_path',
			})
			if (!target.ok) {
				return target
			}
			const priorContent = await readBoundedUtf8({
				path: target.value,
				maxBytes: recoveryProjectionMaxBytes,
				unavailableCode: 'projection_write_failed',
				tooLargeCode: 'projection_write_failed',
				invalidUtf8Code: 'projection_write_failed',
				label: 'Shared Beads recovery export',
			})
			let prior: ValidatedRecoveryProjection | undefined
			if (priorContent.ok) {
				const validatedPrior = validateRecoveryProjection(priorContent.value)
				if (!validatedPrior.ok) {
					return validatedPrior
				}
				prior = validatedPrior.value
			} else if (!isMissingLockResult(priorContent)) {
				return projectionPublicationFailure()
			}
			let authoritativeProviderIds = prior?.providerIds
			if (authoritativeProviderIds === undefined || prior?.records === 0) {
				const authoritative = this.#authoritativeRecoveryProviderIds()
				if (!authoritative.ok) {
					return authoritative
				}
				authoritativeProviderIds = authoritative.value
			}
			const temporary = `${target.value}.export-${randomUUID()}.tmp`
			try {
				const exported = this.#run(['export', '--output', temporary])
				if (!exported.ok) {
					return exported
				}
				const before = await lstat(temporary)
				if (!before.isFile() || before.nlink !== 1 || before.size > recoveryProjectionMaxBytes) {
					return projectionPublicationFailure()
				}
				const content = await readBoundedUtf8({
					path: temporary,
					maxBytes: recoveryProjectionMaxBytes,
					unavailableCode: 'projection_write_failed',
					tooLargeCode: 'projection_write_failed',
					invalidUtf8Code: 'projection_write_failed',
					label: 'Shared Beads recovery export',
				})
				if (!content.ok) {
					return content
				}
				const after = await lstat(temporary)
				if (
					after.dev !== before.dev ||
					after.ino !== before.ino ||
					after.ctimeMs !== before.ctimeMs ||
					after.mtimeMs !== before.mtimeMs ||
					after.size !== before.size ||
					after.nlink !== 1
				) {
					return projectionPublicationFailure()
				}
				const records = validateRecoveryProjection(content.value)
				if (!records.ok) {
					return records
				}
				if (
					[...authoritativeProviderIds].some(
						(providerId) => !records.value.providerIds.has(providerId),
					)
				) {
					return projectionPublicationFailure()
				}
				for (const expectation of parsedInput.value.expected ?? []) {
					const status = records.value.workStates.get(
						recoveryWorkKey(this.#projectId, expectation.workId),
					)
					if (
						status === undefined ||
						(expectation.status !== undefined && status !== expectation.status)
					) {
						return projectionPublicationFailure()
					}
				}
				await rename(temporary, target.value)
				const published = await lstat(target.value)
				if (
					published.dev !== before.dev ||
					published.ino !== before.ino ||
					published.nlink !== 1 ||
					published.size !== before.size
				) {
					return projectionPublicationFailure()
				}
				return {
					ok: true,
					value: {
						path: '.beads/export-state/issues.jsonl',
						records: records.value.records,
					},
				}
			} catch {
				return projectionPublicationFailure()
			} finally {
				await rm(temporary, { force: true }).catch(() => false)
			}
		})
	}

	async #prepareLegacyItem(
		record: BeadsRecord,
		definition: LedgerDefinitionInput,
	): Promise<WorkResult<LedgerItem>> {
		const metadata = record.metadata?.symphony
		if (
			metadata === undefined ||
			metadata.source !== definition.artifact.source.path ||
			(definition.artifact.parentId !== undefined &&
				metadata.prd !== definition.artifact.parentId) ||
			record.external_ref !== definition.artifact.source.path ||
			record.id !== definition.artifact.id ||
			(record.status !== 'open' && record.status !== 'in_progress' && record.status !== 'closed')
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Legacy record does not match the exact file-owned definition.',
				},
			}
		}
		const actor = record.assignee
		if (record.status !== 'open' && actor === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Active or completed legacy work requires final actor attribution.',
				},
			}
		}
		const activity =
			actor === undefined
				? undefined
				: {
						actor,
						startedAt: record.started_at ?? record.created_at,
						touchedAt: record.closed_at ?? record.updated_at,
					}
		const evidence: LedgerEvidence[] = []
		if (record.status === 'closed') {
			const disposition = parseLegacyDisposition(record.close_reason)
			if (!disposition.ok) {
				return disposition
			}
			for (const reference of disposition.value.evidence) {
				const content = await readBoundedContainedFile({
					root: this.#root,
					reference,
					maxBytes: INPUT_LIMITS.evidenceBytes,
					unsafeCode: 'unsafe_evidence_path',
					unavailableCode: 'evidence_unavailable',
					tooLargeCode: 'evidence_too_large',
					label: 'Legacy completion evidence',
				})
				if (!content.ok) {
					return content
				}
				evidence.push({
					kind: 'artifact',
					reference,
					digest: createHash('sha256').update(content.value).digest('hex'),
					recordedAt: record.closed_at ?? record.updated_at,
					actor: actor ?? this.#actor,
				})
			}
		}
		const dependencies = (record.dependencies ?? []).flatMap((dependency) => {
			const relationType = dependency.dependency_type ?? dependency.type
			return relationType === 'blocks' && dependency.depends_on_id !== undefined
				? [dependency.depends_on_id]
				: []
		})
		const candidate: LedgerItem = {
			definitionSchemaVersion: 1,
			providerId: record.id,
			projectId: this.#projectId,
			workId: definition.artifact.id,
			title: record.title,
			kind: definition.artifact.kind,
			execution: definition.artifact.execution,
			status: record.status,
			parentId: undefined,
			dependencies: [...new Set(dependencies)].toSorted(),
			roles: definition.artifact.roles,
			evidenceRequirements: definition.artifact.evidenceRequirements,
			source: definition.artifact.source,
			graphFingerprint: definition.graphFingerprint,
			assignee: actor,
			activity,
			handoff: undefined,
			evidence,
			blockReason: undefined,
			updatedAt: record.updated_at,
		}
		const validated = safeParse(LedgerItemSchema, candidate)
		return validated.success
			? { ok: true, value: candidate }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Legacy record cannot be represented by the work contract.',
					},
				}
	}

	public async list(): Promise<WorkResult<readonly LedgerItem[]>> {
		this.#invalidateListProjection()
		const listed = this.#run([
			'list',
			'--all',
			'--metadata-field',
			`work_contract_project_key=${this.#projectKey}`,
			'--limit',
			String(providerProjectItems + 1),
		])
		if (!listed.ok) {
			return listed
		}
		const summaries = this.#parseRecords(listed.value)
		if (!summaries.ok) {
			return summaries
		}
		if (summaries.value.length > providerProjectItems) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'beads_item_limit_exceeded',
					message: `Beads returned more than ${providerProjectItems} project records.`,
				},
			}
		}
		const providerIds = new Map<string, string>()
		const providerWorkIds = new Map<string, string>()
		for (const record of summaries.value) {
			const metadata = record.metadata?.work_contract
			if (
				metadata === undefined ||
				(record.metadata?.work_contract_project_key === undefined
					? metadata.schema_version !== 1
					: record.metadata.work_contract_project_key !== this.#projectKey)
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads project routing metadata is inconsistent.',
					},
				}
			}
			if (providerIds.has(metadata.work_id)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads contains duplicate owned work IDs for the selected project.',
					},
				}
			}
			providerIds.set(metadata.work_id, record.id)
			providerWorkIds.set(record.id, metadata.work_id)
		}
		const items: LedgerItem[] = []
		let projectionBytes = 2
		for (const record of summaries.value) {
			const normalized = normalizeRecord(record, providerWorkIds)
			if (!normalized.ok) {
				return normalized
			}
			if (normalized.value?.projectId === this.#projectId) {
				const itemBytes = serializedBytes(normalized.value)
				if (itemBytes > providerItemProjectionBytes) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'provider_capacity_exceeded',
							message: 'A Beads work item exceeds the supported projection budget.',
						},
					}
				}
				projectionBytes += itemBytes + (items.length === 0 ? 0 : 1)
				if (projectionBytes > providerProjectProjectionBytes) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'provider_capacity_exceeded',
							message: 'The Beads project exceeds the supported projection budget.',
						},
					}
				}
				items.push(normalized.value)
			}
		}
		for (const [workId, providerId] of providerIds) {
			this.#providerIds.set(workId, providerId)
		}
		this.#hasAuthoritativeListProjection = true
		return {
			ok: true,
			value: items.toSorted((left, right) => left.workId.localeCompare(right.workId)),
		}
	}

	public async inspectCoordinationHealth(): Promise<WorkResult<void>> {
		return this.#inspectMutationLockHealth()
	}

	public async discoverLegacyDefinitions(): Promise<WorkResult<readonly LedgerItem[]>> {
		const migrationComplete = await this.#legacyMigrationComplete()
		if (!migrationComplete.ok || migrationComplete.value) {
			return migrationComplete.ok ? { ok: true, value: [] } : migrationComplete
		}
		const listed = this.#run([
			'list',
			'--all',
			'--label',
			'work-contract',
			'--limit',
			String(legacyDiscoveryItems + 1),
		])
		if (!listed.ok) {
			return listed
		}
		const records = this.#parseRecords(listed.value)
		if (!records.ok) {
			return records
		}
		if (records.value.length > legacyDiscoveryItems) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_capacity_exceeded',
					message: `Legacy migration discovery exceeds ${legacyDiscoveryItems} labeled records.`,
				},
			}
		}
		const candidates = records.value.filter(
			(record) =>
				record.metadata?.work_contract?.schema_version === 1 &&
				record.metadata.work_contract.project_id === this.#projectId,
		)
		const providerWorkIds = new Map(
			[...this.#providerIds.entries()].map(([workId, providerId]) => [providerId, workId]),
		)
		for (const record of candidates) {
			const metadata = record.metadata?.work_contract
			if (
				metadata === undefined ||
				(record.metadata?.work_contract_project_key !== undefined &&
					record.metadata.work_contract_project_key !== this.#projectKey) ||
				providerWorkIds.has(record.id) ||
				this.#providerIds.has(metadata.work_id)
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Legacy Beads routing metadata is inconsistent or duplicated.',
					},
				}
			}
			providerWorkIds.set(record.id, metadata.work_id)
		}
		const items: LedgerItem[] = []
		for (const record of candidates) {
			const normalized = normalizeRecord(record, providerWorkIds)
			if (!normalized.ok) {
				return normalized
			}
			if (normalized.value !== undefined) {
				const capacity = this.#validateProjectionItem(normalized.value)
				if (!capacity.ok) {
					return capacity
				}
				items.push(normalized.value)
			}
		}
		if (items.length + this.#providerIds.size > providerProjectItems) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_capacity_exceeded',
					message: `The Beads project supports at most ${providerProjectItems} work items.`,
				},
			}
		}
		return {
			ok: true,
			value: items.toSorted((left, right) => left.workId.localeCompare(right.workId)),
		}
	}

	public async finalizeLegacyMigration(): Promise<WorkResult<void>> {
		const prepared = await this.#legacyMigrationPath()
		if (!prepared.ok) {
			return prepared
		}
		try {
			await writeUtf8NoFollow({
				path: prepared.value,
				content: this.#legacyMigrationMarker(),
				mode: 'replace',
			})
			return { ok: true, value: undefined }
		} catch {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_failed',
					message: 'Legacy provider migration marker could not be written.',
				},
			}
		}
	}

	async #legacyMigrationPath(): Promise<WorkResult<string>> {
		return prepareSafeOutputPath({
			root: this.#stateDirectory,
			path: `export-state/work-contract/beads-${this.#projectKey.slice(0, 16)}.migration-v2.json`,
			errorCode: 'unsafe_provider_lock',
		})
	}

	#legacyMigrationMarker(): string {
		return `${JSON.stringify({ schemaVersion: 1, projectKey: this.#projectKey })}\n`
	}

	async #legacyMigrationComplete(): Promise<WorkResult<boolean>> {
		const prepared = await this.#legacyMigrationPath()
		if (!prepared.ok) {
			return prepared
		}
		const marker = await readBoundedUtf8({
			path: prepared.value,
			maxBytes: 256,
			unavailableCode: 'provider_failed',
			tooLargeCode: 'provider_failed',
			invalidUtf8Code: 'provider_failed',
			label: 'Legacy provider migration marker',
		})
		if (!marker.ok) {
			return isMissingLockResult(marker) ? { ok: true, value: false } : marker
		}
		let value: unknown
		try {
			value = JSON.parse(marker.value)
		} catch {
			value = undefined
		}
		const parsed = safeParse(LegacyMigrationMarkerSchema, value)
		if (parsed.success && parsed.output.projectKey === this.#projectKey) {
			return { ok: true, value: true }
		}
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_failed',
				message: 'Legacy provider migration marker is invalid.',
			},
		}
	}

	#listLegacyDefinitions(
		candidateWorkIds: readonly string[],
		normalizeWorkIds: readonly string[] = candidateWorkIds,
	): WorkResult<readonly LedgerItem[]> {
		const expectedByProviderId = new Map(
			candidateWorkIds.map((workId) => [deterministicProviderId(this.#projectId, workId), workId]),
		)
		const allRecords: BeadsRecord[] = []
		const providerIds = [...expectedByProviderId.keys()]
		const chunkSize = 1000
		for (let offset = 0; offset < providerIds.length; offset += chunkSize) {
			const ids = providerIds.slice(offset, offset + chunkSize)
			const listed = this.#run(
				['show', ...ids],
				true,
				undefined,
				true,
				ids.length * providerRawRecordBytes + 4096,
			)
			if (!listed.ok) {
				return listed
			}
			const records = this.#parseRecords(listed.value)
			if (!records.ok) {
				return records
			}
			if (records.value.length > ids.length) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads returned too many targeted migration candidates.',
					},
				}
			}
			allRecords.push(...records.value)
		}
		if (allRecords.length > candidateWorkIds.length) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Beads returned too many targeted migration candidates.',
				},
			}
		}
		for (const record of allRecords) {
			if (!expectedByProviderId.has(record.id)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads returned an unexpected targeted migration candidate.',
					},
				}
			}
		}
		for (const record of allRecords) {
			const expectedWorkId = expectedByProviderId.get(record.id)
			const metadata = record.metadata?.work_contract
			if (
				expectedWorkId === undefined ||
				metadata?.project_id !== this.#projectId ||
				metadata.work_id !== expectedWorkId ||
				(record.metadata?.work_contract_project_key !== undefined &&
					record.metadata.work_contract_project_key !== this.#projectKey)
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads returned inconsistent targeted migration metadata.',
					},
				}
			}
		}
		const owned = allRecords
		const byProviderId = new Map<string, string>(
			[...this.#providerIds].map(([workId, providerId]) => [providerId, workId]),
		)
		const seenWorkIds = new Set<string>()
		for (const record of owned) {
			const metadata = record.metadata?.work_contract
			if (metadata === undefined || seenWorkIds.has(metadata.work_id)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_ledger_projection',
						message: 'Beads migration candidates contain duplicate owned work metadata.',
					},
				}
			}
			seenWorkIds.add(metadata.work_id)
			byProviderId.set(record.id, metadata.work_id)
		}
		const normalizedWorkIds = new Set(normalizeWorkIds)
		const items: LedgerItem[] = []
		for (const record of owned) {
			if (!normalizedWorkIds.has(record.metadata?.work_contract?.work_id ?? '')) {
				continue
			}
			const normalized = normalizeRecord(record, byProviderId)
			if (!normalized.ok) {
				return normalized
			}
			if (normalized.value !== undefined) {
				const capacity = this.#validateProjectionItem(normalized.value)
				if (!capacity.ok) {
					return capacity
				}
				items.push(normalized.value)
			}
		}
		for (const item of items) {
			this.#providerIds.set(item.workId, item.providerId)
		}
		return { ok: true, value: items }
	}

	public async createDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerDefinitionInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		const { parentId, ...artifact } = parsed.value.artifact
		const definition: LedgerDefinitionInput = {
			...parsed.value,
			artifact: {
				...artifact,
				...(parentId === undefined ? {} : { parentId }),
			},
		}
		if (definition.projectId !== this.#projectId) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'project_mismatch',
					message: 'Definition targets another project.',
				},
			}
		}
		const capacity = this.#validateProjectionItem(this.#definitionProjectionItem(definition))
		if (!capacity.ok) {
			return capacity
		}
		return this.#withMutationLocks([definitionAdmissionLockId], async () => {
			this.#invalidateListProjection()
			const { result } = await this.#createDefinitionWithItemLock(definition)
			return result
		})
	}

	public async createDefinitions(
		inputs: readonly LedgerDefinitionInput[],
	): Promise<LedgerDefinitionBatchResult> {
		if (!Array.isArray(inputs)) {
			return {
				ok: false,
				applied: 0,
				error: {
					type: 'work_contract_error',
					code: 'invalid_operation_input',
					message: 'Definition batch input is invalid.',
				},
			}
		}
		if (inputs.length === 0) {
			return { ok: true, value: [] }
		}
		if (inputs.length > providerProjectItems) {
			return {
				ok: false,
				applied: 0,
				failedIndex: 0,
				error: {
					type: 'work_contract_error',
					code: 'provider_capacity_exceeded',
					message: `A Beads definition batch supports at most ${providerProjectItems} work items.`,
				},
			}
		}
		const definitions: LedgerDefinitionInput[] = []
		const workIds = new Set<string>()
		for (const input of inputs) {
			const parsed = parseAdapterInput(LedgerDefinitionInputSchema, input)
			if (!parsed.ok) {
				return { ...parsed, applied: 0, failedIndex: definitions.length }
			}
			if (parsed.value.projectId !== this.#projectId) {
				return {
					ok: false,
					applied: 0,
					failedIndex: definitions.length,
					error: {
						type: 'work_contract_error',
						code: 'project_mismatch',
						message: 'Definition batch targets another project.',
					},
				}
			}
			if (workIds.has(parsed.value.artifact.id)) {
				return {
					ok: false,
					applied: 0,
					failedIndex: definitions.length,
					error: {
						type: 'work_contract_error',
						code: 'invalid_operation_input',
						message: 'A definition batch contains a duplicate work ID.',
					},
				}
			}
			workIds.add(parsed.value.artifact.id)
			const { parentId, ...artifact } = parsed.value.artifact
			const definition = {
				...parsed.value,
				artifact: {
					...artifact,
					...(parentId === undefined ? {} : { parentId }),
				},
			}
			definitions.push(definition)
			const capacity = this.#validateProjectionItem(this.#definitionProjectionItem(definition))
			if (!capacity.ok) {
				return {
					...capacity,
					applied: 0,
					failedIndex: definitions.length - 1,
				}
			}
		}
		let operationOutcome: LedgerDefinitionBatchResult | undefined
		const locked = await this.#withMutationLocks<LedgerDefinitionBatchResult>(
			[definitionAdmissionLockId],
			async () => {
				this.#invalidateListProjection()
				const listed = await this.list()
				if (!listed.ok) {
					operationOutcome = { ...listed, applied: 0, failedIndex: 0 }
					return { ok: true, value: operationOutcome }
				}
				const absent: {
					readonly definition: LedgerDefinitionInput
					readonly index: number
				}[] = []
				const outcomes = new Map<number, LedgerItem>()
				for (const [index, definition] of definitions.entries()) {
					const existing = listed.value.find(({ workId }) => workId === definition.artifact.id)
					if (existing === undefined) {
						absent.push({ definition, index })
						continue
					}
					if (
						existing.definitionSchemaVersion !==
							(definition.definitionRevision === undefined ? 2 : 3) ||
						!this.#matchesDefinitionRevision(existing, definition)
					) {
						operationOutcome = {
							ok: false,
							applied: 0,
							failedIndex: index,
							error: {
								type: 'work_contract_error',
								code: 'definition_already_exists',
								message: `${definition.artifact.id} exists with a different definition; recompute the sync plan.`,
							},
						}
						return { ok: true, value: operationOutcome }
					}
					outcomes.set(index, existing)
				}
				const orderedAbsent = orderDefinitionsByPrerequisites(absent)
				if (orderedAbsent === undefined) {
					operationOutcome = {
						ok: false,
						applied: 0,
						failedIndex: absent[0]?.index ?? 0,
						error: {
							type: 'work_contract_error',
							code: 'invalid_operation_input',
							message: 'Definition batch prerequisites contain a cycle.',
						},
					}
					return { ok: true, value: operationOutcome }
				}
				let absentOutcome: LedgerDefinitionBatchResult | undefined
				let absentApplied = 0
				const itemLocked = await this.#withMutationLocks<LedgerDefinitionBatchResult>(
					absent.map(({ definition }) => definition.artifact.id),
					async () => {
						const legacyByWorkId = new Map<string, LedgerItem>()
						if (absent.length > 0) {
							const legacy = this.#listLegacyDefinitions(
								absent.map(({ definition }) => definition.artifact.id),
							)
							if (!legacy.ok) {
								absentOutcome = {
									...legacy,
									applied: 0,
									failedIndex: absent[0]?.index ?? 0,
								}
								return { ok: true, value: absentOutcome }
							}
							for (const item of legacy.value) {
								legacyByWorkId.set(item.workId, item)
							}
						}
						const newDefinitions = absent.filter(
							({ definition }) => !legacyByWorkId.has(definition.artifact.id),
						).length
						if (listed.value.length + legacyByWorkId.size + newDefinitions > providerProjectItems) {
							absentOutcome = {
								ok: false,
								applied: 0,
								failedIndex: absent[0]?.index ?? 0,
								error: {
									type: 'work_contract_error',
									code: 'provider_capacity_exceeded',
									message: `The Beads project supports at most ${providerProjectItems} work items.`,
								},
							}
							return { ok: true, value: absentOutcome }
						}
						let applied = 0
						for (const { definition, index } of orderedAbsent) {
							const legacyItem = legacyByWorkId.get(definition.artifact.id)
							if (
								legacyItem !== undefined &&
								!this.#matchesDefinitionRevision(legacyItem, definition)
							) {
								absentOutcome = {
									ok: false,
									applied,
									failedIndex: index,
									error: {
										type: 'work_contract_error',
										code: 'definition_already_exists',
										message: `${definition.artifact.id} exists with a different legacy definition; recompute the sync plan.`,
									},
								}
								return { ok: true, value: absentOutcome }
							}
							const result =
								legacyItem === undefined
									? await this.#createDefinition(definition)
									: this.#updateDefinitionItem(legacyItem, definition)
							if (!result.ok) {
								absentOutcome = {
									ok: false,
									applied,
									failedIndex: index,
									error: result.error,
								}
								return { ok: true, value: absentOutcome }
							}
							applied += 1
							absentApplied = applied
							outcomes.set(index, result.value)
						}
						absentOutcome = {
							ok: true,
							value: definitions.flatMap((_, index) => {
								const outcome = outcomes.get(index)
								return outcome === undefined ? [] : [outcome]
							}),
						}
						return { ok: true, value: absentOutcome }
					},
				)
				if (!itemLocked.ok) {
					operationOutcome =
						absentOutcome?.ok === false
							? {
									...absentOutcome,
									error: {
										...absentOutcome.error,
										details: [
											...(absentOutcome.error.details ?? []),
											`cleanupFailure=${itemLocked.error.code}`,
										],
									},
								}
							: {
									...itemLocked,
									applied: absentApplied,
									...(absentApplied === absent.length
										? {}
										: {
												failedIndex:
													orderedAbsent[absentApplied]?.index ?? orderedAbsent[0]?.index ?? 0,
											}),
								}
					return { ok: true, value: operationOutcome }
				}
				operationOutcome = itemLocked.value
				return { ok: true, value: operationOutcome }
			},
		)
		if (locked.ok) {
			return locked.value
		}
		if (operationOutcome?.ok === false) {
			return {
				...operationOutcome,
				error: {
					...operationOutcome.error,
					details: [
						...(operationOutcome.error.details ?? []),
						`cleanupFailure=${locked.error.code}`,
					],
				},
			}
		}
		return {
			...locked,
			applied: operationOutcome?.ok === true ? operationOutcome.value.length : 0,
		}
	}

	async #createDefinitionWithItemLock(input: LedgerDefinitionInput): Promise<{
		readonly result: WorkResult<LedgerItem>
		readonly confirmed?: LedgerItem
	}> {
		let confirmed: LedgerItem | undefined
		const result = await this.#withMutationLocks([input.artifact.id], async () => {
			const created = await this.#createDefinition(input)
			if (created.ok) {
				confirmed = created.value
			}
			return created
		})
		return { result, ...(confirmed === undefined ? {} : { confirmed }) }
	}

	async #createDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		if (this.#hasAuthoritativeListProjection && this.#providerIds.has(input.artifact.id)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'definition_already_exists',
					message: `${input.artifact.id} already exists; recompute the sync plan.`,
				},
			}
		}
		if (!this.#hasAuthoritativeListProjection) {
			const existing = await this.#find(
				input.artifact.id,
				[input.artifact.parentId, ...input.artifact.dependencies].filter(
					(value): value is string => value !== undefined,
				),
			)
			if (existing.ok) {
				if (!this.#providerIds.has(input.artifact.id)) {
					return this.#updateDefinitionItem(existing.value, input)
				}
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'definition_already_exists',
						message: `${input.artifact.id} already exists; recompute the sync plan.`,
					},
				}
			}
			if (existing.error.code !== 'work_not_found') {
				return existing
			}
		}
		if (this.#providerIds.size >= providerProjectItems) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_capacity_exceeded',
					message: `The Beads project supports at most ${providerProjectItems} work items.`,
				},
			}
		}
		if (input.projectId !== this.#projectId) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'project_mismatch',
					message: 'Definition targets another project.',
				},
			}
		}
		const expectedProviderId = deterministicProviderId(input.projectId, input.artifact.id)
		const capacity = this.#validateProjectionItem(this.#definitionProjectionItem(input))
		if (!capacity.ok) {
			return capacity
		}
		const projection = definitionProjection(input)
		const created = this.#run(
			[
				'create',
				'--id',
				expectedProviderId,
				'--force',
				'--title',
				input.artifact.title,
				'--type',
				providerType(input.artifact.kind),
				'--body-file',
				'-',
				'--acceptance',
				projection.acceptance,
				'--external-ref',
				`work-contract:${input.projectId}:${input.artifact.id}`,
				'--labels',
				'work-contract',
				'--metadata',
				JSON.stringify(metadataForDefinition(input)),
			],
			true,
			projection.body,
		)
		if (!created.ok) {
			this.#invalidateListProjection()
			const concurrent = await this.#find(input.artifact.id)
			if (!concurrent.ok) {
				return created
			}
			return concurrent.value.definitionSchemaVersion ===
				(input.definitionRevision === undefined ? 2 : 3) &&
				this.#matchesDefinitionRevision(concurrent.value, input)
				? concurrent
				: {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'definition_already_exists',
							message: `${input.artifact.id} was created concurrently with a different definition; recompute the sync plan.`,
						},
					}
		}
		const confirmed = this.#confirmMutation({
			source: created.value,
			workId: input.artifact.id,
			operation: 'createDefinition',
			postcondition: (item) =>
				item.providerId === expectedProviderId && this.#matchesDefinition(item, input),
		})
		if (!confirmed.ok) {
			this.#invalidateListProjection()
			return confirmed
		}
		this.#providerIds.set(confirmed.value.workId, confirmed.value.providerId)
		return confirmed
	}

	public async updateDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerDefinitionInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		const { parentId, ...artifact } = parsed.value.artifact
		const definition: LedgerDefinitionInput = {
			...parsed.value,
			artifact: {
				...artifact,
				...(parentId === undefined ? {} : { parentId }),
			},
		}
		return this.#withMutationLocks([definition.artifact.id], async () =>
			this.#updateDefinition(definition),
		)
	}

	async #updateDefinition(input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		if (input.projectId !== this.#projectId) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'project_mismatch',
					message: 'Definition targets another project.',
				},
			}
		}
		const current = await this.#find(
			input.artifact.id,
			[input.artifact.parentId, ...input.artifact.dependencies].filter(
				(value): value is string => value !== undefined,
			),
		)
		if (!current.ok) {
			return current
		}
		return this.#updateDefinitionItem(current.value, input)
	}

	#updateDefinitionItem(current: LedgerItem, input: LedgerDefinitionInput): WorkResult<LedgerItem> {
		if (
			['in_progress', 'blocked'].includes(current.status) &&
			!this.#matchesDefinitionRevision(current, input)
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message: 'Active work definitions cannot change until the work is released or completed.',
				},
			}
		}
		const updatedDefinitionItem: LedgerItem = {
			...current,
			definitionSchemaVersion: input.definitionRevision === undefined ? 2 : 3,
			title: input.artifact.title,
			kind: input.artifact.kind,
			execution: input.artifact.execution,
			source: input.artifact.source,
			graphFingerprint: input.graphFingerprint,
			...(input.definitionRevision === undefined
				? { definitionRevision: undefined }
				: { definitionRevision: input.definitionRevision }),
			roles: input.artifact.roles,
			evidenceRequirements: input.artifact.evidenceRequirements,
		}
		const capacity = this.#validateProjectionItem(updatedDefinitionItem)
		if (!capacity.ok) {
			return capacity
		}
		const projection = definitionProjection(input)
		const updated = this.#run(
			[
				'update',
				current.providerId,
				'--title',
				input.artifact.title,
				'--type',
				providerType(input.artifact.kind),
				'--body-file',
				'-',
				'--acceptance',
				projection.acceptance,
				'--external-ref',
				`work-contract:${input.projectId}:${input.artifact.id}`,
				'--metadata',
				JSON.stringify(metadataForItem({ item: updatedDefinitionItem })),
			],
			true,
			projection.body,
		)
		if (!updated.ok) {
			return updated
		}
		return this.#confirmMutation({
			source: updated.value,
			workId: input.artifact.id,
			operation: 'updateDefinition',
			postcondition: (item) => this.#matchesDefinition(item, input),
		})
	}

	public async setRelations(input: LedgerRelationsInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerRelationsInputSchema, input)
		return parsed.ok
			? this.#withMutationLocks(
					[parsed.value.workId, parsed.value.parentId, ...parsed.value.dependencies].filter(
						(value): value is string => value !== undefined,
					),
					async () =>
						this.#setRelations({
							...parsed.value,
							parentId: parsed.value.parentId,
						}),
				)
			: parsed
	}

	async #setRelations(input: LedgerRelationsInput): Promise<WorkResult<LedgerItem>> {
		let mutationsApplied = 0
		const failed = (error: WorkError): WorkResult<never> =>
			mutationsApplied === 0
				? { ok: false, error }
				: {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'relation_reconciliation_failed',
							message:
								'Relation reconciliation partially applied; rerun sync to converge provider state.',
							details: [
								`${error.code}: ${error.message}`,
								`mutationsApplied=${mutationsApplied}`,
								'stateMayHaveChanged=true',
							],
						},
					}
		const all = await this.list()
		if (!all.ok) {
			return all
		}
		const byWorkId = new Map(all.value.map((item) => [item.workId, item]))
		const current = byWorkId.get(input.workId)
		if (current === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_found',
					message: 'Unknown work item.',
				},
			}
		}
		if (
			['in_progress', 'blocked'].includes(current.status) &&
			(current.parentId !== input.parentId ||
				JSON.stringify(current.dependencies.toSorted()) !==
					JSON.stringify(input.dependencies.toSorted()))
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message: 'Active work relations cannot change until the work is released or completed.',
				},
			}
		}
		const desiredParent = input.parentId === undefined ? undefined : byWorkId.get(input.parentId)
		if (input.parentId !== undefined && desiredParent === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_found',
					message: 'Unknown parent work item.',
				},
			}
		}
		const capacity = this.#validateProjectionItem({
			...current,
			parentId: input.parentId,
			dependencies: input.dependencies,
		})
		if (!capacity.ok) {
			return capacity
		}
		if (current.parentId !== input.parentId) {
			const reparented = this.#run([
				'update',
				current.providerId,
				'--parent',
				desiredParent?.providerId ?? '',
			])
			if (!reparented.ok) {
				return failed(reparented.error)
			}
			const confirmed = this.#confirmMutation({
				source: reparented.value,
				workId: input.workId,
				operation: 'setRelationsParent',
				postcondition: (item) => item.parentId === input.parentId,
			})
			if (!confirmed.ok && !this.#isKnownRelationAcknowledgement(reparented.value, current).ok) {
				return failed(confirmed.error)
			}
			mutationsApplied += 1
		}

		const desiredDependencies = new Set(input.dependencies)
		for (const dependency of current.dependencies) {
			if (desiredDependencies.has(dependency)) {
				continue
			}
			const providerDependency = byWorkId.get(dependency)
			if (providerDependency === undefined) {
				continue
			}
			const removed = this.#run([
				'dep',
				'remove',
				current.providerId,
				providerDependency.providerId,
			])
			if (!removed.ok) {
				return failed(removed.error)
			}
			mutationsApplied += 1
		}
		for (const dependency of [...desiredDependencies].toSorted()) {
			if (current.dependencies.includes(dependency)) {
				continue
			}
			const providerDependency = byWorkId.get(dependency)
			if (providerDependency === undefined) {
				return failed({
					type: 'work_contract_error',
					code: 'work_not_found',
					message: `Unknown dependency ${dependency}.`,
				})
			}
			const added = this.#run([
				'dep',
				'add',
				current.providerId,
				providerDependency.providerId,
				'--type',
				'blocks',
			])
			if (!added.ok) {
				return failed(added.error)
			}
			mutationsApplied += 1
		}
		const reconciled = await this.#find(input.workId)
		if (!reconciled.ok) {
			return failed(reconciled.error)
		}
		return reconciled.value.parentId === input.parentId &&
			reconciled.value.dependencies.length === desiredDependencies.size &&
			reconciled.value.dependencies.every((dependency) => desiredDependencies.has(dependency))
			? reconciled
			: failed({
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads did not confirm the requested relation postcondition.',
					details: [
						'operation=setRelations',
						'stateMayHaveChanged=true',
						'recovery=rerun relation synchronization to converge provider state',
					],
				})
	}

	public async archive(workId: string): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerWorkIdInputSchema, { workId })
		return parsed.ok
			? this.#withMutationLocks([parsed.value.workId], async () =>
					this.#archive(parsed.value.workId),
				)
			: parsed
	}

	async #archive(workId: string): Promise<WorkResult<LedgerItem>> {
		const current = await this.#find(workId)
		if (!current.ok) {
			return current
		}
		if (['in_progress', 'blocked'].includes(current.value.status)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message:
						'Active work definitions cannot be archived until the work is released or completed.',
				},
			}
		}
		const capacity = this.#validateProjectionItem({
			...current.value,
			status: 'archived',
		})
		if (!capacity.ok) {
			return capacity
		}
		const marked = this.#run([
			'update',
			current.value.providerId,
			'--metadata',
			JSON.stringify(metadataForItem({ item: current.value, archived: true })),
		])
		if (!marked.ok) {
			return marked
		}
		const marker = this.#confirmArchivedMarker(marked.value, workId)
		if (!marker.ok) {
			return marker
		}
		const closed = this.#run([
			'close',
			current.value.providerId,
			'--reason',
			'work-contract: archived because source definition was removed',
		])
		if (!closed.ok) {
			const observed = await this.#find(workId)
			if (observed.ok && observed.value.status === 'archived') {
				return observed
			}
			if (
				!observed.ok ||
				observed.value.status !== current.value.status ||
				observed.value.assignee !== current.value.assignee ||
				!sameActivity(observed.value.activity, current.value.activity) ||
				!sameEvidence(observed.value.evidence, current.value.evidence) ||
				!sameHandoff(observed.value.handoff, current.value.handoff) ||
				observed.value.blockReason !== current.value.blockReason
			) {
				return this.#uncertainTerminalRecovery({
					code: 'archive_close_failed_recovery_required',
					cause: closed.error,
					message: 'Archival close outcome is uncertain; inspect provider state before retrying.',
				})
			}
			return this.#compensateMetadata({
				item: current.value,
				actor: this.#actor,
				cause: closed.error,
				code: 'archive_close_failed',
				message: 'Archival close failed; the archived metadata marker was restored.',
			})
		}
		return this.#confirmMutation({
			source: closed.value,
			workId,
			operation: 'archive',
			postcondition: (item) => item.status === 'archived',
		})
	}

	public async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerClaimInputSchema, input)
		return parsed.ok
			? this.#withMutationLocks(
					[
						...parsed.value.expectedDefinitionClosure.map(({ workId }) => workId),
						...parsed.value.expectedDependencies.map(({ workId }) => workId),
					],
					async () => {
						const expectedDefinitionClosure = parsed.value.expectedDefinitionClosure.map(
							normalizeDependencyExpectation,
						)
						return this.#claim({
							workId: parsed.value.workId,
							actor: parsed.value.actor,
							timestamp: parsed.value.timestamp,
							expectedDefinition: normalizeDefinitionExpectation(parsed.value.expectedDefinition),
							expectedDefinitionClosure,
							expectedDependencies: parsed.value.expectedDependencies.map(
								normalizeDependencyExpectation,
							),
							...(parsed.value.role === undefined ? {} : { role: parsed.value.role }),
							...(parsed.value.session === undefined ? {} : { session: parsed.value.session }),
						})
					},
				)
			: parsed
	}

	async #claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		const current = await this.#findReady(
			input.workId,
			input.expectedDefinition,
			input.expectedDependencies,
			input.expectedDefinitionClosure,
		)
		if (!current.ok) {
			return current
		}
		const definition = this.#verifyExpectedDefinition(current.value, input.expectedDefinition)
		if (!definition.ok) {
			return definition
		}
		if (current.value.status !== 'open' && current.value.status !== 'in_progress') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${input.workId} cannot be claimed from ${current.value.status}.`,
				},
			}
		}
		if (input.role !== undefined && !current.value.roles.includes(input.role)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'role_not_allowed',
					message: `${input.workId} cannot be claimed under the requested role.`,
				},
			}
		}
		if (current.value.assignee !== undefined && current.value.assignee !== input.actor) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ownership_conflict',
					message: 'Work item is already claimed by another actor.',
				},
			}
		}
		const resumesIncompleteClaim =
			current.value.status === 'in_progress' &&
			current.value.assignee === input.actor &&
			current.value.activity === undefined
		const resumesActiveClaim =
			current.value.status === 'in_progress' &&
			current.value.assignee === input.actor &&
			current.value.activity !== undefined
		if (resumesActiveClaim && current.value.activity?.role !== input.role) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'role_conflict',
					message: `${input.workId} is active under another role.`,
				},
			}
		}
		if (resumesActiveClaim && current.value.activity?.session !== input.session) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'session_conflict',
					message: `${input.workId} is active in another session; use resume explicitly.`,
				},
			}
		}
		if (resumesActiveClaim) {
			return current
		}
		const activity: LedgerActivity = {
			actor: input.actor,
			...(input.role === undefined ? {} : { role: input.role }),
			...(input.session === undefined ? {} : { session: input.session }),
			startedAt: input.timestamp,
			touchedAt: input.timestamp,
		}
		const capacity = this.#validateProjectionItem({
			...current.value,
			status: 'in_progress',
			assignee: input.actor,
			activity,
			blockReason: undefined,
		})
		if (!capacity.ok) {
			return capacity
		}
		if (!resumesIncompleteClaim) {
			const claimed = this.#run([
				'update',
				current.value.providerId,
				'--claim',
				'--actor',
				input.actor,
			])
			if (!claimed.ok) {
				return claimed
			}
			const claimedItem = this.#confirmMutation({
				source: claimed.value,
				workId: input.workId,
				operation: 'claim',
				structure: current.value,
				postcondition: (item) => item.status === 'in_progress' && item.assignee === input.actor,
			})
			if (!claimedItem.ok) {
				return claimedItem
			}
		}
		const metadata = this.#run([
			'update',
			current.value.providerId,
			'--metadata',
			JSON.stringify(metadataForItem({ item: current.value, activity, blockReason: null })),
			'--actor',
			input.actor,
		])
		if (!metadata.ok) {
			if (!resumesIncompleteClaim && current.value.assignee === undefined) {
				return this.#compensateMetadata({
					item: current.value,
					actor: input.actor,
					cause: metadata.error,
					code: 'claim_persistence_failed',
					message: 'Claim metadata failed; the complete pre-claim state was restored.',
					restoreOperationalState: true,
				})
			}
			return metadata
		}
		return this.#confirmMutation({
			source: metadata.value,
			workId: input.workId,
			operation: 'claim',
			structure: current.value,
			postcondition: (item) =>
				item.status === 'in_progress' &&
				item.assignee === input.actor &&
				sameActivity(item.activity, activity) &&
				item.blockReason === undefined,
		})
	}

	public async recordActivity(input: LedgerActivityInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerActivityInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		if (parsed.value.activity.actor !== parsed.value.actor) {
			return invalidAuditIdentity()
		}
		return this.#withMutationLocks(
			parsed.value.expectedDefinitionClosure.map(({ workId }) => workId),
			async () => {
				const expectedDefinitionClosure = parsed.value.expectedDefinitionClosure.map(
					normalizeDependencyExpectation,
				)
				return this.#recordActivity({
					workId: parsed.value.workId,
					actor: parsed.value.actor,
					replaceSession: parsed.value.replaceSession,
					...(parsed.value.role === undefined ? {} : { role: parsed.value.role }),
					...(parsed.value.session === undefined ? {} : { session: parsed.value.session }),
					expectedDefinition: normalizeDefinitionExpectation(parsed.value.expectedDefinition),
					expectedDefinitionClosure,
					activity: {
						actor: parsed.value.activity.actor,
						startedAt: parsed.value.activity.startedAt,
						touchedAt: parsed.value.activity.touchedAt,
						...(parsed.value.activity.role === undefined
							? {}
							: { role: parsed.value.activity.role }),
						...(parsed.value.activity.session === undefined
							? {}
							: { session: parsed.value.activity.session }),
					},
				})
			},
		)
	}

	async #recordActivity(input: LedgerActivityInput): Promise<WorkResult<LedgerItem>> {
		const current = await this.#find(input.workId, [], input.expectedDefinitionClosure)
		if (!current.ok) {
			return current
		}
		const definition = this.#verifyExpectedDefinition(current.value, input.expectedDefinition)
		if (!definition.ok) {
			return definition
		}
		if (current.value.status !== 'in_progress' && current.value.status !== 'blocked') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${input.workId} cannot update activity from ${current.value.status}.`,
				},
			}
		}
		const owned = this.#verifyOperationContext(current.value, input)
		if (!owned.ok) {
			return owned
		}
		if (current.value.activity === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'activity_missing',
					message: `${input.workId} has no active session.`,
				},
			}
		}
		if (
			input.activity.startedAt !== current.value.activity.startedAt ||
			input.activity.role !== current.value.activity.role ||
			(!input.replaceSession && input.activity.session !== current.value.activity.session)
		) {
			return invalidAuditIdentity()
		}
		const capacity = this.#validateProjectionItem({
			...current.value,
			activity: input.activity,
		})
		if (!capacity.ok) {
			return capacity
		}
		const updated = this.#run([
			'update',
			current.value.providerId,
			'--metadata',
			JSON.stringify(metadataForItem({ item: current.value, activity: input.activity })),
			'--actor',
			input.actor,
		])
		if (!updated.ok) {
			return updated
		}
		return this.#confirmMutation({
			source: updated.value,
			workId: input.workId,
			operation: 'recordActivity',
			structure: current.value,
			postcondition: (item) =>
				(item.status === 'in_progress' || item.status === 'blocked') &&
				item.assignee === input.actor &&
				sameActivity(item.activity, input.activity),
		})
	}

	public async recordSubmission(input: LedgerSubmissionInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerSubmissionInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		if (parsed.value.candidate.actor !== parsed.value.actor) {
			return invalidAuditIdentity()
		}
		const { ref: candidateRef, ...candidateFields } = parsed.value.candidate
		const candidate: LedgerCandidate = {
			...candidateFields,
			...(candidateRef === undefined ? {} : { ref: candidateRef }),
		}
		const gates: readonly LedgerGateReceipt[] = parsed.value.gates
		return this.#withMutationLocks(
			parsed.value.expectedDefinitionClosure.map(({ workId }) => workId),
			async () => {
				const current = await this.#find(
					parsed.value.workId,
					[],
					parsed.value.expectedDefinitionClosure.map(normalizeDependencyExpectation),
				)
				if (!current.ok) {
					return current
				}
				const definition = this.#verifyExpectedDefinition(
					current.value,
					normalizeDefinitionExpectation(parsed.value.expectedDefinition),
				)
				if (!definition.ok) {
					return definition
				}
				if (current.value.status !== 'in_progress') {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_transition',
							message: `${parsed.value.workId} cannot submit from ${current.value.status}.`,
						},
					}
				}
				const owned = this.#verifyOperationContext(current.value, {
					actor: parsed.value.actor,
					...(parsed.value.role === undefined ? {} : { role: parsed.value.role }),
					...(parsed.value.session === undefined ? {} : { session: parsed.value.session }),
				})
				if (!owned.ok) {
					return owned
				}
				const projected = {
					...current.value,
					candidate,
					gates,
				}
				const capacity = this.#validateProjectionItem(projected)
				if (!capacity.ok) {
					return capacity
				}
				const updated = this.#run([
					'update',
					current.value.providerId,
					'--metadata',
					JSON.stringify(
						metadataForItem({
							item: current.value,
							candidate,
							gates,
						}),
					),
					'--actor',
					parsed.value.actor,
				])
				if (!updated.ok) {
					return updated
				}
				return this.#confirmMutation({
					source: updated.value,
					workId: parsed.value.workId,
					operation: 'recordSubmission',
					structure: current.value,
					postcondition: (item) =>
						item.status === 'in_progress' &&
						item.assignee === parsed.value.actor &&
						isDeepStrictEqual(item.candidate, candidate) &&
						isDeepStrictEqual(item.gates ?? [], gates),
				})
			},
		)
	}

	public async recordHandoff(input: LedgerHandoffInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerHandoffInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		if (parsed.value.handoff.actor !== parsed.value.actor) {
			return invalidAuditIdentity()
		}
		return this.#withMutationLocks(
			parsed.value.expectedDefinitionClosure.map(({ workId }) => workId),
			async () => {
				const expectedDefinitionClosure = parsed.value.expectedDefinitionClosure.map(
					normalizeDependencyExpectation,
				)
				return this.#recordHandoff({
					workId: parsed.value.workId,
					actor: parsed.value.actor,
					...(parsed.value.role === undefined ? {} : { role: parsed.value.role }),
					...(parsed.value.session === undefined ? {} : { session: parsed.value.session }),
					release: parsed.value.release,
					expectedDefinition: normalizeDefinitionExpectation(parsed.value.expectedDefinition),
					expectedDefinitionClosure,
					handoff: {
						actor: parsed.value.handoff.actor,
						summary: parsed.value.handoff.summary,
						remaining: parsed.value.handoff.remaining,
						references: parsed.value.handoff.references,
						createdAt: parsed.value.handoff.createdAt,
						...(parsed.value.handoff.fromSession === undefined
							? {}
							: { fromSession: parsed.value.handoff.fromSession }),
						...(parsed.value.handoff.toActor === undefined
							? {}
							: { toActor: parsed.value.handoff.toActor }),
					},
				})
			},
		)
	}

	async #recordHandoff(input: LedgerHandoffInput): Promise<WorkResult<LedgerItem>> {
		const current = await this.#find(input.workId, [], input.expectedDefinitionClosure)
		if (!current.ok) {
			return current
		}
		const definition = this.#verifyExpectedDefinition(current.value, input.expectedDefinition)
		if (!definition.ok) {
			return definition
		}
		if (current.value.status !== 'in_progress' && current.value.status !== 'blocked') {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${input.workId} cannot hand off from ${current.value.status}.`,
				},
			}
		}
		const owned = this.#verifyOperationContext(current.value, input)
		if (!owned.ok) {
			return owned
		}
		if (
			input.handoff.fromSession !== undefined &&
			input.handoff.fromSession !== current.value.activity?.session
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'session_conflict',
					message: `${input.workId} is active in another session.`,
				},
			}
		}
		const capacity = this.#validateProjectionItem({
			...current.value,
			handoff: input.handoff,
			...(input.release
				? { status: 'open' as const, assignee: undefined, activity: undefined }
				: {}),
		})
		if (!capacity.ok) {
			return capacity
		}
		const comment = this.#run(
			['comment', current.value.providerId, '--stdin', '--actor', input.actor],
			true,
			`work-contract:handoff-intent:v1 ${JSON.stringify(input.handoff)}`,
		)
		if (!comment.ok) {
			if (comment.error.details?.includes('stateMayHaveChanged=true') === true) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'handoff_audit_failed_recovery_required',
						message: 'Handoff intent audit outcome is uncertain; inspect provider history.',
						details: [
							'auditCommentApplied=unknown',
							'stateMayHaveChanged=true',
							'recovery=inspect provider history before retrying the handoff',
						],
					},
				}
			}
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'handoff_audit_failed',
					message: 'Handoff intent audit failed before operational state changed.',
					details: [
						'auditCommentApplied=false',
						'stateApplied=false',
						'retrySafe=true',
						'recovery=retry the same handoff after restoring provider history writes',
					],
				},
			}
		}
		const metadata = this.#run([
			'update',
			current.value.providerId,
			'--metadata',
			JSON.stringify(
				metadataForItem({
					item: current.value,
					handoff: input.handoff,
					...(input.release ? { activity: null } : {}),
				}),
			),
			...(input.release ? ['--status', 'open', '--assignee', ''] : []),
			'--actor',
			input.actor,
		])
		if (!metadata.ok) {
			return {
				ok: false,
				error: {
					...metadata.error,
					details: [
						...(metadata.error.details ?? []),
						'auditCommentApplied=true',
						'stateMayHaveChanged=true',
						'recovery=inspect provider state against the handoff intent before retrying',
					],
				},
			}
		}
		return this.#confirmMutation({
			source: metadata.value,
			workId: input.workId,
			operation: input.release ? 'recordHandoffRelease' : 'recordHandoff',
			structure: current.value,
			postcondition: (item) =>
				input.release
					? item.status === 'open' &&
						item.assignee === undefined &&
						item.activity === undefined &&
						sameHandoff(item.handoff, input.handoff)
					: item.status === current.value.status &&
						item.assignee === input.actor &&
						sameHandoff(item.handoff, input.handoff) &&
						sameActivity(item.activity, current.value.activity),
		})
	}

	public async transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		const parsed = parseAdapterInput(LedgerTransitionInputSchema, input)
		if (!parsed.ok) {
			return parsed
		}
		if (parsed.value.type === 'complete') {
			const completion = parsed.value
			const validEvidenceIdentity =
				completion.candidate === undefined
					? completion.evidence.every(
							(evidence) =>
								evidence.actor === completion.actor && evidence.recordedAt === completion.timestamp,
						)
					: isDeepStrictEqual(completion.evidence, completion.candidate.evidence)
			if (!validEvidenceIdentity) {
				return invalidAuditIdentity()
			}
		}
		if (parsed.value.type === 'complete') {
			const request = parsed.value
			const candidate: LedgerCandidate | undefined =
				request.candidate === undefined
					? undefined
					: {
							schemaVersion: 1,
							generation: request.candidate.generation,
							projectId: request.candidate.projectId,
							workId: request.candidate.workId,
							graphFingerprint: request.candidate.graphFingerprint,
							repositoryId: request.candidate.repositoryId,
							headSha: request.candidate.headSha,
							treeSha: request.candidate.treeSha,
							...(request.candidate.ref === undefined ? {} : { ref: request.candidate.ref }),
							isolation: request.candidate.isolation,
							submittedAt: request.candidate.submittedAt,
							actor: request.candidate.actor,
							evidence: request.candidate.evidence,
						}
			return this.#withMutationLocks(
				[
					...request.expectedDefinitionClosure.map(({ workId }) => workId),
					...request.expectedDependencies.map(({ workId }) => workId),
					...(request.expectedChildren ?? []).map(({ workId }) => workId),
				],
				async () => {
					const expectedDefinitionClosure = request.expectedDefinitionClosure.map(
						normalizeDependencyExpectation,
					)
					return this.#transition({
						type: 'complete',
						workId: request.workId,
						actor: request.actor,
						evidence: request.evidence,
						...(candidate === undefined ? {} : { candidate }),
						...(request.gates === undefined ? {} : { gates: request.gates }),
						timestamp: request.timestamp,
						expectedDefinition: normalizeDefinitionExpectation(request.expectedDefinition),
						expectedDefinitionClosure,
						expectedDependencies: request.expectedDependencies.map((expectation) =>
							normalizeDependencyExpectation(expectation),
						),
						expectedChildren: (request.expectedChildren ?? []).map((expectation) =>
							normalizeDependencyExpectation(expectation),
						),
						...(request.role === undefined ? {} : { role: request.role }),
						...(request.session === undefined ? {} : { session: request.session }),
					})
				},
			)
		}
		const request = parsed.value
		if (request.type === 'reopen') {
			const expectedAggregateParents = (request.expectedAggregateParents ?? []).map((expectation) =>
				normalizeDependencyExpectation(expectation),
			)
			return this.#withMutationLocks(
				[
					...request.expectedDefinitionClosure.map(({ workId }) => workId),
					...expectedAggregateParents.map(({ workId }) => workId),
				],
				async () =>
					this.#transition({
						type: 'reopen',
						workId: request.workId,
						actor: request.actor,
						reason: request.reason,
						expectedDefinition: normalizeDefinitionExpectation(request.expectedDefinition),
						expectedDefinitionClosure: request.expectedDefinitionClosure.map(
							normalizeDependencyExpectation,
						),
						expectedAggregateParents,
						...(request.role === undefined ? {} : { role: request.role }),
						...(request.session === undefined ? {} : { session: request.session }),
					}),
			)
		}
		const { expectedDefinition, expectedDefinitionClosure, role, session, ...transition } = request
		return this.#withMutationLocks(
			expectedDefinitionClosure.map(({ workId }) => workId),
			async () => {
				const normalizedClosure = expectedDefinitionClosure.map((expectation) =>
					normalizeDependencyExpectation(expectation),
				)
				return this.#transition({
					...transition,
					expectedDefinition: normalizeDefinitionExpectation(expectedDefinition),
					expectedDefinitionClosure: normalizedClosure,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
				})
			},
		)
	}

	async #verifyReopenAggregateParents(
		input: Extract<LedgerTransitionInput, { readonly type: 'reopen' }>,
	): Promise<WorkResult<undefined>> {
		const expectations = input.expectedAggregateParents ?? []
		if (expectations.length === 0) {
			return { ok: true, value: undefined }
		}
		const listed = await this.list()
		if (!listed.ok) {
			return listed
		}
		const byId = new Map(listed.value.map((item) => [item.workId, item]))
		for (const expectation of expectations) {
			const parent = byId.get(expectation.workId)
			if (parent === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'Required aggregate parent is missing.',
					},
				}
			}
			const exact = this.#verifyExpectedDefinition(parent, expectation)
			if (!exact.ok) {
				return exact
			}
			if (parent.status === 'closed') {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'aggregate_not_ready',
						message: 'Reopen the aggregate parent before reopening its child.',
					},
				}
			}
		}
		return { ok: true, value: undefined }
	}

	async #prepareTransition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		const current =
			input.type === 'complete'
				? await this.#findReady(
						input.workId,
						input.expectedDefinition,
						input.expectedDependencies,
						input.expectedDefinitionClosure,
						input.expectedChildren ?? [],
					)
				: await this.#find(input.workId, [], input.expectedDefinitionClosure)
		if (!current.ok) {
			return current
		}
		const definition = this.#verifyExpectedDefinition(current.value, input.expectedDefinition)
		if (!definition.ok) {
			return definition
		}
		if (input.type === 'reopen') {
			const parents = await this.#verifyReopenAggregateParents(input)
			if (!parents.ok) {
				return parents
			}
		}
		const allowedStatuses: Readonly<Record<typeof input.type, readonly LedgerStatus[]>> = {
			block: ['in_progress'],
			complete: input.expectedDefinition.execution === 'aggregate' ? ['open'] : ['in_progress'],
			release: ['in_progress', 'blocked'],
			reopen: ['blocked', 'closed'],
		}
		if (!allowedStatuses[input.type].includes(current.value.status)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: `${input.workId} cannot ${input.type} from ${current.value.status}.`,
				},
			}
		}
		if (
			!(
				(input.type === 'complete' || input.type === 'reopen') &&
				input.expectedDefinition.execution === 'aggregate'
			)
		) {
			const owned = this.#verifyOperationContext(current.value, input)
			if (!owned.ok) {
				return owned
			}
		}
		const projectedItem = projectTransitionItem(input, current.value)
		const capacity = this.#validateProjectionItem(projectedItem)
		if (!capacity.ok) {
			return capacity
		}
		return current
	}

	async #transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		const current = await this.#prepareTransition(input)
		if (!current.ok) {
			return current
		}
		const requestDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
		const intentPayload = transitionIntentPayload(input, requestDigest)
		const intentRecord = `work-contract:${input.type}-intent:v1 ${JSON.stringify(intentPayload)}`
		const intent = this.#recordTransitionIntent(input, current.value, intentRecord)
		if (!intent.ok) {
			if (intent.error.details?.includes('stateMayHaveChanged=true') === true) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'transition_audit_failed',
						message: 'Transition intent audit outcome is uncertain; inspect provider history.',
						details: [
							'auditCommentApplied=unknown',
							'stateMayHaveChanged=true',
							'recovery=inspect provider history before retrying the transition',
						],
					},
				}
			}
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'transition_audit_failed',
					message: 'Transition intent audit failed before operational state changed.',
					details: [
						'auditCommentApplied=false',
						'stateApplied=false',
						'retrySafe=true',
						'recovery=retry the same transition after restoring provider history writes',
					],
				},
			}
		}
		if (input.type === 'complete') {
			const aggregateCompletion = input.expectedDefinition.execution === 'aggregate'
			const completionAssignee = aggregateCompletion ? current.value.assignee : input.actor
			const completionActiveStatus = aggregateCompletion ? 'open' : 'in_progress'
			const expectedCandidate = input.candidate ?? current.value.candidate
			const expectedGates = input.gates ?? current.value.gates ?? []
			const metadata = this.#run([
				'update',
				current.value.providerId,
				'--metadata',
				JSON.stringify(
					metadataForItem({
						item: current.value,
						blockReason: null,
						evidence: input.evidence,
						...(input.candidate === undefined ? {} : { candidate: input.candidate }),
						...(input.gates === undefined ? {} : { gates: input.gates }),
					}),
				),
				'--append-notes',
				intentRecord,
				'--actor',
				input.actor,
			])
			if (!metadata.ok) {
				return {
					ok: false,
					error: {
						...metadata.error,
						details: [
							...(metadata.error.details ?? []),
							'auditRecordApplied=unknown',
							'stateMayHaveChanged=true',
							'recovery=inspect provider state against the completion intent before retrying',
						],
					},
				}
			}
			const recorded = this.#confirmMutation({
				source: metadata.value,
				workId: input.workId,
				operation: 'complete',
				structure: current.value,
				postcondition: (item) =>
					item.status === completionActiveStatus &&
					item.assignee === completionAssignee &&
					sameEvidence(item.evidence, input.evidence) &&
					(input.candidate === undefined || isDeepStrictEqual(item.candidate, input.candidate)) &&
					(input.gates === undefined || isDeepStrictEqual(item.gates ?? [], input.gates)) &&
					item.blockReason === undefined,
			})
			if (!recorded.ok) {
				return recorded
			}
			const completed = this.#run([
				'close',
				current.value.providerId,
				'--reason',
				'work-contract: completed with evidence receipt',
				'--actor',
				input.actor,
				...(current.value.activity?.session === undefined
					? []
					: ['--session', current.value.activity.session]),
			])
			if (!completed.ok) {
				const observed = await this.#find(input.workId)
				if (
					observed.ok &&
					observed.value.status === 'closed' &&
					observed.value.assignee === completionAssignee &&
					sameActivity(observed.value.activity, current.value.activity) &&
					sameEvidence(observed.value.evidence, input.evidence) &&
					isDeepStrictEqual(observed.value.candidate, expectedCandidate) &&
					isDeepStrictEqual(observed.value.gates ?? [], expectedGates) &&
					observed.value.blockReason === undefined
				) {
					return observed
				}
				if (
					!observed.ok ||
					observed.value.status !== completionActiveStatus ||
					observed.value.assignee !== completionAssignee ||
					!sameActivity(observed.value.activity, current.value.activity) ||
					(!sameEvidence(observed.value.evidence, input.evidence) &&
						!sameEvidence(observed.value.evidence, current.value.evidence)) ||
					!isDeepStrictEqual(
						observed.value.candidate,
						input.candidate ?? current.value.candidate,
					) ||
					!isDeepStrictEqual(
						observed.value.gates ?? [],
						input.gates ?? current.value.gates ?? [],
					) ||
					!sameHandoff(observed.value.handoff, current.value.handoff) ||
					observed.value.blockReason !== undefined
				) {
					return this.#uncertainTerminalRecovery({
						code: 'completion_close_failed_recovery_required',
						cause: completed.error,
						message:
							'Completion close outcome is uncertain; inspect provider state before retrying.',
						residualDetails: ['auditRecordApplied=true'],
					})
				}
				return this.#compensateMetadata({
					item: current.value,
					actor: input.actor,
					cause: completed.error,
					code: 'completion_close_failed',
					message: 'Completion close failed; the prior operational metadata was restored.',
					residualDetails: ['auditRecordApplied=true'],
				})
			}
			return this.#confirmMutation({
				source: completed.value,
				workId: input.workId,
				operation: 'complete',
				structure: current.value,
				postcondition: (item) =>
					item.status === 'closed' &&
					item.assignee === completionAssignee &&
					sameActivity(item.activity, current.value.activity) &&
					sameEvidence(item.evidence, input.evidence) &&
					isDeepStrictEqual(item.candidate, expectedCandidate) &&
					isDeepStrictEqual(item.gates ?? [], expectedGates) &&
					item.blockReason === undefined,
			})
		}

		const status = input.type === 'block' ? 'blocked' : 'open'
		const updated = this.#run([
			'update',
			current.value.providerId,
			'--metadata',
			JSON.stringify(
				metadataForItem({
					item: current.value,
					...(input.type === 'block'
						? { blockReason: input.reason }
						: { blockReason: null, activity: null }),
				}),
			),
			'--status',
			status,
			...(input.type === 'block' ? [] : ['--assignee', '']),
			'--actor',
			input.actor,
		])
		if (!updated.ok) {
			return {
				ok: false,
				error: {
					...updated.error,
					details: [
						...(updated.error.details ?? []),
						'auditCommentApplied=true',
						'stateMayHaveChanged=true',
						'recovery=inspect provider state against the transition intent before retrying',
					],
				},
			}
		}
		return this.#confirmMutation({
			source: updated.value,
			workId: input.workId,
			operation: input.type,
			structure: current.value,
			postcondition: (item) =>
				item.status === status &&
				(input.type === 'block'
					? item.assignee === input.actor &&
						item.blockReason === input.reason &&
						sameActivity(item.activity, current.value.activity)
					: item.assignee === undefined &&
						item.blockReason === undefined &&
						item.activity === undefined),
		})
	}

	#recordTransitionIntent(
		input: LedgerTransitionInput,
		current: LedgerItem,
		intentRecord: string,
	): WorkResult<void> {
		if (input.type === 'complete') {
			return { ok: true, value: undefined }
		}
		const recorded = this.#run([
			'comment',
			current.providerId,
			intentRecord,
			'--actor',
			input.actor,
		])
		return recorded.ok ? { ok: true, value: undefined } : recorded
	}

	async #withMutationLocks<T>(
		workIds: readonly string[],
		operation: () => Promise<WorkResult<T>>,
	): Promise<WorkResult<T>> {
		const deadline = Date.now() + providerLockWaitMs
		const legacy = await this.#waitForLegacyMutationLock(deadline)
		if (!legacy.ok) {
			return legacy
		}
		const owner: MutationLockOwner = {
			pid: processId,
			startedAt: new Date().toISOString(),
			nonce: randomUUID(),
		}
		const acquired: AcquiredMutationLock[] = []
		for (const workId of [...new Set(workIds)].toSorted()) {
			const lock = await this.#acquireMutationLock(workId, owner, deadline)
			if (!lock.ok) {
				const released = await this.#releaseMutationLocks(acquired)
				return released.ok
					? lock
					: {
							ok: false,
							error: {
								...lock.error,
								details: [
									...(lock.error.details ?? []).slice(0, 16).map((detail) => detail.slice(0, 512)),
									`cleanupFailure=${released.error.code}`,
									'recovery=preserve the primary acquisition error and inspect the provider mutation lock manually',
								],
							},
						}
			}
			acquired.push(lock.value)
		}
		let result: WorkResult<T>
		try {
			result = await operation()
		} catch {
			result = {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Provider mutation failed unexpectedly; provider state is uncertain.',
					details: [
						'stateMayHaveChanged=true',
						'recovery=inspect provider state and reconcile before retrying',
					],
				},
			}
		}
		const released = await this.#releaseMutationLocks(acquired)
		if (released.ok) {
			return result
		}
		if (result.ok) {
			return {
				ok: false,
				error: {
					...released.error,
					details: [
						'stateApplied=true',
						'stateMayHaveChanged=true',
						'recovery=inspect the committed provider state and remove only the verified owned lock before continuing',
					],
				},
			}
		}
		return {
			ok: false,
			error: {
				...result.error,
				details: [
					...(result.error.details ?? []).slice(0, 16).map((detail) => detail.slice(0, 512)),
					`cleanupFailure=${released.error.code}`,
					'recovery=preserve the primary error and inspect the provider mutation lock manually',
				],
			},
		}
	}

	async #waitForLegacyMutationLock(deadline: number): Promise<WorkResult<void>> {
		const prepared = await prepareSafeOutputPath({
			root: this.#coordinationRoot,
			path: `.work/beads-${createHash('sha256').update(this.#projectId).digest('hex').slice(0, 16)}.lock`,
			errorCode: 'unsafe_provider_lock',
		})
		if (!prepared.ok) {
			return prepared
		}
		while (true) {
			const observed = await this.#readMutationLock(prepared.value)
			if (!observed.ok) {
				if (isMissingLockResult(observed)) {
					return { ok: true, value: undefined }
				}
				return this.#providerBusy()
			}
			const match = /^(\d+)\n$/.exec(observed.value)
			const legacyPid = match?.[1] === undefined ? undefined : Number(match[1])
			if (
				legacyPid !== undefined &&
				Number.isSafeInteger(legacyPid) &&
				legacyPid > 0 &&
				!isProcessAlive(legacyPid)
			) {
				return this.#staleProviderLock()
			}
			if (Date.now() >= deadline) {
				return this.#providerBusy()
			}
			await delay(providerLockRetryMs)
		}
	}

	async #inspectMutationLockHealth(): Promise<WorkResult<void>> {
		const legacy = await prepareSafeOutputPath({
			root: this.#coordinationRoot,
			path: `.work/beads-${this.#projectKey.slice(0, 16)}.lock`,
			errorCode: 'unsafe_provider_lock',
			createParents: false,
		})
		if (!legacy.ok) {
			return legacy
		}
		const legacyState = await this.#readMutationLock(legacy.value)
		if (legacyState.ok) {
			const pidSource = /^(\d+)\n$/.exec(legacyState.value)?.[1]
			const pid = pidSource === undefined ? undefined : Number(pidSource)
			if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
				return this.#staleProviderLock()
			}
		} else if (!isMissingLockResult(legacyState)) {
			return this.#providerBusy()
		}

		let directory: Awaited<ReturnType<typeof opendir>> | undefined
		try {
			directory = await opendir(dirname(legacy.value))
			const itemLockPattern = new RegExp(
				`^beads-${this.#projectKey.slice(0, 12)}-[0-9a-f]{12}\\.lock$`,
			)
			for (let count = 0; count <= INPUT_LIMITS.sourceEntries; count += 1) {
				const entry = await directory.read()
				if (entry === null) {
					return { ok: true, value: undefined }
				}
				if (count === INPUT_LIMITS.sourceEntries) {
					return this.#providerBusy()
				}
				if (!entry.isFile() || !itemLockPattern.test(entry.name)) {
					continue
				}
				const deadOwner = await this.#hasDeadMutationLockOwner(
					join(dirname(legacy.value), entry.name),
				)
				if (!deadOwner.ok) {
					if (isMissingLockResult(deadOwner)) {
						continue
					}
					return this.#providerBusy()
				}
				if (deadOwner.value) {
					return this.#staleProviderLock()
				}
			}
			return this.#providerBusy()
		} catch (error: unknown) {
			return error instanceof Error && 'code' in error && error.code === 'ENOENT'
				? { ok: true, value: undefined }
				: this.#providerBusy()
		} finally {
			if (directory !== undefined) {
				try {
					await directory.close()
				} catch {
					// The directory may already be closed after its terminal read.
				}
			}
		}
	}

	async #acquireMutationLock(
		workId: string,
		owner: MutationLockOwner,
		deadline: number,
	): Promise<WorkResult<AcquiredMutationLock>> {
		const prepared = await prepareSafeOutputPath({
			root: this.#coordinationRoot,
			path: `.work/beads-${createHash('sha256').update(this.#projectId).digest('hex').slice(0, 12)}-${createHash('sha256').update(workId).digest('hex').slice(0, 12)}.lock`,
			errorCode: 'unsafe_provider_lock',
		})
		if (!prepared.ok) {
			return prepared
		}
		const content = `${JSON.stringify(owner)}\n`
		while (true) {
			let handle: FileHandle | undefined
			try {
				handle = await open(prepared.value, 'wx', 0o600)
				await handle.writeFile(content)
				await handle.close()
				handle = undefined
				return { ok: true, value: { content, path: prepared.value } }
			} catch (error: unknown) {
				if (handle !== undefined) {
					await handle.close().catch(() => false)
					await this.#removeOwnedLock(prepared.value, content).catch(() => false)
				}
				if (!isAlreadyExistsError(error)) {
					return this.#providerBusy()
				}
				const deadOwner = await this.#hasDeadMutationLockOwner(prepared.value)
				if (!deadOwner.ok) {
					if (isMissingLockResult(deadOwner)) {
						continue
					}
					return this.#providerBusy()
				}
				if (deadOwner.value) {
					return this.#staleProviderLock()
				}
				if (Date.now() >= deadline) {
					return this.#providerBusy()
				}
				await delay(providerLockRetryMs)
			}
		}
	}

	async #hasDeadMutationLockOwner(path: string): Promise<WorkResult<boolean>> {
		const observed = await this.#readMutationLock(path)
		if (!observed.ok) {
			return observed
		}
		let document: unknown
		try {
			document = JSON.parse(observed.value)
		} catch {
			return { ok: true, value: false }
		}
		const parsed = safeParse(MutationLockOwnerSchema, document)
		return {
			ok: true,
			value: parsed.success && !isProcessAlive(parsed.output.pid),
		}
	}

	async #readMutationLock(path: string): Promise<WorkResult<string>> {
		return readBoundedUtf8({
			path,
			maxBytes: providerLockMaxBytes,
			unavailableCode: 'provider_busy',
			tooLargeCode: 'provider_busy',
			invalidUtf8Code: 'provider_busy',
			label: 'Provider mutation lock',
		})
	}

	async #removeOwnedLock(path: string, expectedContent: string): Promise<boolean> {
		const observed = await this.#readMutationLock(path)
		if (!observed.ok || observed.value !== expectedContent) {
			return false
		}
		const claimPath = `${path}.release-${randomUUID()}`
		try {
			await link(path, claimPath)
			const [authoritative, claim, claimedContent] = await Promise.all([
				lstat(path),
				lstat(claimPath),
				this.#readMutationLock(claimPath),
			])
			if (
				authoritative.dev !== claim.dev ||
				authoritative.ino !== claim.ino ||
				!claimedContent.ok ||
				claimedContent.value !== expectedContent
			) {
				await rm(claimPath).catch(() => false)
				return false
			}
			await rm(path)
			await rm(claimPath)
			return true
		} catch {
			await rm(claimPath).catch(() => false)
			return false
		}
	}

	async #releaseMutationLocks(locks: readonly AcquiredMutationLock[]): Promise<WorkResult<void>> {
		let releaseFailed = false
		for (const lock of locks.toReversed()) {
			if (!(await this.#removeOwnedLock(lock.path, lock.content))) {
				releaseFailed = true
			}
		}
		return releaseFailed
			? {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'provider_lock_release_failed',
						message: 'Provider mutation finished but an owned repository lock was not removed.',
					},
				}
			: { ok: true, value: undefined }
	}

	#providerBusy<T>(): WorkResult<T> {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_busy',
				message: 'Another work-contract provider mutation remained active past the bounded wait.',
			},
		}
	}

	#staleProviderLock<T>(): WorkResult<T> {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_busy',
				message: 'A stale provider mutation lock requires manual recovery.',
				details: [
					'lockState=stale',
					'automaticRecovery=false',
					'recovery=confirm no provider mutation is active, then remove the stale lock',
				],
			},
		}
	}

	#compensateMetadata(input: {
		readonly item: LedgerItem
		readonly actor: string
		readonly cause: WorkError
		readonly code:
			| 'archive_close_failed'
			| 'claim_persistence_failed'
			| 'completion_close_failed'
			| 'handoff_audit_failed'
			| 'handoff_release_failed'
			| 'transition_status_failed'
		readonly message: string
		readonly residualDetails?: readonly string[]
		readonly restoreOperationalState?: boolean
	}): WorkResult<never> {
		const restored = this.#run([
			'update',
			input.item.providerId,
			'--metadata',
			JSON.stringify(metadataForItem({ item: input.item })),
			...(input.restoreOperationalState === true
				? ['--status', input.item.status, '--assignee', input.item.assignee ?? '']
				: []),
			'--actor',
			input.actor,
		])
		const confirmed = restored.ok
			? this.#confirmMutation({
					source: restored.value,
					workId: input.item.workId,
					operation: 'metadataCompensation',
					postcondition: (item) =>
						item.status === input.item.status &&
						item.assignee === input.item.assignee &&
						sameActivity(item.activity, input.item.activity) &&
						sameEvidence(item.evidence, input.item.evidence) &&
						sameHandoff(item.handoff, input.item.handoff) &&
						item.blockReason === input.item.blockReason,
				})
			: restored
		const recoveryCodes = {
			archive_close_failed: 'archive_close_failed_recovery_required',
			claim_persistence_failed: 'claim_compensation_failed',
			completion_close_failed: 'completion_close_failed_recovery_required',
			handoff_audit_failed: 'handoff_audit_failed_recovery_required',
			handoff_release_failed: 'handoff_release_failed_recovery_required',
			transition_status_failed: 'transition_status_failed_recovery_required',
		} as const
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: confirmed.ok ? input.code : recoveryCodes[input.code],
				message: confirmed.ok
					? input.message
					: `${input.message} Metadata restoration also failed; manual recovery is required.`,
				details: [
					`causeCode=${input.cause.code}`,
					...(input.residualDetails ?? []),
					...(confirmed.ok
						? []
						: [
								'restorationConfirmed=false',
								'stateMayHaveChanged=true',
								'recovery=inspect provider state and reconcile manually',
							]),
				],
			},
		}
	}

	#uncertainTerminalRecovery(input: {
		readonly code:
			| 'archive_close_failed_recovery_required'
			| 'completion_close_failed_recovery_required'
		readonly cause: WorkError
		readonly message: string
		readonly residualDetails?: readonly string[]
	}): WorkResult<never> {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: input.code,
				message: input.message,
				details: [
					`causeCode=${input.cause.code}`,
					...(input.residualDetails ?? []),
					'stateMayHaveChanged=true',
					'recovery=inspect provider state and reconcile manually before retrying',
				],
			},
		}
	}

	#claimOwnership(item: LedgerItem, actor: string): WorkResult<void> {
		if (item.assignee !== actor) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ownership_conflict',
					message: 'Work item is not assigned to the requesting actor.',
				},
			}
		}
		return { ok: true, value: undefined }
	}

	#verifyOperationContext(
		item: LedgerItem,
		input: {
			readonly actor: string
			readonly role?: string
			readonly session?: string
		},
	): WorkResult<void> {
		const owned = this.#claimOwnership(item, input.actor)
		if (!owned.ok) {
			return owned
		}
		if (input.role !== undefined && !item.roles.includes(input.role)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'role_not_allowed',
					message: `${item.workId} does not allow the requested role.`,
				},
			}
		}
		if (input.role !== undefined && item.activity?.role !== input.role) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'role_conflict',
					message: `${item.workId} is active under another role.`,
				},
			}
		}
		if (input.session !== undefined && item.activity?.session !== input.session) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'session_conflict',
					message: `${item.workId} is active in another session.`,
				},
			}
		}
		return { ok: true, value: undefined }
	}

	#parseMutationItem(source: string, workId: string): WorkResult<LedgerItem> {
		const parsed = this.#parseRecords(source)
		if (!parsed.ok) {
			return parsed
		}
		if (parsed.value.length > 1) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_beads_record',
					message: `Beads returned multiple records for the ${workId} mutation response.`,
				},
			}
		}
		const record = parsed.value[0]
		if (record === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_beads_record',
					message: `Beads omitted ${workId} from its mutation response.`,
				},
			}
		}
		const providerWorkIds = new Map(
			[...this.#providerIds.entries()].map(([candidateWorkId, providerId]) => [
				providerId,
				candidateWorkId,
			]),
		)
		const normalized = normalizeRecord(record, providerWorkIds)
		if (!normalized.ok) {
			return normalized
		}
		return normalized.value?.projectId === this.#projectId && normalized.value.workId === workId
			? { ok: true, value: normalized.value }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_beads_record',
						message: `Beads returned an unexpected mutation target for ${workId}.`,
					},
				}
	}

	#confirmMutation(input: {
		readonly source: string
		readonly workId: string
		readonly operation: string
		readonly structure?: Readonly<Pick<LedgerItem, 'dependencies' | 'parentId'>>
		readonly postcondition: (item: LedgerItem) => boolean
	}): WorkResult<LedgerItem> {
		const parsed = this.#parseMutationItem(input.source, input.workId)
		if (parsed.ok) {
			const item =
				input.structure === undefined
					? parsed.value
					: {
							...parsed.value,
							dependencies: input.structure.dependencies,
							parentId: input.structure.parentId,
						}
			if (input.postcondition(item)) {
				return { ok: true, value: item }
			}
		}
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_mutation_failed',
				message: `Beads ${input.operation} response did not confirm the requested postcondition.`,
				details: [
					`operation=${input.operation}`,
					'stateMayHaveChanged=true',
					'recovery=inspect provider state and reconcile before retrying',
					...(parsed.ok ? [] : [`providerCode=${parsed.error.code}`]),
				],
			},
		}
	}

	#matchesDefinition(item: LedgerItem, input: LedgerDefinitionInput): boolean {
		return (
			item.definitionSchemaVersion === (input.definitionRevision === undefined ? 2 : 3) &&
			item.graphFingerprint === input.graphFingerprint &&
			(input.definitionRevision === undefined ||
				(item.definitionRevision?.targetRef === input.definitionRevision.targetRef &&
					item.definitionRevision.graphFingerprint ===
						input.definitionRevision.graphFingerprint)) &&
			this.#matchesDefinitionRevision(item, input)
		)
	}

	#matchesDefinitionRevision(item: LedgerItem, input: LedgerDefinitionInput): boolean {
		return (
			item.projectId === input.projectId &&
			item.workId === input.artifact.id &&
			item.title === input.artifact.title &&
			item.kind === input.artifact.kind &&
			(item.execution ?? 'task') === input.artifact.execution &&
			item.source.path === input.artifact.source.path &&
			item.source.hash === input.artifact.source.hash &&
			(item.definitionSchemaVersion === 1 ||
				(JSON.stringify(item.roles.toSorted()) ===
					JSON.stringify(input.artifact.roles.toSorted()) &&
					JSON.stringify(item.evidenceRequirements.toSorted()) ===
						JSON.stringify(input.artifact.evidenceRequirements.toSorted())))
		)
	}

	#verifyExpectedDefinition(
		item: LedgerItem,
		expected: LedgerDefinitionExpectation,
	): WorkResult<void> {
		const actualDependencies = item.dependencies.toSorted()
		const expectedDependencies = expected.dependencies.toSorted()
		const actualRoles = item.roles.toSorted()
		const expectedRoles = expected.roles.toSorted()
		const actualEvidenceRequirements = item.evidenceRequirements.toSorted()
		const expectedEvidenceRequirements = expected.evidenceRequirements.toSorted()
		return item.definitionSchemaVersion === expected.schemaVersion &&
			(expected.schemaVersion === 2 ||
				(item.graphFingerprint === expected.graphFingerprint &&
					item.definitionRevision?.targetRef === expected.definitionRevision.targetRef &&
					item.definitionRevision.graphFingerprint ===
						expected.definitionRevision.graphFingerprint)) &&
			item.title === expected.title &&
			item.kind === expected.kind &&
			(item.execution ?? 'task') === (expected.execution ?? 'task') &&
			item.source.path === expected.source.path &&
			item.source.hash === expected.source.hash &&
			item.parentId === expected.parentId &&
			actualDependencies.length === expectedDependencies.length &&
			actualDependencies.every((dependency, index) => dependency === expectedDependencies[index]) &&
			actualRoles.length === expectedRoles.length &&
			actualRoles.every((role, index) => role === expectedRoles[index]) &&
			actualEvidenceRequirements.length === expectedEvidenceRequirements.length &&
			actualEvidenceRequirements.every(
				(requirement, index) => requirement === expectedEvidenceRequirements[index],
			)
			? { ok: true, value: undefined }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'Work definition changed; rerun synchronization before retrying.',
					},
				}
	}

	#verifyDefinitionClosure(
		items: ReadonlyMap<string, LedgerItem>,
		expected: readonly LedgerDependencyExpectation[],
	): WorkResult<void> {
		for (const expectation of expected) {
			const item = items.get(expectation.workId)
			if (item === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'Required work definition changed; rerun synchronization before retrying.',
					},
				}
			}
			const definition = this.#verifyExpectedDefinition(item, expectation)
			if (!definition.ok) {
				return definition
			}
		}
		return { ok: true, value: undefined }
	}

	#invalidateListProjection(): void {
		this.#hasAuthoritativeListProjection = false
		this.#providerIds.clear()
	}

	#validateProjectionItem(item: LedgerItem): WorkResult<void> {
		return serializedBytes(item) <= providerItemProjectionBytes
			? { ok: true, value: undefined }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'provider_capacity_exceeded',
						message: 'The requested work state exceeds the supported item projection budget.',
					},
				}
	}

	#definitionProjectionItem(input: LedgerDefinitionInput): LedgerItem {
		return {
			definitionSchemaVersion: input.definitionRevision === undefined ? 2 : 3,
			providerId: deterministicProviderId(input.projectId, input.artifact.id),
			projectId: input.projectId,
			workId: input.artifact.id,
			title: input.artifact.title,
			kind: input.artifact.kind,
			execution: input.artifact.execution,
			status: 'open',
			parentId: undefined,
			dependencies: [],
			roles: input.artifact.roles,
			evidenceRequirements: input.artifact.evidenceRequirements,
			source: input.artifact.source,
			graphFingerprint: input.graphFingerprint,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
			assignee: undefined,
			activity: undefined,
			handoff: undefined,
			evidence: [],
			blockReason: undefined,
			updatedAt: new Date(0).toISOString(),
		}
	}

	#isKnownRelationAcknowledgement(source: string, expected: LedgerItem): WorkResult<void> {
		const parsed = this.#parseRecords(source)
		if (!parsed.ok || parsed.value.length !== 1) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads returned an unsupported relation acknowledgement.',
				},
			}
		}
		const acknowledgement = parsed.value[0]
		if (acknowledgement === undefined || acknowledgement.dependencies !== undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads returned an unsupported relation acknowledgement.',
				},
			}
		}
		const normalized = normalizeRecord(acknowledgement)
		if (
			!normalized.ok ||
			normalized.value === undefined ||
			normalized.value.providerId !== expected.providerId ||
			normalized.value.projectId !== expected.projectId ||
			normalized.value.workId !== expected.workId ||
			normalized.value.title !== expected.title ||
			normalized.value.kind !== expected.kind ||
			normalized.value.status !== expected.status ||
			normalized.value.assignee !== expected.assignee ||
			normalized.value.source.path !== expected.source.path ||
			normalized.value.source.hash !== expected.source.hash ||
			normalized.value.graphFingerprint !== expected.graphFingerprint ||
			!sameActivity(normalized.value.activity, expected.activity) ||
			!sameEvidence(normalized.value.evidence, expected.evidence) ||
			!sameHandoff(normalized.value.handoff, expected.handoff) ||
			JSON.stringify(normalized.value.roles.toSorted()) !==
				JSON.stringify(expected.roles.toSorted()) ||
			JSON.stringify(normalized.value.evidenceRequirements.toSorted()) !==
				JSON.stringify(expected.evidenceRequirements.toSorted()) ||
			normalized.value.blockReason !== expected.blockReason
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads returned an unsupported relation acknowledgement.',
				},
			}
		}
		return { ok: true, value: undefined }
	}

	#confirmArchivedMarker(source: string, workId: string): WorkResult<void> {
		const parsed = this.#parseRecords(source)
		const metadata =
			parsed.ok && parsed.value.length === 1 ? parsed.value[0]?.metadata?.work_contract : undefined
		if (
			metadata?.project_id === this.#projectId &&
			metadata.work_id === workId &&
			metadata.archived === true
		) {
			return { ok: true, value: undefined }
		}
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_mutation_failed',
				message: 'Beads archive response did not confirm the requested postcondition.',
				details: [
					'operation=archive',
					'stateMayHaveChanged=true',
					'recovery=inspect provider state and reconcile before retrying',
					...(parsed.ok ? [] : [`providerCode=${parsed.error.code}`]),
				],
			},
		}
	}

	async #find(
		workId: string,
		relatedWorkIds: readonly string[] = [],
		expectedDefinitionClosure: readonly LedgerDependencyExpectation[] = [],
	): Promise<WorkResult<LedgerItem>> {
		const listed = await this.list()
		if (!listed.ok) {
			return listed
		}
		const items = new Map(listed.value.map((item) => [item.workId, item]))
		const closure = this.#verifyDefinitionClosure(items, expectedDefinitionClosure)
		if (!closure.ok) {
			return closure
		}
		const item = items.get(workId)
		if (item !== undefined) {
			return { ok: true, value: item }
		}
		if (relatedWorkIds.length > 0) {
			const candidates = this.#listLegacyDefinitions([workId, ...relatedWorkIds], [workId])
			if (!candidates.ok) {
				return candidates
			}
			const candidate = candidates.value.find((value) => value.workId === workId)
			return candidate === undefined
				? {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'work_not_found',
							message: 'Unknown work item.',
						},
					}
				: { ok: true, value: candidate }
		}
		return this.#findLegacy(workId)
	}

	#findLegacy(workId: string): WorkResult<LedgerItem> {
		const providerId = deterministicProviderId(this.#projectId, workId)
		const shown = this.#run(['show', providerId], true, undefined, true)
		if (!shown.ok) {
			return shown
		}
		const parsed = this.#parseRecords(shown.value)
		if (parsed.ok && parsed.value.length === 0) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'work_not_found',
					message: 'Unknown work item.',
				},
			}
		}
		if (!parsed.ok || parsed.value.length !== 1) {
			return parsed.ok
				? {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_ledger_projection',
							message: 'Legacy Beads lookup returned an ambiguous record.',
						},
					}
				: parsed
		}
		const record = parsed.value[0]
		if (
			record === undefined ||
			record.id !== providerId ||
			record.metadata?.work_contract?.project_id !== this.#projectId ||
			record.metadata.work_contract.work_id !== workId
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: 'Legacy Beads lookup returned an unexpected record.',
				},
			}
		}
		const normalized = normalizeRecord(record)
		if (!normalized.ok || normalized.value === undefined) {
			return normalized.ok
				? {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_ledger_projection',
							message: 'Legacy Beads lookup omitted owned metadata.',
						},
					}
				: normalized
		}
		const capacity = this.#validateProjectionItem(normalized.value)
		return capacity.ok ? { ok: true, value: normalized.value } : capacity
	}

	async #findReady(
		workId: string,
		expected: LedgerDefinitionExpectation,
		expectedDependencies: readonly LedgerDependencyExpectation[],
		expectedDefinitionClosure: readonly LedgerDependencyExpectation[],
		expectedChildren: readonly LedgerDependencyExpectation[] = [],
	): Promise<WorkResult<LedgerItem>> {
		const listed = await this.list()
		if (!listed.ok) {
			return listed
		}
		const items = new Map(listed.value.map((item) => [item.workId, item]))
		let readyItem = items.get(workId)
		if (readyItem === undefined) {
			const legacyCandidateIds = [
				workId,
				expected.parentId,
				...expected.dependencies,
				...expectedDependencies.flatMap((dependency) => [
					dependency.workId,
					dependency.parentId,
					...dependency.dependencies,
				]),
				...expectedDefinitionClosure.flatMap((definition) => [
					definition.workId,
					definition.parentId,
					...definition.dependencies,
				]),
			].filter((value): value is string => value !== undefined)
			const legacy = this.#listLegacyDefinitions(legacyCandidateIds, [
				workId,
				...expectedDependencies.map(({ workId: dependencyId }) => dependencyId),
				...expectedDefinitionClosure.map(({ workId: definitionId }) => definitionId),
			])
			if (!legacy.ok) {
				return legacy
			}
			for (const legacyItem of legacy.value) {
				items.set(legacyItem.workId, legacyItem)
			}
			readyItem = items.get(workId)
			if (readyItem === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'work_not_found',
						message: 'Unknown work item.',
					},
				}
			}
		}
		const closure = this.#verifyDefinitionClosure(items, expectedDefinitionClosure)
		if (!closure.ok) {
			return closure
		}
		const definition = this.#verifyExpectedDefinition(readyItem, expected)
		if (!definition.ok) {
			return definition
		}
		const dependencyIds = expectedDependencies
			.map(({ workId: dependencyId }) => dependencyId)
			.toSorted()
		const definitionDependencyIds = expected.dependencies.toSorted()
		if (
			dependencyIds.length !== definitionDependencyIds.length ||
			!dependencyIds.every((dependencyId, index) => dependencyId === definitionDependencyIds[index])
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ledger_not_synchronized',
					message: 'Work definition changed; rerun synchronization before retrying.',
				},
			}
		}
		for (const dependencyExpectation of expectedDependencies) {
			const dependency = items.get(dependencyExpectation.workId)
			if (dependency === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'Work definition changed; rerun synchronization before retrying.',
					},
				}
			}
			const dependencyDefinition = this.#verifyExpectedDefinition(dependency, dependencyExpectation)
			if (!dependencyDefinition.ok) {
				return dependencyDefinition
			}
			const evidenceKinds = new Set(dependency.evidence.map(({ kind }) => kind))
			if (
				dependency.status !== 'closed' ||
				dependencyExpectation.evidenceRequirements.some((kind) => !evidenceKinds.has(kind))
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'work_not_ready',
						message: 'A dependency is incomplete.',
					},
				}
			}
		}
		if (expected.execution !== 'aggregate') {
			return { ok: true, value: readyItem }
		}
		const actualChildIds = [...items.values()]
			.filter(({ parentId, status }) => parentId === workId && status !== 'archived')
			.map(({ workId: childId }) => childId)
			.toSorted()
		const expectedChildIds = expectedChildren.map(({ workId: childId }) => childId).toSorted()
		if (
			actualChildIds.length !== expectedChildIds.length ||
			!actualChildIds.every((childId, index) => childId === expectedChildIds[index])
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ledger_not_synchronized',
					message: 'Aggregate child relations changed; rerun synchronization.',
				},
			}
		}
		for (const childExpectation of expectedChildren) {
			const child = items.get(childExpectation.workId)
			if (child === undefined) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'Required aggregate child is missing.',
					},
				}
			}
			const childDefinition = this.#verifyExpectedDefinition(child, childExpectation)
			if (!childDefinition.ok) {
				return childDefinition
			}
			const evidenceKinds = new Set(child.evidence.map(({ kind }) => kind))
			if (
				child.status !== 'closed' ||
				childExpectation.evidenceRequirements.some((kind) => !evidenceKinds.has(kind))
			) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'aggregate_not_ready',
						message: 'A required aggregate child is incomplete.',
					},
				}
			}
		}
		return { ok: true, value: readyItem }
	}

	#parseRecords(source: string): WorkResult<readonly BeadsRecord[]> {
		let document: unknown
		try {
			document = JSON.parse(source)
		} catch {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_beads_json',
					message: 'Beads returned malformed JSON.',
				},
			}
		}
		const candidate = Array.isArray(document) ? document : [document]
		if (candidate.length > providerProjectItems + 1) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'beads_item_limit_exceeded',
					message: 'Beads returned too many records for one bounded operation.',
				},
			}
		}
		const parsed = safeParse(BeadsRecordsSchema, candidate)
		return parsed.success
			? { ok: true, value: parsed.output }
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_beads_record',
						message: 'Beads returned data outside the supported JSON contract.',
					},
				}
	}

	#run(
		args: readonly string[],
		decorate = true,
		stdin?: string,
		allowMissingShow = false,
		outputLimitOverride?: number,
	): WorkResult<string> {
		const phase = mutationCommands.has(args[0] ?? 'unknown') ? 'provider_mutation' : 'provider_read'
		return measureCommandPhaseSync(phase, () =>
			this.#runUnprofiled(args, decorate, stdin, allowMissingShow, outputLimitOverride),
		)
	}

	// oxlint-disable-next-line eslint/complexity, eslint/max-lines-per-function -- One subprocess boundary owns classification, redaction, timeout, and cleanup.
	#runUnprofiled(
		args: readonly string[],
		decorate = true,
		stdin?: string,
		allowMissingShow = false,
		outputLimitOverride?: number,
	): WorkResult<string> {
		const operation = args[0] ?? 'unknown'
		const isMutation = mutationCommands.has(operation)
		const outputLimitBytes =
			outputLimitOverride ??
			(operation === 'list' ? providerListOutputLimitBytes : providerCommandOutputLimitBytes)
		const transportedArgs = [...args]
		let metadataDirectory: string | undefined
		let metadataCleanupFailed = false
		const metadataIndex = transportedArgs.indexOf('--metadata')
		const metadata = metadataIndex === -1 ? undefined : transportedArgs[metadataIndex + 1]
		if (
			metadata !== undefined &&
			Buffer.byteLength(metadata, 'utf8') > inlineMetadataTransportBytes
		) {
			try {
				metadataDirectory = mkdtempSync(join(tmpdir(), 'work-contract-metadata-'))
				const metadataPath = join(metadataDirectory, 'metadata.json')
				writeFileSync(metadataPath, metadata, {
					encoding: 'utf8',
					flag: 'wx',
					mode: 0o600,
				})
				transportedArgs[metadataIndex + 1] = `@${metadataPath}`
			} catch {
				if (metadataDirectory !== undefined) {
					try {
						rmSync(metadataDirectory, { force: true, recursive: true })
					} catch {
						metadataCleanupFailed = true
					}
				}
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'provider_failed',
						message: 'Unable to prepare bounded provider metadata transport.',
						...(metadataCleanupFailed ? { details: ['Temporary metadata cleanup failed.'] } : {}),
					},
				}
			}
		}
		const commandArgs = decorate
			? [
					...transportedArgs,
					...(isMutation ? [] : ['--readonly']),
					'--json',
					'--directory',
					this.#coordinationRoot,
				]
			: transportedArgs
		let result: SpawnSyncReturns<Buffer> | undefined
		try {
			result = spawnSync(this.#binary, commandArgs, {
				cwd: this.#root,
				env: {
					...providerSubprocessEnvironment(),
					BEADS_ACTOR: this.#actor,
					BEADS_DIR: this.#stateDirectory,
				},
				maxBuffer: outputLimitBytes,
				...(stdin === undefined ? {} : { input: stdin }),
				timeout: 60_000,
			})
		} catch {
			// Classified below without retaining the raw runtime exception.
		} finally {
			if (metadataDirectory !== undefined) {
				try {
					rmSync(metadataDirectory, { force: true, recursive: true })
				} catch {
					metadataCleanupFailed = true
				}
			}
		}
		if (result === undefined) {
			return isMutation
				? {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'provider_mutation_failed',
							message: 'Beads mutation process could not start; provider state is uncertain.',
							details: [
								`operation=${operation}`,
								'stateMayHaveChanged=true',
								'failureKind=spawn_exception',
								...(metadataCleanupFailed
									? ['cleanupFailure=temporary_metadata_cleanup_failed']
									: []),
								'recovery=inspect provider state and reconcile before retrying',
							],
						},
					}
				: {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'beads_unavailable',
							message: 'Beads process could not start.',
							...(metadataCleanupFailed ? { details: ['Temporary metadata cleanup failed.'] } : {}),
						},
					}
		}
		let decodedStdout: string
		let decodedStderr: string
		try {
			const decoder = new TextDecoder('utf-8', { fatal: true })
			decodedStdout = decoder.decode(result.stdout ?? Buffer.alloc(0))
			decodedStderr = decoder.decode(result.stderr ?? Buffer.alloc(0))
		} catch {
			return isMutation
				? {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'provider_mutation_failed',
							message: 'Beads mutation returned invalid UTF-8; provider state is uncertain.',
							details: [
								`operation=${operation}`,
								'stateMayHaveChanged=true',
								'failureKind=invalid_utf8',
								'recovery=inspect provider state and reconcile before retrying',
							],
						},
					}
				: {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_beads_json',
							message: 'Beads returned output that is not valid UTF-8.',
						},
					}
		}
		const output: CommandOutput = {
			status: result.status,
			stdout: decodedStdout,
			stderr: decodedStderr,
			...(result.error === undefined ? {} : { error: result.error }),
		}
		const preserveCleanupFailure = <T>(primary: WorkResult<T>): WorkResult<T> =>
			metadataCleanupFailed && !primary.ok
				? {
						ok: false,
						error: {
							...primary.error,
							details: [
								...(primary.error.details ?? []).slice(0, 16),
								'cleanupFailure=temporary_metadata_cleanup_failed',
								'recovery=preserve the primary provider error and remove the private temporary metadata directory',
							],
						},
					}
				: primary
		const processErrorCode =
			result.error !== undefined && 'code' in result.error && typeof result.error.code === 'string'
				? result.error.code
				: undefined
		const processNeverStarted = processErrorCode === 'ENOENT'
		const unavailable =
			processNeverStarted ||
			[output.stderr, output.stdout]
				.filter((value): value is string => typeof value === 'string')
				.some((value) =>
					/bd binary not found|command not found/i.test(
						value.slice(0, diagnosticClassificationLimit),
					),
				)
		const didEndAbnormally =
			!processNeverStarted &&
			(result.status === null ||
				result.signal !== null ||
				processErrorCode === 'ETIMEDOUT' ||
				processErrorCode === 'ENOBUFS')
		if (metadataCleanupFailed && result.status === 0) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message:
						'Beads mutation completed but temporary metadata cleanup failed; provider state changed.',
					details: [
						`operation=${operation}`,
						'stateMayHaveChanged=true',
						'cleanupFailure=temporary_metadata_cleanup_failed',
						'recovery=inspect provider state and remove the private temporary metadata directory',
					],
				},
			}
		}
		if (isMutation && didEndAbnormally) {
			return preserveCleanupFailure({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads mutation process ended abnormally; provider state is uncertain.',
					details: [
						`operation=${operation}`,
						'stateMayHaveChanged=true',
						'failureKind=abnormal_process_exit',
						'recovery=inspect provider state and reconcile before retrying',
					],
				},
			})
		}
		if (
			operation === 'update' &&
			args.includes('--claim') &&
			result.status !== 0 &&
			indicatesOwnershipConflict(output)
		) {
			return preserveCleanupFailure({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ownership_conflict',
					message: 'Beads rejected the mutation because the item is already claimed.',
				},
			})
		}
		if (isMutation && !processNeverStarted && result.status !== 0) {
			return preserveCleanupFailure({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'provider_mutation_failed',
					message: 'Beads mutation failed after launch; provider state is uncertain.',
					details: [
						`operation=${operation}`,
						'stateMayHaveChanged=true',
						'failureKind=nonzero_exit',
						'recovery=inspect provider state and reconcile before retrying',
					],
				},
			})
		}
		const stdout = decodedStdout
		if (allowMissingShow && operation === 'show' && result.status === 1) {
			try {
				const missing = JSON.parse(stdout) as unknown
				if (
					typeof missing === 'object' &&
					missing !== null &&
					'error' in missing &&
					missing.error === 'no issues found matching the provided IDs' &&
					'schema_version' in missing &&
					missing.schema_version === 1
				) {
					return { ok: true, value: '[]' }
				}
			} catch {
				// Fall through to the normal bounded provider error.
			}
		}
		if (result.status === 0 && Buffer.byteLength(stdout, 'utf8') > outputLimitBytes) {
			return preserveCleanupFailure(
				isMutation
					? {
							ok: false,
							error: {
								type: 'work_contract_error',
								code: 'provider_mutation_failed',
								message:
									'Beads mutation output exceeded its supported bound; provider state is uncertain.',
								details: [
									`operation=${operation}`,
									'stateMayHaveChanged=true',
									'failureKind=oversized_output',
									'recovery=inspect provider state and reconcile before retrying',
								],
							},
						}
					: {
							ok: false,
							error: {
								type: 'work_contract_error',
								code: 'beads_command_failed',
								message: 'Beads command output exceeded its supported bound.',
							},
						},
			)
		}
		return preserveCleanupFailure(
			result.status === 0
				? { ok: true, value: stdout.trim() }
				: {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: unavailable ? 'beads_unavailable' : 'beads_command_failed',
							message: unavailable ? 'Beads executable is unavailable.' : 'Beads command failed.',
							details: [
								`exitCode=${String(result.status)}`,
								...(unavailable
									? [
											'Install a supported bd binary or run the package checksum-verifying provider installer.',
										]
									: []),
							],
						},
					},
		)
	}
}

/** @description Creates a project-bound fail-closed adapter for the pinned Beads CLI contract. */
export const createBeadsProvider = (input: {
	readonly root: string
	readonly projectId: string
	readonly binary?: string
	readonly actor?: string
	readonly stateDirectory?: string
	readonly coordinationRoot?: string
}): BeadsProvider => {
	const parsed = safeParse(CreateBeadsProviderInputSchema, input)
	if (!parsed.success) {
		throw new InvalidBeadsProviderInputError(
			parsed.issues.map(
				({ message, path }) =>
					`${path?.map(({ key }) => String(key)).join('.') ?? 'input'}: ${message}`,
			),
		)
	}
	return new BeadsCliProvider({
		root: parsed.output.root,
		stateDirectory: resolve(parsed.output.root, parsed.output.stateDirectory ?? '.beads'),
		coordinationRoot: resolve(parsed.output.coordinationRoot ?? parsed.output.root),
		projectId: parsed.output.projectId,
		binary: parsed.output.binary ?? resolveDefaultBeadsBinary(),
		actor: parsed.output.actor ?? 'work-contract',
	})
}
