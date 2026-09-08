/**
 * @description Resolves Git-backed work definitions from one exact configured target-ref snapshot.
 *
 * @module work/definition-authority
 * @file Definition-authority.ts
 */

import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import picomatch from 'picomatch'

import { compileWorkGraph, loadWorkManifest } from './compiler'
import { COMPLETION_LEDGER_DIRECTORY, loadCompletionLedger } from './completion-ledger'
import type { CompletionRecord } from './completion-ledger'
import type {
	CanonicalDefinitionRevision,
	CompiledWorkGraph,
	WorkManifest,
	WorkResult,
} from './contracts'
import { INPUT_LIMITS, safeSystemErrorDetails } from './files'
import { executeFile, executeFileBytes } from './subprocess'

const GIT_TIMEOUT_MS = 10_000
const GIT_TREE_BUFFER_BYTES = 16_000_000

interface CanonicalProject {
	readonly manifest: WorkManifest
	readonly graph: CompiledWorkGraph
	readonly completionRecords: readonly CompletionRecord[]
	readonly definitionRevision?: CanonicalDefinitionRevision
}

/** @description Diagnostic comparison between caller-worktree files and the canonical graph. */
export interface WorkspaceDefinitionOverlay {
	readonly status: 'same' | 'different' | 'invalid'
	readonly graphFingerprint?: string
}

const failure = (message: string, error?: unknown): WorkResult<never> => {
	const details = error === undefined ? undefined : safeSystemErrorDetails(error)
	return {
		ok: false,
		error: {
			type: 'work_contract_error',
			code: 'canonical_definition_drift',
			message,
			...(details === undefined ? {} : { details }),
		},
	}
}

const git = async (
	root: string,
	arguments_: readonly string[],
	maxBuffer: number,
): Promise<string> => {
	const result = await executeFile('git', arguments_, {
		cwd: root,
		maxBuffer,
		timeout: GIT_TIMEOUT_MS,
	})
	return result.stdout
}

interface CanonicalRepositoryContext {
	readonly authorityRef: string
	readonly projectPrefix: string
	readonly repositoryRoot: string
}

const hasGitMarker = async (root: string): Promise<boolean> => {
	let current = resolve(root)
	for (;;) {
		try {
			await lstat(resolve(current, '.git'))
			return true
		} catch (error: unknown) {
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code !== 'ENOENT'
			) {
				return true
			}
			const parent = dirname(current)
			if (parent === current) {
				return false
			}
			current = parent
		}
	}
}

const primaryWorktree = (source: string): string | undefined => {
	for (const field of source.split('\0')) {
		if (!field.startsWith('worktree ')) {
			continue
		}
		const path = field.slice('worktree '.length)
		return isAbsolute(path) &&
			path.length <= 4096 &&
			!path.includes('\0') &&
			!path.includes('\r') &&
			!path.includes('\n')
			? path
			: undefined
	}
	return undefined
}

const repositoryLocation = async (
	root: string,
): Promise<WorkResult<CanonicalRepositoryContext | undefined>> => {
	const gitMarker = await hasGitMarker(root)
	try {
		const [resolvedRoot, repositoryRootOutput, commonDirectoryOutput, worktreesOutput] =
			await Promise.all([
				realpath(root),
				git(root, ['rev-parse', '--show-toplevel'], 4096),
				git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 4096),
				git(root, ['worktree', 'list', '--porcelain', '-z'], GIT_TREE_BUFFER_BYTES),
			])
		const repositoryRoot = await realpath(repositoryRootOutput.trim())
		const commonDirectory = await realpath(commonDirectoryOutput.trim())
		const primaryPath = primaryWorktree(worktreesOutput)
		if (primaryPath === undefined) {
			return failure('Canonical Git primary worktree cannot be resolved.')
		}
		const primaryRoot = await realpath(primaryPath)
		const primaryCommonDirectoryOutput = await git(
			primaryRoot,
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			4096,
		)
		const primaryCommonDirectory = await realpath(primaryCommonDirectoryOutput.trim())
		if (primaryCommonDirectory !== commonDirectory) {
			return failure('Canonical Git primary worktree does not share repository state.')
		}
		const authorityRefOutput = await git(primaryRoot, ['symbolic-ref', '--quiet', 'HEAD'], 4096)
		const authorityRef = authorityRefOutput.trim()
		await git(primaryRoot, ['check-ref-format', authorityRef], 4096)
		const projectPrefix = relative(repositoryRoot, resolvedRoot).replaceAll('\\', '/')
		if (projectPrefix.startsWith('..') || isAbsolute(projectPrefix)) {
			return failure('Work project root is outside the canonical Git repository.')
		}
		return { ok: true, value: { authorityRef, repositoryRoot, projectPrefix } }
	} catch (error: unknown) {
		return gitMarker
			? failure('Canonical Git repository cannot be resolved.', error)
			: { ok: true, value: undefined }
	}
}

const gitPath = (prefix: string, path: string): string =>
	prefix === '' ? path : `${prefix}/${path}`

const readBlob = async (input: {
	readonly root: string
	readonly targetSha: string
	readonly path: string
	readonly maxBytes: number
}): Promise<WorkResult<string>> => {
	try {
		const result = await executeFileBytes('git', ['show', `${input.targetSha}:${input.path}`], {
			cwd: input.root,
			maxBuffer: input.maxBytes + 1,
			timeout: GIT_TIMEOUT_MS,
		})
		if (result.stdout.byteLength > input.maxBytes) {
			return failure('Canonical definition source exceeds its bounded size contract.')
		}
		try {
			return {
				ok: true,
				value: new TextDecoder('utf-8', { fatal: true }).decode(result.stdout),
			}
		} catch {
			return failure('Canonical definition source must be valid UTF-8.')
		}
	} catch (error: unknown) {
		return failure('Canonical definition source cannot be read.', error)
	}
}

interface TreeEntry {
	readonly mode: string
	readonly path: string
	readonly size?: number
	readonly type: string
}

const listTree = async (input: {
	readonly root: string
	readonly targetSha: string
	readonly projectPrefix: string
}): Promise<WorkResult<readonly TreeEntry[]>> => {
	try {
		const scope = input.projectPrefix === '' ? '.' : input.projectPrefix
		const output = await git(
			input.root,
			['ls-tree', '-r', '-z', '--long', input.targetSha, '--', scope],
			GIT_TREE_BUFFER_BYTES,
		)
		const records = output.split('\0').filter((record) => record.length > 0)
		if (records.length > INPUT_LIMITS.sourceEntries) {
			return failure('Canonical definition discovery exceeds its bounded entry contract.')
		}
		const entries: TreeEntry[] = []
		for (const record of records) {
			const separator = record.indexOf('\t')
			const header = separator === -1 ? [] : record.slice(0, separator).trim().split(/\s+/u)
			const repositoryPath = separator === -1 ? '' : record.slice(separator + 1)
			const size = header[1] === 'blob' ? Number(header[3]) : undefined
			const localPath =
				input.projectPrefix === ''
					? repositoryPath
					: repositoryPath.slice(input.projectPrefix.length + 1)
			if (
				header.length !== 4 ||
				(header[1] === 'blob' && (!Number.isSafeInteger(size) || (size ?? -1) < 0)) ||
				localPath.length === 0 ||
				localPath.startsWith('../')
			) {
				return failure('Canonical Git tree returned an invalid definition entry.')
			}
			entries.push({
				mode: header[0] ?? '',
				path: localPath,
				type: header[1] ?? '',
				...(size === undefined ? {} : { size }),
			})
		}
		return { ok: true, value: entries }
	} catch (error: unknown) {
		return failure('Canonical Git tree cannot be enumerated.', error)
	}
}

const isExclusionPattern = (pattern: string): boolean =>
	pattern.startsWith('!') && !pattern.startsWith('!(')

const expandSourcePattern = (pattern: string): readonly string[] => {
	const scan = picomatch.scan(pattern)
	return scan.isGlob ? [pattern] : [pattern, `${pattern.replace(/\/$/u, '')}/**`]
}

const sourceMatcher = (manifest: WorkManifest): ((path: string) => boolean) => {
	const patterns = manifest.sources.flatMap(({ include }) => include)
	const positive = patterns.filter((pattern) => !isExclusionPattern(pattern))
	const negative = patterns
		.filter((pattern) => isExclusionPattern(pattern))
		.map((pattern) => pattern.slice(1))
	const included = picomatch(
		positive.flatMap((pattern) => expandSourcePattern(pattern)),
		{
			dot: false,
			posix: true,
		},
	)
	const excluded = picomatch(
		negative.flatMap((pattern) => expandSourcePattern(pattern)),
		{
			dot: false,
			posix: true,
		},
	)
	return (path) => included(path) && !excluded(path)
}

const parseManifestSource = async (input: {
	readonly path: string
	readonly source: string
}): Promise<WorkResult<WorkManifest>> => {
	const root = await mkdtemp(resolve(tmpdir(), 'work-contract-authority-manifest-'))
	try {
		await mkdir(dirname(resolve(root, input.path)), { recursive: true })
		await writeFile(resolve(root, input.path), input.source)
		return await loadWorkManifest({ root, path: input.path })
	} finally {
		await rm(root, { force: true, recursive: true })
	}
}

const loadLocalProject = async (input: {
	readonly root: string
	readonly path?: string
}): Promise<WorkResult<CanonicalProject>> => {
	const manifest = await loadWorkManifest(input)
	if (!manifest.ok) {
		return manifest
	}
	const graph = await compileWorkGraph({ root: input.root, manifest: manifest.value })
	if (!graph.ok) {
		return graph
	}
	const completionRecords = manifest.value.completionLedger
		? await loadCompletionLedger({ root: input.root })
		: { ok: true as const, value: [] as const }
	return completionRecords.ok
		? {
				ok: true,
				value: {
					manifest: manifest.value,
					graph: graph.value,
					completionRecords: completionRecords.value,
				},
			}
		: completionRecords
}

/** @description Loads a local evidence-only project or an exact canonical Git definition snapshot. */
// oxlint-disable-next-line eslint/max-statements -- Canonical discovery keeps the resolve-once authority transaction explicit while delegating parsing, matching, and Git boundaries.
export const loadAuthoritativeWorkProject = async (input: {
	readonly root: string
	readonly path?: string
}): Promise<WorkResult<CanonicalProject>> => {
	const location = await repositoryLocation(input.root)
	if (!location.ok) {
		return location
	}
	if (location.value === undefined) {
		return loadLocalProject(input)
	}
	const authorityRef = location.value.authorityRef
	const manifestPath = input.path ?? 'work.yaml'
	let authoritySha: string
	try {
		const resolvedAuthority = await git(
			input.root,
			['rev-parse', '--verify', `${authorityRef}^{commit}`],
			4096,
		)
		authoritySha = resolvedAuthority.trim()
	} catch (error: unknown) {
		return failure('Canonical definition authority ref cannot be resolved.', error)
	}
	if (!/^[0-9a-f]{40,64}$/u.test(authoritySha)) {
		return failure('Canonical definition authority did not resolve to an exact commit.')
	}
	const authorityManifestSource = await readBlob({
		root: input.root,
		targetSha: authoritySha,
		path: gitPath(location.value.projectPrefix, manifestPath),
		maxBytes: INPUT_LIMITS.manifestBytes,
	})
	if (!authorityManifestSource.ok) {
		return failure(
			`Commit ${manifestPath} and its definition sources to ${authorityRef} before Git-backed synchronization.`,
		)
	}
	const authorityManifest = await parseManifestSource({
		path: manifestPath,
		source: authorityManifestSource.value,
	})
	if (!authorityManifest.ok) {
		return authorityManifest
	}
	const targetRef = authorityManifest.value.policies.delivery?.targetRef
	if (targetRef === undefined) {
		return loadLocalProject(input)
	}
	let targetSha = authoritySha
	try {
		await git(input.root, ['check-ref-format', targetRef], 4096)
	} catch (error: unknown) {
		return failure('Configured canonical target ref is invalid.', error)
	}
	if (targetRef !== authorityRef) {
		try {
			const resolvedTarget = await git(
				input.root,
				['rev-parse', '--verify', `${targetRef}^{commit}`],
				4096,
			)
			targetSha = resolvedTarget.trim()
		} catch (error: unknown) {
			return failure('Configured canonical target ref cannot be resolved.', error)
		}
	}
	if (!/^[0-9a-f]{40,64}$/u.test(targetSha)) {
		return failure('Configured canonical target ref did not resolve to an exact commit.')
	}
	const manifestSource =
		targetSha === authoritySha
			? authorityManifestSource
			: await readBlob({
					root: input.root,
					targetSha,
					path: gitPath(location.value.projectPrefix, manifestPath),
					maxBytes: INPUT_LIMITS.manifestBytes,
				})
	if (!manifestSource.ok) {
		return manifestSource
	}
	const tree = await listTree({
		root: input.root,
		targetSha,
		projectPrefix: location.value.projectPrefix,
	})
	if (!tree.ok) {
		return tree
	}

	const snapshotRoot = await mkdtemp(resolve(tmpdir(), 'work-contract-canonical-'))
	try {
		await mkdir(dirname(resolve(snapshotRoot, manifestPath)), { recursive: true })
		await writeFile(resolve(snapshotRoot, manifestPath), manifestSource.value)
		const manifest = await loadWorkManifest({ root: snapshotRoot, path: manifestPath })
		if (!manifest.ok) {
			return manifest
		}
		if (manifest.value.policies.delivery?.targetRef !== targetRef) {
			return failure('Canonical target manifest disagrees with definition authority.')
		}
		const matches = sourceMatcher(manifest.value)
		const sources = tree.value.filter(
			({ path }) =>
				matches(path) ||
				(path.startsWith(`${COMPLETION_LEDGER_DIRECTORY}/`) && path.endsWith('.yaml')),
		)
		if (sources.length > INPUT_LIMITS.sourceItems) {
			return failure('Canonical definition discovery exceeds its bounded source contract.')
		}
		let aggregateBytes = 0
		for (const source of sources) {
			if (
				source.type !== 'blob' ||
				source.size === undefined ||
				!['100644', '100755'].includes(source.mode)
			) {
				return failure('Canonical definition source must be a regular Git file.')
			}
			aggregateBytes += source.size
			if (
				source.size > INPUT_LIMITS.sourceBytes ||
				aggregateBytes > INPUT_LIMITS.sourceAggregateBytes
			) {
				return failure('Canonical definition sources exceed their bounded size contract.')
			}
			const content = await readBlob({
				root: input.root,
				targetSha,
				path: gitPath(location.value.projectPrefix, source.path),
				maxBytes: INPUT_LIMITS.sourceBytes,
			})
			if (!content.ok) {
				return content
			}
			const destination = resolve(snapshotRoot, source.path)
			await mkdir(dirname(destination), { recursive: true })
			await writeFile(destination, content.value)
		}
		const graph = await compileWorkGraph({ root: snapshotRoot, manifest: manifest.value })
		if (!graph.ok) {
			return graph
		}
		const completionRecords = manifest.value.completionLedger
			? await loadCompletionLedger({ root: snapshotRoot })
			: { ok: true as const, value: [] as const }
		return completionRecords.ok
			? {
					ok: true,
					value: {
						manifest: manifest.value,
						graph: graph.value,
						completionRecords: completionRecords.value,
						definitionRevision: {
							targetRef,
							graphFingerprint: graph.value.fingerprint,
						},
					},
				}
			: completionRecords
	} catch (error: unknown) {
		return failure('Canonical definition snapshot could not be materialized.', error)
	} finally {
		await rm(snapshotRoot, { force: true, recursive: true })
	}
}

/** @description Inspects local definition files without granting them provider synchronization authority. */
export const inspectWorkspaceDefinitionOverlay = async (input: {
	readonly root: string
	readonly path?: string
	readonly canonicalGraphFingerprint: string
}): Promise<WorkResult<WorkspaceDefinitionOverlay>> => {
	const manifest = await loadWorkManifest({
		root: input.root,
		...(input.path === undefined ? {} : { path: input.path }),
	})
	if (!manifest.ok) {
		return { ok: true, value: { status: 'invalid' } }
	}
	const graph = await compileWorkGraph({ root: input.root, manifest: manifest.value })
	if (!graph.ok) {
		return { ok: true, value: { status: 'invalid' } }
	}
	return {
		ok: true,
		value: {
			status: graph.value.fingerprint === input.canonicalGraphFingerprint ? 'same' : 'different',
			graphFingerprint: graph.value.fingerprint,
		},
	}
}
