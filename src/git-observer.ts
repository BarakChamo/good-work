/**
 * @description Produces sanitized, read-only Git workspace observations for policy admission.
 *
 * @module work/git-observer
 * @file Git-observer.ts
 */

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { env as processEnvironment } from 'node:process'

import type { WorkResult, WorkspaceObservation } from './contracts'
import { measureCommandPhase } from './command-profile'
import { executeFile } from './subprocess'

const gitOutput = async (
	root: string,
	args: readonly string[],
	options: { readonly trim?: boolean } = {},
): Promise<string> => {
	const result = await executeFile('git', args, {
		cwd: root,
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	})
	return options.trim === false ? result.stdout : result.stdout.trim()
}

const operationalProjection = (path: string): boolean =>
	path === '.beads/interactions.jsonl' ||
	path === '.work/lock.json' ||
	path === '.work/snapshots/current.json' ||
	/^\.work\/beads-[a-f0-9]{12,16}(?:-[a-f0-9]{12})?\.lock(?:\.release-[0-9a-f-]{36})?$/u.test(path)

/** @description Observes Git identity, revision, isolation, and meaningful dirtiness without mutation. */
const observeGitWorkspaceInternal = async (input: {
	readonly root: string
}): Promise<WorkResult<WorkspaceObservation>> => {
	try {
		const [commonDirectory, gitDirectory, headSha, treeSha, symbolicRef, status] =
			await Promise.all([
				gitOutput(input.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
				gitOutput(input.root, ['rev-parse', '--path-format=absolute', '--git-dir']),
				gitOutput(input.root, ['rev-parse', 'HEAD']),
				gitOutput(input.root, ['rev-parse', 'HEAD^{tree}']),
				gitOutput(input.root, ['symbolic-ref', '-q', 'HEAD']).catch(() => ''),
				gitOutput(input.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
					trim: false,
				}),
			])
		const canonicalCommon = await realpath(commonDirectory).catch(() => commonDirectory)
		const canonicalGit = await realpath(gitDirectory).catch(() => gitDirectory)
		const paths = status
			.split('\0')
			.filter(Boolean)
			.map((entry) => entry.slice(3).split(' -> ').at(-1) ?? '')
		const inContainer = processEnvironment.WORK_CONTRACT_CONTAINER === '1'
		let isolation: WorkspaceObservation['isolation'] =
			canonicalCommon === canonicalGit ? 'main' : 'worktree'
		if (inContainer) {
			isolation = 'container'
		}
		return {
			ok: true,
			value: {
				available: true,
				repositoryId: createHash('sha256').update(canonicalCommon).digest('hex'),
				headSha,
				treeSha,
				...(symbolicRef === '' ? {} : { ref: symbolicRef }),
				isolation,
				dirty: paths.some((path) => !operationalProjection(path)),
			},
		}
	} catch {
		return {
			ok: true,
			value: { available: false, isolation: 'none', dirty: false },
		}
	}
}

/** @description Observes Git workspace state under the active command performance profile. */
export const observeGitWorkspace = async (input: {
	readonly root: string
}): Promise<WorkResult<WorkspaceObservation>> =>
	measureCommandPhase('git_observation', async () => observeGitWorkspaceInternal(input))
