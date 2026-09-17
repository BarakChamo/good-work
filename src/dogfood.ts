/**
 * @description Persists bounded local dogfood feedback and default-on sanitized command telemetry.
 *
 * @module work/dogfood
 * @file Dogfood.ts
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, rm, rmdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { kill as signalProcess } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import {
	array,
	boolean,
	check,
	isoTimestamp,
	literal,
	maxLength,
	maxValue,
	minValue,
	number,
	optional,
	picklist,
	pipe,
	regex,
	safeInteger,
	safeParse,
	strictObject,
	string,
	uuid,
} from 'valibot'
import type { InferOutput } from 'valibot'

import type { WorkResult } from './contracts'
import { COMMAND_PROFILE_PHASES } from './command-profile'
import type { CommandPhaseMeasurement } from './command-profile'
import type { WorkContractInvocation } from './cli-program'
import { readBoundedUtf8, writeUtf8NoFollow } from './files'
import { prepareSafeOutputPath } from './paths'

export { withCommandPerformanceProfile } from './command-profile'

const FEEDBACK_MESSAGE_MAX_BYTES = 2000
const TELEMETRY_CONFIG_MAX_BYTES = 4096
const TELEMETRY_FILE_MAX_BYTES = 5_000_000
const TELEMETRY_EVENT_MAX_BYTES = 2000
const TELEMETRY_EVENT_MAX_COUNT = 10_000
const TELEMETRY_SHOW_MAX_EVENTS = 500
const TELEMETRY_SESSION_MAX_COUNT = 500
const TELEMETRY_CONFIG_PATH = '.work/telemetry/config.json'
const TELEMETRY_EVENTS_PATH = '.work/telemetry/events.jsonl'
const TELEMETRY_IGNORE_PATH = '.work/telemetry/.gitignore'
const TELEMETRY_LOCK_BOUNDARY_PATH = '.work/telemetry/.write-lock-boundary'
const TELEMETRY_LOCK_OWNER_PATH = '.work/telemetry/write.lock/owner.json'
const TELEMETRY_LOCK_MAX_BYTES = 512
const TELEMETRY_LOCK_WAIT_MS = 2000
const TELEMETRY_LOCK_RETRY_MS = 10
const TELEMETRY_COMMANDS = [
	'cli',
	'overview',
	'init',
	'doctor',
	'compile',
	'sync',
	'drift',
	'dashboard',
	'prepare',
	'status',
	'start',
	'submit',
	'finalize',
	'reconcile',
	'review.status',
	'review.prepare',
	'review.approve',
	'review.request-changes',
	'integration.status',
	'integration.acquire',
	'integration.release',
	'integration.recover',
	'export',
	'graph',
	'ready',
	'active',
	'show',
	'context',
	'claim',
	'touch',
	'resume',
	'handoff',
	'block',
	'release',
	'reopen',
	'complete',
	'rollup',
	'proposal.validate',
	'proposal.apply',
	'snapshot',
	'skill.install',
	'feedback',
	'telemetry.enable',
	'telemetry.disable',
	'telemetry.show',
	'telemetry.sessions',
	'hooks.init',
	'hooks.inspect',
	'hooks.trust',
	'hooks.untrust',
	'hooks.status',
	'hooks.dispatch',
] as const

const phasesAreCanonical = (phases: CommandPhaseMeasurement[]): boolean =>
	phases.every(({ phase }, index) => {
		const previous = phases[index - 1]
		return (
			previous === undefined ||
			COMMAND_PROFILE_PHASES.indexOf(previous.phase) < COMMAND_PROFILE_PHASES.indexOf(phase)
		)
	})

const CommandPhaseMeasurementSchema = strictObject({
	phase: picklist(COMMAND_PROFILE_PHASES),
	count: pipe(number(), safeInteger(), minValue(1), maxValue(10_000)),
	durationMs: pipe(number(), safeInteger(), minValue(0), maxValue(86_400_000)),
})

const CommandPhasesSchema = pipe(
	array(CommandPhaseMeasurementSchema),
	maxLength(COMMAND_PROFILE_PHASES.length),
	check(phasesAreCanonical, 'Performance phases must be unique and canonical.'),
)

const FeedbackInputSchema = strictObject({
	kind: picklist(['bug', 'friction', 'idea', 'docs', 'other']),
	message: string(),
	workId: optional(string()),
	actor: optional(string()),
	sessionId: optional(string()),
})

const TelemetryConfigSchema = strictObject({
	schemaVersion: literal(1),
	enabled: boolean(),
	correlationSalt: pipe(string(), regex(/^[a-f0-9]{64}$/)),
})

const TelemetryLockOwnerSchema = strictObject({
	pid: pipe(number(), safeInteger(), minValue(1), maxValue(2_147_483_647)),
	startedAt: pipe(string(), maxLength(40), isoTimestamp()),
	nonce: pipe(string(), uuid()),
})

const TelemetryEventSchema = strictObject({
	schemaVersion: literal(1),
	eventId: pipe(string(), uuid()),
	occurredAt: pipe(string(), maxLength(40), isoTimestamp()),
	command: picklist(TELEMETRY_COMMANDS),
	outcome: picklist(['success', 'attention', 'failure']),
	exitCode: pipe(number(), safeInteger(), minValue(0), maxValue(255)),
	durationMs: pipe(number(), safeInteger(), minValue(0), maxValue(86_400_000)),
	workCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	actorCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	roleCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	sessionCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	contextMaxBytes: optional(pipe(number(), safeInteger(), minValue(1), maxValue(5_000_000))),
	failureStage: optional(picklist(['routing', 'arguments'])),
	runCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	phases: optional(CommandPhasesSchema),
	unattributedMs: optional(pipe(number(), safeInteger(), minValue(0), maxValue(86_400_000))),
	hookEvent: optional(picklist(['sessionStart', 'afterEdit', 'beforeStop', 'sessionEnd'])),
	hookEntryCorrelation: optional(pipe(string(), regex(/^[a-f0-9]{64}$/))),
	hookOutcome: optional(picklist(['success', 'failure', 'timeout', 'skipped'])),
	hookOutputMode: optional(picklist(['silent', 'passthrough', 'summarize'])),
	hookSkipReason: optional(
		picklist(['runtime', 'session_source', 'changed_files', 'unrecognized_edit']),
	),
})

type FeedbackKind = 'bug' | 'friction' | 'idea' | 'docs' | 'other'

export interface FeedbackRecord {
	readonly schemaVersion: 1
	readonly id: string
	readonly createdAt: string
	readonly kind: FeedbackKind
	readonly message: string
	readonly workId?: string
	readonly actor?: string
	readonly sessionId?: string
}

export interface CommandTelemetryEvent {
	readonly schemaVersion: 1
	readonly eventId: string
	readonly occurredAt: string
	readonly command: string
	readonly outcome: 'success' | 'attention' | 'failure'
	readonly exitCode: number
	readonly durationMs: number
	readonly workCorrelation?: string
	readonly actorCorrelation?: string
	readonly roleCorrelation?: string
	readonly sessionCorrelation?: string
	readonly contextMaxBytes?: number
	readonly failureStage?: 'routing' | 'arguments'
	readonly runCorrelation?: string
	readonly phases?: readonly CommandPhaseMeasurement[]
	readonly unattributedMs?: number
	readonly hookEvent?: 'sessionStart' | 'afterEdit' | 'beforeStop' | 'sessionEnd'
	readonly hookEntryCorrelation?: string
	readonly hookOutcome?: 'success' | 'failure' | 'timeout' | 'skipped'
	readonly hookOutputMode?: 'silent' | 'passthrough' | 'summarize'
	readonly hookSkipReason?: 'runtime' | 'session_source' | 'changed_files' | 'unrecognized_edit'
}

/** @description Bounded aggregate for one privacy-preserving session correlation. */
export interface CommandTelemetrySession {
	readonly sessionCorrelation: string
	readonly firstOccurredAt: string
	readonly lastOccurredAt: string
	readonly eventCount: number
	readonly durationMs: number
	readonly outcomes: {
		readonly success: number
		readonly attention: number
		readonly failure: number
	}
	readonly commands: readonly { readonly command: string; readonly count: number }[]
}

interface TelemetryConfig {
	readonly schemaVersion: 1
	readonly enabled: boolean
	readonly correlationSalt: string
}

type TelemetryLockOwner = InferOutput<typeof TelemetryLockOwnerSchema>

interface AcquiredTelemetryLock {
	readonly content: string
	readonly ownerPath: string
	readonly path: string
}

const failure = <T>(
	code:
		| 'feedback_write_failed'
		| 'invalid_feedback'
		| 'invalid_telemetry_filter'
		| 'invalid_telemetry_run_id'
		| 'invalid_telemetry_session_id'
		| 'telemetry_limit_exceeded'
		| 'telemetry_read_failed'
		| 'telemetry_write_failed',
	message: string,
): WorkResult<T> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code,
		message,
	},
})

const boundedOptional = (
	value: string | undefined,
	label: string,
): WorkResult<string | undefined> => {
	if (value === undefined) {
		return { ok: true, value: undefined }
	}
	const normalized = value.trim()
	return normalized.length > 0 && Buffer.byteLength(normalized, 'utf8') <= 256
		? { ok: true, value: normalized }
		: failure('invalid_feedback', `${label} must be between 1 and 256 UTF-8 bytes.`)
}

const isAlreadyExistsError = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'EEXIST'

const isProcessAlive = (pid: number): boolean => {
	try {
		signalProcess(pid, 0)
		return true
	} catch (error: unknown) {
		return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
	}
}

const withoutErrorDetails = <T>(result: WorkResult<T>): WorkResult<T> =>
	result.ok
		? result
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: result.error.code,
					message: result.error.message,
				},
			}

/** @description Writes one structured feedback report without requiring manifest or provider access. */
export const writeDogfoodFeedback = async (input: {
	readonly root: string
	readonly kind: string
	readonly message: string
	readonly workId?: string
	readonly actor?: string
	readonly sessionId?: string
}): Promise<WorkResult<{ readonly report: string; readonly record: FeedbackRecord }>> => {
	const parsed = safeParse(FeedbackInputSchema, {
		kind: input.kind,
		message: input.message,
		...(input.workId === undefined ? {} : { workId: input.workId }),
		...(input.actor === undefined ? {} : { actor: input.actor }),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
	})
	if (!parsed.success) {
		return failure('invalid_feedback', 'Feedback input is invalid.')
	}
	const message = parsed.output.message.trim()
	if (message.length === 0 || Buffer.byteLength(message, 'utf8') > FEEDBACK_MESSAGE_MAX_BYTES) {
		return failure(
			'invalid_feedback',
			`Feedback message must be between 1 and ${FEEDBACK_MESSAGE_MAX_BYTES} UTF-8 bytes.`,
		)
	}
	const workId = boundedOptional(parsed.output.workId, 'Work ID')
	const actor = boundedOptional(parsed.output.actor, 'Actor')
	const sessionId = boundedOptional(parsed.output.sessionId, 'Session ID')
	const invalid = [workId, actor, sessionId].find((result) => !result.ok)
	if (invalid !== undefined && !invalid.ok) {
		return invalid
	}
	const createdAt = new Date().toISOString()
	const id = randomUUID()
	const record: FeedbackRecord = {
		schemaVersion: 1,
		id,
		createdAt,
		kind: parsed.output.kind,
		message,
		...(workId.ok && workId.value !== undefined ? { workId: workId.value } : {}),
		...(actor.ok && actor.value !== undefined ? { actor: actor.value } : {}),
		...(sessionId.ok && sessionId.value !== undefined ? { sessionId: sessionId.value } : {}),
	}
	const report = `.work/feedback/${createdAt.replaceAll(':', '-')}-${id}.json`
	const target = await prepareSafeOutputPath({
		root: input.root,
		path: report,
		errorCode: 'unsafe_feedback_path',
	})
	if (!target.ok) {
		return withoutErrorDetails(target)
	}
	try {
		await writeUtf8NoFollow({
			path: target.value,
			content: `${JSON.stringify(record, null, 2)}\n`,
			mode: 'exclusive',
		})
		return { ok: true, value: { report, record } }
	} catch {
		return failure('feedback_write_failed', 'Unable to persist dogfood feedback.')
	}
}

const telemetryPath = async (
	root: string,
	path: string,
	createParents: boolean,
): Promise<WorkResult<string>> =>
	withoutErrorDetails(
		await prepareSafeOutputPath({
			root,
			path,
			errorCode: 'unsafe_telemetry_path',
			createParents,
		}),
	)

const readTelemetryConfig = async (
	root: string,
): Promise<WorkResult<TelemetryConfig | undefined>> => {
	const target = await telemetryPath(root, TELEMETRY_CONFIG_PATH, false)
	if (!target.ok) {
		return target
	}
	const source = await readBoundedUtf8({
		path: target.value,
		maxBytes: TELEMETRY_CONFIG_MAX_BYTES,
		unavailableCode: 'telemetry_read_failed',
		tooLargeCode: 'telemetry_limit_exceeded',
		label: 'Telemetry configuration',
	})
	if (!source.ok) {
		return source.error.details?.some((detail) => detail.includes('ENOENT'))
			? { ok: true, value: undefined }
			: failure(
					source.error.code === 'telemetry_limit_exceeded'
						? 'telemetry_limit_exceeded'
						: 'telemetry_read_failed',
					source.error.message,
				)
	}
	let document: unknown
	try {
		document = JSON.parse(source.value)
	} catch {
		return failure('telemetry_read_failed', 'Telemetry configuration is not valid JSON.')
	}
	const parsed = safeParse(TelemetryConfigSchema, document)
	return parsed.success
		? { ok: true, value: parsed.output }
		: failure('telemetry_read_failed', 'Telemetry configuration schema validation failed.')
}

const ensureTelemetryIsIgnored = async (root: string): Promise<WorkResult<void>> => {
	const target = await telemetryPath(root, TELEMETRY_IGNORE_PATH, true)
	if (!target.ok) {
		return target
	}
	try {
		await writeUtf8NoFollow({ path: target.value, content: '*\n', mode: 'replace' })
		return { ok: true, value: undefined }
	} catch {
		return failure('telemetry_write_failed', 'Unable to protect telemetry from Git tracking.')
	}
}

const materializeDefaultTelemetryConfig = async (
	root: string,
): Promise<WorkResult<TelemetryConfig>> => {
	const ignored = await ensureTelemetryIsIgnored(root)
	if (!ignored.ok) {
		return ignored
	}
	const target = await telemetryPath(root, TELEMETRY_CONFIG_PATH, true)
	if (!target.ok) {
		return target
	}
	const config: TelemetryConfig = {
		schemaVersion: 1,
		enabled: true,
		correlationSalt: randomBytes(32).toString('hex'),
	}
	try {
		await writeUtf8NoFollow({
			path: target.value,
			content: `${JSON.stringify(config, null, 2)}\n`,
			mode: 'replace',
		})
		return { ok: true, value: config }
	} catch {
		return failure('telemetry_write_failed', 'Unable to initialize telemetry configuration.')
	}
}

const readTelemetryLockFile = async (path: string): Promise<WorkResult<string>> =>
	readBoundedUtf8({
		path,
		maxBytes: TELEMETRY_LOCK_MAX_BYTES,
		unavailableCode: 'telemetry_write_failed',
		tooLargeCode: 'telemetry_write_failed',
		label: 'Telemetry lock',
	})

const readTelemetryLock = async (root: string): Promise<WorkResult<string>> => {
	const ownerPath = await telemetryPath(root, TELEMETRY_LOCK_OWNER_PATH, false)
	if (!ownerPath.ok) {
		return ownerPath
	}
	return readTelemetryLockFile(ownerPath.value)
}

const removeOwnedTelemetryLock = async (
	root: string,
	lockPath: string,
	ownerPath: string,
	expectedContent: string,
): Promise<boolean> => {
	const observed = await readTelemetryLock(root)
	if (!observed.ok || observed.value !== expectedContent) {
		return false
	}
	let expectedOwner: unknown
	try {
		expectedOwner = JSON.parse(expectedContent)
	} catch {
		return false
	}
	const parsedOwner = safeParse(TelemetryLockOwnerSchema, expectedOwner)
	if (!parsedOwner.success) {
		return false
	}
	const claimPath = resolve(lockPath, `.owner-${parsedOwner.output.nonce}.claim`)
	try {
		await link(ownerPath, claimPath)
		const [authoritative, claim, claimed] = await Promise.all([
			lstat(ownerPath),
			lstat(claimPath),
			readTelemetryLockFile(claimPath),
		])
		if (
			authoritative.dev !== claim.dev ||
			authoritative.ino !== claim.ino ||
			!claimed.ok ||
			claimed.value !== expectedContent
		) {
			await rm(claimPath).catch(() => false)
			return false
		}
		await rm(ownerPath)
		await rm(claimPath)
		await rmdir(lockPath)
		return true
	} catch {
		return false
	}
}

const recoverDeadTelemetryLock = async (
	root: string,
	lockPath: string,
	ownerPath: string,
): Promise<boolean> => {
	const observed = await readTelemetryLock(root)
	if (!observed.ok) {
		return false
	}
	let document: unknown
	try {
		document = JSON.parse(observed.value)
	} catch {
		return false
	}
	const parsed = safeParse(TelemetryLockOwnerSchema, document)
	if (!parsed.success || isProcessAlive(parsed.output.pid)) {
		return false
	}
	return removeOwnedTelemetryLock(root, lockPath, ownerPath, observed.value)
}

const acquireTelemetryLock = async (
	root: string,
	waitMs = TELEMETRY_LOCK_WAIT_MS,
): Promise<WorkResult<AcquiredTelemetryLock>> => {
	const boundary = await telemetryPath(root, TELEMETRY_LOCK_BOUNDARY_PATH, true)
	if (!boundary.ok) {
		return boundary
	}
	const lockPath = resolve(dirname(boundary.value), 'write.lock')
	const ownerPath = resolve(lockPath, 'owner.json')
	const owner: TelemetryLockOwner = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		nonce: randomUUID(),
	}
	const content = `${JSON.stringify(owner)}\n`
	const deadline = Date.now() + Math.max(0, Math.min(TELEMETRY_LOCK_WAIT_MS, waitMs))
	while (true) {
		try {
			await mkdir(lockPath, { mode: 0o700 })
			try {
				await writeUtf8NoFollow({ path: ownerPath, content, mode: 'exclusive' })
			} catch {
				await removeOwnedTelemetryLock(root, lockPath, ownerPath, content)
				await rmdir(lockPath).catch(() => false)
				return failure('telemetry_write_failed', 'Unable to establish the telemetry lock.')
			}
			return { ok: true, value: { content, ownerPath, path: lockPath } }
		} catch (error: unknown) {
			if (!isAlreadyExistsError(error)) {
				return failure(
					'telemetry_write_failed',
					'Another telemetry operation remained active past the bounded wait.',
				)
			}
			if (await recoverDeadTelemetryLock(root, lockPath, ownerPath)) {
				continue
			}
			if (Date.now() >= deadline) {
				return failure(
					'telemetry_write_failed',
					'Another telemetry operation remained active past the bounded wait.',
				)
			}
			await delay(TELEMETRY_LOCK_RETRY_MS)
		}
	}
}

const withTelemetryLock = async <T>(
	root: string,
	operation: () => Promise<WorkResult<T>>,
	waitMs?: number,
): Promise<WorkResult<T>> => {
	const acquired = await acquireTelemetryLock(root, waitMs)
	if (!acquired.ok) {
		return acquired
	}
	let result: WorkResult<T>
	try {
		result = await operation()
	} catch {
		result = failure('telemetry_write_failed', 'Telemetry operation failed unexpectedly.')
	}
	const didRemove = await removeOwnedTelemetryLock(
		root,
		acquired.value.path,
		acquired.value.ownerPath,
		acquired.value.content,
	)
	if (!didRemove) {
		if (!result.ok) {
			return {
				ok: false,
				error: {
					...result.error,
					details: [
						...(result.error.details ?? []).slice(0, 16).map((detail) => detail.slice(0, 512)),
						'cleanupFailure=telemetry_lock_release_failed',
					],
				},
			}
		}
		return failure('telemetry_write_failed', 'Telemetry lock could not be released.')
	}
	return result
}

/** @description Explicitly enables or disables local command telemetry for one repository. */
export const setCommandTelemetry = async (input: {
	readonly root: string
	readonly enabled: boolean
}): Promise<WorkResult<{ readonly enabled: boolean; readonly path: string }>> =>
	withTelemetryLock(input.root, async () => {
		const current = await readTelemetryConfig(input.root)
		if (!current.ok) {
			return current
		}
		const ignored = await ensureTelemetryIsIgnored(input.root)
		if (!ignored.ok) {
			return ignored
		}
		const target = await telemetryPath(input.root, TELEMETRY_CONFIG_PATH, true)
		if (!target.ok) {
			return target
		}
		const config: TelemetryConfig = {
			schemaVersion: 1,
			enabled: input.enabled,
			correlationSalt: current.value?.correlationSalt ?? randomBytes(32).toString('hex'),
		}
		try {
			await writeUtf8NoFollow({
				path: target.value,
				content: `${JSON.stringify(config, null, 2)}\n`,
				mode: 'replace',
			})
			return { ok: true, value: { enabled: input.enabled, path: TELEMETRY_EVENTS_PATH } }
		} catch {
			return failure('telemetry_write_failed', 'Unable to update telemetry configuration.')
		}
	})

const canonicalTelemetryCommand = (command: string): (typeof TELEMETRY_COMMANDS)[number] => {
	const canonical = command.trim().split(/\s+/).join('.')
	return TELEMETRY_COMMANDS.find((candidate) => candidate === canonical) ?? 'cli'
}

const nestedCommandName = (
	invocation: WorkContractInvocation,
): (typeof TELEMETRY_COMMANDS)[number] => {
	if (
		invocation.command === 'proposal' ||
		invocation.command === 'skill' ||
		invocation.command === 'telemetry' ||
		invocation.command === 'integration' ||
		invocation.command === 'review' ||
		invocation.command === 'hooks'
	) {
		const action = invocation.positionals[0]
		return canonicalTelemetryCommand(
			action === undefined ? invocation.command : `${invocation.command}.${action}`,
		)
	}
	return canonicalTelemetryCommand(invocation.command)
}

const workIdFor = (invocation: WorkContractInvocation): string | undefined => {
	if (invocation.command === 'feedback') {
		return invocation.options['work-id']?.at(-1)
	}
	if (invocation.command === 'review') {
		return invocation.positionals[1]
	}
	return [
		'prepare',
		'status',
		'start',
		'submit',
		'finalize',
		'reconcile',
		'graph',
		'show',
		'context',
		'rollup',
		'claim',
		'touch',
		'resume',
		'handoff',
		'block',
		'release',
		'reopen',
		'complete',
	].includes(invocation.command)
		? invocation.positionals[0]
		: undefined
}

const telemetryCorrelation = (namespace: 'session' | 'work', value: string, salt: string): string =>
	createHmac('sha256', salt).update(`${namespace}\0${value}`).digest('hex')

const telemetryLookupId = (value: string | undefined): string | undefined => {
	if (value === undefined) {
		return undefined
	}
	return value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256 ? value : undefined
}

const correlateTelemetrySession = (
	sessionId: string | undefined,
	correlationSalt: string,
): WorkResult<string | undefined> => {
	if (sessionId === undefined) {
		return { ok: true, value: undefined }
	}
	return telemetryLookupId(sessionId) === undefined
		? failure(
				'invalid_telemetry_session_id',
				'Telemetry session ID must be between 1 and 256 UTF-8 bytes.',
			)
		: { ok: true, value: telemetryCorrelation('session', sessionId, correlationSalt) }
}

const toTelemetryEvent = (input: {
	readonly invocation: WorkContractInvocation
	readonly exitCode: number
	readonly durationMs: number
	readonly correlationSalt: string
	readonly runId?: string
	readonly sessionId?: string
	readonly phases?: readonly CommandPhaseMeasurement[]
}): WorkResult<CommandTelemetryEvent> => {
	const contextMaxBytes = Number(input.invocation.options['max-bytes']?.at(-1))
	const workId = workIdFor(input.invocation)
	const actor = input.invocation.options.actor?.at(-1)
	const role = input.invocation.options.role?.at(-1)
	const sessionId = input.invocation.options.session?.at(-1) ?? input.sessionId
	const sessionCorrelation = correlateTelemetrySession(sessionId, input.correlationSalt)
	if (!sessionCorrelation.ok) {
		return sessionCorrelation
	}
	const correlate = (namespace: string, value: string): string =>
		createHmac('sha256', input.correlationSalt).update(`${namespace}\0${value}`).digest('hex')
	let outcome: CommandTelemetryEvent['outcome'] = 'failure'
	if (input.exitCode === 0) {
		outcome = 'success'
	} else if (input.exitCode === 2) {
		outcome = 'attention'
	}
	const runCorrelation = correlateRunId(input.runId, input.correlationSalt)
	if (!runCorrelation.ok) {
		return runCorrelation
	}
	const durationMs = Math.max(0, Math.round(input.durationMs))
	const phases = input.phases ?? []
	const attributedMs = phases.reduce((total, phase) => total + phase.durationMs, 0)
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			eventId: randomUUID(),
			occurredAt: new Date().toISOString(),
			command: nestedCommandName(input.invocation),
			outcome,
			exitCode: input.exitCode,
			durationMs,
			...(workId === undefined ? {} : { workCorrelation: correlate('work', workId) }),
			...(actor === undefined ? {} : { actorCorrelation: correlate('actor', actor) }),
			...(role === undefined ? {} : { roleCorrelation: correlate('role', role) }),
			...(sessionCorrelation.value === undefined
				? {}
				: { sessionCorrelation: sessionCorrelation.value }),
			...(Number.isSafeInteger(contextMaxBytes) && contextMaxBytes > 0 ? { contextMaxBytes } : {}),
			...(runCorrelation.value === undefined ? {} : { runCorrelation: runCorrelation.value }),
			...(phases.length === 0
				? {}
				: { phases, unattributedMs: Math.max(0, durationMs - attributedMs) }),
		},
	}
}

const correlateRunId = (
	runId: string | undefined,
	correlationSalt: string,
): WorkResult<string | undefined> => {
	if (runId === undefined) {
		return { ok: true, value: undefined }
	}
	if (
		Buffer.byteLength(runId, 'utf8') > 128 ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)
	) {
		return failure(
			'invalid_telemetry_run_id',
			'WORK_CONTRACT_RUN_ID must be 1-128 safe identifier bytes.',
		)
	}
	return {
		ok: true,
		value: createHmac('sha256', correlationSalt).update(`run\0${runId}`).digest('hex'),
	}
}

const appendTelemetryEvent = async (input: {
	readonly root: string
	readonly build: (correlationSalt: string) => WorkResult<CommandTelemetryEvent>
	readonly maxLockWaitMs?: number
}): Promise<WorkResult<{ readonly recorded: boolean }>> => {
	const initialConfig = await readTelemetryConfig(input.root)
	if (!initialConfig.ok || initialConfig.value?.enabled === false) {
		return initialConfig.ok ? { ok: true, value: { recorded: false } } : initialConfig
	}
	return withTelemetryLock(
		input.root,
		async () => {
			const observedConfig = await readTelemetryConfig(input.root)
			if (!observedConfig.ok || observedConfig.value?.enabled === false) {
				return observedConfig.ok ? { ok: true, value: { recorded: false } } : observedConfig
			}
			const config =
				observedConfig.value === undefined
					? await materializeDefaultTelemetryConfig(input.root)
					: { ok: true as const, value: observedConfig.value }
			if (!config.ok) {
				return config
			}
			const built = input.build(config.value.correlationSalt)
			if (!built.ok) {
				return built
			}
			const verified = safeParse(TelemetryEventSchema, built.value)
			if (!verified.success) {
				return failure(
					'telemetry_write_failed',
					'Sanitized telemetry event failed its bounded schema.',
				)
			}
			const target = await telemetryPath(input.root, TELEMETRY_EVENTS_PATH, true)
			if (!target.ok) {
				return target
			}
			const source = await readTelemetryEventSource(target.value)
			if (!source.ok) {
				return source
			}
			const existing = parseTelemetryEvents(source.value)
			if (!existing.ok) {
				return existing
			}
			if (existing.value.length >= TELEMETRY_EVENT_MAX_COUNT) {
				return failure(
					'telemetry_limit_exceeded',
					`Telemetry event log reached its ${TELEMETRY_EVENT_MAX_COUNT}-record limit.`,
				)
			}
			const line = `${JSON.stringify(verified.output)}\n`
			const lineBytes = Buffer.byteLength(line, 'utf8')
			if (lineBytes > TELEMETRY_EVENT_MAX_BYTES) {
				return failure(
					'telemetry_write_failed',
					'Sanitized telemetry event exceeds its byte limit.',
				)
			}
			if (Buffer.byteLength(source.value, 'utf8') + lineBytes > TELEMETRY_FILE_MAX_BYTES) {
				return failure(
					'telemetry_limit_exceeded',
					`Telemetry log reached its ${TELEMETRY_FILE_MAX_BYTES}-byte local retention limit.`,
				)
			}
			try {
				await writeUtf8NoFollow({
					path: target.value,
					content: `${source.value}${line}`,
					mode: 'replace',
				})
				return { ok: true, value: { recorded: true } }
			} catch {
				return failure('telemetry_write_failed', 'Unable to append command telemetry.')
			}
		},
		input.maxLockWaitMs,
	)
}

const readTelemetryEventSource = async (path: string): Promise<WorkResult<string>> => {
	const source = await readBoundedUtf8({
		path,
		maxBytes: TELEMETRY_FILE_MAX_BYTES,
		unavailableCode: 'telemetry_read_failed',
		tooLargeCode: 'telemetry_limit_exceeded',
		label: 'Telemetry event log',
	})
	if (source.ok) {
		return source
	}
	return source.error.details?.some((detail) => detail.includes('ENOENT'))
		? { ok: true, value: '' }
		: failure(
				source.error.code === 'telemetry_limit_exceeded'
					? 'telemetry_limit_exceeded'
					: 'telemetry_read_failed',
				source.error.message,
			)
}

const parseTelemetryEvents = (source: string): WorkResult<readonly CommandTelemetryEvent[]> => {
	const lines = source.split('\n').filter((line) => line.length > 0)
	if (lines.length > TELEMETRY_EVENT_MAX_COUNT) {
		return failure(
			'telemetry_limit_exceeded',
			`Telemetry event log exceeds ${TELEMETRY_EVENT_MAX_COUNT} records.`,
		)
	}
	const events: CommandTelemetryEvent[] = []
	for (const [index, line] of lines.entries()) {
		if (Buffer.byteLength(`${line}\n`, 'utf8') > TELEMETRY_EVENT_MAX_BYTES) {
			return failure(
				'telemetry_limit_exceeded',
				`Telemetry event ${index + 1} exceeds its byte limit.`,
			)
		}
		let document: unknown
		try {
			document = JSON.parse(line)
		} catch {
			return failure('telemetry_read_failed', `Telemetry event ${index + 1} is not valid JSON.`)
		}
		const parsed = safeParse(TelemetryEventSchema, document)
		if (!parsed.success) {
			return failure(
				'telemetry_read_failed',
				`Telemetry event ${index + 1} failed schema validation.`,
			)
		}
		const event = parsed.output
		events.push({
			schemaVersion: event.schemaVersion,
			eventId: event.eventId,
			occurredAt: event.occurredAt,
			command: event.command,
			outcome: event.outcome,
			exitCode: event.exitCode,
			durationMs: event.durationMs,
			...(event.workCorrelation === undefined ? {} : { workCorrelation: event.workCorrelation }),
			...(event.actorCorrelation === undefined ? {} : { actorCorrelation: event.actorCorrelation }),
			...(event.roleCorrelation === undefined ? {} : { roleCorrelation: event.roleCorrelation }),
			...(event.sessionCorrelation === undefined
				? {}
				: { sessionCorrelation: event.sessionCorrelation }),
			...(event.contextMaxBytes === undefined ? {} : { contextMaxBytes: event.contextMaxBytes }),
			...(event.failureStage === undefined ? {} : { failureStage: event.failureStage }),
			...(event.runCorrelation === undefined ? {} : { runCorrelation: event.runCorrelation }),
			...(event.phases === undefined ? {} : { phases: event.phases }),
			...(event.unattributedMs === undefined ? {} : { unattributedMs: event.unattributedMs }),
			...(event.hookEvent === undefined ? {} : { hookEvent: event.hookEvent }),
			...(event.hookEntryCorrelation === undefined
				? {}
				: { hookEntryCorrelation: event.hookEntryCorrelation }),
			...(event.hookOutcome === undefined ? {} : { hookOutcome: event.hookOutcome }),
			...(event.hookOutputMode === undefined ? {} : { hookOutputMode: event.hookOutputMode }),
			...(event.hookSkipReason === undefined ? {} : { hookSkipReason: event.hookSkipReason }),
		})
	}
	return { ok: true, value: events }
}

const resolveTelemetryFilters = (input: {
	readonly config?: TelemetryConfig
	readonly sessionId?: string
	readonly sessionCorrelation?: string
	readonly workId?: string
}): WorkResult<{ readonly sessionCorrelation?: string; readonly workCorrelation?: string }> => {
	if (input.sessionId !== undefined && input.sessionCorrelation !== undefined) {
		return failure(
			'invalid_telemetry_filter',
			'Use either a session ID or a session correlation, not both.',
		)
	}
	const sessionId = telemetryLookupId(input.sessionId)
	const workId = telemetryLookupId(input.workId)
	if (
		(input.sessionId !== undefined && sessionId === undefined) ||
		(input.workId !== undefined && workId === undefined) ||
		(input.sessionCorrelation !== undefined && !/^[a-f0-9]{64}$/.test(input.sessionCorrelation))
	) {
		return failure('invalid_telemetry_filter', 'Telemetry filters are invalid.')
	}
	if ((sessionId !== undefined || workId !== undefined) && input.config === undefined) {
		return failure(
			'invalid_telemetry_filter',
			'Telemetry lookup IDs cannot be resolved because local correlation state is unavailable.',
		)
	}
	return {
		ok: true,
		value: {
			...(input.sessionCorrelation === undefined
				? sessionId === undefined || input.config === undefined
					? {}
					: {
							sessionCorrelation: telemetryCorrelation(
								'session',
								sessionId,
								input.config.correlationSalt,
							),
						}
				: { sessionCorrelation: input.sessionCorrelation }),
			...(workId === undefined || input.config === undefined
				? {}
				: { workCorrelation: telemetryCorrelation('work', workId, input.config.correlationSalt) }),
		},
	}
}

/** @description Appends one allowlisted command envelope unless local telemetry is explicitly disabled. */
export const recordCommandTelemetry = async (input: {
	readonly root: string
	readonly invocation: WorkContractInvocation
	readonly exitCode: number
	readonly durationMs: number
	readonly runId?: string
	readonly sessionId?: string
	readonly phases?: readonly CommandPhaseMeasurement[]
}): Promise<WorkResult<{ readonly recorded: boolean }>> =>
	appendTelemetryEvent({
		root: input.root,
		build: (correlationSalt) => toTelemetryEvent({ ...input, correlationSalt }),
	})

/** @description Records a sanitized Stricli routing or argument failure without retaining raw input. */
export const recordCliFailureTelemetry = async (input: {
	readonly root: string
	readonly command: string
	readonly failureStage: 'routing' | 'arguments'
	readonly exitCode: number
	readonly durationMs: number
	readonly runId?: string
	readonly sessionId?: string
}): Promise<WorkResult<{ readonly recorded: boolean }>> =>
	appendTelemetryEvent({
		root: input.root,
		build: (correlationSalt) => {
			const runCorrelation = correlateRunId(input.runId, correlationSalt)
			if (!runCorrelation.ok) {
				return runCorrelation
			}
			const sessionCorrelation = correlateTelemetrySession(input.sessionId, correlationSalt)
			if (!sessionCorrelation.ok) {
				return sessionCorrelation
			}
			return {
				ok: true,
				value: {
					schemaVersion: 1,
					eventId: randomUUID(),
					occurredAt: new Date().toISOString(),
					command: canonicalTelemetryCommand(input.command),
					outcome: input.exitCode === 2 ? 'attention' : 'failure',
					exitCode: input.exitCode,
					durationMs: Math.max(0, Math.round(input.durationMs)),
					failureStage: input.failureStage,
					...(sessionCorrelation.value === undefined
						? {}
						: { sessionCorrelation: sessionCorrelation.value }),
					...(runCorrelation.value === undefined ? {} : { runCorrelation: runCorrelation.value }),
				},
			}
		},
	})

const hookTelemetryOutcome = (
	outcome: 'success' | 'failure' | 'timeout' | 'skipped',
): 'success' | 'failure' | 'attention' => {
	if (outcome === 'failure' || outcome === 'timeout') {
		return 'failure'
	}
	return outcome === 'skipped' ? 'attention' : 'success'
}

/** @description Records one sanitized configured-hook outcome without command data or output. */
export const recordHookTelemetry = async (input: {
	readonly root: string
	readonly event: 'sessionStart' | 'afterEdit' | 'beforeStop' | 'sessionEnd'
	readonly entryId: string
	readonly durationMs: number
	readonly outcome: 'success' | 'failure' | 'timeout' | 'skipped'
	readonly outputMode: 'silent' | 'passthrough' | 'summarize'
	readonly skipReason?: 'runtime' | 'session_source' | 'changed_files' | 'unrecognized_edit'
	readonly maxWaitMs?: number
	readonly sessionId?: string
}): Promise<WorkResult<{ readonly recorded: boolean }>> =>
	appendTelemetryEvent({
		root: input.root,
		...(input.maxWaitMs === undefined ? {} : { maxLockWaitMs: input.maxWaitMs }),
		build: (correlationSalt) => {
			const sessionCorrelation = correlateTelemetrySession(input.sessionId, correlationSalt)
			if (!sessionCorrelation.ok) {
				return sessionCorrelation
			}
			return {
				ok: true,
				value: {
					schemaVersion: 1,
					eventId: randomUUID(),
					occurredAt: new Date().toISOString(),
					command: 'hooks.dispatch',
					outcome: hookTelemetryOutcome(input.outcome),
					exitCode: input.outcome === 'success' || input.outcome === 'skipped' ? 0 : 1,
					durationMs: Math.max(0, Math.round(input.durationMs)),
					hookEvent: input.event,
					hookEntryCorrelation: createHmac('sha256', Buffer.from(correlationSalt, 'hex'))
						.update(input.entryId)
						.digest('hex'),
					...(sessionCorrelation.value === undefined
						? {}
						: { sessionCorrelation: sessionCorrelation.value }),
					hookOutcome: input.outcome,
					hookOutputMode: input.outputMode,
					...(input.skipReason === undefined ? {} : { hookSkipReason: input.skipReason }),
				},
			}
		},
	})

/** @description Reads a bounded newest-first view of sanitized local command telemetry. */
export const showCommandTelemetry = async (input: {
	readonly root: string
	readonly limit: number
	readonly sessionId?: string
	readonly sessionCorrelation?: string
	readonly workId?: string
}): Promise<
	WorkResult<{
		readonly enabled: boolean
		readonly path: string
		readonly events: readonly CommandTelemetryEvent[]
		readonly filters?: {
			readonly sessionCorrelation?: string
			readonly workCorrelation?: string
		}
	}>
> => {
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > TELEMETRY_SHOW_MAX_EVENTS
	) {
		return failure(
			'telemetry_limit_exceeded',
			`Telemetry show limit must be between 1 and ${TELEMETRY_SHOW_MAX_EVENTS}.`,
		)
	}
	const config = await readTelemetryConfig(input.root)
	if (!config.ok) {
		return config
	}
	const filters = resolveTelemetryFilters({
		...(config.value === undefined ? {} : { config: config.value }),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.sessionCorrelation === undefined
			? {}
			: { sessionCorrelation: input.sessionCorrelation }),
		...(input.workId === undefined ? {} : { workId: input.workId }),
	})
	if (!filters.ok) {
		return filters
	}
	const target = await telemetryPath(input.root, TELEMETRY_EVENTS_PATH, false)
	if (!target.ok) {
		return target
	}
	const source = await readTelemetryEventSource(target.value)
	if (!source.ok) {
		return source
	}
	const events = parseTelemetryEvents(source.value)
	if (!events.ok) {
		return events
	}
	const filtered = events.value.filter(
		(event) =>
			(filters.value.sessionCorrelation === undefined ||
				event.sessionCorrelation === filters.value.sessionCorrelation) &&
			(filters.value.workCorrelation === undefined ||
				event.workCorrelation === filters.value.workCorrelation),
	)
	return {
		ok: true,
		value: {
			enabled: config.value?.enabled ?? true,
			path: TELEMETRY_EVENTS_PATH,
			events: filtered.slice(-input.limit).toReversed(),
			...(Object.keys(filters.value).length === 0 ? {} : { filters: filters.value }),
		},
	}
}

/** @description Lists bounded newest-first aggregates for sessions present in local telemetry. */
export const listCommandTelemetrySessions = async (input: {
	readonly root: string
	readonly limit: number
}): Promise<
	WorkResult<{
		readonly enabled: boolean
		readonly path: string
		readonly unattributedEventCount: number
		readonly sessions: readonly CommandTelemetrySession[]
	}>
> => {
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > TELEMETRY_SESSION_MAX_COUNT
	) {
		return failure(
			'telemetry_limit_exceeded',
			`Telemetry session limit must be between 1 and ${TELEMETRY_SESSION_MAX_COUNT}.`,
		)
	}
	const config = await readTelemetryConfig(input.root)
	if (!config.ok) {
		return config
	}
	const target = await telemetryPath(input.root, TELEMETRY_EVENTS_PATH, false)
	if (!target.ok) {
		return target
	}
	const source = await readTelemetryEventSource(target.value)
	if (!source.ok) {
		return source
	}
	const parsed = parseTelemetryEvents(source.value)
	if (!parsed.ok) {
		return parsed
	}
	interface SessionAccumulator {
		firstOccurredAt: string
		lastOccurredAt: string
		lastIndex: number
		eventCount: number
		durationMs: number
		outcomes: { success: number; attention: number; failure: number }
		commands: Map<string, number>
	}
	const sessions = new Map<string, SessionAccumulator>()
	let unattributedEventCount = 0
	for (const [index, event] of parsed.value.entries()) {
		if (event.sessionCorrelation === undefined) {
			unattributedEventCount += 1
			continue
		}
		const current = sessions.get(event.sessionCorrelation) ?? {
			firstOccurredAt: event.occurredAt,
			lastOccurredAt: event.occurredAt,
			lastIndex: index,
			eventCount: 0,
			durationMs: 0,
			outcomes: { success: 0, attention: 0, failure: 0 },
			commands: new Map<string, number>(),
		}
		current.lastOccurredAt = event.occurredAt
		current.lastIndex = index
		current.eventCount += 1
		current.durationMs += event.durationMs
		current.outcomes[event.outcome] += 1
		current.commands.set(event.command, (current.commands.get(event.command) ?? 0) + 1)
		sessions.set(event.sessionCorrelation, current)
	}
	const summaries = [...sessions.entries()]
		.toSorted((left, right) => right[1].lastIndex - left[1].lastIndex)
		.slice(0, input.limit)
		.map(
			([sessionCorrelation, session]): CommandTelemetrySession => ({
				sessionCorrelation,
				firstOccurredAt: session.firstOccurredAt,
				lastOccurredAt: session.lastOccurredAt,
				eventCount: session.eventCount,
				durationMs: session.durationMs,
				outcomes: session.outcomes,
				commands: [...session.commands.entries()]
					.map(([command, count]) => ({ command, count }))
					.toSorted(
						(left, right) => right.count - left.count || left.command.localeCompare(right.command),
					),
			}),
		)
	return {
		ok: true,
		value: {
			enabled: config.value?.enabled ?? true,
			path: TELEMETRY_EVENTS_PATH,
			unattributedEventCount,
			sessions: summaries,
		},
	}
}
