/**
 * @description Creates repository-local output parents without following symlinked path components.
 *
 * @module work/paths
 * @file Paths.ts
 */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import type { WorkErrorCode, WorkResult } from './contracts'

const isMissing = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT'

const isAlreadyExists = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'EEXIST'

const createDirectoryCooperatively = async (candidate: string): Promise<boolean> => {
	try {
		await mkdir(candidate)
		return true
	} catch (error: unknown) {
		if (!isAlreadyExists(error)) {
			throw error
		}
		const information = await lstat(candidate)
		return !information.isSymbolicLink() && information.isDirectory()
	}
}

export const prepareSafeOutputPath = async (input: {
	readonly root: string
	readonly path: string
	readonly errorCode: WorkErrorCode
	readonly createParents?: boolean
}): Promise<WorkResult<string>> => {
	if (isAbsolute(input.path) || input.path.startsWith('..') || input.path.includes('/../')) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: input.errorCode,
				message: 'Output path is not repository-relative.',
			},
		}
	}
	try {
		const rootPath = await realpath(input.root)
		const parentSegments = dirname(input.path)
			.split(/[\\/]/)
			.filter((segment) => segment !== '.')
		let parentPath = rootPath
		let parentExists = true
		for (const segment of parentSegments) {
			const candidate = resolve(parentPath, segment)
			try {
				if (!parentExists) {
					parentPath = candidate
					continue
				}
				const information = await lstat(candidate)
				if (information.isSymbolicLink() || !information.isDirectory()) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: input.errorCode,
							message: 'Output path traverses an unsafe parent.',
						},
					}
				}
			} catch (error: unknown) {
				if (!isMissing(error)) {
					throw error
				}
				if (input.createParents === false) {
					parentExists = false
					parentPath = candidate
					continue
				}
				if (!(await createDirectoryCooperatively(candidate))) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: input.errorCode,
							message: 'Output path traverses an unsafe concurrently-created parent.',
						},
					}
				}
			}
			parentPath = parentExists ? await realpath(candidate) : candidate
			const localParent = relative(rootPath, parentPath)
			if (localParent.startsWith('..') || isAbsolute(localParent)) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: input.errorCode,
						message: 'Output path escapes the repository.',
					},
				}
			}
		}
		const target = resolve(parentPath, basename(input.path))
		try {
			if (!parentExists) {
				return { ok: true, value: target }
			}
			const information = await lstat(target)
			if (information.isSymbolicLink() || !information.isFile()) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: input.errorCode,
						message: 'Output path is not a regular file.',
					},
				}
			}
		} catch (error: unknown) {
			if (!isMissing(error)) {
				throw error
			}
		}
		return { ok: true, value: target }
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: input.errorCode,
				message: 'Unable to prepare output path.',
			},
		}
	}
}
