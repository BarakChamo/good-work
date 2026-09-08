/**
 * @description Installs the packaged work skill into supported project-local agent paths.
 *
 * @module work/skill
 * @file Skill.ts
 */

import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { kill as signalProcess, pid as processId } from 'node:process'
import { fileURLToPath } from 'node:url'

import {
	isoTimestamp,
	maxLength,
	minValue,
	number,
	pipe,
	safeInteger,
	safeParse,
	strictObject,
	string,
	uuid,
} from 'valibot'
import type { InferOutput } from 'valibot'

import type { WorkResult } from './contracts'
import { readBoundedUtf8, writeUtf8NoFollow } from './files'
import { prepareSafeOutputPath } from './paths'

const SKILL_ASSETS = [
	{ source: '../skills/work/SKILL.md', path: '.agents/skills/work/SKILL.md' },
	{
		source: '../skills/work/references/commands.md',
		path: '.agents/skills/work/references/commands.md',
	},
	{
		source: '../skills/work/agents/openai.yaml',
		path: '.agents/skills/work/agents/openai.yaml',
	},
	{ source: '../skills/work/SKILL.md', path: '.claude/skills/work/SKILL.md' },
	{
		source: '../skills/work/references/commands.md',
		path: '.claude/skills/work/references/commands.md',
	},
] as const
const LEGACY_SKILL_ASSETS = [
	{
		source: '../skills/work/migrations/work-contract-v1.md',
		path: '.agents/skills/work-contract/SKILL.md',
	},
	{
		source: '../skills/work/migrations/work-contract-v1.md',
		path: '.claude/skills/work-contract/SKILL.md',
	},
] as const
const SKILL_INSTALL_LOCK = '.work/skill-install.lock'
const SKILL_INSTALL_LOCK_MAX_BYTES = 512
const SkillInstallLockOwnerSchema = strictObject({
	pid: pipe(number(), safeInteger(), minValue(1)),
	startedAt: pipe(string(), maxLength(40), isoTimestamp()),
	nonce: pipe(string(), uuid()),
})
const OVERSIZED_SKILL = Symbol('oversized-skill')
type PreviousSkill = string | undefined | typeof OVERSIZED_SKILL
type SkillInstallLockOwner = InferOutput<typeof SkillInstallLockOwnerSchema>

interface SkillTargetState {
	readonly path: (typeof SKILL_ASSETS)[number]['path']
	readonly absolutePath: string
	readonly source: string
	readonly maxBytes: number
	readonly previous: PreviousSkill
	readonly backupPath?: string
}

interface LegacySkillState {
	readonly path: (typeof LEGACY_SKILL_ASSETS)[number]['path']
	readonly absolutePath: string
	readonly source: string
	readonly maxBytes: number
	readonly previous: PreviousSkill
	readonly backupPath?: string
}

interface LoadedSkillAsset<Path extends string = string> {
	readonly path: Path
	readonly source: string
	readonly maxBytes: number
}

interface AcquiredSkillInstallLock {
	readonly content: string
	readonly handle: FileHandle
	readonly path: string
}

const failure = (
	code: 'skill_install_conflict' | 'skill_install_failed',
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

/** @description Removes raw filesystem diagnostics before a skill failure crosses the package boundary. */
const withoutPrivateDetails = <T>(result: WorkResult<T>): WorkResult<T> =>
	result.ok
		? result
		: {
				ok: false,
				error: {
					type: result.error.type,
					code: result.error.code,
					message: result.error.message,
				},
			}

const safeErrorDetail = (error: unknown): string => {
	const code =
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		/^[A-Z0-9_]{1,64}$/.test(error.code)
			? error.code
			: 'unknown'
	return `errorCode=${code}`
}

const preservePrimaryCleanupFailure = <T>(
	result: WorkResult<T>,
	cleanupMessage: string,
): WorkResult<T> =>
	result.ok
		? failure('skill_install_failed', cleanupMessage)
		: {
				ok: false,
				error: {
					...result.error,
					details: [
						...(result.error.details ?? []).slice(0, 16).map((detail) => detail.slice(0, 512)),
						'cleanupFailure=skill_install_lock_release_failed',
						'recovery=preserve the primary error and inspect the skill installation lock manually',
					],
				},
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

/** @description Reads one untrusted skill-lock record without following the final symlink. */
const readSkillInstallLock = async (path: string): Promise<WorkResult<string>> =>
	readBoundedUtf8({
		path,
		maxBytes: SKILL_INSTALL_LOCK_MAX_BYTES,
		unavailableCode: 'skill_install_failed',
		tooLargeCode: 'skill_install_failed',
		invalidUtf8Code: 'skill_install_failed',
		label: 'Skill installation lock',
	})

/**
 * @description Removes a lock only while its complete record still belongs to the observed owner.
 *
 * @internal
 */
export const removeOwnedSkillInstallLock = async (
	path: string,
	expectedContent: string,
	afterValidation?: () => Promise<void>,
): Promise<boolean> => {
	const current = await readSkillInstallLock(path)
	if (!current.ok || current.value !== expectedContent) {
		return false
	}
	await afterValidation?.()
	const claimPath = `${path}.release-${randomUUID()}`
	try {
		await link(path, claimPath)
		const [authoritative, claim, claimedContent] = await Promise.all([
			lstat(path),
			lstat(claimPath),
			readSkillInstallLock(claimPath),
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

/** @description Detects schema-valid skill locks whose owning process has exited. */
const hasDeadSkillInstallLockOwner = async (path: string): Promise<boolean> => {
	const observed = await readSkillInstallLock(path)
	if (!observed.ok) {
		return false
	}
	let document: unknown
	try {
		document = JSON.parse(observed.value)
	} catch {
		return false
	}
	const owner = safeParse(SkillInstallLockOwnerSchema, document)
	return owner.success && !isProcessAlive(owner.output.pid)
}

/** @description Acquires the skill lock once; stale generations require explicit recovery. */
const acquireSkillInstallLock = async (
	path: string,
): Promise<WorkResult<AcquiredSkillInstallLock>> => {
	const owner: SkillInstallLockOwner = {
		pid: processId,
		startedAt: new Date().toISOString(),
		nonce: randomUUID(),
	}
	const content = `${JSON.stringify(owner)}\n`
	while (true) {
		let handle: FileHandle | undefined
		try {
			handle = await open(path, 'wx', 0o600)
			await handle.writeFile(content)
			return { ok: true, value: { content, handle, path } }
		} catch (error: unknown) {
			if (handle !== undefined) {
				await handle.close().catch(() => false)
				await removeOwnedSkillInstallLock(path, content)
			}
			if (isAlreadyExistsError(error) && (await hasDeadSkillInstallLockOwner(path))) {
				return failure(
					'skill_install_failed',
					'A stale skill installation lock requires manual recovery.',
					[
						'lockState=stale',
						'automaticRecovery=false',
						'recovery=confirm no skill installation is active, then remove the stale lock',
					],
				)
			}
			return failure('skill_install_failed', 'Another skill installation is active.')
		}
	}
}

const readPrevious = async (
	path: string,
	maxBytes: number,
	allowOversized = false,
): Promise<WorkResult<PreviousSkill>> => {
	const existing = await readBoundedUtf8({
		path,
		maxBytes,
		unavailableCode: 'skill_install_failed',
		tooLargeCode: 'skill_install_conflict',
		label: 'Existing local skill',
	})
	if (!existing.ok) {
		if (existing.error.details?.some((detail) => detail.includes('ENOENT'))) {
			return { ok: true, value: undefined }
		}
		return existing.error.code === 'skill_install_conflict' && allowOversized
			? { ok: true, value: OVERSIZED_SKILL }
			: withoutPrivateDetails(existing)
	}
	return existing
}

const rollbackSkillTargets = async (
	targets: readonly SkillTargetState[],
): Promise<readonly string[]> => {
	const failures: string[] = []
	for (const target of targets.toReversed()) {
		try {
			const current = await readPrevious(target.absolutePath, target.maxBytes)
			if (!current.ok || current.value !== target.source) {
				failures.push(`${target.path}: changed after installation; rollback skipped`)
				continue
			}
			if (target.previous === OVERSIZED_SKILL) {
				if (target.backupPath === undefined) {
					failures.push(`${target.path}: oversized backup is unavailable`)
					continue
				}
				await rm(target.absolutePath)
				await rename(target.backupPath, target.absolutePath)
			} else if (target.previous === undefined) {
				await rm(target.absolutePath)
			} else {
				await writeUtf8NoFollow({
					path: target.absolutePath,
					content: target.previous,
					mode: 'replace',
				})
			}
		} catch (error: unknown) {
			failures.push(`${target.path}: ${safeErrorDetail(error)}`)
		}
	}
	return failures
}

const restoreLegacySkills = async (
	targets: readonly LegacySkillState[],
): Promise<readonly string[]> => {
	const failures: string[] = []
	for (const target of targets.toReversed()) {
		if (target.backupPath === undefined) {
			continue
		}
		try {
			await rename(target.backupPath, target.absolutePath)
		} catch (error: unknown) {
			failures.push(`${target.path}: ${safeErrorDetail(error)}`)
		}
	}
	return failures
}

const replaceOversizedSkill = async (path: string, source: string): Promise<string> => {
	const backupPath = `${path}.${randomUUID()}.backup`
	await rename(path, backupPath)
	try {
		await writeUtf8NoFollow({ path, content: source, mode: 'exclusive' })
	} catch (error: unknown) {
		try {
			await rename(backupPath, path)
		} catch (restoreError: unknown) {
			throw new Error(
				'Oversized skill replacement failed and its local backup could not be restored.',
				{ cause: restoreError },
			)
		}
		throw error instanceof Error
			? error
			: new Error('Oversized skill replacement failed with a non-Error value.', { cause: error })
	}
	return backupPath
}

const preflightSkillTargets = async (input: {
	readonly root: string
	readonly force: boolean
	readonly assets: readonly LoadedSkillAsset<SkillTargetState['path']>[]
	readonly legacyAssets: readonly LoadedSkillAsset<LegacySkillState['path']>[]
}): Promise<
	WorkResult<{
		readonly targets: readonly SkillTargetState[]
		readonly legacyTargets: readonly LegacySkillState[]
	}>
> => {
	const targets: SkillTargetState[] = []
	const legacyTargets: LegacySkillState[] = []
	for (const asset of input.assets) {
		const prepared = await prepareSafeOutputPath({
			root: input.root,
			path: asset.path,
			errorCode: 'unsafe_skill_path',
			createParents: false,
		})
		if (!prepared.ok) {
			return withoutPrivateDetails(prepared)
		}
		const previous = await readPrevious(prepared.value, asset.maxBytes, input.force)
		if (!previous.ok) {
			return previous
		}
		targets.push({
			path: asset.path,
			absolutePath: prepared.value,
			source: asset.source,
			maxBytes: asset.maxBytes,
			previous: previous.value,
		})
	}
	for (const asset of input.legacyAssets) {
		const prepared = await prepareSafeOutputPath({
			root: input.root,
			path: asset.path,
			errorCode: 'unsafe_skill_path',
			createParents: false,
		})
		if (!prepared.ok) {
			return withoutPrivateDetails(prepared)
		}
		const previous = await readPrevious(prepared.value, asset.maxBytes, input.force)
		if (!previous.ok) {
			return previous
		}
		legacyTargets.push({
			path: asset.path,
			absolutePath: prepared.value,
			source: asset.source,
			maxBytes: asset.maxBytes,
			previous: previous.value,
		})
	}
	return { ok: true, value: { targets, legacyTargets } }
}

const withSkillInstallLock = async <T>(
	root: string,
	operation: () => Promise<WorkResult<T>>,
): Promise<WorkResult<T>> => {
	const lockPath = await prepareSafeOutputPath({
		root,
		path: SKILL_INSTALL_LOCK,
		errorCode: 'unsafe_skill_path',
	})
	if (!lockPath.ok) {
		return withoutPrivateDetails(lockPath)
	}
	const lock = await acquireSkillInstallLock(lockPath.value)
	if (!lock.ok) {
		return lock
	}
	let result: WorkResult<T>
	try {
		result = await operation()
	} catch (error: unknown) {
		result = failure('skill_install_failed', 'Skill installation failed unexpectedly.', [
			safeErrorDetail(error),
		])
	}
	try {
		await lock.value.handle.close()
	} catch {
		return preservePrimaryCleanupFailure(result, 'Skill installation lock could not be released.')
	}
	if (!(await removeOwnedSkillInstallLock(lock.value.path, lock.value.content))) {
		return preservePrimaryCleanupFailure(
			result,
			'Skill installation lock ownership changed before release; the lock was preserved.',
		)
	}
	return result
}

/** @description Preflights every supported skill target before applying any installation writes. */
export const installWorkContractSkill = async (input: {
	readonly root: string
	readonly force: boolean
}): Promise<WorkResult<{ readonly installed: readonly string[]; readonly changed: boolean }>> => {
	const assets: {
		readonly path: (typeof SKILL_ASSETS)[number]['path']
		readonly source: string
		readonly maxBytes: number
	}[] = []
	const legacyAssets: {
		readonly path: (typeof LEGACY_SKILL_ASSETS)[number]['path']
		readonly source: string
		readonly maxBytes: number
	}[] = []
	try {
		for (const asset of SKILL_ASSETS) {
			const source = await readFile(fileURLToPath(new URL(asset.source, import.meta.url)), 'utf8')
			assets.push({ path: asset.path, source, maxBytes: Buffer.byteLength(source, 'utf8') })
		}
		for (const asset of LEGACY_SKILL_ASSETS) {
			const source = await readFile(fileURLToPath(new URL(asset.source, import.meta.url)), 'utf8')
			legacyAssets.push({
				path: asset.path,
				source,
				maxBytes: Buffer.byteLength(source, 'utf8'),
			})
		}
	} catch (error: unknown) {
		return failure('skill_install_failed', 'Unable to read the packaged work skill.', [
			safeErrorDetail(error),
		])
	}
	return withSkillInstallLock<{
		readonly installed: readonly string[]
		readonly changed: boolean
	}>(input.root, async () => {
		const preflight = await preflightSkillTargets({
			root: input.root,
			force: input.force,
			assets,
			legacyAssets,
		})
		if (!preflight.ok) {
			return preflight
		}
		const { targets, legacyTargets } = preflight.value

		const conflicts: readonly { readonly path: string }[] = [
			...targets.filter(
				(target) => target.previous !== undefined && target.previous !== target.source,
			),
			...legacyTargets.filter(
				(target) => target.previous !== undefined && target.previous !== target.source,
			),
		]
		if (conflicts.length > 0 && !input.force) {
			return failure(
				'skill_install_conflict',
				'The work skill differs from one or more local copies; use --force to replace all supported targets.',
				conflicts.map(({ path }) => path),
			)
		}
		const changedTargets = targets.filter(({ previous, source }) => previous !== source)
		const legacyApplied: LegacySkillState[] = []
		for (const target of legacyTargets) {
			if (target.previous === undefined) {
				continue
			}
			const backupPath = `${target.absolutePath}.${randomUUID()}.backup`
			try {
				await rename(target.absolutePath, backupPath)
				legacyApplied.push({ ...target, backupPath })
			} catch (error: unknown) {
				const restorationFailures = await restoreLegacySkills(legacyApplied)
				return failure(
					'skill_install_failed',
					'Legacy skill migration failed and was rolled back.',
					[
						`${target.path}: ${safeErrorDetail(error)}`,
						...restorationFailures.map((entry) => `rollback: ${entry}`),
					],
				)
			}
		}
		const applied: SkillTargetState[] = []
		for (const target of changedTargets) {
			const prepared = await prepareSafeOutputPath({
				root: input.root,
				path: target.path,
				errorCode: 'unsafe_skill_path',
			})
			if (!prepared.ok) {
				const rollbackFailures = await rollbackSkillTargets(applied)
				const legacyRollbackFailures = await restoreLegacySkills(legacyApplied)
				return failure('skill_install_failed', 'Skill installation failed and was rolled back.', [
					prepared.error.message,
					...rollbackFailures.map((entry) => `rollback: ${entry}`),
					...legacyRollbackFailures.map((entry) => `rollback: ${entry}`),
				])
			}
			const current = await readPrevious(prepared.value, target.maxBytes, input.force)
			if (!current.ok || current.value !== target.previous) {
				const rollbackFailures = await rollbackSkillTargets(applied)
				const legacyRollbackFailures = await restoreLegacySkills(legacyApplied)
				return failure(
					'skill_install_conflict',
					'One or more local skill targets changed during installation; no further writes were applied.',
					[
						target.path,
						...rollbackFailures.map((entry) => `rollback: ${entry}`),
						...legacyRollbackFailures.map((entry) => `rollback: ${entry}`),
					],
				)
			}
			try {
				let backupPath: string | undefined
				if (target.previous === OVERSIZED_SKILL) {
					backupPath = await replaceOversizedSkill(prepared.value, target.source)
				} else {
					await writeUtf8NoFollow({
						path: prepared.value,
						content: target.source,
						mode: target.previous === undefined ? 'exclusive' : 'replace',
					})
				}
				applied.push({
					...target,
					absolutePath: prepared.value,
					...(backupPath === undefined ? {} : { backupPath }),
				})
			} catch (error: unknown) {
				const rollbackFailures = await rollbackSkillTargets(applied)
				const legacyRollbackFailures = await restoreLegacySkills(legacyApplied)
				return failure('skill_install_failed', 'Skill installation failed and was rolled back.', [
					`${target.path}: ${safeErrorDetail(error)}`,
					...rollbackFailures.map((rollbackFailure) => `rollback: ${rollbackFailure}`),
					...legacyRollbackFailures.map((entry) => `rollback: ${entry}`),
				])
			}
		}
		const backupCleanupFailures: string[] = []
		for (const target of applied) {
			if (target.backupPath === undefined) {
				continue
			}
			try {
				await rm(target.backupPath)
			} catch (error: unknown) {
				backupCleanupFailures.push(`${target.path}: ${safeErrorDetail(error)}`)
			}
		}
		for (const target of legacyApplied) {
			if (target.backupPath === undefined) {
				continue
			}
			try {
				await rm(target.backupPath)
			} catch (error: unknown) {
				backupCleanupFailures.push(`${target.path}: ${safeErrorDetail(error)}`)
			}
		}
		if (backupCleanupFailures.length > 0) {
			return failure(
				'skill_install_failed',
				'Skill targets were installed, but one or more bounded backups could not be removed.',
				backupCleanupFailures,
			)
		}
		return {
			ok: true,
			value: {
				installed: SKILL_ASSETS.map(({ path }) => path),
				changed: changedTargets.length > 0 || legacyApplied.length > 0,
			},
		}
	})
}
