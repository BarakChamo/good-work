/**
 * @description Resolves disposable work coordination shared by linked Git worktrees.
 *
 * @module work/work-state
 * @file Work-state.ts
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'

import type { ProviderStateObservation, WorkResult } from './contracts'
import { PROJECT_UID_PATTERN } from './contracts'
import { executeFile } from './subprocess'

export interface WorkCoordinationLocation {
	readonly root: string
	readonly observation: ProviderStateObservation
}

export interface WorkStateLocation extends WorkCoordinationLocation {
	readonly directory: string
	readonly coordinationRoot: string
	readonly initialized: boolean
}

type ExecuteGit = (root: string, args: readonly string[]) => Promise<string>

const identityFor = (scopeRoot: string): string =>
	createHash('sha256').update(`work-contract-state-v2\0${scopeRoot}`).digest('hex')

const externalStateHome = (override?: string): string =>
	resolve(override ?? processEnvironment.WORK_CONTRACT_STATE_HOME ?? join(homedir(), '.work'))

const validProjectId = (value: string): boolean =>
	value.length > 0 &&
	value.length <= 128 &&
	!value.includes('\0') &&
	!value.includes('\r') &&
	!value.includes('\n')

const gitOutput = async (root: string, args: readonly string[]): Promise<string> => {
	const result = await executeFile('git', args, {
		cwd: root,
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	})
	return result.stdout
}

const unsafeStateLocation = (): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'unsafe_work_directory',
		message: 'Work coordination state could not be resolved safely.',
	},
})

const existingSafeDirectory = async (path: string): Promise<WorkResult<boolean>> => {
	try {
		const information = await lstat(path)
		return information.isDirectory() && !information.isSymbolicLink()
			? { ok: true, value: true }
			: unsafeStateLocation()
	} catch (error: unknown) {
		return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
			? { ok: true, value: false }
			: unsafeStateLocation()
	}
}

const ensureSafeDirectory = async (path: string, recursive: boolean): Promise<WorkResult<true>> => {
	try {
		await mkdir(path, { recursive, mode: 0o700 })
	} catch (error: unknown) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'EEXIST'
		) {
			return unsafeStateLocation()
		}
	}
	const state = await existingSafeDirectory(path)
	return state.ok && state.value ? { ok: true, value: true } : unsafeStateLocation()
}

const externalRoot = async (
	scopeRoot: string,
	projectUid?: string,
	stateHome?: string,
): Promise<WorkResult<string>> => {
	const home = externalStateHome(stateHome)
	if (!isAbsolute(home) || home.includes('\u0000') || home.includes('\r') || home.includes('\n')) {
		return unsafeStateLocation()
	}
	const homeReady = await ensureSafeDirectory(home, true)
	if (!homeReady.ok) {
		return homeReady
	}
	const identity = identityFor(scopeRoot)
	const legacyRoot = join(home, identity)
	let root = legacyRoot
	if (projectUid !== undefined) {
		const namespace = join(home, projectUid)
		const namespaceState = await existingSafeDirectory(namespace)
		if (!namespaceState.ok) {
			return namespaceState
		}
		const namespacedRoot = join(namespace, identity)
		const namespaced = namespaceState.value
			? await existingSafeDirectory(namespacedRoot)
			: { ok: true as const, value: false }
		if (!namespaced.ok) {
			return namespaced
		}
		if (namespaced.value) {
			root = namespacedRoot
		} else {
			const legacyState = await existingSafeDirectory(legacyRoot)
			if (!legacyState.ok) {
				return legacyState
			}
			if (!legacyState.value) {
				const namespaceReady = namespaceState.value
					? { ok: true as const, value: true as const }
					: await ensureSafeDirectory(namespace, false)
				if (!namespaceReady.ok) {
					return namespaceReady
				}
				root = namespacedRoot
			}
		}
	}
	const rootReady = await ensureSafeDirectory(root, false)
	return rootReady.ok ? { ok: true, value: root } : rootReady
}

/** @description Resolves one external coordination root per local Git repository. */
export const resolveWorkCoordinationLocation = async (input: {
	readonly root: string
	readonly projectUid?: string
	readonly stateHome?: string
	/** @internal */
	readonly executeGit?: ExecuteGit
}): Promise<WorkResult<WorkCoordinationLocation>> => {
	if (input.projectUid !== undefined && !PROJECT_UID_PATTERN.test(input.projectUid)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_operation_input',
				message: 'Project UID is invalid.',
			},
		}
	}
	let workspaceRoot: string
	try {
		workspaceRoot = await realpath(resolve(input.root))
	} catch {
		return unsafeStateLocation()
	}
	const runGit = input.executeGit ?? gitOutput
	let isGitRepository = false
	try {
		const repositoryCheck = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'])
		isGitRepository = repositoryCheck.trim() === 'true'
	} catch {
		// A normal non-Git workspace keeps coordination local.
	}
	if (!isGitRepository) {
		return {
			ok: true,
			value: {
				root: workspaceRoot,
				observation: {
					identity: identityFor(workspaceRoot),
					...(input.projectUid === undefined ? {} : { projectUid: input.projectUid }),
					scope: 'workspace',
					shared: false,
				},
			},
		}
	}
	try {
		const commonSource = await runGit(workspaceRoot, [
			'rev-parse',
			'--path-format=absolute',
			'--git-common-dir',
		])
		const commonRoot = await realpath(commonSource.trim())
		const external = await externalRoot(commonRoot, input.projectUid, input.stateHome)
		return external.ok
			? {
					ok: true,
					value: {
						root: external.value,
						observation: {
							identity: identityFor(commonRoot),
							...(input.projectUid === undefined ? {} : { projectUid: input.projectUid }),
							scope: 'repository',
							shared: true,
						},
					},
				}
			: external
	} catch {
		return unsafeStateLocation()
	}
}

/** @description Resolves the Beads directory inside disposable coordination state. */
export const resolveWorkStateLocation = async (input: {
	readonly root: string
	readonly projectId: string
	readonly projectUid?: string
	readonly stateHome?: string
	/** @internal */
	readonly executeGit?: ExecuteGit
}): Promise<WorkResult<WorkStateLocation>> => {
	if (!validProjectId(input.projectId)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_operation_input',
				message: 'Provider-state project identity is invalid.',
			},
		}
	}
	const coordination = await resolveWorkCoordinationLocation({
		root: input.root,
		...(input.projectUid === undefined ? {} : { projectUid: input.projectUid }),
		...(input.stateHome === undefined ? {} : { stateHome: input.stateHome }),
		...(input.executeGit === undefined ? {} : { executeGit: input.executeGit }),
	})
	if (!coordination.ok) {
		return coordination
	}
	const directory = join(coordination.value.root, '.beads')
	let initialized = false
	try {
		const stat = await lstat(directory)
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return unsafeStateLocation()
		}
		initialized = true
	} catch (error: unknown) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			return unsafeStateLocation()
		}
	}
	return {
		ok: true,
		value: {
			directory,
			coordinationRoot: coordination.value.root,
			initialized,
			root: coordination.value.root,
			observation: coordination.value.observation,
		},
	}
}
