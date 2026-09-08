/**
 * @description Validates and materializes exact-revision, path-bounded planning proposals.
 *
 * @module work/proposals
 * @file Proposals.ts
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { array, literal, looseObject, optional, picklist, safeParse, string } from 'valibot'
import { parse as parseYaml } from 'yaml'

import { compileWorkGraph, loadWorkManifest } from './compiler'
import { acquireConfigurationLock, configurationLockMaxBytes } from './configuration-lock'
import type { CompiledWorkGraph, WorkErrorCode, WorkManifest, WorkResult } from './contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY, WORK_DEFINITION_LIMITS } from './contracts'
import {
	INPUT_LIMITS,
	readBoundedContainedFile,
	readBoundedContainedUtf8,
	safeSystemErrorDetails,
} from './files'

/* oxlint-disable unicorn/max-nested-calls -- Declarative validation schemas are clearer when structurally nested. */
const ProposalSchema = looseObject({
	version: literal(1),
	id: string(),
	baseGraphFingerprint: string(),
	changes: array(
		looseObject({
			type: picklist(['create', 'update', 'delete']),
			path: string(),
			expectedHash: optional(string()),
			content: optional(string()),
		}),
	),
})
/* oxlint-enable unicorn/max-nested-calls */

/** @description One exact-revision file mutation requested by a planning proposal. */
interface PlanningProposalChange {
	readonly type: 'create' | 'update' | 'delete'
	readonly path: string
	readonly expectedHash?: string
	readonly content?: string
}

/** @description Loaded inert proposal before scope, revision, and graph validation. */
export interface PlanningProposal {
	readonly schemaVersion: 1
	readonly id: string
	readonly baseGraphFingerprint: string
	readonly changes: readonly PlanningProposalChange[]
}

/** @description Branded validated proposal and its exact approval fingerprint. */
export interface PlanningProposalPlan {
	readonly schemaVersion: 1
	readonly proposalId: string
	readonly baseGraphFingerprint: string
	readonly resultingGraphFingerprint: string
	readonly fingerprint: string
	readonly sourceRevisions: Readonly<Record<string, string>>
	readonly manifestBinding: {
		readonly path: string
		readonly fingerprint: string
	}
	readonly changes: readonly PlanningProposalChange[]
}

/** @description Resulting file hashes and graph binding after a successful proposal apply. */
export interface PlanningProposalReceipt {
	readonly schemaVersion: 1
	readonly proposalId: string
	readonly baseGraphFingerprint: string
	readonly resultingGraphFingerprint: string
	readonly fingerprint: string
	readonly paths: readonly string[]
	readonly resultingHashes: Readonly<Record<string, string | null>>
}

const validatedPlanMarker = Symbol('work-contract.validated-planning-proposal')

const isValidatedPlanningProposalPlan = (value: unknown): value is PlanningProposalPlan =>
	typeof value === 'object' &&
	value !== null &&
	validatedPlanMarker in value &&
	value[validatedPlanMarker] === true

const digest = (content: string | Uint8Array): string =>
	createHash('sha256').update(content).digest('hex')

const effectiveManifest = (manifest: WorkManifest): WorkManifest => ({
	...manifest,
	policies: {
		...manifest.policies,
		delivery: manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
	},
})

const proposalError = (
	code: WorkErrorCode,
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

/** @description Loads one repository-local proposal document without authorizing it. */
export const loadPlanningProposal = async (input: {
	readonly root: string
	readonly proposalId: string
}): Promise<WorkResult<PlanningProposal>> => {
	if (!/^[A-Z][A-Z0-9]*-[A-Z0-9][A-Z0-9-]{0,63}$/.test(input.proposalId)) {
		return proposalError('invalid_proposal_id', 'Proposal ID contains unsafe characters.')
	}
	const proposalReference = join(
		'.work',
		'proposals',
		input.proposalId,
		'proposal.yaml',
	).replaceAll('\\', '/')
	const boundedProposal = await readBoundedContainedUtf8({
		root: input.root,
		reference: proposalReference,
		maxBytes: INPUT_LIMITS.proposalBytes,
		unsafeCode: 'unsafe_proposal_path',
		unavailableCode: 'proposal_unavailable',
		tooLargeCode: 'proposal_too_large',
		invalidUtf8Code: 'invalid_proposal',
		label: 'Proposal document',
		unsafeMessage: 'Proposal document must be a repository-local regular file.',
	})
	if (!boundedProposal.ok) {
		return boundedProposal
	}
	const source = boundedProposal.value
	let document: unknown
	try {
		document = parseYaml(source)
	} catch {
		return proposalError('invalid_proposal', 'Proposal YAML cannot be parsed.')
	}
	const parsed = safeParse(ProposalSchema, document)
	if (!parsed.success) {
		return proposalError('invalid_proposal', 'Proposal schema validation failed.')
	}
	if (parsed.output.id !== input.proposalId) {
		return proposalError('invalid_proposal', 'Proposal directory and document IDs differ.')
	}
	if (
		parsed.output.changes.length === 0 ||
		parsed.output.changes.length > INPUT_LIMITS.proposalItems
	) {
		return proposalError(
			'invalid_proposal',
			`A proposal must contain between 1 and ${INPUT_LIMITS.proposalItems} changes.`,
		)
	}
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			id: parsed.output.id,
			baseGraphFingerprint: parsed.output.baseGraphFingerprint,
			changes: parsed.output.changes.map((change) => ({
				type: change.type,
				path: change.path,
				...(change.expectedHash === undefined ? {} : { expectedHash: change.expectedHash }),
				...(change.content === undefined ? {} : { content: change.content }),
			})),
		},
	}
}

const resolveExistingSafePath = async (root: string, path: string): Promise<WorkResult<string>> => {
	try {
		const [rootPath, targetPath] = await Promise.all([
			realpath(root),
			realpath(resolve(root, path)),
		])
		const localPath = relative(rootPath, targetPath)
		if (localPath === '' || localPath.startsWith('..') || isAbsolute(localPath)) {
			return proposalError('unsafe_proposal_path', 'Proposal target path escapes the repository.')
		}
		const info = await lstat(resolve(root, path))
		if (info.isSymbolicLink() || !info.isFile()) {
			return proposalError(
				'unsafe_proposal_path',
				'Proposal target must resolve to a regular file.',
			)
		}
		return { ok: true, value: localPath.replaceAll('\\', '/') }
	} catch (error: unknown) {
		return proposalError(
			'proposal_target_unavailable',
			'Proposal target cannot be read.',
			safeSystemErrorDetails(error),
		)
	}
}

const resolveCreateSafePath = async (root: string, path: string): Promise<WorkResult<string>> => {
	try {
		const [rootPath, parentPath] = await Promise.all([
			realpath(root),
			realpath(resolve(root, dirname(path))),
		])
		const targetPath = resolve(parentPath, path.split('/').at(-1) ?? '')
		const localPath = relative(rootPath, targetPath)
		if (localPath === '' || localPath.startsWith('..') || isAbsolute(localPath)) {
			return proposalError('unsafe_proposal_path', 'Proposal target path escapes the repository.')
		}
		try {
			await lstat(targetPath)
			return proposalError('proposal_target_exists', 'Proposal create target already exists.')
		} catch (error: unknown) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
				throw error
			}
		}
		return { ok: true, value: localPath.replaceAll('\\', '/') }
	} catch (error: unknown) {
		return proposalError(
			'proposal_target_unavailable',
			'Proposal target parent cannot be resolved.',
			safeSystemErrorDetails(error),
		)
	}
}

const compileProposedGraph = async (input: {
	readonly root: string
	readonly graph: CompiledWorkGraph
	readonly manifest: WorkManifest
	readonly changes: readonly PlanningProposalChange[]
}): Promise<WorkResult<CompiledWorkGraph>> => {
	let overlayRoot: string | undefined
	let result: WorkResult<CompiledWorkGraph> | undefined
	try {
		overlayRoot = await mkdtemp(join(tmpdir(), 'work-contract-proposal-graph-'))
		const byPath = new Map(input.changes.map((change) => [change.path, change]))
		for (const artifact of input.graph.items) {
			const safeSource = await resolveExistingSafePath(input.root, artifact.source.path)
			if (!safeSource.ok) {
				result = safeSource
				break
			}
			const change = byPath.get(safeSource.value)
			if (change?.type === 'delete') {
				continue
			}
			const source =
				change?.content === undefined
					? await readBoundedContainedFile({
							root: input.root,
							reference: safeSource.value,
							maxBytes: INPUT_LIMITS.sourceBytes,
							unsafeCode: 'unsafe_proposal_path',
							unavailableCode: 'proposal_source_unavailable',
							tooLargeCode: 'source_too_large',
							label: 'Proposal source file',
						})
					: { ok: true as const, value: Buffer.from(change.content) }
			if (!source.ok) {
				result = source
				break
			}
			const target = resolve(overlayRoot, safeSource.value)
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, source.value)
		}
		if (result === undefined) {
			for (const change of input.changes) {
				if (change.type !== 'create') {
					continue
				}
				const target = resolve(overlayRoot, change.path)
				await mkdir(dirname(target), { recursive: true })
				await writeFile(target, change.content ?? '')
			}
			result = await compileWorkGraph({ root: overlayRoot, manifest: input.manifest })
		}
	} catch (error: unknown) {
		result = proposalError(
			'proposal_overlay_failed',
			'Unable to materialize the proposed graph.',
			safeSystemErrorDetails(error),
		)
	}
	if (overlayRoot !== undefined) {
		try {
			await rm(overlayRoot, { force: true, recursive: true })
		} catch (error: unknown) {
			const cleanupDetails = ['Overlay cleanup failed.', ...(safeSystemErrorDetails(error) ?? [])]
			if (result !== undefined && !result.ok) {
				return {
					ok: false,
					error: {
						...result.error,
						details: [...(result.error.details ?? []), ...cleanupDetails],
					},
				}
			}
			return proposalError('proposal_cleanup_failed', 'Unable to remove the proposal overlay.', [
				...cleanupDetails,
			])
		}
	}
	return (
		result ??
		proposalError('proposal_overlay_failed', 'Proposal overlay did not produce a graph result.')
	)
}

/** @description Runtime input for exact-revision planning proposal validation. */
export interface ValidatePlanningProposalInput {
	readonly root: string
	readonly proposal: PlanningProposal
	readonly graph: CompiledWorkGraph
	readonly manifest: WorkManifest
	readonly manifestPath: string
	readonly allowDelete?: boolean
}

/** @description Validates file revisions, path authority, and the complete proposed graph overlay. */
// oxlint-disable-next-line eslint/max-statements -- Validation keeps one ordered fail-closed authority transaction visible.
const validatePlanningProposalInternal = async (
	input: ValidatePlanningProposalInput,
): Promise<WorkResult<PlanningProposalPlan>> => {
	const currentManifest = await loadWorkManifest({ root: input.root, path: input.manifestPath })
	if (!currentManifest.ok) {
		return proposalError(
			'stale_proposal_graph',
			'Work graph configuration is unavailable or changed.',
			[`manifestCode=${currentManifest.error.code}`],
		)
	}
	if (
		digest(JSON.stringify(effectiveManifest(currentManifest.value))) !==
		digest(JSON.stringify(effectiveManifest(input.manifest)))
	) {
		return proposalError(
			'stale_proposal_graph',
			'Work graph configuration changed before validation.',
		)
	}
	if (input.proposal.baseGraphFingerprint !== input.graph.fingerprint) {
		return proposalError(
			'stale_proposal_graph',
			'Proposal was created against a different work graph.',
		)
	}
	if (
		input.proposal.changes.length === 0 ||
		input.proposal.changes.length > INPUT_LIMITS.proposalItems
	) {
		return proposalError(
			'invalid_proposal',
			`A proposal must contain between 1 and ${INPUT_LIMITS.proposalItems} changes.`,
		)
	}
	const seen = new Set<string>()
	const existingSourcePaths = new Set(input.graph.items.map(({ source }) => source.path))
	const normalized: PlanningProposalChange[] = []
	for (const change of input.proposal.changes) {
		const path = change.path.replaceAll('\\', '/')
		if (
			isAbsolute(path) ||
			path.startsWith('../') ||
			path.includes('/../') ||
			Buffer.byteLength(path, 'utf8') > WORK_DEFINITION_LIMITS.sourcePathBytes
		) {
			return proposalError('unsafe_proposal_path', 'Proposal change path is unsafe.')
		}
		if (change.type === 'delete' && input.allowDelete !== true) {
			return proposalError(
				'proposal_delete_not_authorized',
				'Proposal deletion requires explicit authorization.',
			)
		}
		if ((change.type === 'create' || change.type === 'update') && change.content === undefined) {
			return proposalError('invalid_proposal', 'Proposal create or update changes require content.')
		}
		if (change.content !== undefined && Buffer.byteLength(change.content, 'utf8') > 1_000_000) {
			return proposalError('invalid_proposal', 'Proposal change content exceeds one megabyte.')
		}
		if (change.type === 'create') {
			const safe = await resolveCreateSafePath(input.root, path)
			if (!safe.ok) {
				return safe
			}
			if (seen.has(safe.value)) {
				return proposalError('invalid_proposal', 'Proposal contains a duplicate change path.')
			}
			seen.add(safe.value)
			normalized.push({ type: 'create', path: safe.value, content: change.content ?? '' })
			continue
		}
		const canonicalLexicalPath = relative(
			resolve(input.root),
			resolve(input.root, path),
		).replaceAll('\\', '/')
		if (!existingSourcePaths.has(canonicalLexicalPath)) {
			return proposalError(
				'proposal_path_not_allowed',
				'Proposal path is not part of the compiled work graph.',
			)
		}
		if (change.expectedHash === undefined || !/^[a-f0-9]{64}$/.test(change.expectedHash)) {
			return proposalError(
				'invalid_proposal',
				'Proposal update or delete requires a lowercase SHA-256 expectedHash.',
			)
		}
		const safe = await resolveExistingSafePath(input.root, path)
		if (!safe.ok) {
			return safe
		}
		if (!existingSourcePaths.has(safe.value)) {
			return proposalError(
				'proposal_path_not_allowed',
				'Proposal path is not part of the compiled work graph.',
			)
		}
		if (seen.has(safe.value)) {
			return proposalError('invalid_proposal', 'Proposal contains a duplicate change path.')
		}
		seen.add(safe.value)
		const current = await readBoundedContainedFile({
			root: input.root,
			reference: safe.value,
			maxBytes: INPUT_LIMITS.sourceBytes,
			unsafeCode: 'unsafe_proposal_path',
			unavailableCode: 'proposal_source_unavailable',
			tooLargeCode: 'source_too_large',
			label: 'Proposal source file',
		})
		if (!current.ok) {
			return current
		}
		if (digest(current.value) !== change.expectedHash) {
			return proposalError('stale_proposal_file', 'Proposal target changed after planning.')
		}
		normalized.push({
			type: change.type,
			path: safe.value,
			expectedHash: change.expectedHash,
			...(change.content === undefined ? {} : { content: change.content }),
		})
	}
	const proposedGraph = await compileProposedGraph({
		root: input.root,
		graph: input.graph,
		manifest: input.manifest,
		changes: normalized,
	})
	if (!proposedGraph.ok) {
		if (
			proposedGraph.error.code === 'proposal_overlay_failed' ||
			proposedGraph.error.code === 'proposal_cleanup_failed' ||
			proposedGraph.error.code === 'proposal_source_unavailable'
		) {
			return proposedGraph
		}
		return proposalError(
			'invalid_proposed_work_graph',
			'Proposal would leave the file-defined work graph invalid.',
			[
				`${proposedGraph.error.code}: ${proposedGraph.error.message}`,
				...(proposedGraph.error.details ?? []),
			],
		)
	}
	const proposedSourcePaths = new Set(proposedGraph.value.items.map(({ source }) => source.path))
	const unauthorizedCreate = normalized.find(
		(change) => change.type === 'create' && !proposedSourcePaths.has(change.path),
	)
	if (unauthorizedCreate !== undefined) {
		return proposalError(
			'proposal_path_not_allowed',
			'Proposal create path is not part of the compiled work graph.',
		)
	}
	const sourceRevisionEntries = input.graph.items
		.map(({ source }): readonly [string, string] => [source.path, source.hash])
		.toSorted(([left], [right]) => left.localeCompare(right))
	const sourceRevisions = Object.freeze(Object.fromEntries(sourceRevisionEntries))
	const manifestBinding = Object.freeze({
		path: input.manifestPath,
		fingerprint: digest(JSON.stringify(effectiveManifest(currentManifest.value))),
	})
	const stable = JSON.stringify({
		schemaVersion: 1,
		proposalId: input.proposal.id,
		baseGraphFingerprint: input.proposal.baseGraphFingerprint,
		resultingGraphFingerprint: proposedGraph.value.fingerprint,
		sourceRevisions,
		manifestBinding,
		changes: normalized,
	})
	const plan: PlanningProposalPlan = {
		schemaVersion: 1,
		proposalId: input.proposal.id,
		baseGraphFingerprint: input.proposal.baseGraphFingerprint,
		resultingGraphFingerprint: proposedGraph.value.fingerprint,
		fingerprint: digest(stable),
		sourceRevisions,
		manifestBinding,
		changes: Object.freeze(normalized.map((change) => Object.freeze(change))),
	}
	Object.defineProperty(plan, validatedPlanMarker, { value: true })
	return { ok: true, value: Object.freeze(plan) }
}

/** @description Validates a proposal without rejecting its declared Result contract. */
export const validatePlanningProposal = async (
	input: ValidatePlanningProposalInput,
): Promise<WorkResult<PlanningProposalPlan>> => {
	try {
		return await validatePlanningProposalInternal(input)
	} catch (error: unknown) {
		return proposalError(
			'proposal_validation_failed',
			'Proposal validation failed.',
			safeSystemErrorDetails(error),
		)
	}
}

interface PreparedProposalChange {
	readonly change: PlanningProposalChange
	readonly path: string
	readonly target: string
	readonly original: Uint8Array | undefined
}

const proposalApplyRecoveryDetails = [
	'lock=.work/proposal-apply.lock',
	'recovery=inspect the configuration-mutation lock intent, repository sources, provider definitions, and .work/lock.json before manual removal',
] as const

const acquireProposalApplyLock = async (
	root: string,
	plan: PlanningProposalPlan,
): Promise<WorkResult<{ readonly release: () => Promise<void> }>> => {
	const paths = plan.changes.map(({ path }) => path).toSorted()
	const intent = {
		schemaVersion: 1 as const,
		kind: 'work_contract_proposal_apply' as const,
		pid: process.pid,
		proposalId: plan.proposalId,
		fingerprint: plan.fingerprint,
		paths,
	}
	const content = `${JSON.stringify(intent)}\n`
	if (
		paths.length > INPUT_LIMITS.proposalItems ||
		Buffer.byteLength(content, 'utf8') > configurationLockMaxBytes
	) {
		return proposalError('invalid_proposal', 'Proposal apply intent exceeds its safety bounds.')
	}
	const lock = await acquireConfigurationLock({ root, intent })
	if (!lock.ok) {
		if (lock.error.code === 'unsafe_configuration_lock') {
			return proposalError('unsafe_proposal_lock', 'Proposal apply lock path is unsafe.')
		}
		return proposalError(
			'proposal_apply_locked',
			'Another configuration mutation is active or left a lock that requires inspection.',
			proposalApplyRecoveryDetails,
		)
	}
	return {
		ok: true,
		value: {
			release: async (): Promise<void> => {
				const released = await lock.value.release()
				if (!released.ok) {
					throw new Error('Proposal apply lock ownership changed before release.')
				}
			},
		},
	}
}

const revalidatePreparedChanges = async (
	root: string,
	prepared: readonly PreparedProposalChange[],
): Promise<WorkResult<void>> => {
	for (const entry of prepared) {
		if (entry.change.type === 'create') {
			try {
				await lstat(entry.target)
				return proposalError(
					'stale_proposal_file',
					'Proposal create target appeared before commit.',
				)
			} catch (error: unknown) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
					throw error
				}
			}
			continue
		}
		const current = await readBoundedContainedFile({
			root,
			reference: entry.path,
			maxBytes: INPUT_LIMITS.sourceBytes,
			unsafeCode: 'unsafe_proposal_path',
			unavailableCode: 'proposal_source_unavailable',
			tooLargeCode: 'source_too_large',
			label: 'Proposal source file',
		})
		if (!current.ok) {
			return current
		}
		if (
			entry.change.expectedHash === undefined ||
			digest(current.value) !== entry.change.expectedHash
		) {
			return proposalError(
				'stale_proposal_file',
				'Proposal target changed immediately before commit.',
			)
		}
	}
	return { ok: true, value: undefined }
}

const rollbackPreparedChanges = async (input: {
	readonly root: string
	readonly prepared: readonly PreparedProposalChange[]
	readonly staged: ReadonlyMap<string, string>
	readonly cause: unknown
}): Promise<WorkResult<never>> => {
	const failures: string[] = []
	const attempt = async (operation: () => Promise<void>): Promise<void> => {
		try {
			await operation()
		} catch (error: unknown) {
			failures.push('Proposal rollback operation failed.', ...(safeSystemErrorDetails(error) ?? []))
		}
	}
	for (const [path, temporary] of input.staged) {
		await attempt(async () => {
			await rm(temporary, { force: true })
			const original = input.prepared.find((entry) => entry.path === path)
			if (original?.original === undefined) {
				await rm(resolve(input.root, path), { force: true })
			}
		})
	}
	for (const entry of input.prepared) {
		const original = entry.original
		if (original !== undefined) {
			await attempt(async () => writeFile(entry.target, original))
		}
	}
	return proposalError(
		failures.length === 0 ? 'proposal_apply_failed' : 'proposal_rollback_failed',
		failures.length === 0
			? 'Proposal application failed and its previous contents were restored.'
			: 'Proposal application failed and rollback requires manual recovery.',
		['Proposal mutation failed.', ...(safeSystemErrorDetails(input.cause) ?? []), ...failures],
	)
}

// oxlint-disable-next-line eslint/max-statements -- Apply and rollback remain one auditable filesystem transaction.
const applyValidatedPlanningProposal = async (input: {
	readonly root: string
	readonly plan: PlanningProposalPlan
	readonly manifest: WorkManifest
}): Promise<WorkResult<PlanningProposalReceipt>> => {
	try {
		for (const [path, expectedHash] of Object.entries(input.plan.sourceRevisions)) {
			const safe = await resolveExistingSafePath(input.root, path)
			if (!safe.ok) {
				return safe
			}
			const current = await readBoundedContainedFile({
				root: input.root,
				reference: safe.value,
				maxBytes: INPUT_LIMITS.sourceBytes,
				unsafeCode: 'unsafe_proposal_path',
				unavailableCode: 'proposal_source_unavailable',
				tooLargeCode: 'source_too_large',
				label: 'Proposal source file',
			})
			if (!current.ok) {
				return current
			}
			if (digest(current.value) !== expectedHash) {
				return proposalError(
					'stale_proposal_graph_source',
					'Work graph source changed after proposal validation.',
				)
			}
		}
		const currentGraph = await compileWorkGraph({ root: input.root, manifest: input.manifest })
		if (!currentGraph.ok || currentGraph.value.fingerprint !== input.plan.baseGraphFingerprint) {
			return proposalError(
				'stale_proposal_graph',
				'Work graph changed after proposal validation.',
				currentGraph.ok ? undefined : [`graphCode=${currentGraph.error.code}`],
			)
		}
		const prepared: PreparedProposalChange[] = []
		for (const change of input.plan.changes) {
			const safe =
				change.type === 'create'
					? await resolveCreateSafePath(input.root, change.path)
					: await resolveExistingSafePath(input.root, change.path)
			if (!safe.ok) {
				return safe
			}
			const target = resolve(input.root, safe.value)
			if (change.type === 'create') {
				prepared.push({ change, path: safe.value, target, original: undefined })
				continue
			}
			const current = await readBoundedContainedFile({
				root: input.root,
				reference: safe.value,
				maxBytes: INPUT_LIMITS.sourceBytes,
				unsafeCode: 'unsafe_proposal_path',
				unavailableCode: 'proposal_source_unavailable',
				tooLargeCode: 'source_too_large',
				label: 'Proposal source file',
			})
			if (!current.ok) {
				return current
			}
			if (change.expectedHash === undefined || digest(current.value) !== change.expectedHash) {
				return proposalError('stale_proposal_file', 'Proposal target changed before apply.')
			}
			prepared.push({ change, path: safe.value, target, original: current.value })
		}

		const staged = new Map<string, string>()
		try {
			for (const entry of prepared) {
				if (entry.change.type !== 'delete') {
					const temporary = `${entry.target}.work-contract-${randomUUID()}.tmp`
					await writeFile(temporary, entry.change.content ?? '', { flag: 'wx' })
					staged.set(entry.path, temporary)
				}
			}
			const revalidated = await revalidatePreparedChanges(input.root, prepared)
			if (!revalidated.ok) {
				for (const temporary of staged.values()) {
					await rm(temporary, { force: true })
				}
				return revalidated
			}

			for (const entry of prepared) {
				if (entry.change.type === 'delete') {
					await rm(entry.target)
					continue
				}
				const temporary = staged.get(entry.path)
				if (temporary === undefined) {
					throw new Error('Missing staged proposal file.')
				}
				await mkdir(dirname(entry.target), { recursive: true })
				await rename(temporary, entry.target)
			}
		} catch (error: unknown) {
			return await rollbackPreparedChanges({ root: input.root, prepared, staged, cause: error })
		}

		const resultingHashes: Record<string, string | null> = {}
		for (const change of input.plan.changes) {
			if (change.type === 'delete') {
				resultingHashes[change.path] = null
				continue
			}
			const result = await readBoundedContainedFile({
				root: input.root,
				reference: change.path,
				maxBytes: INPUT_LIMITS.sourceBytes,
				unsafeCode: 'unsafe_proposal_path',
				unavailableCode: 'proposal_source_unavailable',
				tooLargeCode: 'source_too_large',
				label: 'Proposal result file',
			})
			if (!result.ok) {
				return proposalError(
					'proposal_apply_state_uncertain',
					'Proposal files changed, but a resulting hash could not be recorded.',
					[`${result.error.code}: ${result.error.message}`, ...(result.error.details ?? [])],
				)
			}
			resultingHashes[change.path] = digest(result.value)
		}
		return {
			ok: true,
			value: {
				schemaVersion: 1,
				proposalId: input.plan.proposalId,
				baseGraphFingerprint: input.plan.baseGraphFingerprint,
				resultingGraphFingerprint: input.plan.resultingGraphFingerprint,
				fingerprint: input.plan.fingerprint,
				paths: input.plan.changes.map(({ path }) => path).toSorted(),
				resultingHashes,
			},
		}
	} catch (error: unknown) {
		return proposalError(
			'proposal_apply_state_uncertain',
			'Proposal apply encountered an unexpected filesystem failure; inspect repository state.',
			safeSystemErrorDetails(error),
		)
	}
}

/** @description Applies a validated plan only when its exact fingerprint was explicitly approved. */
export const applyPlanningProposal = async (input: {
	readonly root: string
	readonly coordinationRoot?: string
	readonly plan: unknown
	readonly approvedFingerprint: string
}): Promise<WorkResult<PlanningProposalReceipt>> => {
	if (!isValidatedPlanningProposalPlan(input.plan)) {
		return proposalError(
			'unvalidated_proposal_plan',
			'Proposal application requires the unchanged result of validatePlanningProposal.',
		)
	}
	if (input.approvedFingerprint !== input.plan.fingerprint) {
		return proposalError(
			'proposal_approval_mismatch',
			'Proposal apply requires the exact fingerprint returned by validation.',
		)
	}
	const lock = await acquireProposalApplyLock(input.coordinationRoot ?? input.root, input.plan)
	if (!lock.ok) {
		return lock
	}
	const manifestBinding = input.plan.manifestBinding
	const currentManifest = await loadWorkManifest({
		root: input.root,
		path: manifestBinding.path,
	})
	const applied: WorkResult<PlanningProposalReceipt> =
		!currentManifest.ok ||
		digest(JSON.stringify(effectiveManifest(currentManifest.value))) !== manifestBinding.fingerprint
			? proposalError(
					'stale_proposal_graph',
					'Work graph configuration changed after proposal validation.',
				)
			: await applyValidatedPlanningProposal({
					root: input.root,
					plan: input.plan,
					manifest: currentManifest.value,
				})
	try {
		await lock.value.release()
	} catch (error: unknown) {
		const cleanupDetails = ['Apply-lock cleanup failed.', ...(safeSystemErrorDetails(error) ?? [])]
		if (!applied.ok) {
			return {
				ok: false,
				error: {
					...applied.error,
					details: [...(applied.error.details ?? []), ...cleanupDetails],
				},
			}
		}
		return proposalError(
			'proposal_lock_release_failed',
			'Proposal processing finished but its apply lock could not be removed.',
			[
				'stateApplied=true',
				'stateMayHaveChanged=true',
				...proposalApplyRecoveryDetails,
				...cleanupDetails,
			],
		)
	}
	return applied
}
