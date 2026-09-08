/**
 * @description Plans and applies deterministic file-definition reconciliation through a ledger provider.
 *
 * @module work/sync
 * @file Sync.ts
 */

import type {
	CanonicalDefinitionRevision,
	CompiledWorkGraph,
	WorkError,
	WorkResult,
} from './contracts'
import type { LedgerItem, LedgerProvider } from './provider'
import { sanitizeProviderError, validateLedgerProjection } from './provider'

/** @description One authorized definition reconciliation mutation. */
type SyncAction =
	| { readonly type: 'create'; readonly workId: string }
	| { readonly type: 'update'; readonly workId: string }
	| { readonly type: 'relations'; readonly workId: string }
	| { readonly type: 'archive'; readonly workId: string }

/** @description Non-mutating definition/ledger divergence requiring attention. */
interface SyncDrift {
	readonly code: string
	readonly workId: string
	readonly message: string
}

/** @description Branded deterministic reconciliation plan returned by {@link planSync}. */
export interface SyncPlan {
	readonly schemaVersion: 1
	readonly graphFingerprint: string
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly actions: readonly SyncAction[]
	readonly drift: readonly SyncDrift[]
}

const validatedSyncPlanMarker = Symbol('work-contract.validated-sync-plan')

const isValidatedSyncPlan = (value: unknown): value is SyncPlan =>
	typeof value === 'object' &&
	value !== null &&
	validatedSyncPlanMarker in value &&
	value[validatedSyncPlanMarker] === true

const artifactDepths = (
	items: ReadonlyMap<string, CompiledWorkGraph['items'][number]>,
): ReadonlyMap<string, number> => {
	const depths = new Map<string, number>()
	for (const start of items.keys()) {
		if (depths.has(start)) {
			continue
		}
		const path: string[] = []
		const positions = new Map<string, number>()
		let current: string | undefined = start
		let baseDepth = -1
		let cycleStart: number | undefined
		while (current !== undefined) {
			const knownDepth = depths.get(current)
			if (knownDepth !== undefined) {
				baseDepth = knownDepth
				break
			}
			cycleStart = positions.get(current)
			if (cycleStart !== undefined) {
				break
			}
			const item = items.get(current)
			if (item === undefined) {
				break
			}
			positions.set(current, path.length)
			path.push(current)
			current = item.parentId
		}
		if (cycleStart !== undefined) {
			for (const workId of path.slice(cycleStart)) {
				depths.set(workId, 0)
			}
			path.splice(cycleStart)
			baseDepth = 0
		}
		for (const workId of path.toReversed()) {
			baseDepth += 1
			depths.set(workId, baseDepth)
		}
	}
	return depths
}

const sameSemanticDefinition = (
	artifact: CompiledWorkGraph['items'][number],
	ledgerItem: LedgerItem,
): boolean =>
	artifact.title === ledgerItem.title &&
	artifact.kind === ledgerItem.kind &&
	artifact.execution === (ledgerItem.execution ?? 'task') &&
	artifact.source.path === ledgerItem.source.path &&
	artifact.source.hash === ledgerItem.source.hash &&
	JSON.stringify([...artifact.roles].toSorted()) ===
		JSON.stringify([...ledgerItem.roles].toSorted()) &&
	JSON.stringify([...artifact.evidenceRequirements].toSorted()) ===
		JSON.stringify([...ledgerItem.evidenceRequirements].toSorted())

const sameDefinition = (
	artifact: CompiledWorkGraph['items'][number],
	ledgerItem: LedgerItem,
	definitionRevision?: CanonicalDefinitionRevision,
): boolean =>
	ledgerItem.definitionSchemaVersion === (definitionRevision === undefined ? 2 : 3) &&
	(definitionRevision === undefined ||
		(ledgerItem.definitionRevision?.targetRef === definitionRevision.targetRef &&
			ledgerItem.definitionRevision.graphFingerprint === definitionRevision.graphFingerprint)) &&
	sameSemanticDefinition(artifact, ledgerItem)

const sameRelations = (
	artifact: CompiledWorkGraph['items'][number],
	ledgerItem: LedgerItem,
): boolean =>
	artifact.parentId === ledgerItem.parentId &&
	JSON.stringify([...artifact.dependencies].toSorted()) ===
		JSON.stringify([...ledgerItem.dependencies].toSorted())

const providerPostconditionError = (): WorkError => ({
	type: 'work_contract_error',
	code: 'invalid_ledger_projection',
	message: 'Ledger provider did not confirm the requested sync postcondition.',
	details: ['stateMayHaveChanged=true'],
})

const hasExactDefinition = (input: {
	readonly artifact: CompiledWorkGraph['items'][number]
	readonly graphFingerprint?: string
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly item: LedgerItem
}): boolean =>
	input.item.definitionSchemaVersion === (input.definitionRevision === undefined ? 2 : 3) &&
	sameDefinition(input.artifact, input.item, input.definitionRevision) &&
	(input.graphFingerprint === undefined || input.item.graphFingerprint === input.graphFingerprint)

const validateProviderItem = (input: {
	readonly value: unknown
	readonly projectId: string
	readonly workId: string
	readonly postcondition: (item: LedgerItem) => boolean
}): WorkResult<LedgerItem> => {
	const projection = validateLedgerProjection([input.value])
	const item = projection.ok ? projection.value[0] : undefined
	if (
		item === undefined ||
		item.projectId !== input.projectId ||
		item.workId !== input.workId ||
		!input.postcondition(item)
	) {
		return { ok: false, error: providerPostconditionError() }
	}
	return { ok: true, value: item }
}

const validateCreatedItem = (input: {
	readonly value: unknown
	readonly graph: CompiledWorkGraph
	readonly artifact: CompiledWorkGraph['items'][number]
	readonly definitionRevision?: CanonicalDefinitionRevision
}): WorkResult<LedgerItem> =>
	validateProviderItem({
		value: input.value,
		projectId: input.graph.projectId,
		workId: input.artifact.id,
		postcondition: (item) =>
			hasExactDefinition({
				artifact: input.artifact,
				graphFingerprint: input.graph.fingerprint,
				...(input.definitionRevision === undefined
					? {}
					: { definitionRevision: input.definitionRevision }),
				item,
			}) &&
			item.status === 'open' &&
			item.parentId === undefined &&
			item.dependencies.length === 0 &&
			item.assignee === undefined &&
			item.activity === undefined &&
			item.handoff === undefined &&
			item.evidence.length === 0 &&
			item.blockReason === undefined,
	})

const validateBatchCreateResult = (input: {
	readonly value: unknown
	readonly graph: CompiledWorkGraph
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly definitions: readonly {
		readonly artifact: CompiledWorkGraph['items'][number]
	}[]
}): WorkResult<readonly LedgerItem[]> => {
	const projection = validateLedgerProjection(input.value)
	if (!projection.ok || projection.value.length !== input.definitions.length) {
		return { ok: false, error: providerPostconditionError() }
	}
	const validated: LedgerItem[] = []
	const workIds = new Set<string>()
	for (const [index, definition] of input.definitions.entries()) {
		const candidate = projection.value[index]
		const result = validateCreatedItem({
			value: candidate,
			graph: input.graph,
			artifact: definition.artifact,
			...(input.definitionRevision === undefined
				? {}
				: { definitionRevision: input.definitionRevision }),
		})
		if (!result.ok || workIds.has(result.value.workId)) {
			return { ok: false, error: providerPostconditionError() }
		}
		workIds.add(result.value.workId)
		validated.push(result.value)
	}
	return { ok: true, value: validated }
}

const isValidBatchFailure = (input: {
	readonly applied: unknown
	readonly failedIndex: unknown
	readonly batchSize: number
}): boolean =>
	Number.isInteger(input.applied) &&
	typeof input.applied === 'number' &&
	input.applied >= 0 &&
	input.applied <= input.batchSize &&
	(input.failedIndex === undefined ||
		(Number.isInteger(input.failedIndex) &&
			typeof input.failedIndex === 'number' &&
			input.failedIndex >= 0 &&
			input.failedIndex < input.batchSize &&
			input.applied < input.batchSize))

/** @description Compares a compiled graph with a ledger projection without mutating either. */
export const planSync = (input: {
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
	readonly definitionRevision?: CanonicalDefinitionRevision
	readonly archiveMissing?: boolean
}): WorkResult<SyncPlan> => {
	const projection = validateLedgerProjection(input.ledgerItems)
	if (!projection.ok) {
		return projection
	}
	if (projection.value.some(({ projectId }) => projectId !== input.graph.projectId)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_ledger_projection',
				message: 'Ledger projection contains work from another project.',
			},
		}
	}
	const artifacts = new Map(input.graph.items.map((item) => [item.id, item]))
	const ledger = new Map<string, LedgerItem>()
	for (const item of projection.value) {
		if (ledger.has(item.workId)) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					message: `Ledger contains duplicate work ID ${item.workId}.`,
				},
			}
		}
		ledger.set(item.workId, item)
	}

	const actions: SyncAction[] = []
	const drift: SyncDrift[] = []
	const depths = artifactDepths(artifacts)
	const orderedArtifacts = [...input.graph.items].toSorted((left, right) => {
		const depth = (depths.get(left.id) ?? 0) - (depths.get(right.id) ?? 0)
		return depth === 0 ? left.id.localeCompare(right.id) : depth
	})

	for (const artifact of orderedArtifacts) {
		const current = ledger.get(artifact.id)
		if (current === undefined) {
			actions.push({ type: 'create', workId: artifact.id })
			continue
		}
		if (
			(current.status === 'in_progress' || current.status === 'blocked') &&
			!sameSemanticDefinition(artifact, current)
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message: `${artifact.id} is active and its canonical definition changed.`,
				},
			}
		}
		const preservesClaimBoundRevision =
			(current.status === 'in_progress' || current.status === 'blocked') &&
			current.definitionSchemaVersion === 3 &&
			sameSemanticDefinition(artifact, current)
		if (
			!preservesClaimBoundRevision &&
			!sameDefinition(artifact, current, input.definitionRevision)
		) {
			actions.push({ type: 'update', workId: artifact.id })
			drift.push({
				code: 'definition_drift',
				workId: artifact.id,
				message: 'Ledger definition differs from its source file.',
			})
		}
	}

	for (const artifact of orderedArtifacts) {
		const current = ledger.get(artifact.id)
		if (
			current !== undefined &&
			(current.status === 'in_progress' || current.status === 'blocked') &&
			!sameRelations(artifact, current)
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message: `${artifact.id} is active and its canonical relations changed.`,
				},
			}
		}
		if (
			(current === undefined &&
				(artifact.parentId !== undefined || artifact.dependencies.length > 0)) ||
			(current !== undefined && !sameRelations(artifact, current))
		) {
			actions.push({ type: 'relations', workId: artifact.id })
		}
	}

	for (const ledgerItem of [...projection.value].toSorted((left, right) =>
		left.workId.localeCompare(right.workId),
	)) {
		if (artifacts.has(ledgerItem.workId) || ledgerItem.status === 'archived') {
			continue
		}
		if (
			input.archiveMissing === true &&
			(ledgerItem.status === 'in_progress' || ledgerItem.status === 'blocked')
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'active_definition_conflict',
					message: `${ledgerItem.workId} is active and cannot be removed from canonical definitions.`,
				},
			}
		}
		if (input.archiveMissing === true) {
			actions.push({ type: 'archive', workId: ledgerItem.workId })
		} else {
			drift.push({
				code: 'orphaned_ledger_item',
				workId: ledgerItem.workId,
				message: 'Ledger item has no source definition.',
			})
		}
	}

	const plan: SyncPlan = {
		schemaVersion: 1,
		graphFingerprint: input.graph.fingerprint,
		...(input.definitionRevision === undefined
			? {}
			: { definitionRevision: input.definitionRevision }),
		actions: Object.freeze(actions.map((action) => Object.freeze(action))),
		drift: Object.freeze(drift.map((entry) => Object.freeze(entry))),
	}
	Object.defineProperty(plan, validatedSyncPlanMarker, { value: true })
	return { ok: true, value: Object.freeze(plan) }
}

const syncApplyFailure = (input: {
	readonly action: SyncAction
	readonly applied: number
	readonly providerError: WorkError
}): WorkResult<never> => {
	const providerError = sanitizeProviderError(input.providerError)
	return {
		ok: false,
		error: {
			type: 'work_contract_error',
			code: 'sync_apply_failed',
			message: `Sync stopped while applying ${input.action.type}:${input.action.workId}.`,
			details: [
				`applied=${input.applied}`,
				`providerCode=${providerError.code}`,
				...(providerError.details ?? []),
			],
		},
	}
}

const syncBatchApplyFailure = (input: {
	readonly applied: number
	readonly failedWorkId?: string
	readonly providerError: WorkError
}): WorkResult<never> => {
	const providerError = sanitizeProviderError(input.providerError)
	return {
		ok: false,
		error: {
			type: 'work_contract_error',
			code: 'sync_apply_failed',
			message:
				input.failedWorkId === undefined
					? 'Sync stopped while finalizing the definition create batch.'
					: `Sync stopped while applying create:${input.failedWorkId}.`,
			details: [
				`applied=${input.applied}`,
				`providerCode=${providerError.code}`,
				...(providerError.details ?? []),
			],
		},
	}
}

/** @description Applies only an unchanged in-memory plan returned by {@link planSync}. */
// oxlint-disable-next-line eslint/max-statements -- The ordered sync transaction stays linear while each provider boundary is delegated and validated.
export const applySyncPlan = async (input: {
	readonly graph: CompiledWorkGraph
	readonly plan: unknown
	readonly provider: LedgerProvider
}): Promise<WorkResult<{ readonly applied: number; readonly graphFingerprint: string }>> => {
	if (!isValidatedSyncPlan(input.plan)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'unvalidated_sync_plan',
				message: 'Sync application requires the unchanged result of planSync.',
			},
		}
	}
	if (input.plan.graphFingerprint !== input.graph.fingerprint) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'stale_sync_plan',
				message: 'Sync plan does not match the current work graph.',
			},
		}
	}
	const definitionRevision = input.plan.definitionRevision
	const artifacts = new Map(input.graph.items.map((item) => [item.id, item]))
	let applied = 0
	let actionIndex = 0
	while (actionIndex < input.plan.actions.length) {
		const action = input.plan.actions[actionIndex]
		if (action === undefined) {
			break
		}
		if (action.type === 'create' && input.provider.createDefinitions !== undefined) {
			const createActions = []
			for (let index = actionIndex; index < input.plan.actions.length; index += 1) {
				const candidate = input.plan.actions[index]
				if (candidate?.type !== 'create') {
					break
				}
				createActions.push(candidate)
			}
			const definitions = createActions.flatMap(({ workId }) => {
				const artifact = artifacts.get(workId)
				return artifact === undefined
					? []
					: [
							{
								projectId: input.graph.projectId,
								graphFingerprint: input.graph.fingerprint,
								...(definitionRevision === undefined ? {} : { definitionRevision }),
								artifact,
							},
						]
			})
			if (definitions.length !== createActions.length) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'invalid_sync_plan',
						message: 'Sync create action references unknown work.',
					},
				}
			}
			const result = await input.provider.createDefinitions(definitions)
			if (!result.ok) {
				if (
					!isValidBatchFailure({
						applied: result.applied,
						failedIndex: result.failedIndex,
						batchSize: definitions.length,
					})
				) {
					return syncBatchApplyFailure({
						applied,
						providerError: providerPostconditionError(),
					})
				}
				const failedWorkId =
					result.failedIndex === undefined
						? undefined
						: definitions[result.failedIndex]?.artifact.id
				return syncBatchApplyFailure({
					...(failedWorkId === undefined ? {} : { failedWorkId }),
					applied: applied + result.applied,
					providerError: result.error,
				})
			}
			const validated = validateBatchCreateResult({
				value: result.value,
				graph: input.graph,
				...(definitionRevision === undefined ? {} : { definitionRevision }),
				definitions,
			})
			if (!validated.ok) {
				return syncBatchApplyFailure({
					applied,
					providerError: validated.error,
				})
			}
			applied += validated.value.length
			actionIndex += createActions.length
			continue
		}
		if (action.type === 'archive') {
			const result = await input.provider.archive(action.workId)
			if (!result.ok) {
				return syncApplyFailure({ action, applied, providerError: result.error })
			}
			const validated = validateProviderItem({
				value: result.value,
				projectId: input.graph.projectId,
				workId: action.workId,
				postcondition: (item) => item.status === 'archived',
			})
			if (!validated.ok) {
				return syncApplyFailure({ action, applied, providerError: validated.error })
			}
			applied += 1
			actionIndex += 1
			continue
		}
		const artifact = artifacts.get(action.workId)
		if (artifact === undefined) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_sync_plan',
					message: `Sync action references unknown work ${action.workId}.`,
				},
			}
		}
		if (action.type === 'relations') {
			const result = await input.provider.setRelations({
				workId: artifact.id,
				parentId: artifact.parentId,
				dependencies: artifact.dependencies,
			})
			if (!result.ok) {
				return syncApplyFailure({ action, applied, providerError: result.error })
			}
			const validated = validateProviderItem({
				value: result.value,
				projectId: input.graph.projectId,
				workId: artifact.id,
				postcondition: (item) =>
					hasExactDefinition({
						artifact,
						item,
						...(definitionRevision === undefined ? {} : { definitionRevision }),
					}) && sameRelations(artifact, item),
			})
			if (!validated.ok) {
				return syncApplyFailure({ action, applied, providerError: validated.error })
			}
			applied += 1
			actionIndex += 1
			continue
		}
		const definition = {
			projectId: input.graph.projectId,
			graphFingerprint: input.graph.fingerprint,
			...(definitionRevision === undefined ? {} : { definitionRevision }),
			artifact,
		}
		const result =
			action.type === 'create'
				? await input.provider.createDefinition(definition)
				: await input.provider.updateDefinition(definition)
		if (!result.ok) {
			return syncApplyFailure({ action, applied, providerError: result.error })
		}
		const validated =
			action.type === 'create'
				? validateCreatedItem({
						value: result.value,
						graph: input.graph,
						artifact,
						...(definitionRevision === undefined ? {} : { definitionRevision }),
					})
				: validateProviderItem({
						value: result.value,
						projectId: input.graph.projectId,
						workId: artifact.id,
						postcondition: (item) =>
							hasExactDefinition({
								artifact,
								graphFingerprint: input.graph.fingerprint,
								...(definitionRevision === undefined ? {} : { definitionRevision }),
								item,
							}),
					})
		if (!validated.ok) {
			return syncApplyFailure({ action, applied, providerError: validated.error })
		}
		applied += 1
		actionIndex += 1
	}
	return { ok: true, value: { applied, graphFingerprint: input.graph.fingerprint } }
}
