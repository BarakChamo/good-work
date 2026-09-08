/**
 * @description Bounded filesystem reads for untrusted repository and provider-adjacent files.
 *
 * @module work/files
 * @file Files.ts
 */

import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

import type { WorkErrorCode, WorkResult } from './contracts'

/* oxlint-disable eslint/no-bitwise -- Node file-open flags are bitmasks by contract. */

export const INPUT_LIMITS = Object.freeze({
	manifestBytes: 1_000_000,
	proposalBytes: 1_000_000,
	proposalItems: 100,
	sourceBytes: 5_000_000,
	sourceAggregateBytes: 16_000_000,
	evidenceBytes: 16_000_000,
	summaryBytes: 4000,
	sourceItems: 1024,
	sourceEntries: 100_000,
	providerItems: 1024,
	providerItemBytes: 48 * 1024,
	providerAggregateBytes: 1024 * (48 * 1024 + 1) + 2,
})

const noFollow = constants.O_NOFOLLOW ?? 0

const SAFE_SYSTEM_ERROR_CODES = new Set([
	'EACCES',
	'EBUSY',
	'EDQUOT',
	'EEXIST',
	'EISDIR',
	'ELOOP',
	'EMFILE',
	'ENFILE',
	'ENOENT',
	'ENOSPC',
	'ENOTDIR',
	'EPERM',
	'EROFS',
])

const safeSystemErrorCode = (error: unknown): string | undefined => {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined
	}
	const code = error.code
	return typeof code === 'string' && SAFE_SYSTEM_ERROR_CODES.has(code) ? code : undefined
}

/** @description Redacts exception text while retaining an allowlisted system error category. */
export const safeSystemErrorDetails = (error: unknown): readonly string[] | undefined => {
	const code = safeSystemErrorCode(error)
	return code === undefined ? undefined : [`System error code: ${code}.`]
}

const safeFileError = (message: string, error: unknown): Error => {
	const code = safeSystemErrorCode(error)
	const sanitized = new Error(
		code === undefined ? message : `${message} System error code: ${code}.`,
	)
	if (code !== undefined) {
		Object.defineProperty(sanitized, 'code', { value: code })
	}
	return sanitized
}

const failure = (input: {
	readonly code: WorkErrorCode
	readonly message: string
	readonly details?: readonly string[]
}): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: input.code,
		message: input.message,
		...(input.details === undefined ? {} : { details: input.details }),
	},
})

const readBoundedHandle = async (
	handle: FileHandle,
	input: {
		readonly maxBytes: number
		readonly unavailableCode: WorkErrorCode
		readonly tooLargeCode: WorkErrorCode
		readonly label: string
	},
): Promise<WorkResult<Uint8Array>> => {
	const information = await handle.stat()
	if (!information.isFile()) {
		return failure({
			code: input.unavailableCode,
			message: `${input.label} is not a regular file.`,
		})
	}
	if (information.size > input.maxBytes) {
		return failure({
			code: input.tooLargeCode,
			message: `${input.label} exceeds ${input.maxBytes} bytes.`,
		})
	}
	const chunks: Uint8Array[] = []
	let total = 0
	while (total <= input.maxBytes) {
		const buffer = new Uint8Array(Math.min(64 * 1024, input.maxBytes + 1 - total))
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
		if (bytesRead === 0) {
			return { ok: true, value: Buffer.concat(chunks, total) }
		}
		chunks.push(buffer.subarray(0, bytesRead))
		total += bytesRead
	}
	return failure({
		code: input.tooLargeCode,
		message: `${input.label} exceeds ${input.maxBytes} bytes.`,
	})
}

const closeBoundedHandle = async (
	handle: FileHandle | undefined,
	result: WorkResult<Uint8Array>,
	input: { readonly unavailableCode: WorkErrorCode; readonly label: string },
): Promise<WorkResult<Uint8Array>> => {
	if (handle === undefined) {
		return result
	}
	try {
		await handle.close()
		return result
	} catch (error: unknown) {
		const cleanupDetails = ['File-handle cleanup failed.', ...(safeSystemErrorDetails(error) ?? [])]
		return result.ok
			? failure({
					code: input.unavailableCode,
					message: `${input.label} was read but its file handle could not be closed.`,
					details: cleanupDetails,
				})
			: {
					ok: false,
					error: {
						...result.error,
						details: [...(result.error.details ?? []), ...cleanupDetails],
					},
				}
	}
}

/** @description Reads no more than maxBytes plus one sentinel byte before failing closed. */
export const readBoundedFile = async (input: {
	readonly path: string
	readonly maxBytes: number
	readonly unavailableCode: WorkErrorCode
	readonly tooLargeCode: WorkErrorCode
	readonly label: string
}): Promise<WorkResult<Uint8Array>> => {
	let handle: FileHandle | undefined
	let result: WorkResult<Uint8Array>
	try {
		handle = await open(input.path, constants.O_RDONLY | noFollow)
		result = await readBoundedHandle(handle, input)
	} catch (error: unknown) {
		const details = safeSystemErrorDetails(error)
		result = failure({
			code: input.unavailableCode,
			message: `${input.label} cannot be read.`,
			...(details === undefined ? {} : { details }),
		})
	}
	return closeBoundedHandle(handle, result, input)
}

/** @description Reads a repository-contained file through the same handle whose inode is validated. */
export const readBoundedContainedFile = async (input: {
	readonly root: string
	readonly reference: string
	readonly maxBytes: number
	readonly unsafeCode: WorkErrorCode
	readonly unavailableCode: WorkErrorCode
	readonly tooLargeCode: WorkErrorCode
	readonly label: string
	readonly unsafeMessage?: string
	readonly afterOpen?: () => Promise<void>
}): Promise<WorkResult<Uint8Array>> => {
	let handle: FileHandle | undefined
	let result: WorkResult<Uint8Array>
	try {
		const rootPath = await realpath(input.root)
		const requestedPath = resolve(input.root, input.reference)
		handle = await open(requestedPath, constants.O_RDONLY | noFollow)
		await input.afterOpen?.()
		const [opened, canonicalPath] = await Promise.all([handle.stat(), realpath(requestedPath)])
		const pathInformation = await lstat(canonicalPath)
		const relativePath = relative(rootPath, canonicalPath)
		if (
			relativePath === '' ||
			relativePath.startsWith('..') ||
			isAbsolute(relativePath) ||
			opened.dev !== pathInformation.dev ||
			opened.ino !== pathInformation.ino
		) {
			result = failure({
				code: input.unsafeCode,
				message: input.unsafeMessage ?? `${input.label} must remain within the repository.`,
			})
		} else {
			result = await readBoundedHandle(handle, input)
		}
	} catch (error: unknown) {
		const details = safeSystemErrorDetails(error)
		const unsafeSymlink = safeSystemErrorCode(error) === 'ELOOP'
		result = failure({
			code: unsafeSymlink ? input.unsafeCode : input.unavailableCode,
			message: unsafeSymlink
				? (input.unsafeMessage ?? `${input.label} must remain within the repository.`)
				: `${input.label} cannot be read.`,
			...(details === undefined ? {} : { details }),
		})
	}
	return closeBoundedHandle(handle, result, input)
}

/** @description Writes one UTF-8 payload without following a symlink at the final path component. */
export const writeUtf8NoFollow = async (input: {
	readonly path: string
	readonly content: string
	readonly mode: 'append' | 'exclusive' | 'replace'
}): Promise<void> => {
	if (input.mode === 'replace') {
		const temporary = `${input.path}.work-contract-${randomUUID()}.tmp`
		let temporaryHandle: FileHandle | undefined
		let writeError: unknown
		try {
			temporaryHandle = await open(
				temporary,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
				0o600,
			)
			await temporaryHandle.writeFile(input.content, { encoding: 'utf8' })
			await temporaryHandle.sync()
			await temporaryHandle.close()
			temporaryHandle = undefined
			await rename(temporary, input.path)
			return
		} catch (error: unknown) {
			writeError = error
		} finally {
			if (temporaryHandle !== undefined) {
				await temporaryHandle.close().catch(() => false)
			}
			await rm(temporary, { force: true }).catch(() => false)
		}
		throw safeFileError('Atomic file replacement failed.', writeError)
	}
	const modeFlags = {
		append: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
		exclusive: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
	} as const
	let handle: FileHandle
	try {
		handle = await open(input.path, modeFlags[input.mode] | noFollow, 0o600)
	} catch (error: unknown) {
		throw safeFileError('File open failed.', error)
	}
	let writeError: unknown
	try {
		await handle.writeFile(input.content, { encoding: 'utf8' })
	} catch (error: unknown) {
		writeError = error
	}
	try {
		await handle.close()
	} catch (error: unknown) {
		if (writeError === undefined) {
			throw safeFileError('File-handle cleanup failed.', error)
		}
	}
	if (writeError !== undefined) {
		throw safeFileError('File write failed.', writeError)
	}
}

/** @description Decodes a bounded file as UTF-8 after the byte ceiling is enforced. */
export const readBoundedUtf8 = async (
	input: Parameters<typeof readBoundedFile>[0] & {
		readonly invalidUtf8Code?: WorkErrorCode
	},
): Promise<WorkResult<string>> => {
	const content = await readBoundedFile(input)
	if (!content.ok) {
		return content
	}
	try {
		return {
			ok: true,
			value: new TextDecoder('utf-8', { fatal: true }).decode(content.value),
		}
	} catch {
		return failure({
			code: input.invalidUtf8Code ?? input.unavailableCode,
			message: `${input.label} is not valid UTF-8.`,
		})
	}
}

/** @description Decodes a repository-contained bounded file through its validated open handle. */
export const readBoundedContainedUtf8 = async (
	input: Parameters<typeof readBoundedContainedFile>[0] & {
		readonly invalidUtf8Code?: WorkErrorCode
	},
): Promise<WorkResult<string>> => {
	const content = await readBoundedContainedFile(input)
	if (!content.ok) {
		return content
	}
	try {
		return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(content.value) }
	} catch {
		return failure({
			code: input.invalidUtf8Code ?? input.unavailableCode,
			message: `${input.label} is not valid UTF-8.`,
		})
	}
}
