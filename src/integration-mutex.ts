/**
 * @description One cooperative local mutex around external integration work.
 *
 * @module work/integration-mutex
 * @file Integration-mutex.ts
 */

import { randomUUID } from 'node:crypto'
import { link, rename, rm } from 'node:fs/promises'

import {
	isoTimestamp,
	literal,
	maxLength,
	minLength,
	optional,
	pipe,
	regex,
	safeParse,
	strictObject,
	string,
} from 'valibot'

import type { WorkResult } from './contracts'
import { readBoundedUtf8, writeUtf8NoFollow } from './files'
import { prepareSafeOutputPath } from './paths'

const LOCK_PATH = '.work/integration.lock'
const OPERATION_PATH = '.work/integration.operation.lock'
const MAX_BYTES = 8 * 1024
const NonceSchema = pipe(string(), regex(/^[a-f0-9-]{36}$/u))
const OwnerSchema = strictObject({
	actor: pipe(string(), minLength(1), maxLength(128)),
	session: optional(pipe(string(), minLength(1), maxLength(256))),
	acquiredAt: pipe(string(), maxLength(40), isoTimestamp()),
	nonce: NonceSchema,
})
const LockSchema = strictObject({
	version: literal(1),
	...OwnerSchema.entries,
	recoveredFrom: optional(OwnerSchema),
	recoveryReason: optional(pipe(string(), minLength(1), maxLength(2000))),
	recoveredAt: optional(pipe(string(), maxLength(40), isoTimestamp())),
})

interface IntegrationLockOwner {
	readonly actor: string
	readonly session?: string | undefined
	readonly acquiredAt: string
	readonly nonce: string
}

export interface IntegrationLock extends IntegrationLockOwner {
	readonly version: 1
	readonly recoveredFrom?: IntegrationLockOwner | undefined
	readonly recoveryReason?: string | undefined
	readonly recoveredAt?: string | undefined
}

interface LockState {
	readonly lock: IntegrationLock
	readonly source: string
	readonly path: string
}

const failure = (
	code: 'integration_locked' | 'integration_lock_release_failed' | 'invalid_integration_lock',
	message: string,
): WorkResult<never> => ({ ok: false, error: { type: 'work_contract_error', code, message } })

const isMissingResult = (result: WorkResult<unknown>): boolean =>
	!result.ok && result.error.details?.includes('System error code: ENOENT.') === true

const mutexPath = async (root: string, path: string): Promise<WorkResult<string>> =>
	prepareSafeOutputPath({ root, path, errorCode: 'invalid_integration_lock' })

const lockTarget = async (root: string): Promise<WorkResult<string>> => mutexPath(root, LOCK_PATH)

const operationTarget = async (root: string): Promise<WorkResult<string>> =>
	mutexPath(root, OPERATION_PATH)

const readLockState = async (root: string): Promise<WorkResult<LockState | undefined>> => {
	const target = await lockTarget(root)
	if (!target.ok) {
		return target
	}
	const source = await readBoundedUtf8({
		path: target.value,
		maxBytes: MAX_BYTES,
		unavailableCode: 'invalid_integration_lock',
		tooLargeCode: 'invalid_integration_lock',
		invalidUtf8Code: 'invalid_integration_lock',
		label: 'Integration mutex',
	})
	if (!source.ok) {
		return isMissingResult(source)
			? { ok: true, value: undefined }
			: failure('invalid_integration_lock', 'Integration mutex cannot be read safely.')
	}
	try {
		const parsed = safeParse(LockSchema, JSON.parse(source.value) as unknown)
		if (!parsed.success) {
			return failure('invalid_integration_lock', 'Integration mutex is malformed.')
		}
		return {
			ok: true,
			value: { lock: parsed.output, source: source.value, path: target.value },
		}
	} catch {
		return failure('invalid_integration_lock', 'Integration mutex is malformed.')
	}
}

const operationIsPresent = async (root: string): Promise<WorkResult<boolean>> => {
	const target = await operationTarget(root)
	if (!target.ok) {
		return target
	}
	const source = await readBoundedUtf8({
		path: target.value,
		maxBytes: MAX_BYTES,
		unavailableCode: 'invalid_integration_lock',
		tooLargeCode: 'invalid_integration_lock',
		invalidUtf8Code: 'invalid_integration_lock',
		label: 'Integration mutex operation',
	})
	if (source.ok) {
		return { ok: true, value: true }
	}
	return isMissingResult(source)
		? { ok: true, value: false }
		: failure('invalid_integration_lock', 'Integration mutex operation is malformed.')
}

const sameOwner = (
	lock: IntegrationLock,
	actor: string,
	session: string | undefined,
	nonce: string,
): boolean => lock.actor === actor && lock.session === session && lock.nonce === nonce

const makeLock = (input: {
	readonly actor: string
	readonly session?: string
	readonly recoveredFrom?: IntegrationLockOwner
	readonly recoveryReason?: string
}): IntegrationLock => ({
	version: 1,
	actor: input.actor.trim(),
	...(input.session === undefined ? {} : { session: input.session.trim() }),
	acquiredAt: new Date().toISOString(),
	nonce: randomUUID(),
	...(input.recoveredFrom === undefined ? {} : { recoveredFrom: input.recoveredFrom }),
	...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
	...(input.recoveryReason === undefined ? {} : { recoveredAt: new Date().toISOString() }),
})

const prepareLockFile = async (
	root: string,
	lock: IntegrationLock,
): Promise<WorkResult<string>> => {
	if (!safeParse(LockSchema, lock).success) {
		return failure('invalid_integration_lock', 'Integration mutex owner is invalid.')
	}
	const prepared = await mutexPath(root, `.work/integration.pending-${lock.nonce}.json`)
	if (!prepared.ok) {
		return prepared
	}
	try {
		await writeUtf8NoFollow({
			path: prepared.value,
			content: `${JSON.stringify(lock)}\n`,
			mode: 'exclusive',
		})
		return prepared
	} catch {
		await rm(prepared.value, { force: true })
		return failure('integration_locked', 'Integration mutex could not be prepared.')
	}
}

const acquireOperation = async (
	root: string,
	ownerNonce: string,
): Promise<WorkResult<{ readonly path: string; readonly source: string }>> => {
	const target = await operationTarget(root)
	if (!target.ok) {
		return target
	}
	const source = `${JSON.stringify({ nonce: randomUUID(), ownerNonce })}\n`
	try {
		await writeUtf8NoFollow({ path: target.value, content: source, mode: 'exclusive' })
		return { ok: true, value: { path: target.value, source } }
	} catch {
		return failure('integration_locked', 'Another integration operation is active.')
	}
}

const releaseOperation = async (operation: {
	readonly path: string
	readonly source: string
}): Promise<void> => {
	const observed = await readBoundedUtf8({
		path: operation.path,
		maxBytes: MAX_BYTES,
		unavailableCode: 'invalid_integration_lock',
		tooLargeCode: 'invalid_integration_lock',
		label: 'Integration mutex operation',
	})
	if (observed.ok && observed.value === operation.source) {
		await rm(operation.path, { force: true }).catch(() => false)
	}
}

/** @description Reports whether local integration is currently held. */
export const inspectIntegrationMutex = async (
	root: string,
): Promise<WorkResult<IntegrationLock | undefined>> => {
	const state = await readLockState(root)
	return state.ok ? { ok: true, value: state.value?.lock } : state
}

/** @description Acquires the local integration mutex without performing integration. */
export const acquireIntegrationMutex = async (input: {
	readonly root: string
	readonly actor: string
	readonly session?: string
}): Promise<WorkResult<IntegrationLock>> => {
	const operation = await operationIsPresent(input.root)
	if (!operation.ok) {
		return operation
	}
	if (operation.value) {
		return failure('integration_locked', 'Another integration operation is active.')
	}
	const lock = makeLock(input)
	const prepared = await prepareLockFile(input.root, lock)
	if (!prepared.ok) {
		return prepared
	}
	const target = await lockTarget(input.root)
	if (!target.ok) {
		await rm(prepared.value, { force: true })
		return target
	}
	try {
		await link(prepared.value, target.value)
		await rm(prepared.value, { force: true }).catch(() => false)
		return { ok: true, value: lock }
	} catch {
		await rm(prepared.value, { force: true })
		return failure('integration_locked', 'Another local integration is already active.')
	}
}

/** @description Releases the mutex only for the exact recorded owner generation. */
export const releaseIntegrationMutex = async (input: {
	readonly root: string
	readonly actor: string
	readonly session?: string
	readonly nonce: string
}): Promise<WorkResult<{ readonly released: boolean }>> => {
	const initial = await readLockState(input.root)
	if (!initial.ok) {
		return initial
	}
	if (initial.value === undefined) {
		return { ok: true, value: { released: false } }
	}
	if (!sameOwner(initial.value.lock, input.actor, input.session, input.nonce)) {
		return failure(
			'integration_lock_release_failed',
			'Only the exact current integration owner may release the mutex.',
		)
	}
	const operation = await acquireOperation(input.root, initial.value.lock.nonce)
	if (!operation.ok) {
		return operation
	}
	try {
		const current = await readLockState(input.root)
		if (
			!current.ok ||
			current.value === undefined ||
			current.value.source !== initial.value.source ||
			!sameOwner(current.value.lock, input.actor, input.session, input.nonce)
		) {
			return failure('integration_lock_release_failed', 'Integration mutex changed during release.')
		}
		await rm(current.value.path)
		return { ok: true, value: { released: true } }
	} catch {
		return failure('integration_lock_release_failed', 'Integration mutex could not be released.')
	} finally {
		await releaseOperation(operation.value)
	}
}

/** @description Explicitly replaces a valid stale cooperative owner after operator inspection. */
export const recoverIntegrationMutex = async (input: {
	readonly root: string
	readonly actor: string
	readonly session?: string
	readonly reason: string
	/**
	 * @description Test seam for contention after the exact owner is guarded.
	 *
	 * @internal
	 */
	readonly onGuarded?: () => Promise<void>
}): Promise<WorkResult<IntegrationLock>> => {
	const reason = input.reason.trim()
	if (reason.length === 0 || Buffer.byteLength(reason, 'utf8') > 2000) {
		return failure('invalid_integration_lock', 'Integration recovery requires a bounded reason.')
	}
	const initial = await readLockState(input.root)
	if (!initial.ok) {
		return initial
	}
	if (initial.value === undefined) {
		return acquireIntegrationMutex(input)
	}
	const operation = await acquireOperation(input.root, initial.value.lock.nonce)
	if (!operation.ok) {
		return operation
	}
	let preparedPath: string | undefined
	try {
		const current = await readLockState(input.root)
		if (
			!current.ok ||
			current.value === undefined ||
			current.value.source !== initial.value.source
		) {
			return failure('integration_locked', 'Integration mutex changed during recovery.')
		}
		await input.onGuarded?.()
		const lock = makeLock({
			actor: input.actor,
			...(input.session === undefined ? {} : { session: input.session }),
			recoveredFrom: {
				actor: current.value.lock.actor,
				...(current.value.lock.session === undefined
					? {}
					: { session: current.value.lock.session }),
				acquiredAt: current.value.lock.acquiredAt,
				nonce: current.value.lock.nonce,
			},
			recoveryReason: reason,
		})
		const prepared = await prepareLockFile(input.root, lock)
		if (!prepared.ok) {
			return prepared
		}
		preparedPath = prepared.value
		await rename(preparedPath, current.value.path)
		preparedPath = undefined
		return { ok: true, value: lock }
	} catch {
		return failure('integration_locked', 'Integration mutex changed during recovery.')
	} finally {
		if (preparedPath !== undefined) {
			await rm(preparedPath, { force: true })
		}
		await releaseOperation(operation.value)
	}
}
