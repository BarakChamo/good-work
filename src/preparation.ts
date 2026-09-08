/**
 * @description Resolves safe work references and constructs bounded pre-claim launch packets.
 *
 * @module work/preparation
 * @file Preparation.ts
 */

import { isAbsolute } from 'node:path'

import type {
	CanonicalDefinitionRevision,
	CompiledWorkGraph,
	WorkDeliveryPolicy,
	WorkLaunchPacket,
	ProviderStateObservation,
	WorkResult,
	WorkspaceObservation,
} from './contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY } from './contracts'
import { buildOperationalContext } from './context'
import type { LedgerItem } from './provider'

export { observeGitWorkspace } from './git-observer'
export { resolveWorkStateLocation } from './work-state'

const maximumLaunchPacketBytes = 64 * 1024

const successful = (input: {
	readonly artifact: CompiledWorkGraph['items'][number]
	readonly item: LedgerItem
}): boolean => {
	const providedKinds = new Set(input.item.evidence.map(({ kind }) => kind))
	return (
		input.item.status === 'closed' &&
		input.artifact.evidenceRequirements.every((kind) => providedKinds.has(kind))
	)
}

const sameValues = (left: readonly string[], right: readonly string[]): boolean => {
	const actual = [...left].toSorted()
	const expected = [...right].toSorted()
	return (
		actual.length === expected.length && actual.every((value, index) => value === expected[index])
	)
}

const definitionMatches = (input: {
	readonly artifact: CompiledWorkGraph['items'][number]
	readonly item: LedgerItem
	readonly graph: CompiledWorkGraph
	readonly definitionRevision?: CanonicalDefinitionRevision
}): boolean =>
	input.item.definitionSchemaVersion === (input.definitionRevision === undefined ? 2 : 3) &&
	(input.definitionRevision === undefined ||
		input.item.definitionRevision?.targetRef === input.definitionRevision.targetRef) &&
	input.item.projectId === input.graph.projectId &&
	input.item.workId === input.artifact.id &&
	input.item.title === input.artifact.title &&
	input.item.kind === input.artifact.kind &&
	(input.item.execution ?? 'task') === input.artifact.execution &&
	input.item.source.path === input.artifact.source.path &&
	input.item.source.hash === input.artifact.source.hash &&
	input.item.parentId === input.artifact.parentId &&
	sameValues(input.item.dependencies, input.artifact.dependencies) &&
	sameValues(input.item.roles, input.artifact.roles) &&
	sameValues(input.item.evidenceRequirements, input.artifact.evidenceRequirements)

const unsafeReference = (reference: string): boolean =>
	reference.trim() === '' ||
	reference.length > 500 ||
	reference.includes('\0') ||
	isAbsolute(reference) ||
	reference.split(/[\\/]/u).includes('..')

/** @description Resolves one canonical ID or registered source path and validates startability without mutation. */
export const prepareWorkLaunch = (input: {
	readonly graph: CompiledWorkGraph
	readonly ledgerItems: readonly LedgerItem[]
	readonly maxBytes: number
	readonly reference: string
	readonly deliveryPolicy?: WorkDeliveryPolicy
	readonly workspace?: WorkspaceObservation
	readonly providerState?: ProviderStateObservation
	readonly definitionRevision?: CanonicalDefinitionRevision
}): WorkResult<WorkLaunchPacket> => {
	if (unsafeReference(input.reference)) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'unsafe_work_reference',
				message:
					'Work reference must be a canonical ID or registered repository-relative source path.',
			},
		}
	}
	const matches = input.graph.items.filter(
		({ id, source }) => id === input.reference || source.path === input.reference,
	)
	if (matches.length > 1) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'ambiguous_work_reference',
				message: 'Work reference matches multiple definitions.',
			},
		}
	}
	const artifact = matches[0]
	if (artifact === undefined) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_not_found',
				message: 'Unknown work reference.',
			},
		}
	}
	const ledgerById = new Map(input.ledgerItems.map((item) => [item.workId, item]))
	const graphById = new Map(input.graph.items.map((item) => [item.id, item]))
	const requiredIds = new Set<string>()
	const pending = [artifact.id]
	while (pending.length > 0) {
		const requiredId = pending.pop()
		if (requiredId === undefined || requiredIds.has(requiredId)) {
			continue
		}
		requiredIds.add(requiredId)
		const requiredArtifact = graphById.get(requiredId)
		if (requiredArtifact === undefined) {
			continue
		}
		pending.push(...requiredArtifact.dependencies)
		if (requiredArtifact.parentId !== undefined) {
			pending.push(requiredArtifact.parentId)
		}
	}
	for (const requiredId of requiredIds) {
		const requiredItem = ledgerById.get(requiredId)
		const requiredArtifact = graphById.get(requiredId)
		if (
			requiredItem === undefined ||
			requiredArtifact === undefined ||
			!definitionMatches({
				artifact: requiredArtifact,
				item: requiredItem,
				graph: input.graph,
				...(input.definitionRevision === undefined
					? {}
					: { definitionRevision: input.definitionRevision }),
			})
		) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'definition_drift',
					message: `${requiredId} ledger definition is stale; run sync before claiming.`,
				},
			}
		}
	}
	if (artifact.execution === 'aggregate') {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'aggregate_not_executable',
				message: `${artifact.id} derives progress from direct children and cannot be started.`,
			},
		}
	}
	const current = ledgerById.get(artifact.id)
	const blockedBy = artifact.dependencies.filter((id) => {
		const dependency = ledgerById.get(id)
		const dependencyArtifact = graphById.get(id)
		return (
			dependency === undefined ||
			dependencyArtifact === undefined ||
			!successful({ artifact: dependencyArtifact, item: dependency })
		)
	})
	if (current?.status !== 'open' || current.assignee !== undefined || blockedBy.length > 0) {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_not_ready',
				message: `${artifact.id} is not ready to claim.`,
				...(blockedBy.length === 0 ? {} : { details: [`Blocked by: ${blockedBy.join(', ')}`] }),
			},
		}
	}
	const context = buildOperationalContext({
		graph: input.graph,
		ledgerItems: input.ledgerItems,
		itemId: artifact.id,
		maxBytes: input.maxBytes,
	})
	if (!context.ok) {
		return context
	}
	const deliveryPolicy = input.deliveryPolicy ?? EVIDENCE_ONLY_DELIVERY_POLICY
	const reasons: string[] = []
	if (deliveryPolicy.isolation === 'worktree' && input.workspace?.isolation !== 'worktree') {
		reasons.push('linked_worktree_required')
	}
	if (deliveryPolicy.isolation === 'container' && input.workspace?.isolation !== 'container') {
		reasons.push('container_required')
	}
	const admitted = reasons.length === 0
	const packet: WorkLaunchPacket = {
		schemaVersion: 1,
		projectId: input.graph.projectId,
		graphFingerprint: input.graph.fingerprint,
		reference: input.reference,
		workId: artifact.id,
		execution: artifact.execution,
		sourcePath: artifact.source.path,
		...(artifact.parentId === undefined ? {} : { parentId: artifact.parentId }),
		dependencies: artifact.dependencies,
		roles: artifact.roles,
		evidenceRequirements: artifact.evidenceRequirements,
		context: context.value,
		deliveryPolicy,
		...(input.workspace === undefined ? {} : { workspace: input.workspace }),
		...(input.providerState === undefined ? {} : { providerState: input.providerState }),
		admission: { admitted, reasons },
		nextActions: admitted
			? [
					{
						action: 'start',
						owner: 'work',
						command: 'work start',
						workId: artifact.id,
						requires: ['actor'],
					},
				]
			: [
					{
						action: 'provision_workspace',
						owner: 'integration',
						isolation: deliveryPolicy.isolation === 'container' ? 'container' : 'worktree',
						workId: artifact.id,
						then: 'work start',
					},
				],
		startable: admitted,
	}
	return Buffer.byteLength(JSON.stringify(packet), 'utf8') <= maximumLaunchPacketBytes
		? { ok: true, value: packet }
		: {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_context_budget',
					message: `Launch packet exceeds ${maximumLaunchPacketBytes} bytes.`,
				},
			}
}
