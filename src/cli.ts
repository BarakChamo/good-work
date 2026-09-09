/**
 * @description Thin, scriptable CLI over the work-contract compiler, provider, and coordination service.
 *
 * @module work/cli
 * @file Cli.ts
 */

/* oxlint-disable import/max-dependencies -- The thin command dispatcher composes every internal work-contract boundary. */

import { randomUUID } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { env as processEnvironment } from 'node:process'
import { isDeepStrictEqual } from 'node:util'

import { createBeadsProvider, resolveDefaultBeadsBinary } from './beads'
import type { BeadsProvider } from './beads'
import { installPinnedBeads } from './beads-installer'
import { restoreCompletionLedger } from './completion-recovery'
import {
	buildCompletionRecord,
	loadCompletionLedger,
	writeCompletionRecord,
} from './completion-ledger'
import { loadWorkManifest } from './compiler'
import { loadWorkProject } from './facade'
import { acquireConfigurationLock, finalizeConfigurationMutation } from './configuration-lock'
import { buildOperationalContext } from './context'
import { observeGitWorkspace, prepareWorkLaunch, resolveWorkStateLocation } from './preparation'
import { resolveWorkCoordinationLocation } from './work-state'
import type { EvidenceKind, WorkError, WorkNextAction, WorkResult } from './contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY } from './contracts'
import { inspectWorkspaceDefinitionOverlay } from './definition-authority'
import {
	acquireIntegrationMutex,
	inspectIntegrationMutex,
	recoverIntegrationMutex,
	releaseIntegrationMutex,
} from './integration-mutex'
import { INPUT_LIMITS, readBoundedContainedUtf8, readBoundedUtf8, writeUtf8NoFollow } from './files'
import {
	listCommandTelemetrySessions,
	recordCliFailureTelemetry,
	recordCommandTelemetry,
	recordHookTelemetry,
	setCommandTelemetry,
	showCommandTelemetry,
	withCommandPerformanceProfile,
	writeDogfoodFeedback,
} from './dogfood'
import { projectGraph } from './graph'
import {
	dispatchWorkHooks,
	initializeWorkHooks,
	inspectWorkHooks,
	statusWorkHooks,
	trustWorkHooks,
	untrustWorkHooks,
} from './hooks'
import { prepareSafeOutputPath } from './paths'
import type { LedgerStatus } from './provider'
import { applyPlanningProposal, loadPlanningProposal, validatePlanningProposal } from './proposals'
import { writeWorkLock, writeWorkSnapshot } from './projections'
import { createWorkContractService } from './service'
import { installWorkContractSkill } from './skill'
import { applySyncPlan, planSync } from './sync'
import { renderWorkContractHelp, runWorkContractProgram } from './cli-program'
import type { WorkContractInvocation } from './cli-program'

const option = (parsed: WorkContractInvocation, name: string): string | undefined =>
	parsed.options[name]?.at(-1)

const telemetrySessionId = (parsed?: WorkContractInvocation): string | undefined =>
	parsed?.options.session?.at(-1) ??
	processEnvironment.WORK_SESSION_ID ??
	processEnvironment.CODEX_THREAD_ID ??
	processEnvironment.CLAUDE_CODE_SESSION_ID ??
	processEnvironment.CODEX_SESSION_ID

const pluginArtifactPresent = async (): Promise<boolean> => {
	if (
		processEnvironment.PLUGIN_ROOT !== undefined ||
		processEnvironment.CLAUDE_PLUGIN_ROOT !== undefined
	) {
		return true
	}
	try {
		await access(resolve(import.meta.dirname, '../plugins/work/.codex-plugin/plugin.json'))
		await access(resolve(import.meta.dirname, '../plugins/work/.claude-plugin/plugin.json'))
		return true
	} catch {
		return false
	}
}

interface OverviewItemInput {
	readonly id: string
	readonly title: string
	readonly status: string
	readonly ready: boolean
	readonly stale: boolean
	readonly assignee?: string
	readonly blockReason?: string
}

const summarizeOverviewItem = ({
	id,
	title,
	status,
	ready,
	stale,
	assignee,
	blockReason,
}: OverviewItemInput) => ({
	id,
	title,
	status,
	ready,
	stale,
	...(assignee === undefined ? {} : { assignee }),
	...(blockReason === undefined ? {} : { blockReason }),
})

const requiredOption = (parsed: WorkContractInvocation, name: string): string => {
	const value = option(parsed, name)
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`--${name} is required.`)
	}
	return value
}

const renderTelemetryWarning = (input: {
	readonly json: boolean
	readonly error: WorkError
}): string =>
	input.json
		? JSON.stringify({
				type: 'work_telemetry_warning',
				code: input.error.code,
				message: input.error.message,
			})
		: `telemetry warning: ${input.error.code}: ${input.error.message}`
const positional = (parsed: WorkContractInvocation, index: number, label: string): string => {
	const value = parsed.positionals[index]
	if (value === undefined) {
		throw new Error(`${label} is required.`)
	}
	return value
}

const coordinationRootFor = async (
	root: string,
	manifestPath = 'work.yaml',
): Promise<WorkResult<string>> => {
	const manifest = await loadWorkManifest({ root, path: manifestPath })
	if (!manifest.ok && manifest.error.details?.includes('System error code: ENOENT.') !== true) {
		return manifest
	}
	const location = await resolveWorkCoordinationLocation({
		root,
		...(manifest.ok && manifest.value.projectUid !== undefined
			? { projectUid: manifest.value.projectUid }
			: {}),
	})
	return location.ok ? { ok: true, value: location.value.root } : location
}

const loadProject = async (parsed: WorkContractInvocation) => {
	const project = await loadWorkProject({ root: parsed.root, path: parsed.manifestPath })
	if (!project.ok) {
		return project
	}
	const state = await resolveWorkStateLocation({
		root: parsed.root,
		projectId: project.value.manifest.projectId,
		...(project.value.manifest.projectUid === undefined
			? {}
			: { projectUid: project.value.manifest.projectUid }),
	})
	if (!state.ok) {
		return state
	}
	const provider = createBeadsProvider({
		root: parsed.root,
		projectId: project.value.manifest.projectId,
		binary: parsed.binary,
		stateDirectory: state.value.directory,
		coordinationRoot: state.value.coordinationRoot,
	})
	if (parsed.command !== 'doctor' && parsed.binary !== resolveDefaultBeadsBinary()) {
		const compatibility = await provider.doctor()
		if (!compatibility.ok) {
			return compatibility
		}
	}
	return {
		ok: true as const,
		value: {
			...project.value,
			provider,
			state: state.value.observation,
			coordinationRoot: state.value.coordinationRoot,
			providerInitialized: state.value.initialized,
		},
	}
}

const syncProjectionFailure = (input: {
	readonly applied: number
	readonly cause: WorkError
}): WorkResult<never> => ({
	ok: false,
	error: {
		type: 'work_contract_error',
		code: 'sync_projection_failed',
		message: 'Ledger sync applied, but its generated projections were not refreshed.',
		details: [
			`applied=${input.applied}`,
			`cause=${input.cause.code}: ${input.cause.message}`,
			'Rerun sync --apply to reconcile and regenerate the projections.',
		],
	},
})

const publishMutation = async <
	Value extends {
		readonly workId: string
		readonly newStatus: LedgerStatus
		readonly previousStatus?: LedgerStatus
	},
>(
	provider: BeadsProvider,
	result: WorkResult<Value>,
): Promise<WorkResult<Value>> => {
	if (!result.ok) {
		return result
	}
	if (result.value.previousStatus === 'closed' && result.value.newStatus === 'closed') {
		return result
	}
	const projection = await provider.publishRecoveryProjection({
		expected: [{ workId: result.value.workId, status: result.value.newStatus }],
	})
	return projection.ok
		? result
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'projection_write_failed',
					message: 'Work changed, but the shared Beads recovery export was not refreshed.',
					details: [
						`cause=${projection.error.code}`,
						'Provider state may have changed.',
						'Rerun the original command or work export before continuing.',
					],
				},
			}
}

const reconcileSync = async (parsed: WorkContractInvocation): Promise<WorkResult<unknown>> => {
	const loaded = await loadProject(parsed)
	if (!loaded.ok) {
		return loaded
	}
	const {
		graph,
		provider,
		definitionRevision,
		completionRecords,
		coordinationRoot,
		providerInitialized,
	} = loaded.value
	if (!providerInitialized) {
		const initialized = await provider.initialize()
		if (!initialized.ok) {
			return initialized
		}
	}
	const listed = await provider.list()
	if (!listed.ok) {
		return listed
	}
	const legacy =
		provider.discoverLegacyDefinitions === undefined
			? { ok: true as const, value: [] as const }
			: await provider.discoverLegacyDefinitions()
	if (!legacy.ok) {
		return legacy
	}
	const ledgerItems = [...listed.value, ...legacy.value]
	const plan = planSync({
		graph,
		...(definitionRevision === undefined ? {} : { definitionRevision }),
		ledgerItems: ledgerItems.filter(({ projectId }) => projectId === graph.projectId),
		archiveMissing: option(parsed, 'archive-missing') !== undefined,
	})
	if (!plan.ok) {
		return plan
	}
	const applied = await applySyncPlan({ graph, plan: plan.value, provider })
	if (!applied.ok) {
		return applied
	}
	const restored = await restoreCompletionLedger({
		root: parsed.root,
		graph,
		records: completionRecords,
		provider,
		...(definitionRevision === undefined ? {} : { definitionRevision }),
	})
	if (!restored.ok) {
		return restored
	}
	const canFinalizeLegacyMigration =
		option(parsed, 'archive-missing') !== undefined ||
		legacy.value.every(({ workId }) => graph.items.some(({ id }) => id === workId))
	if (canFinalizeLegacyMigration && provider.finalizeLegacyMigration !== undefined) {
		const finalized = await provider.finalizeLegacyMigration()
		if (!finalized.ok) {
			return syncProjectionFailure({ applied: applied.value.applied, cause: finalized.error })
		}
	}
	const refreshed = await provider.list()
	if (!refreshed.ok) {
		return syncProjectionFailure({ applied: applied.value.applied, cause: refreshed.error })
	}
	const projected = await writeWorkLock({
		root: coordinationRoot,
		graph,
		ledgerItems: refreshed.value,
	})
	if (!projected.ok) {
		return syncProjectionFailure({ applied: applied.value.applied, cause: projected.error })
	}
	const recoveryProjection = await provider.publishRecoveryProjection({
		expected: graph.items.map(({ id }) => ({ workId: id })),
	})
	return recoveryProjection.ok
		? {
				ok: true,
				value: {
					...applied.value,
					restored: restored.value.restored,
					lock: projected.value.path,
					recoveryProjection: recoveryProjection.value.path,
				},
			}
		: syncProjectionFailure({ applied: applied.value.applied, cause: recoveryProjection.error })
}

const applyLockedSync = async (parsed: WorkContractInvocation): Promise<WorkResult<unknown>> => {
	const coordination = await coordinationRootFor(parsed.root, parsed.manifestPath)
	if (!coordination.ok) {
		return coordination
	}
	const lock = await acquireConfigurationLock({
		root: coordination.value,
		intent: {
			schemaVersion: 1,
			kind: 'work_contract_sync_apply',
			pid: process.pid,
			manifestPath: parsed.manifestPath,
		},
	})
	if (!lock.ok) {
		return lock
	}
	let result: WorkResult<unknown>
	try {
		result = await reconcileSync(parsed)
	} catch {
		result = {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'sync_apply_failed',
				message: 'Sync application failed unexpectedly; inspect repository and provider state.',
			},
		}
	}
	return finalizeConfigurationMutation({ result, lock: lock.value })
}

const safeRead = async (root: string, path: string): Promise<WorkResult<string>> => {
	if (isAbsolute(path) || path.startsWith('..')) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'unsafe_summary_path',
				message: 'Summary files must be repository-relative.',
			},
		}
	}
	try {
		return await readBoundedContainedUtf8({
			root,
			reference: path,
			maxBytes: INPUT_LIMITS.summaryBytes,
			unsafeCode: 'unsafe_summary_path',
			unavailableCode: 'summary_unavailable',
			tooLargeCode: 'summary_too_large',
			label: 'Handoff summary',
		})
	} catch {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'summary_unavailable',
				message: 'Handoff summary cannot be resolved.',
			},
		}
	}
}

const restoreManifest = async (
	path: string,
	previous: string | undefined,
	written: string,
): Promise<string | undefined> => {
	try {
		const current = await readBoundedUtf8({
			path,
			maxBytes: INPUT_LIMITS.manifestBytes,
			unavailableCode: 'invalid_work_manifest',
			tooLargeCode: 'work_manifest_too_large',
			label: 'Written work manifest',
		})
		if (!current.ok || current.value !== written) {
			return 'Manifest changed after initialization write; automatic restoration was skipped.'
		}
		if (previous === undefined) {
			await rm(path)
		} else {
			await writeUtf8NoFollow({ path, content: previous, mode: 'replace' })
		}
		return undefined
	} catch {
		return 'Manifest restoration failed.'
	}
}

const initializeProject = async (
	parsed: WorkContractInvocation,
): Promise<
	WorkResult<{
		readonly manifest: string
		readonly projectUid: string
		readonly provider: { readonly prefix: string }
	}>
> => {
	const projectId = requiredOption(parsed, 'project')
	if (!/^[a-z][a-z0-9-]{1,20}$/.test(projectId)) {
		throw new Error('--project must be a 2-21 character lowercase slug.')
	}
	const force = option(parsed, 'force') !== undefined
	const existingManifest = force
		? await loadWorkManifest({ root: parsed.root, path: parsed.manifestPath })
		: undefined
	const projectUid =
		existingManifest?.ok === true && existingManifest.value.projectUid !== undefined
			? existingManifest.value.projectUid
			: randomUUID()
	const state = await resolveWorkStateLocation({ root: parsed.root, projectId, projectUid })
	if (!state.ok) {
		return state
	}
	const manifestPath = await prepareSafeOutputPath({
		root: parsed.root,
		path: parsed.manifestPath,
		errorCode: 'unsafe_work_manifest',
	})
	if (!manifestPath.ok) {
		return manifestPath
	}
	const provider = createBeadsProvider({
		root: parsed.root,
		projectId,
		binary: parsed.binary,
		stateDirectory: state.value.directory,
		coordinationRoot: state.value.coordinationRoot,
	})
	const providerHealth = await provider.doctor()
	if (!providerHealth.ok) {
		return providerHealth
	}
	const itemDirectory = await prepareSafeOutputPath({
		root: parsed.root,
		path: '.work/items/.placeholder',
		errorCode: 'unsafe_work_directory',
	})
	if (!itemDirectory.ok) {
		return itemDirectory
	}
	const lock = await acquireConfigurationLock({
		root: state.value.coordinationRoot,
		intent: {
			schemaVersion: 1,
			kind: 'work_contract_initialize',
			pid: process.pid,
			manifestPath: parsed.manifestPath,
			projectId,
		},
	})
	if (!lock.ok) {
		return lock
	}
	const source = `version: 1\nproject:\n  id: ${projectId}\n  uid: ${projectUid}\ncompletionLedger: true\nsources:\n  - kind: issue\n    include: .work/items/*.md\npolicies:\n  contextMaxBytes: 12000\n  staleClaimMinutes: 90\n  terminalEvidence: [test, review]\n  delivery:\n    profile: evidence-only\n`
	let previous: string | undefined
	let manifestWritten = false
	let result: WorkResult<{
		readonly manifest: string
		readonly projectUid: string
		readonly provider: { readonly prefix: string }
	}>
	try {
		if (force) {
			const existing = await readBoundedUtf8({
				path: manifestPath.value,
				maxBytes: INPUT_LIMITS.manifestBytes,
				unavailableCode: 'invalid_work_manifest',
				tooLargeCode: 'work_manifest_too_large',
				label: 'Existing work manifest',
			})
			if (existing.ok) {
				previous = existing.value
			} else if (!existing.error.details?.some((detail) => detail.includes('ENOENT'))) {
				return await finalizeConfigurationMutation({ result: existing, lock: lock.value })
			}
		}
		await writeUtf8NoFollow({
			path: manifestPath.value,
			content: source,
			mode: force ? 'replace' : 'exclusive',
		})
		manifestWritten = true
		const initialized = await provider.initialize({ prefix: projectId })
		if (initialized.ok) {
			result = {
				ok: true,
				value: { manifest: parsed.manifestPath, projectUid, provider: initialized.value },
			}
		} else {
			const rollbackError = await restoreManifest(manifestPath.value, previous, source)
			result = rollbackError
				? {
						ok: false,
						error: {
							...initialized.error,
							details: [
								...(initialized.error.details ?? []),
								`Manifest rollback failed: ${rollbackError}`,
							],
						},
					}
				: initialized
		}
	} catch {
		const rollbackError = manifestWritten
			? await restoreManifest(manifestPath.value, previous, source)
			: undefined
		result = {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_work_manifest',
				message: 'Unable to initialize the work manifest.',
				...(rollbackError === undefined
					? {}
					: { details: [`Manifest rollback failed: ${rollbackError}`] }),
			},
		}
	}
	return finalizeConfigurationMutation({ result, lock: lock.value })
}

const parsePositive = (value: string | undefined, fallback: number): number => {
	if (value === undefined) {
		return fallback
	}
	const number = Number(value)
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new Error('Expected a positive integer option.')
	}
	return number
}

const isEvidenceKind = (value: string): value is EvidenceKind =>
	['test', 'review', 'build', 'ci', 'security', 'artifact'].includes(value) ||
	/^custom:[a-z][a-z0-9-]*$/.test(value)

const evidenceKind = (value: string): EvidenceKind => {
	if (isEvidenceKind(value)) {
		return value
	}
	throw new Error('Unsupported evidence kind.')
}

const reviewEvaluator = (value: string): 'agent' | 'human' => {
	if (value === 'agent' || value === 'human') {
		return value
	}
	throw new Error('Reviewer evaluator must be agent or human.')
}

const splitMapping = (value: string, label: string): readonly [string, string] => {
	const index = value.indexOf('=')
	if (index < 1 || index === value.length - 1) {
		throw new Error(`${label} must use key=value.`)
	}
	return [value.slice(0, index), value.slice(index + 1)]
}

const parseEvidenceOptions = (
	parsed: WorkContractInvocation,
): readonly {
	readonly kind: EvidenceKind
	readonly reference: string
	readonly digest?: string
}[] => {
	const digests = new Map(
		(parsed.options['evidence-digest'] ?? []).map((entry) =>
			splitMapping(entry, '--evidence-digest'),
		),
	)
	return (parsed.options.evidence ?? []).map((entry) => {
		const [kind, reference] = splitMapping(entry, '--evidence')
		const digest = digests.get(kind)
		return { kind: evidenceKind(kind), reference, ...(digest === undefined ? {} : { digest }) }
	})
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const displayField = (value: unknown, fallback = ''): string =>
	typeof value === 'string' || typeof value === 'number' ? String(value) : fallback

const renderHuman = (value: unknown): string => {
	if (typeof value === 'string') {
		return value
	}
	if (Array.isArray(value)) {
		return value.length === 0
			? 'No matching work.'
			: value
					.map((entry) => {
						if (!isRecord(entry)) {
							return `- ${String(entry)}`
						}
						const label = displayField(
							entry.id,
							displayField(entry.workId, displayField(entry.type, 'item')),
						)
						const state = displayField(entry.status, displayField(entry.title))
						return `- ${label}  ${state}`.trimEnd()
					})
					.join('\n')
	}
	return JSON.stringify(value, null, 2)
}

/** @description Output boundary injectable by tests and embedding applications. */
export interface CliIo {
	readonly stdout: (value: string) => void
	readonly stderr: (value: string) => void
	readonly stdin?: () => Promise<string>
}

const readHookInput = async (): Promise<string> => {
	const chunks: Buffer[] = []
	let total = 0
	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
		total += bytes.byteLength
		if (total > 256 * 1024) {
			return 'x'.repeat(256 * 1024 + 1)
		}
		chunks.push(bytes)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/** @description Executes one already parsed Stricli invocation against work-contract operations. */
/* oxlint-disable eslint/max-statements, eslint/complexity, eslint/max-lines-per-function -- Operation dispatch stays linear and delegates domain behavior to deep modules. */
const executeWorkContractInvocation = async (
	parsed: WorkContractInvocation,
	output: CliIo,
): Promise<number> => {
	const emitInvocationError = (error: unknown): number => {
		void error
		const message = `Invalid arguments for work ${parsed.command}; run work ${parsed.command} --help`
		output.stderr(
			parsed.json
				? JSON.stringify({
						ok: false,
						error: { type: 'work_contract_error', code: 'invalid_cli_invocation', message },
					})
				: message,
		)
		return 2
	}

	const emit = (
		result: WorkResult<unknown> | { readonly ok: true; readonly value: unknown },
		driftExit = false,
	): number => {
		if (!result.ok) {
			output.stderr(
				parsed.json
					? JSON.stringify(result)
					: `${result.error.code}: ${result.error.message}${result.error.details === undefined ? '' : `\n${result.error.details.join('\n')}`}`,
			)
			return 1
		}
		output.stdout(parsed.json ? JSON.stringify(result) : renderHuman(result.value))
		return driftExit ? 2 : 0
	}

	try {
		if (parsed.command === 'provider') {
			if (positional(parsed, 0, 'provider action') !== 'install') {
				throw new Error('Only provider install is supported.')
			}
			return emit(await installPinnedBeads())
		}
		if (parsed.command === 'init') {
			return emit(await initializeProject(parsed))
		}
		if (parsed.command === 'skill') {
			if (positional(parsed, 0, 'skill action') !== 'install') {
				throw new Error('Only skill install is supported.')
			}
			return emit(
				await installWorkContractSkill({
					root: parsed.root,
					force: option(parsed, 'force') !== undefined,
				}),
			)
		}
		if (parsed.command === 'feedback') {
			const coordinationRoot = await coordinationRootFor(parsed.root, parsed.manifestPath)
			const workId = option(parsed, 'work-id')
			const actor = option(parsed, 'actor')
			const sessionId = option(parsed, 'session')
			return emit(
				await writeDogfoodFeedback({
					root: coordinationRoot.ok ? coordinationRoot.value : parsed.root,
					kind: requiredOption(parsed, 'kind'),
					message: requiredOption(parsed, 'message'),
					...(workId === undefined ? {} : { workId }),
					...(actor === undefined ? {} : { actor }),
					...(sessionId === undefined ? {} : { sessionId }),
				}),
			)
		}
		if (parsed.command === 'telemetry') {
			const coordinationRoot = await coordinationRootFor(parsed.root, parsed.manifestPath)
			if (!coordinationRoot.ok) {
				return emit(coordinationRoot)
			}
			const action = positional(parsed, 0, 'telemetry action')
			if (action === 'enable' || action === 'disable') {
				return emit(
					await setCommandTelemetry({ root: coordinationRoot.value, enabled: action === 'enable' }),
				)
			}
			if (action === 'show') {
				const sessionId = option(parsed, 'session-id')
				const sessionCorrelation = option(parsed, 'session-correlation')
				const workId = option(parsed, 'work-id')
				return emit(
					await showCommandTelemetry({
						root: coordinationRoot.value,
						limit: parsePositive(option(parsed, 'limit'), 50),
						...(sessionId === undefined ? {} : { sessionId }),
						...(sessionCorrelation === undefined ? {} : { sessionCorrelation }),
						...(workId === undefined ? {} : { workId }),
					}),
				)
			}
			if (action === 'sessions') {
				return emit(
					await listCommandTelemetrySessions({
						root: coordinationRoot.value,
						limit: parsePositive(option(parsed, 'limit'), 20),
					}),
				)
			}
			throw new Error('Telemetry action must be enable, disable, show, or sessions.')
		}
		if (parsed.command === 'hooks') {
			const action = positional(parsed, 0, 'hooks action')
			if (action === 'init') {
				return emit(await initializeWorkHooks({ cwd: parsed.root }))
			}
			if (action === 'inspect') {
				return emit(await inspectWorkHooks({ cwd: parsed.root }))
			}
			const coordinationRoot = await coordinationRootFor(parsed.root, parsed.manifestPath)
			if (!coordinationRoot.ok) {
				return emit(coordinationRoot)
			}
			if (action === 'trust') {
				return emit(
					await trustWorkHooks({ cwd: parsed.root, coordinationRoot: coordinationRoot.value }),
				)
			}
			if (action === 'untrust') {
				return emit(
					await untrustWorkHooks({ cwd: parsed.root, coordinationRoot: coordinationRoot.value }),
				)
			}
			if (action === 'status') {
				const status = await statusWorkHooks({
					cwd: parsed.root,
					coordinationRoot: coordinationRoot.value,
				})
				return status.ok
					? emit({
							ok: true,
							value: {
								...status.value,
								cliAvailable: true,
								pluginArtifactPresent: await pluginArtifactPresent(),
								pluginInvocationActive:
									processEnvironment.PLUGIN_ROOT !== undefined ||
									processEnvironment.CLAUDE_PLUGIN_ROOT !== undefined,
							},
						})
					: emit(status)
			}
			if (action === 'dispatch') {
				const requestedRuntime = option(parsed, 'runtime') ?? 'auto'
				let runtime = requestedRuntime
				if (runtime === 'auto') {
					runtime = processEnvironment.CLAUDE_PROJECT_DIR === undefined ? 'codex' : 'claude'
				}
				if (runtime !== 'codex' && runtime !== 'claude') {
					throw new Error('Invalid hook runtime.')
				}
				const ambientSessionId = telemetrySessionId(parsed)
				const dispatched = await dispatchWorkHooks({
					cwd: parsed.root,
					coordinationRoot: coordinationRoot.value,
					runtime,
					nativeInput: await (output.stdin ?? readHookInput)(),
					recordTelemetry: async (event): Promise<void> => {
						const recorded = await recordHookTelemetry({
							root: coordinationRoot.value,
							event: event.event,
							entryId: event.id,
							durationMs: event.durationMs,
							outcome: event.outcome,
							outputMode: event.outputMode,
							...(event.skipReason === undefined ? {} : { skipReason: event.skipReason }),
							...(event.maxWaitMs === undefined ? {} : { maxWaitMs: event.maxWaitMs }),
							...(ambientSessionId === undefined ? {} : { sessionId: ambientSessionId }),
						})
						if (!recorded.ok) {
							output.stderr(renderTelemetryWarning({ json: false, error: recorded.error }))
						}
					},
				})
				if (!dispatched.ok) {
					return emit(dispatched)
				}
				if (dispatched.value.nativeOutput !== undefined) {
					output.stdout(dispatched.value.nativeOutput)
				}
				return 0
			}
			throw new Error('Hooks action must be init, inspect, trust, untrust, status, or dispatch.')
		}
		if (parsed.command === 'integration') {
			const coordinationRoot = await coordinationRootFor(parsed.root, parsed.manifestPath)
			if (!coordinationRoot.ok) {
				return emit(coordinationRoot)
			}
			const action = parsed.positionals[0] ?? 'status'
			if (action === 'status') {
				const inspected = await inspectIntegrationMutex(coordinationRoot.value)
				return emit(
					inspected.ok
						? {
								ok: true,
								value:
									inspected.value === undefined
										? { held: false }
										: { held: true, owner: inspected.value },
							}
						: inspected,
				)
			}
			const actor = requiredOption(parsed, 'actor')
			const session = option(parsed, 'session')
			if (action === 'acquire') {
				return emit(
					await acquireIntegrationMutex({
						root: coordinationRoot.value,
						actor,
						...(session === undefined ? {} : { session }),
					}),
				)
			}
			if (action === 'release') {
				return emit(
					await releaseIntegrationMutex({
						root: coordinationRoot.value,
						actor,
						nonce: requiredOption(parsed, 'nonce'),
						...(session === undefined ? {} : { session }),
					}),
				)
			}
			if (action === 'recover') {
				return emit(
					await recoverIntegrationMutex({
						root: coordinationRoot.value,
						actor,
						reason: requiredOption(parsed, 'reason'),
						...(session === undefined ? {} : { session }),
					}),
				)
			}
			throw new Error('Integration action must be status, acquire, release, or recover.')
		}
		if (parsed.command === 'sync') {
			const modes = ['check', 'plan', 'apply'].filter((name) => option(parsed, name) !== undefined)
			if (modes.length !== 1) {
				throw new Error('sync requires exactly one of --check, --plan, or --apply.')
			}
			if (modes[0] === 'apply') {
				return emit(await applyLockedSync(parsed))
			}
		}
		const loaded = await loadProject(parsed)
		if (!loaded.ok) {
			return emit(loaded)
		}
		const {
			manifest,
			graph,
			provider,
			state,
			definitionRevision,
			coordinationRoot,
			completionRecords,
		} = loaded.value
		if (parsed.command === 'reconcile' && manifest.completionLedger) {
			const workId = positional(parsed, 0, 'work ID')
			const restored = await restoreCompletionLedger({
				root: parsed.root,
				graph,
				records: completionRecords,
				provider,
				workId,
				...(definitionRevision === undefined ? {} : { definitionRevision }),
			})
			if (!restored.ok) {
				return emit(restored)
			}
		}
		if (parsed.command === 'doctor') {
			const doctor = await provider.doctor()
			const hooks = await statusWorkHooks({ cwd: parsed.root, coordinationRoot })
			const hookStatus = hooks.ok
				? hooks.value
				: {
						present: hooks.error.code !== 'hooks_config_unavailable',
						valid: false,
						committed: false,
						trusted: false,
						diagnostic: hooks.error.code,
					}
			return emit(
				doctor.ok
					? {
							ok: true,
							value: {
								...doctor.value,
								projectId: graph.projectId,
								...(manifest.projectUid === undefined ? {} : { projectUid: manifest.projectUid }),
								graphFingerprint: graph.fingerprint,
								items: graph.items.length,
								providerState: state,
								hooks: {
									...hookStatus,
									cliAvailable: true,
									pluginArtifactPresent: await pluginArtifactPresent(),
									pluginInvocationActive:
										processEnvironment.PLUGIN_ROOT !== undefined ||
										processEnvironment.CLAUDE_PLUGIN_ROOT !== undefined,
								},
							},
						}
					: doctor,
			)
		}
		if (parsed.command === 'compile') {
			return emit({ ok: true, value: graph })
		}
		if (parsed.command === 'graph') {
			return emit(
				projectGraph({
					graph,
					rootId: positional(parsed, 0, 'work ID'),
					depth: parsePositive(option(parsed, 'depth'), 2),
				}),
			)
		}
		if (parsed.command === 'proposal') {
			const action = positional(parsed, 0, 'proposal action')
			const proposalId = positional(parsed, 1, 'proposal ID')
			if (action !== 'validate' && action !== 'apply') {
				throw new Error('Proposal action must be validate or apply.')
			}
			const proposal = await loadPlanningProposal({ root: parsed.root, proposalId })
			if (!proposal.ok) {
				return emit(proposal)
			}
			const validated = await validatePlanningProposal({
				root: parsed.root,
				proposal: proposal.value,
				graph,
				manifest,
				manifestPath: parsed.manifestPath,
				allowDelete: option(parsed, 'allow-delete') !== undefined,
			})
			if (!validated.ok || action === 'validate') {
				return emit(validated)
			}
			return emit(
				await applyPlanningProposal({
					root: parsed.root,
					coordinationRoot,
					plan: validated.value,
					approvedFingerprint: requiredOption(parsed, 'approve'),
				}),
			)
		}
		if (parsed.command === 'overview' && provider.inspectCoordinationHealth !== undefined) {
			const coordination = await provider.inspectCoordinationHealth()
			if (!coordination.ok) {
				return emit(coordination)
			}
		}
		const listed = await provider.list()
		if (!listed.ok) {
			return emit(listed)
		}
		let items = listed.value.filter(({ projectId }) => projectId === graph.projectId)
		if (
			(parsed.command === 'sync' || parsed.command === 'drift') &&
			provider.discoverLegacyDefinitions !== undefined
		) {
			const legacy = await provider.discoverLegacyDefinitions()
			if (!legacy.ok) {
				return emit(legacy)
			}
			items = [...items, ...legacy.value]
		}
		const service = createWorkContractService({
			root: parsed.root,
			graph,
			provider,
			initialLedgerItems: items,
			staleClaimMinutes: manifest.policies.staleClaimMinutes,
			deliveryPolicy: manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
			...(definitionRevision === undefined ? {} : { definitionRevision }),
		})
		if (parsed.command === 'review') {
			const action = positional(parsed, 0, 'review action')
			const workId = positional(parsed, 1, 'work ID')
			if (action === 'status') {
				return emit(await service.reviewStatus(workId))
			}
			if (action === 'prepare') {
				const actor = requiredOption(parsed, 'actor')
				const role = option(parsed, 'role')
				const session = option(parsed, 'session')
				const prepared = await service.prepareReview({
					workId,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
				})
				return prepared.ok
					? emit({
							ok: true,
							value: {
								...prepared.value,
								nextActions: [
									{
										action: 'perform_review',
										owner: 'review',
										workId,
										reviewedHead: prepared.value.subject.headSha,
										report: prepared.value.suggestedReport,
									},
								],
							},
						})
					: emit(prepared)
			}
			if (action === 'approve' || action === 'request-changes') {
				const report = requiredOption(parsed, 'report')
				const reviewerSession = option(parsed, 'session')
				const decision = await service.recordReview({
					workId,
					reviewerActor: requiredOption(parsed, 'actor'),
					...(reviewerSession === undefined ? {} : { reviewerSession }),
					evaluator: reviewEvaluator(requiredOption(parsed, 'evaluator')),
					disposition: action === 'approve' ? 'approved' : 'changes_requested',
					reportReference: report,
					reviewedHead: requiredOption(parsed, 'head'),
				})
				if (!decision.ok) {
					return emit(decision)
				}
				const projection = await provider.publishRecoveryProjection({
					expected: [{ workId, status: 'in_progress' }],
				})
				if (!projection.ok) {
					return emit(projection)
				}
				const evidenceRequirements =
					graph.items.find(({ id }) => id === workId)?.evidenceRequirements ?? []
				const deliveryPolicy = manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY
				const approvedAction: WorkNextAction = manifest.completionLedger
					? {
							action: 'finalize',
							owner: 'work',
							command: 'work finalize',
							workId,
							actor: decision.value.review.implementationActor,
							evidenceRequirements,
						}
					: deliveryPolicy.profile === 'evidence-only'
						? {
								action: 'complete',
								owner: 'work',
								command: 'work complete',
								workId,
								actor: decision.value.review.implementationActor,
								evidenceRequirements,
								requiredGates: deliveryPolicy.requiredGates,
							}
						: {
								action: 'submit',
								owner: 'work',
								command: 'work submit',
								workId,
								actor: decision.value.review.implementationActor,
								evidenceRequirements,
							}
				const nextActions: WorkNextAction[] = [
					{
						action: 'commit_review_receipt',
						owner: 'operator',
						paths: [report, decision.value.reviewReceipt],
					},
					...(decision.value.disposition === 'approved'
						? [approvedAction]
						: [
								{ action: 'resume_rework' as const, owner: 'operator' as const, workId },
								{
									action: 'prepare_review' as const,
									owner: 'work' as const,
									command: 'work review prepare' as const,
									workId,
									actor: decision.value.review.implementationActor,
								},
							]),
				]
				return emit({ ok: true, value: { ...decision.value, nextActions } })
			}
			throw new Error(`Unsupported review action: ${action}.`)
		}
		if (parsed.command === 'finalize') {
			if (!manifest.completionLedger) {
				return emit({
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_transition',
						message: 'Enable completionLedger in work.yaml before using work finalize.',
					},
				})
			}
			const workId = positional(parsed, 0, 'work ID')
			const actor = requiredOption(parsed, 'actor')
			const role = option(parsed, 'role')
			const session = option(parsed, 'session')
			const artifact = graph.items.find(({ id }) => id === workId)
			const item = items.find(({ workId: candidate }) => candidate === workId)
			if (artifact === undefined || item === undefined) {
				return emit({
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'work_not_found',
						message: 'Unknown work item.',
					},
				})
			}
			if (artifact.execution === 'task') {
				if (item.status !== 'in_progress' || item.assignee !== actor) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'ownership_conflict',
							message: `${workId} must be finalized by its current owner.`,
						},
					})
				}
				if (role !== undefined && item.activity?.role !== role) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'role_conflict',
							message: 'Role assertion does not match the active claim.',
						},
					})
				}
				if (session !== undefined && item.activity?.session !== session) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'session_conflict',
							message: 'Session assertion does not match the active claim.',
						},
					})
				}
			} else {
				const children = graph.items.filter(({ parentId }) => parentId === workId)
				const incomplete = children.filter((child) => {
					const childItem = items.find(({ workId: childId }) => childId === child.id)
					const kinds = new Set(childItem?.evidence.map(({ kind }) => kind))
					return (
						childItem?.status !== 'closed' ||
						child.evidenceRequirements.some((kind) => !kinds.has(kind))
					)
				})
				if (incomplete.length > 0) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'aggregate_not_ready',
							message: `${workId} still has incomplete child work.`,
						},
					})
				}
			}
			const workspace = await observeGitWorkspace({ root: parsed.root })
			if (!workspace.ok) {
				return emit(workspace)
			}
			if (
				!workspace.value.available ||
				workspace.value.headSha === undefined ||
				workspace.value.dirty
			) {
				return emit({
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'candidate_dirty',
						message: 'Commit implementation changes before finalizing work.',
					},
				})
			}
			const localRecords = await loadCompletionLedger({ root: parsed.root })
			if (!localRecords.ok) {
				return emit(localRecords)
			}
			const existing = localRecords.value.find(({ workId: candidate }) => candidate === workId)
			let evidence = parseEvidenceOptions(parsed)
			if (artifact.execution === 'task' && artifact.evidenceRequirements.includes('review')) {
				const review = await service.reviewStatus(workId)
				if (!review.ok) {
					return emit(review)
				}
				if (review.value.state !== 'approved' || review.value.receipt === undefined) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: review.value.state === 'stale' ? 'review_target_stale' : 'review_required',
							message:
								review.value.state === 'stale'
									? 'The independent review is stale; request a fresh review.'
									: 'Independent approval is required before finalizing work.',
						},
					})
				}
				if (!evidence.some(({ kind }) => kind === 'review')) {
					evidence = [...evidence, { kind: 'review', reference: review.value.receipt }]
				}
			}
			const record = await buildCompletionRecord({
				root: parsed.root,
				workId,
				actor,
				...(role === undefined ? {} : { role }),
				...(session === undefined ? {} : { session }),
				...(artifact.execution === 'task'
					? { implementation: existing?.implementation ?? workspace.value.headSha }
					: {}),
				...(existing?.completedAt === undefined ? {} : { completedAt: existing.completedAt }),
				requiredEvidence: artifact.evidenceRequirements,
				evidence,
			})
			if (!record.ok) {
				return emit(record)
			}
			if (existing?.state === 'closed') {
				if (!isDeepStrictEqual(existing, record.value)) {
					return emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_completion_record',
							message: `${workId} already has a different completion record.`,
						},
					})
				}
				return emit({
					ok: true,
					value: {
						path: `docs/work/ledger/${workId}.yaml`,
						record: existing,
						idempotent: true,
						nextActions: [
							{ action: 'submit', owner: 'work', command: 'work submit', workId, actor },
						],
					},
				})
			}
			const written = await writeCompletionRecord({ root: parsed.root, record: record.value })
			return written.ok
				? emit({
						ok: true,
						value: {
							...written.value,
							nextActions: [
								{ action: 'commit_completion_record', owner: 'operator', path: written.value.path },
								{ action: 'submit', owner: 'work', command: 'work submit', workId, actor },
							],
						},
					})
				: emit(written)
		}
		if (parsed.command === 'complete' && manifest.completionLedger) {
			return emit({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_transition',
					message: 'Use work finalize, land its completion record, then run work reconcile.',
				},
			})
		}
		if (parsed.command === 'export') {
			return emit(
				await provider.publishRecoveryProjection({
					expected: graph.items.map(({ id }) => ({ workId: id })),
				}),
			)
		}
		if (parsed.command === 'sync' || parsed.command === 'drift') {
			const plan = planSync({
				graph,
				...(definitionRevision === undefined ? {} : { definitionRevision }),
				ledgerItems: items,
				archiveMissing: option(parsed, 'archive-missing') !== undefined,
			})
			if (!plan.ok) {
				return emit(plan)
			}
			const mode =
				parsed.command === 'drift'
					? 'check'
					: ['check', 'plan'].find((name) => option(parsed, name) !== undefined)
			const overlay =
				mode === 'check' && definitionRevision !== undefined
					? await inspectWorkspaceDefinitionOverlay({
							root: parsed.root,
							path: parsed.manifestPath,
							canonicalGraphFingerprint: graph.fingerprint,
						})
					: undefined
			if (overlay !== undefined && !overlay.ok) {
				return emit(overlay)
			}
			const overlayDrift =
				overlay?.value.status === 'different' || overlay?.value.status === 'invalid'
					? [
							{
								code: 'local_definition_overlay',
								workId: '*',
								message:
									overlay.value.status === 'different'
										? 'Caller-worktree definitions differ from canonical target definitions and are not eligible for provider synchronization.'
										: 'Caller-worktree definitions are invalid and are not eligible for provider synchronization.',
							},
						]
					: []
			const displayPlan =
				overlayDrift.length === 0
					? plan.value
					: { ...plan.value, drift: [...plan.value.drift, ...overlayDrift] }
			return emit(
				{ ok: true, value: displayPlan },
				mode === 'check' && (displayPlan.actions.length > 0 || displayPlan.drift.length > 0),
			)
		}
		if (parsed.command === 'snapshot') {
			const synchronized = await service.active()
			if (!synchronized.ok) {
				return emit(synchronized)
			}
		}
		if (parsed.command === 'snapshot') {
			return emit(await writeWorkSnapshot({ root: coordinationRoot, graph, ledgerItems: items }))
		}
		if (parsed.command === 'show' || parsed.command === 'status') {
			const id = positional(parsed, 0, 'work ID')
			const inspected = await service.inspect(id)
			if (!inspected.ok) {
				return emit(inspected)
			}
			const artifact = graph.items.find((entry) => entry.id === id)
			const ledger = items.find((entry) => entry.workId === id)
			const review =
				artifact?.execution === 'task' && artifact.evidenceRequirements.includes('review')
					? await service.reviewStatus(id)
					: undefined
			if (review !== undefined && !review.ok) {
				return emit(review)
			}
			return artifact === undefined
				? emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'work_not_found',
							message: 'Unknown work item.',
						},
					})
				: emit({
						ok: true,
						value: {
							definition: artifact,
							operation: ledger,
							...(review?.ok === true ? { review: review.value } : {}),
							...(inspected.value.aggregate === undefined
								? {}
								: { aggregate: inspected.value.aggregate }),
						},
					})
		}
		if (parsed.command === 'prepare') {
			const reference = positional(parsed, 0, 'work ID or source path')
			const matched = graph.items.filter(
				({ id, source }) => id === reference || source.path === reference,
			)
			if (matched.length === 1 && matched[0] !== undefined) {
				const synchronized = await service.validateDefinition(matched[0].id)
				if (!synchronized.ok) {
					return emit(synchronized)
				}
			}
			const workspace = await observeGitWorkspace({ root: parsed.root })
			if (!workspace.ok) {
				return emit(workspace)
			}
			return emit(
				prepareWorkLaunch({
					graph,
					...(definitionRevision === undefined ? {} : { definitionRevision }),
					ledgerItems: items,
					maxBytes: manifest.policies.contextMaxBytes,
					reference,
					deliveryPolicy: manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
					workspace: workspace.value,
					providerState: state,
				}),
			)
		}
		if (parsed.command === 'start') {
			const workspace = await observeGitWorkspace({ root: parsed.root })
			if (!workspace.ok) {
				return emit(workspace)
			}
			const packet = prepareWorkLaunch({
				graph,
				...(definitionRevision === undefined ? {} : { definitionRevision }),
				ledgerItems: items,
				maxBytes: manifest.policies.contextMaxBytes,
				reference: positional(parsed, 0, 'work ID or source path'),
				deliveryPolicy: manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
				workspace: workspace.value,
				providerState: state,
			})
			if (!packet.ok) {
				return emit(packet)
			}
			if (!packet.value.startable) {
				const deliveryPolicy = manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY
				return emit({
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'workspace_required',
						message: `${packet.value.workId} requires ${deliveryPolicy.isolation} isolation before it can be claimed.`,
						details: [
							...packet.value.admission.reasons,
							'action=provision_workspace',
							`isolation=${deliveryPolicy.isolation}`,
							`workId=${packet.value.workId}`,
							'then=work start',
						],
					},
				})
			}
			const actor = requiredOption(parsed, 'actor')
			const role = option(parsed, 'role')
			const session = option(parsed, 'session')
			const deliveryPolicy = manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY
			let terminalAction: WorkNextAction
			if (packet.value.evidenceRequirements.includes('review')) {
				terminalAction = {
					action: 'prepare_review',
					owner: 'work',
					command: 'work review prepare',
					workId: packet.value.workId,
					actor,
				}
			} else if (manifest.completionLedger) {
				terminalAction = {
					action: 'finalize',
					owner: 'work',
					command: 'work finalize',
					workId: packet.value.workId,
					actor,
					evidenceRequirements: packet.value.evidenceRequirements,
				}
			} else if (deliveryPolicy.profile === 'evidence-only') {
				terminalAction = {
					action: 'complete',
					owner: 'work',
					command: 'work complete',
					workId: packet.value.workId,
					actor,
					evidenceRequirements: packet.value.evidenceRequirements,
					requiredGates: deliveryPolicy.requiredGates,
				}
			} else {
				terminalAction = {
					action: 'submit',
					owner: 'work',
					command: 'work submit',
					workId: packet.value.workId,
					actor,
					evidenceRequirements: packet.value.evidenceRequirements,
				}
			}
			const claimed = await publishMutation(
				provider,
				await service.claim({
					workId: packet.value.workId,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
				}),
			)
			return claimed.ok
				? emit({
						ok: true,
						value: {
							schemaVersion: 1,
							command: 'start',
							packet: packet.value,
							receipt: claimed.value,
							nextActions: [
								{ action: 'perform_work', owner: 'operator', workId: packet.value.workId },
								terminalAction,
							],
						},
					})
				: emit(claimed)
		}
		if (parsed.command === 'context') {
			const id = positional(parsed, 0, 'work ID')
			const synchronized = await service.validateDefinition(id)
			if (!synchronized.ok) {
				return emit(synchronized)
			}
			return emit(
				buildOperationalContext({
					graph,
					ledgerItems: items,
					itemId: id,
					maxBytes: parsePositive(option(parsed, 'max-bytes'), manifest.policies.contextMaxBytes),
				}),
			)
		}
		if (parsed.command === 'ready') {
			const role = option(parsed, 'role')
			return emit(
				await service.ready({
					...(role === undefined ? {} : { role }),
					limit: parsePositive(option(parsed, 'limit'), 20),
				}),
			)
		}
		if (parsed.command === 'active') {
			return emit(await service.active())
		}
		if (parsed.command === 'dashboard' || parsed.command === 'overview') {
			const [ready, active] = await Promise.all([service.ready({ limit: 10 }), service.active()])
			if (!ready.ok) {
				return emit(ready)
			}
			if (!active.ok) {
				return emit(active)
			}
			if (parsed.command === 'dashboard') {
				return emit({
					ok: true,
					value: {
						projectId: graph.projectId,
						graphFingerprint: graph.fingerprint,
						ready: ready.value,
						active: active.value,
					},
				})
			}
			const readyItems = ready.value.map((item) => summarizeOverviewItem(item))
			const activeItems = active.value.slice(0, 10).map((item) => summarizeOverviewItem(item))
			const overview = {
				projectId: graph.projectId,
				graphFingerprint: graph.fingerprint,
				health: { status: 'ready', synchronized: true, provider: 'beads' },
				ready: readyItems,
				active: activeItems,
				recommended: readyItems[0] ?? null,
				actions: [
					{ command: 'prepare <id-or-path>', mutates: false },
					{ command: 'start <id-or-path> --actor <name>', mutates: true },
					{ command: 'claim <id> --actor <name>', mutates: true },
					{ command: 'show <id>', mutates: false },
					{ command: 'finalize <id> --actor <name> --evidence <kind=path>', mutates: true },
					{ command: 'review status <id>', mutates: false },
					{ command: 'review prepare|approve|request-changes <id>', mutates: true },
					{ command: 'submit <id> --actor <name>', mutates: true },
					{ command: 'integration status', mutates: false },
					{ command: 'reconcile <id> --actor <name>', mutates: true },
				],
			}
			return Buffer.byteLength(JSON.stringify(overview), 'utf8') <= 64 * 1024
				? emit({ ok: true, value: overview })
				: emit({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_context_budget',
							message: 'Work overview exceeds 65536 bytes.',
						},
					})
		}
		if (parsed.command === 'rollup') {
			return emit(await service.rollup(positional(parsed, 0, 'work ID')))
		}
		const workId = positional(parsed, 0, 'work ID')
		const actor = requiredOption(parsed, 'actor')
		const role = option(parsed, 'role')
		const session = option(parsed, 'session')
		if (parsed.command === 'claim') {
			return emit(
				await publishMutation(
					provider,
					await service.claim({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
					}),
				),
			)
		}
		if (parsed.command === 'submit') {
			const localCompletionRecords = manifest.completionLedger
				? await loadCompletionLedger({ root: parsed.root })
				: { ok: true as const, value: [] as const }
			if (!localCompletionRecords.ok) {
				return emit(localCompletionRecords)
			}
			const completionRecord = localCompletionRecords.value.find(
				(record) => record.workId === workId && record.state === 'closed',
			)
			if (manifest.completionLedger && completionRecord === undefined) {
				return emit({
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_transition',
						message: `Run work finalize ${workId} and commit its completion record before submitting.`,
					},
				})
			}
			const submitted = await publishMutation(
				provider,
				await service.submit({
					workId,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
					evidence: completionRecord?.evidence ?? parseEvidenceOptions(parsed),
				}),
			)
			return submitted.ok
				? emit({
						ok: true,
						value: {
							...submitted.value,
							nextActions:
								!manifest.completionLedger &&
								(manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY).profile ===
									'evidence-only'
									? [
											{
												action: 'complete' as const,
												owner: 'work' as const,
												command: 'work complete' as const,
												workId,
												actor,
												evidenceRequirements: submitted.value.candidate.evidence.map(
													({ kind }) => kind,
												),
												requiredGates: [],
											},
										]
									: [
											{
												action: 'integrate_candidate' as const,
												owner: 'integration' as const,
												workId,
												candidateGeneration: submitted.value.candidate.generation,
												integration: (manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY)
													.integration,
												...((manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY)
													.targetRef === undefined
													? {}
													: {
															targetRef: (
																manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY
															).targetRef,
														}),
												then: 'work reconcile' as const,
											},
										],
						},
					})
				: emit(submitted)
		}
		if (parsed.command === 'touch') {
			return emit(
				await publishMutation(
					provider,
					await service.touch({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
					}),
				),
			)
		}
		if (parsed.command === 'resume') {
			return emit(
				await publishMutation(
					provider,
					await service.resume({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
					}),
				),
			)
		}
		if (parsed.command === 'handoff') {
			const toActor = option(parsed, 'to-actor')
			const summary = await safeRead(parsed.root, requiredOption(parsed, 'summary-file'))
			if (!summary.ok) {
				return emit(summary)
			}
			return emit(
				await publishMutation(
					provider,
					await service.handoff({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
						summary: summary.value,
						remaining: parsed.options.remaining ?? [],
						references: parsed.options.reference ?? [],
						...(toActor === undefined ? {} : { toActor }),
						release: option(parsed, 'release') !== undefined,
					}),
				),
			)
		}
		if (parsed.command === 'block') {
			return emit(
				await publishMutation(
					provider,
					await service.block({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
						reason: requiredOption(parsed, 'reason'),
					}),
				),
			)
		}
		if (parsed.command === 'release') {
			return emit(
				await publishMutation(
					provider,
					await service.release({
						workId,
						actor,
						...(role === undefined ? {} : { role }),
						...(session === undefined ? {} : { session }),
						reason: requiredOption(parsed, 'reason'),
					}),
				),
			)
		}
		if (parsed.command === 'reopen') {
			const reopened = await publishMutation(
				provider,
				await service.reopen({
					workId,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
					reason: requiredOption(parsed, 'reason'),
				}),
			)
			if (!reopened.ok || !manifest.completionLedger) {
				return emit(reopened)
			}
			const recorded = await writeCompletionRecord({
				root: parsed.root,
				record: {
					version: 1,
					workId,
					state: 'open',
					reopenedAt: reopened.value.timestamp,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
					reason: requiredOption(parsed, 'reason'),
					evidence: [],
				},
			})
			return recorded.ok
				? emit({
						ok: true,
						value: {
							...reopened.value,
							completionRecord: recorded.value.path,
							nextActions: [
								{
									action: 'commit_reopen_record',
									owner: 'operator',
									path: recorded.value.path,
								},
							],
						},
					})
				: emit(recorded)
		}
		if (parsed.command === 'complete' || parsed.command === 'reconcile') {
			const completed = await publishMutation(
				provider,
				await service.complete({
					workId,
					actor,
					...(role === undefined ? {} : { role }),
					...(session === undefined ? {} : { session }),
					evidence: parseEvidenceOptions(parsed),
					receiptFiles: parsed.options.receipt ?? [],
				}),
			)
			if (!completed.ok && parsed.command === 'reconcile') {
				const current = items.find((item) => item.workId === workId)
				if (
					completed.error.code === 'candidate_missing' ||
					completed.error.code === 'candidate_stale'
				) {
					return emit({
						ok: true,
						value: {
							schemaVersion: 1,
							command: 'reconcile',
							workId,
							reconciled: false,
							nextActions: [
								{
									action: 'submit',
									owner: 'work',
									command: 'work submit',
									workId,
									actor,
									evidenceRequirements:
										graph.items.find(({ id }) => id === workId)?.evidenceRequirements ?? [],
								},
							],
						},
					})
				}
				if (
					completed.error.code === 'delivery_gates_incomplete' &&
					current?.candidate !== undefined
				) {
					const requiredGates = (manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY)
						.requiredGates
					const unsatisfied =
						completed.error.details?.flatMap((detail) => {
							const gate = detail.split('=')[0]
							if (gate === undefined) {
								return []
							}
							const requiredGate = requiredGates.find((candidate) => candidate === gate)
							return requiredGate === undefined ? [] : [requiredGate]
						}) ?? []
					const integrationGates = unsatisfied.filter((gate) =>
						['landing', 'merge', 'deployment', 'pull-request'].includes(gate),
					)
					const validationGates = unsatisfied.filter((gate) => !integrationGates.includes(gate))
					return emit({
						ok: true,
						value: {
							schemaVersion: 1,
							command: 'reconcile',
							workId,
							reconciled: false,
							nextActions: [
								...(integrationGates.length === 0
									? []
									: [
											{
												action: 'integrate_candidate',
												owner: 'integration',
												workId,
												candidateGeneration: current.candidate.generation,
												integration: (manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY)
													.integration,
												...((manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY)
													.targetRef === undefined
													? {}
													: {
															targetRef: (
																manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY
															).targetRef,
														}),
												then: 'work reconcile',
											},
										]),
								...(validationGates.length === 0
									? []
									: [
											{
												action: 'provide_gate_receipts',
												owner: 'validation',
												workId,
												gates: validationGates,
												then: 'work reconcile',
											},
										]),
							],
						},
					})
				}
			}
			let integrationMutexReleased = false
			if (completed.ok && parsed.command === 'reconcile' && manifest.completionLedger) {
				const lock = await inspectIntegrationMutex(coordinationRoot)
				if (lock.ok && lock.value?.actor === actor && lock.value.session === session) {
					const released = await releaseIntegrationMutex({
						root: coordinationRoot,
						actor,
						nonce: lock.value.nonce,
						...(session === undefined ? {} : { session }),
					})
					integrationMutexReleased = released.ok && released.value.released
				}
			}
			return completed.ok
				? emit({
						ok: true,
						value: {
							...completed.value,
							reconciled: true,
							integrationMutexReleased,
							nextActions: [
								...(graph.items.find(({ id }) => id === workId)?.execution === 'aggregate'
									? []
									: [
											{
												action: 'cleanup_workspace' as const,
												owner: 'integration' as const,
												workId,
												eligible: true,
											},
										]),
								{ action: 'review_next_work', owner: 'operator', command: 'work' },
							],
						},
					})
				: emit(completed)
		}
		throw new Error(`Unsupported command: ${parsed.command}.`)
	} catch (error: unknown) {
		return emitInvocationError(error)
	}
}
/* oxlint-enable eslint/max-statements, eslint/complexity, eslint/max-lines-per-function */

/** @description Renders complete command help generated from the Stricli application definition. */
export const renderHelp = (): string => renderWorkContractHelp()

/** @description Executes one CLI invocation and returns its stable process exit code. */
export const runWorkContractCli = async (args: readonly string[], io?: CliIo): Promise<number> => {
	const output = io ?? {
		stdout: (value: string): void => {
			process.stdout.write(`${value}\n`)
		},
		stderr: (value: string): void => {
			process.stderr.write(`${value}\n`)
		},
	}
	const executeWithTelemetry = async (
		invocation: WorkContractInvocation,
		invocationOutput: CliIo,
	): Promise<number> => {
		const startedAt = performance.now()
		const profiled = await withCommandPerformanceProfile(async () =>
			executeWorkContractInvocation(invocation, invocationOutput),
		)
		const exitCode = profiled.value
		if (
			invocation.command === 'telemetry' &&
			(exitCode !== 0 || ['show', 'sessions'].includes(invocation.positionals[0] ?? ''))
		) {
			return exitCode
		}
		if (invocation.command === 'hooks' && invocation.positionals[0] === 'dispatch') {
			return exitCode
		}
		const coordinationRoot = await coordinationRootFor(invocation.root, invocation.manifestPath)
		if (!coordinationRoot.ok) {
			invocationOutput.stderr(
				renderTelemetryWarning({ json: invocation.json, error: coordinationRoot.error }),
			)
			return exitCode
		}
		const ambientSessionId = telemetrySessionId(invocation)
		const telemetry = await recordCommandTelemetry({
			root: coordinationRoot.value,
			invocation,
			exitCode,
			durationMs: performance.now() - startedAt,
			phases: profiled.phases,
			...(processEnvironment.WORK_CONTRACT_RUN_ID === undefined
				? {}
				: { runId: processEnvironment.WORK_CONTRACT_RUN_ID }),
			...(ambientSessionId === undefined ? {} : { sessionId: ambientSessionId }),
		})
		if (!telemetry.ok) {
			invocationOutput.stderr(
				renderTelemetryWarning({ json: invocation.json, error: telemetry.error }),
			)
		}
		return exitCode
	}
	return runWorkContractProgram({
		args,
		io: output,
		execute: executeWithTelemetry,
		onInvalidInvocation: async (failure): Promise<void> => {
			const coordinationRoot = await coordinationRootFor(failure.root, failure.manifestPath)
			if (!coordinationRoot.ok) {
				output.stderr(
					renderTelemetryWarning({ json: args.includes('--json'), error: coordinationRoot.error }),
				)
				return
			}
			const ambientSessionId = telemetrySessionId()
			const telemetry = await recordCliFailureTelemetry({
				...failure,
				root: coordinationRoot.value,
				...(processEnvironment.WORK_CONTRACT_RUN_ID === undefined
					? {}
					: { runId: processEnvironment.WORK_CONTRACT_RUN_ID }),
				...(ambientSessionId === undefined ? {} : { sessionId: ambientSessionId }),
			})
			if (!telemetry.ok) {
				output.stderr(
					renderTelemetryWarning({ json: args.includes('--json'), error: telemetry.error }),
				)
			}
		},
	})
}
