/**
 * @description Serializes repository definition mutations across source, provider, and lock publication.
 *
 * @module work/configuration-lock
 * @file Configuration-lock.ts
 */

import { randomUUID } from 'node:crypto'
import { link, lstat, open, rm } from 'node:fs/promises'

import type { WorkResult } from './contracts'
import { readBoundedUtf8 } from './files'
import { prepareSafeOutputPath } from './paths'

const configurationLockPath = '.work/proposal-apply.lock'
export const configurationLockMaxBytes = 64 * 1024

const configurationLockRecoveryDetails = [
	`lock=${configurationLockPath}`,
	'recovery=inspect repository sources, provider definitions, and .work/lock.json before manually removing the lock',
] as const

interface ConfigurationLockIntent {
	readonly schemaVersion: 1
	readonly kind:
		| 'work_contract_initialize'
		| 'work_contract_proposal_apply'
		| 'work_contract_sync_apply'
		| 'work_hooks_trust'
	readonly pid: number
	readonly [key: string]: unknown
}

interface ConfigurationLock {
	readonly release: () => Promise<WorkResult<void>>
}

/** @description Releases a configuration lock without replacing the authoritative mutation result. */
export const finalizeConfigurationMutation = async <Value>(input: {
	readonly result: WorkResult<Value>
	readonly lock: ConfigurationLock
}): Promise<WorkResult<Value>> => {
	const released = await input.lock.release()
	if (released.ok) {
		return input.result
	}
	return input.result.ok
		? {
				ok: false,
				error: {
					...released.error,
					details: [
						'stateApplied=true',
						'stateMayHaveChanged=true',
						...(released.error.details ?? []),
					],
				},
			}
		: {
				ok: false,
				error: {
					...input.result.error,
					details: [
						...(input.result.error.details ?? []),
						`lockReleaseCode=${released.error.code}`,
						...(released.error.details ?? []),
					],
				},
			}
}

const configurationLockError = (
	code: 'configuration_locked' | 'configuration_lock_release_failed',
	message: string,
): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code,
		message,
		details: configurationLockRecoveryDetails,
	},
})

/**
 * @description Removes only the validated configuration-lock inode generation.
 *
 * @internal
 */
export const removeOwnedConfigurationLock = async (
	path: string,
	expectedContent: string,
	afterValidation?: () => Promise<void>,
): Promise<boolean> => {
	const observed = await readBoundedUtf8({
		path,
		maxBytes: configurationLockMaxBytes,
		unavailableCode: 'configuration_lock_release_failed',
		tooLargeCode: 'configuration_lock_release_failed',
		invalidUtf8Code: 'configuration_lock_release_failed',
		label: 'Configuration mutation lock',
	})
	if (!observed.ok || observed.value !== expectedContent) {
		return false
	}
	await afterValidation?.()
	const claimPath = `${path}.release-${randomUUID()}`
	try {
		await link(path, claimPath)
		const [authoritative, claim, claimedContent] = await Promise.all([
			lstat(path),
			lstat(claimPath),
			readBoundedUtf8({
				path: claimPath,
				maxBytes: configurationLockMaxBytes,
				unavailableCode: 'configuration_lock_release_failed',
				tooLargeCode: 'configuration_lock_release_failed',
				invalidUtf8Code: 'configuration_lock_release_failed',
				label: 'Configuration mutation lock claim',
			}),
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

export const acquireConfigurationLock = async (input: {
	readonly root: string
	readonly intent: ConfigurationLockIntent
}): Promise<WorkResult<ConfigurationLock>> => {
	const safe = await prepareSafeOutputPath({
		root: input.root,
		path: configurationLockPath,
		errorCode: 'unsafe_configuration_lock',
	})
	if (!safe.ok) {
		return safe
	}
	const content = `${JSON.stringify(input.intent)}\n`
	if (Buffer.byteLength(content, 'utf8') > configurationLockMaxBytes) {
		return configurationLockError(
			'configuration_locked',
			'Configuration mutation intent exceeds its safety bound.',
		)
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(safe.value, 'wx', 0o600)
		await handle.writeFile(content)
		await handle.sync()
		await handle.close()
		handle = undefined
	} catch {
		if (handle !== undefined) {
			await handle.close().catch(() => false)
		}
		return configurationLockError(
			'configuration_locked',
			'Another configuration mutation is active or left a lock that requires inspection.',
		)
	}
	return {
		ok: true,
		value: {
			release: async (): Promise<WorkResult<void>> => {
				if (await removeOwnedConfigurationLock(safe.value, content)) {
					return { ok: true, value: undefined }
				}
				return configurationLockError(
					'configuration_lock_release_failed',
					'Configuration mutation lock ownership changed before release.',
				)
			},
		},
	}
}
