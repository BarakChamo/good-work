/**
 * @description Bounds and permission-hardens retained live-evaluation artifacts without recursion.
 *
 * @module work/evals/artifact-retention
 * @file Artifact-retention.ts
 */

import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

/* oxlint-disable eslint/no-bitwise -- POSIX open flags bind permission changes to inspected inodes. */

export const EVAL_ARTIFACT_LIMITS = Object.freeze({
	entries: 20_000,
	depth: 64,
	bytes: 512 * 1024 * 1024,
})

/** @description Sanitized failure for an artifact tree that cannot be retained safely. */
export class EvalArtifactBoundaryError extends Error {
	public readonly code = 'eval_artifact_boundary_exceeded'

	public constructor() {
		super('Evaluation artifacts exceed the bounded retention contract.')
		this.name = 'EvalArtifactBoundaryError'
	}
}

/** @description Closes a directory across Node- and Bun-compatible sync/async implementations. */
export const closeDirectoryBestEffort = async (directory: {
	readonly close: () => void | Promise<void>
}): Promise<void> => {
	try {
		await directory.close()
	} catch {
		// A completed async iterator may already have closed the directory handle.
	}
}

/** @description Validates a no-symlink tree within fixed budgets, then restricts its permissions. */
export const secureArtifactTree = async (
	root: string,
	limits: Readonly<{
		readonly entries: number
		readonly depth: number
		readonly bytes: number
	}> = EVAL_ARTIFACT_LIMITS,
): Promise<void> => {
	if (
		!Number.isSafeInteger(limits.entries) ||
		limits.entries < 1 ||
		!Number.isSafeInteger(limits.depth) ||
		limits.depth < 0 ||
		!Number.isSafeInteger(limits.bytes) ||
		limits.bytes < 0
	) {
		throw new EvalArtifactBoundaryError()
	}
	const pending: { readonly path: string; readonly depth: number }[] = [{ path: root, depth: 0 }]
	let entries = 0
	let bytes = 0
	for (const current of pending) {
		if (current.depth > limits.depth) {
			throw new EvalArtifactBoundaryError()
		}
		const details = await lstat(current.path)
		entries += 1
		if (entries > limits.entries || details.isSymbolicLink()) {
			throw new EvalArtifactBoundaryError()
		}
		let handle: Awaited<ReturnType<typeof open>>
		try {
			const flags =
				constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(details.isDirectory() ? (constants.O_DIRECTORY ?? 0) : 0)
			handle = await open(current.path, flags)
		} catch {
			throw new EvalArtifactBoundaryError()
		}
		let boundDetails: Awaited<ReturnType<typeof handle.stat>>
		try {
			boundDetails = await handle.stat()
			if (boundDetails.dev !== details.dev || boundDetails.ino !== details.ino) {
				throw new EvalArtifactBoundaryError()
			}
			if (details.isFile() && (!boundDetails.isFile() || boundDetails.nlink !== 1)) {
				throw new EvalArtifactBoundaryError()
			}
			if (details.isDirectory() && !boundDetails.isDirectory()) {
				throw new EvalArtifactBoundaryError()
			}
			if (!details.isFile() && !details.isDirectory()) {
				throw new EvalArtifactBoundaryError()
			}
			await handle.chmod(details.isDirectory() ? 0o700 : 0o600)
		} finally {
			await handle.close().catch(() => false)
		}
		if (details.isFile()) {
			bytes += boundDetails.size
			if (bytes > limits.bytes) {
				throw new EvalArtifactBoundaryError()
			}
			continue
		}
		const directory = await opendir(current.path)
		try {
			for await (const entry of directory) {
				if (pending.length + 1 > limits.entries) {
					throw new EvalArtifactBoundaryError()
				}
				pending.push({
					path: join(current.path, entry.name),
					depth: current.depth + 1,
				})
			}
		} finally {
			await closeDirectoryBestEffort(directory)
		}
	}
}
