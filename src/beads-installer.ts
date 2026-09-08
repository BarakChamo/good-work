/**
 * @description Installs the pinned Beads release after validating its official SHA-256 manifest.
 *
 * @module work/beads-installer
 * @file Beads-installer.ts
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { installationFailure } from './beads-installer-errors'
import type { InstallationCleanupTarget, InstallationStage } from './beads-installer-errors'
import type { WorkResult } from './contracts'

const SUPPORTED_BEADS_VERSION = '1.2.2'

interface ReleaseTarget {
	readonly archiveName: string
	readonly binaryName: 'bd' | 'bd.exe'
}

/** @internal */
export interface BeadsInstallerRuntime {
	readonly architecture: string
	readonly changeMode: (path: string, mode: number) => Promise<void>
	readonly copyFile: (source: string, destination: string) => Promise<void>
	readonly fetch: (url: string) => Promise<Response>
	readonly makeTemporaryDirectory: (prefix: string) => Promise<string>
	readonly platform: string
	readonly readFile: (path: string) => Promise<Uint8Array>
	readonly remove: (path: string, recursive: boolean) => Promise<void>
	readonly rename: (source: string, destination: string) => Promise<void>
	readonly resolveLauncherPath: () => string
	readonly spawn: (
		command: string,
		args: readonly string[],
	) => { readonly status: number | null; readonly stdout: string }
	readonly writeFile: (path: string, content: Uint8Array) => Promise<void>
}

const releaseRoot = `https://github.com/gastownhall/beads/releases/download/v${SUPPORTED_BEADS_VERSION}`
const maximumChecksumBytes = 2 * 1024 * 1024
const maximumArchiveBytes = 200 * 1024 * 1024
const platformNames: Readonly<Record<string, string | undefined>> = {
	android: 'android',
	darwin: 'darwin',
	linux: 'linux',
	win32: 'windows',
}
const architectureNames: Readonly<Record<string, string | undefined>> = {
	arm64: 'arm64',
	x64: 'amd64',
}

const defaultRuntime: BeadsInstallerRuntime = {
	architecture: process.arch,
	changeMode: chmod,
	copyFile,
	fetch: async (url) => fetch(url, { redirect: 'follow' }),
	makeTemporaryDirectory: mkdtemp,
	platform: process.platform,
	readFile,
	remove: async (path, recursive) =>
		rm(path, {
			force: true,
			maxRetries: recursive ? 5 : 0,
			recursive,
			retryDelay: 100,
		}),
	rename,
	resolveLauncherPath: () => createRequire(import.meta.url).resolve('@beads/bd/bin/bd.js'),
	spawn: (command, args) => {
		const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
		return { status: result.status, stdout: result.stdout }
	},
	writeFile,
}

/** @description Maps a supported Node host to the exact pinned release archive. */
export const resolveReleaseTarget = (platform: string, architecture: string): ReleaseTarget => {
	const releasePlatform = platformNames[platform]
	if (releasePlatform === undefined) {
		throw new Error(`Unsupported Beads platform: ${platform}`)
	}
	const releaseArchitecture = architectureNames[architecture]
	if (releaseArchitecture === undefined) {
		throw new Error(`Unsupported Beads architecture: ${architecture}`)
	}
	const extension = releasePlatform === 'windows' ? 'zip' : 'tar.gz'
	return {
		archiveName: `beads_${SUPPORTED_BEADS_VERSION}_${releasePlatform}_${releaseArchitecture}.${extension}`,
		binaryName: releasePlatform === 'windows' ? 'bd.exe' : 'bd',
	}
}

/** @description Selects one exact archive checksum from the official manifest. */
export const parseExpectedChecksum = (manifest: string, archiveName: string): string => {
	const matches = manifest
		.split(/\r?\n/u)
		.map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/u.exec(line.trim()))
		.filter((match): match is RegExpExecArray => match?.[2] === archiveName)
	if (matches.length === 0) {
		throw new Error(`Official checksum manifest is missing ${archiveName}`)
	}
	if (matches.length > 1) {
		throw new Error(`Official checksum manifest has a duplicate entry for ${archiveName}`)
	}
	const checksum = matches[0]?.[1]
	if (checksum === undefined) {
		throw new Error(`Official checksum manifest is missing ${archiveName}`)
	}
	return checksum.toLowerCase()
}

/** @description Verifies an installed release reports the pinned semantic version. */
export const parseBeadsVersionOutput = (output: string): string => {
	const version = /^bd version ([^\s]+)/u.exec(output.trim())?.[1]
	if (version !== SUPPORTED_BEADS_VERSION) {
		throw new Error(
			`Expected bd version ${SUPPORTED_BEADS_VERSION}, received ${version ?? 'unknown'}`,
		)
	}
	return version
}

const download = async (
	runtime: BeadsInstallerRuntime,
	url: string,
	maximumBytes: number,
): Promise<Uint8Array> => {
	const response = await runtime.fetch(url)
	if (!response.ok) {
		throw new Error(`Download failed (${response.status}) for the pinned Beads release.`)
	}
	const contentLength = response.headers.get('content-length')
	const declaredLength = contentLength === null ? undefined : Number(contentLength)
	if (
		declaredLength !== undefined &&
		(!Number.isSafeInteger(declaredLength) || declaredLength < 0)
	) {
		throw new Error('Download returned an invalid content length.')
	}
	if (declaredLength !== undefined && declaredLength > maximumBytes) {
		throw new Error(`Download exceeds the ${maximumBytes}-byte safety limit.`)
	}
	if (response.body === null) {
		throw new Error('Download returned no response body.')
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	while (true) {
		const result = await reader.read()
		if (result.done) {
			break
		}
		const chunk: unknown = result.value
		if (!(chunk instanceof Uint8Array)) {
			throw new Error('Download returned an invalid response chunk.')
		}
		if (totalBytes + chunk.byteLength > maximumBytes) {
			try {
				await reader.cancel()
			} catch {
				// Cancellation is best-effort after the bounded reader rejects the stream.
			}
			throw new Error(`Download exceeds the ${maximumBytes}-byte safety limit.`)
		}
		chunks.push(chunk)
		totalBytes += chunk.byteLength
	}
	if (totalBytes === 0) {
		throw new Error('Downloaded Beads release has an invalid size.')
	}

	const content = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		content.set(chunk, offset)
		offset += chunk.byteLength
	}
	return content
}

const run = (runtime: BeadsInstallerRuntime, command: string, args: readonly string[]): void => {
	const result = runtime.spawn(command, args)
	if (result.status !== 0) {
		throw new Error(`${command} failed while extracting the pinned Beads release.`)
	}
}

/** @description Downloads, verifies, and atomically installs the pinned native Beads binary. */
export const installPinnedBeads = async (
	runtime: BeadsInstallerRuntime = defaultRuntime,
): Promise<WorkResult<string>> => {
	let temporaryRoot: string | undefined
	let temporaryBinary: string | undefined
	let stage: InstallationStage = 'target_resolution'
	let result: WorkResult<string>
	try {
		const target = resolveReleaseTarget(runtime.platform, runtime.architecture)
		stage = 'temporary_setup'
		temporaryRoot = await runtime.makeTemporaryDirectory(
			join(tmpdir(), 'work-contract-beads-install-'),
		)
		stage = 'checksum_download'
		const checksumBytes = await download(
			runtime,
			`${releaseRoot}/checksums.txt`,
			maximumChecksumBytes,
		)
		stage = 'checksum_manifest'
		const checksumManifest = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes)
		const expectedChecksum = parseExpectedChecksum(checksumManifest, target.archiveName)
		stage = 'archive_download'
		const archiveBytes = await download(
			runtime,
			`${releaseRoot}/${target.archiveName}`,
			maximumArchiveBytes,
		)
		stage = 'archive_checksum'
		const actualChecksum = createHash('sha256').update(archiveBytes).digest('hex')
		if (actualChecksum !== expectedChecksum) {
			throw new Error(`Checksum mismatch for ${target.archiveName}`)
		}

		const archivePath = join(temporaryRoot, target.archiveName)
		await runtime.writeFile(archivePath, archiveBytes)
		stage = 'archive_extraction'
		if (target.archiveName.endsWith('.zip')) {
			run(runtime, 'powershell', [
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${temporaryRoot.replaceAll("'", "''")}' -Force`,
			])
		} else {
			run(runtime, 'tar', ['-xzf', archivePath, '-C', temporaryRoot])
		}

		stage = 'binary_version'
		const extractedBinary = join(temporaryRoot, target.binaryName)
		const versionResult = runtime.spawn(extractedBinary, ['version'])
		if (versionResult.status !== 0) {
			throw new Error('Downloaded Beads binary failed its version check.')
		}
		parseBeadsVersionOutput(versionResult.stdout)

		stage = 'binary_publication'
		const launcher = runtime.resolveLauncherPath()
		const binaryPath = join(dirname(launcher), target.binaryName)
		temporaryBinary = `${binaryPath}.tmp-${process.pid}-${randomUUID()}`
		await runtime.copyFile(extractedBinary, temporaryBinary)
		if (target.binaryName === 'bd') {
			await runtime.changeMode(temporaryBinary, 0o755)
		}
		await runtime.rename(temporaryBinary, binaryPath)
		const installed = await runtime.readFile(binaryPath)
		if (installed.byteLength === 0) {
			throw new Error('Installed Beads binary is empty.')
		}
		result = { ok: true, value: versionResult.stdout.trim() }
	} catch {
		result = installationFailure(stage)
	}

	const failedCleanupTargets: InstallationCleanupTarget[] = []
	for (const [path, target] of [
		[temporaryBinary, 'provider_binary_directory'],
		[temporaryRoot, 'operating_system_temp_directory'],
	] as const) {
		if (path !== undefined) {
			try {
				await runtime.remove(path, path === temporaryRoot)
			} catch {
				failedCleanupTargets.push(target)
			}
		}
	}
	if (
		failedCleanupTargets.length > 0 &&
		(!result.ok || failedCleanupTargets.includes('provider_binary_directory'))
	) {
		return installationFailure(result.ok ? 'cleanup' : stage, failedCleanupTargets)
	}
	return result
}
