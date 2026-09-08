/**
 * @description Owns filesystem identity and process-shutdown safety for the non-shipped live evaluator.
 *
 * @module work/evals/eval-security
 * @file Eval-security.ts
 */

import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

import { readBoundedUtf8Handle } from './live-contract'

/* oxlint-disable eslint/no-bitwise -- POSIX open flags are intentionally composed as bit masks. */

const SAFE_GIT_CONFIGURATION = [
	'-c',
	'core.hooksPath=/dev/null',
	'-c',
	'core.fsmonitor=false',
	'-c',
	'credential.helper=',
	'-c',
	'pager.status=false',
	'-c',
	'init.templateDir=',
] as const

/** @description Resolves only fixed reviewed executable candidates and never consults shell PATH. */
export const trustedExecutablePath = (label: string, candidates: readonly string[]): string => {
	for (const candidate of candidates) {
		try {
			const resolved = realpathSync(candidate)
			const details = lstatSync(resolved)
			if (details.isFile() && (details.mode & 0o111) !== 0) {
				return resolved
			}
		} catch {
			// Only fixed candidates are eligible; unavailable candidates are skipped.
		}
	}
	throw new Error(`Required trusted executable is unavailable: ${label}`)
}

/** @description Prefixes trusted Git operations with config that disables executable extensions. */
export const safeGitArguments = (arguments_: readonly string[]): readonly string[] => [
	...SAFE_GIT_CONFIGURATION,
	...arguments_,
]

/** @description Removes system/global Git config and interactive helpers from evaluator commands. */
export const safeGitEnvironment = (
	base: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
	...base,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_ATTR_NOSYSTEM: '1',
	GIT_PAGER: 'cat',
	GIT_TERMINAL_PROMPT: '0',
})

const assertDockerMountSource = (path: string): void => {
	if (
		!isAbsolute(path) ||
		path.includes(',') ||
		path.includes('\r') ||
		path.includes('\n') ||
		path.includes('\0')
	) {
		throw new Error('Docker isolation rejected an unsafe bind-mount source.')
	}
}

/** @description Builds a least-privilege Docker invocation with exactly one workspace and runtime home. */
export const dockerRunArguments = (input: {
	readonly image: string
	readonly name: string
	readonly workspace: string
	readonly runtimeHome: string
	readonly runtime: 'claude' | 'codex'
	readonly runId: string
	readonly uid: number
	readonly gid: number
	readonly command: string
	readonly arguments: readonly string[]
}): readonly string[] => {
	assertDockerMountSource(input.workspace)
	assertDockerMountSource(input.runtimeHome)
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.name)) {
		throw new Error('Docker isolation rejected an unsafe container name.')
	}
	return [
		'run',
		'--rm',
		'--init',
		'--name',
		input.name,
		'--read-only',
		'--cap-drop',
		'ALL',
		'--security-opt',
		'no-new-privileges=true',
		'--pids-limit',
		'256',
		'--memory',
		'2g',
		'--cpus',
		'2',
		'--user',
		`${String(input.uid)}:${String(input.gid)}`,
		'--workdir',
		'/workspace',
		'--network',
		'bridge',
		'--add-host',
		'host.docker.internal:127.0.0.1',
		'--add-host',
		'gateway.docker.internal:127.0.0.1',
		'--tmpfs',
		'/tmp:rw,nosuid,nodev,size=268435456',
		'--mount',
		`type=bind,src=${input.workspace},dst=/workspace`,
		'--mount',
		`type=bind,src=${input.runtimeHome},dst=/runtime-home`,
		'--env',
		'HOME=/runtime-home',
		'--env',
		'USER=work-contract-eval',
		'--env',
		'LOGNAME=work-contract-eval',
		'--env',
		'PATH=/usr/local/bin:/usr/bin:/bin',
		'--env',
		'TMPDIR=/tmp',
		'--env',
		'NO_COLOR=1',
		'--env',
		'DO_NOT_TRACK=1',
		'--env',
		`WORK_CONTRACT_RUN_ID=${input.runId}`,
		'--env',
		input.runtime === 'codex'
			? 'CODEX_HOME=/runtime-home/.codex'
			: 'CLAUDE_CONFIG_DIR=/runtime-home/.claude',
		input.image,
		input.command,
		...input.arguments,
	]
}

export interface DockerCommandResult {
	readonly status: number | null
}

/** @description Stops, kills, removes, and proves absence of one named eval container. */
export const removeDockerContainer = async (input: {
	readonly name: string
	readonly execute: (arguments_: readonly string[]) => Promise<DockerCommandResult>
}): Promise<boolean> => {
	await input.execute(['stop', '--time', '2', input.name])
	await input.execute(['kill', input.name])
	await input.execute(['rm', '--force', input.name])
	const finalInspection = await input.execute(['inspect', input.name])
	return finalInspection.status !== 0
}

const isContained = (root: string, path: string): boolean => {
	const local = relative(root, path)
	return (
		local === '' ||
		(!isAbsolute(local) &&
			local !== '..' &&
			!local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
	)
}

const sameInode = (
	left: Readonly<{ readonly dev: number | bigint; readonly ino: number | bigint }>,
	right: Readonly<{ readonly dev: number | bigint; readonly ino: number | bigint }>,
): boolean => left.dev === right.dev && left.ino === right.ino

/** @description Resolves only a non-symlink directory already named by its canonical path. */
export const assertCanonicalDirectory = async (path: string): Promise<void> => {
	try {
		const [details, canonical] = await Promise.all([lstat(path), realpath(path)])
		if (!details.isDirectory() || details.isSymbolicLink() || canonical !== path) {
			throw new Error('unsafe')
		}
	} catch {
		throw new Error('Docker isolation rejected a non-canonical bind-mount source.')
	}
}

const boundDirectory = async (root: string, path: string) => {
	const handle = await open(
		path,
		constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
	)
	try {
		const [handleDetails, pathDetails, realRoot, realPath] = await Promise.all([
			handle.stat(),
			lstat(path),
			realpath(root),
			realpath(path),
		])
		if (
			!handleDetails.isDirectory() ||
			!pathDetails.isDirectory() ||
			pathDetails.isSymbolicLink() ||
			!sameInode(handleDetails, pathDetails) ||
			!isContained(realRoot, realPath)
		) {
			throw new Error('Evaluation private directory boundary rejected an unsafe path.')
		}
		return { handle, details: handleDetails, realRoot, realPath }
	} catch (error: unknown) {
		await handle.close().catch(() => false)
		throw error
	}
}

/** @description Creates one descendant directory at a time after binding every existing ancestor. */
export const createPrivateDirectoryPath = async (
	root: string,
	segments: readonly string[],
): Promise<string> => {
	try {
		let current = root
		let currentBinding = await boundDirectory(root, root)
		await currentBinding.handle.close()
		for (const segment of segments) {
			if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/.test(segment)) {
				throw new Error('Evaluation private directory boundary rejected an unsafe path.')
			}
			const next = join(current, segment)
			await mkdir(next, { mode: 0o700 }).catch((error: unknown) => {
				if (
					typeof error !== 'object' ||
					error === null ||
					!('code' in error) ||
					error.code !== 'EEXIST'
				) {
					throw error
				}
			})
			currentBinding = await boundDirectory(root, next)
			await currentBinding.handle.close()
			current = next
		}
		return current
	} catch {
		throw new Error('Evaluation private directory boundary rejected an unsafe path.')
	}
}

/** @description Pins Beads discovery to a fresh fixture instead of an ancestor repository. */
export const establishWorkFixtureBoundary = async (fixtureRoot: string): Promise<string> => {
	await assertCanonicalDirectory(fixtureRoot)
	return createPrivateDirectoryPath(fixtureRoot, ['.beads'])
}

/** @description Reads only a single-link regular file whose opened inode matches its contained path. */
export const readBoundedContainedUtf8 = async (
	root: string,
	path: string,
	maxBytes: number,
): Promise<string | undefined> => {
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
		const [handleDetails, pathDetails, realRoot, realPath] = await Promise.all([
			handle.stat(),
			lstat(path),
			realpath(root),
			realpath(path),
		])
		if (
			!handleDetails.isFile() ||
			!pathDetails.isFile() ||
			pathDetails.isSymbolicLink() ||
			handleDetails.nlink !== 1 ||
			pathDetails.nlink !== 1 ||
			!sameInode(handleDetails, pathDetails) ||
			!isContained(realRoot, realPath)
		) {
			return undefined
		}
		return await readBoundedUtf8Handle(handle, maxBytes)
	} catch {
		return undefined
	} finally {
		if (handle !== undefined) {
			await handle.close().catch(() => false)
		}
	}
}

/** @description Enumerates a bounded directory only while its opened inode remains at one contained path. */
export const readContainedDirectoryEntries = async (
	root: string,
	path: string,
	maxEntries: number,
): Promise<readonly string[]> => {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
		return []
	}
	let binding: Awaited<ReturnType<typeof boundDirectory>> | undefined
	try {
		binding = await boundDirectory(root, path)
		const entries = await readdir(path)
		if (entries.length > maxEntries) {
			return []
		}
		const [afterDetails, afterRealPath] = await Promise.all([lstat(path), realpath(path)])
		if (
			!afterDetails.isDirectory() ||
			afterDetails.isSymbolicLink() ||
			!sameInode(binding.details, afterDetails) ||
			afterRealPath !== binding.realPath ||
			!isContained(binding.realRoot, afterRealPath)
		) {
			return []
		}
		return entries
	} catch {
		return []
	} finally {
		await binding?.handle.close().catch(() => false)
	}
}

/** @description Creates one private output file without following or replacing an existing inode. */
export const writeExclusivePrivateFile = async (
	root: string,
	path: string,
	source: string,
): Promise<void> => {
	let parent: Awaited<ReturnType<typeof boundDirectory>> | undefined
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		parent = await boundDirectory(root, dirname(path))
		handle = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		)
		const [handleDetails, pathDetails, realPath] = await Promise.all([
			handle.stat(),
			lstat(path),
			realpath(path),
		])
		if (
			!handleDetails.isFile() ||
			!pathDetails.isFile() ||
			pathDetails.isSymbolicLink() ||
			handleDetails.nlink !== 1 ||
			pathDetails.nlink !== 1 ||
			!sameInode(handleDetails, pathDetails) ||
			!isContained(parent.realRoot, realPath)
		) {
			throw new Error('Evaluation private file boundary rejected an unsafe path.')
		}
		await handle.writeFile(source, 'utf8')
		await handle.sync()
		const afterDetails = await lstat(path)
		if (!sameInode(handleDetails, afterDetails) || afterDetails.nlink !== 1) {
			throw new Error('Evaluation private file boundary rejected an unsafe path.')
		}
	} catch {
		throw new Error('Evaluation private file boundary rejected an unsafe path.')
	} finally {
		if (handle !== undefined) {
			await handle.close().catch(() => false)
		}
		await parent?.handle.close().catch(() => false)
	}
}

export interface DetachedProcessGroup {
	readonly pid: number
	readonly closed: Promise<void>
	readonly isClosed: () => boolean
}

/** @description Stops every detached runtime group before removing its credential material. */
export const shutdownEvalResources = async (input: {
	readonly groups: readonly DetachedProcessGroup[]
	readonly killGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
	readonly wait: (milliseconds: number) => Promise<void>
	readonly cleanupCredentials: () => Promise<boolean>
	readonly graceMs: number
}): Promise<{ readonly processesTerminated: boolean; readonly credentialsRemoved: boolean }> => {
	for (const group of input.groups) {
		try {
			input.killGroup(group.pid, 'SIGTERM')
		} catch {
			// A group may close after the snapshot and before signaling.
		}
	}
	await Promise.race([
		Promise.all(input.groups.map(async ({ closed }) => closed)),
		input.wait(input.graceMs),
	])
	for (const group of input.groups) {
		if (!group.isClosed()) {
			try {
				input.killGroup(group.pid, 'SIGKILL')
			} catch {
				// A group may close after the grace interval and before escalation.
			}
		}
	}
	await Promise.race([
		Promise.all(input.groups.map(async ({ closed }) => closed)),
		input.wait(input.graceMs),
	])
	const processesTerminated = input.groups.every(({ isClosed }) => isClosed())
	const credentialsRemoved = await input.cleanupCredentials()
	return { processesTerminated, credentialsRemoved }
}
