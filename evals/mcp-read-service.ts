/**
 * @description Non-shipped read-only MCP evaluation seam over the Work application services.
 *
 * @module work/evals/mcp-read-service
 * @file Mcp-read-service.ts
 */

/* oxlint-disable eslint/no-restricted-imports -- The non-shipped prototype intentionally reuses package application services without widening exports. */
import { createBeadsProvider, resolveDefaultBeadsBinary } from '../src/beads'
import type { WorkResult } from '../src/contracts'
import { EVIDENCE_ONLY_DELIVERY_POLICY } from '../src/contracts'
import { loadWorkProject } from '../src/facade'
import {
	observeGitWorkspace,
	prepareWorkLaunch,
	resolveWorkStateLocation,
} from '../src/preparation'
import { createWorkContractService } from '../src/service'

interface McpReadServiceOptions {
	readonly root: string
	readonly manifestPath?: string
	readonly binary?: string
}

interface McpReadService {
	readonly overview: () => Promise<WorkResult<unknown>>
	readonly show: (workId: string) => Promise<WorkResult<unknown>>
	readonly prepare: (reference: string) => Promise<WorkResult<unknown>>
	readonly active: () => Promise<WorkResult<unknown>>
}

type LoadedReadContext = Awaited<ReturnType<typeof loadContext>>

const loadContext = async (options: McpReadServiceOptions) => {
	const project = await loadWorkProject({
		root: options.root,
		...(options.manifestPath === undefined ? {} : { path: options.manifestPath }),
	})
	if (!project.ok) {
		return project
	}
	const state = await resolveWorkStateLocation({
		root: options.root,
		projectId: project.value.manifest.projectId,
		...(project.value.manifest.projectUid === undefined
			? {}
			: { projectUid: project.value.manifest.projectUid }),
	})
	if (!state.ok) {
		return state
	}
	const provider = createBeadsProvider({
		root: options.root,
		projectId: project.value.manifest.projectId,
		binary: options.binary ?? resolveDefaultBeadsBinary(),
		stateDirectory: state.value.directory,
		coordinationRoot: state.value.coordinationRoot,
	})
	const listed = await provider.list()
	if (!listed.ok) {
		return listed
	}
	const items = listed.value.filter(({ projectId }) => projectId === project.value.graph.projectId)
	return {
		ok: true as const,
		value: { ...project.value, provider, items, state: state.value.observation },
	}
}

type SuccessfulReadContext = Extract<LoadedReadContext, { readonly ok: true }>['value']

const serviceFor = (options: McpReadServiceOptions, context: SuccessfulReadContext) =>
	createWorkContractService({
		root: options.root,
		graph: context.graph,
		provider: context.provider,
		initialLedgerItems: context.items,
		staleClaimMinutes: context.manifest.policies.staleClaimMinutes,
		deliveryPolicy: context.manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
		...(context.definitionRevision === undefined
			? {}
			: { definitionRevision: context.definitionRevision }),
	})

const mapOverviewItem = (item: {
	readonly id: string
	readonly title: string
	readonly status: string
	readonly ready: boolean
	readonly stale: boolean
	readonly assignee?: string
}) => ({
	id: item.id,
	title: item.title,
	status: item.status,
	ready: item.ready,
	stale: item.stale,
	...(item.assignee === undefined ? {} : { assignee: item.assignee }),
})

/** @description Creates the four read-only operations used solely by the MCP evaluation. */
export const createMcpReadService = (options: McpReadServiceOptions): McpReadService => ({
	overview: async (): Promise<WorkResult<unknown>> => {
		const context = await loadContext(options)
		if (!context.ok) {
			return context
		}
		if (context.value.provider.inspectCoordinationHealth !== undefined) {
			const coordination = await context.value.provider.inspectCoordinationHealth()
			if (!coordination.ok) {
				return coordination
			}
		}
		const ready = await serviceFor(options, context.value).ready({ limit: 10 })
		if (!ready.ok) {
			return ready
		}
		const active = await serviceFor(options, context.value).active()
		if (!active.ok) {
			return active
		}
		const readyItems = ready.value.map((item) => mapOverviewItem(item))
		return {
			ok: true,
			value: {
				projectId: context.value.graph.projectId,
				graphFingerprint: context.value.graph.fingerprint,
				health: { status: 'ready', synchronized: true, provider: 'beads' },
				ready: readyItems,
				active: active.value.slice(0, 10).map((item) => mapOverviewItem(item)),
				recommended: readyItems[0] ?? null,
				actions: [
					{ command: 'prepare <id-or-path>', mutates: false },
					{ command: 'start <id-or-path> --actor <name>', mutates: true },
					{ command: 'claim <id> --actor <name>', mutates: true },
					{ command: 'show <id>', mutates: false },
					{
						command: 'finalize <id> --actor <name> --evidence <kind=path>',
						mutates: true,
					},
					{ command: 'review status <id>', mutates: false },
					{ command: 'review prepare|approve|request-changes <id>', mutates: true },
					{ command: 'submit <id> --actor <name>', mutates: true },
					{ command: 'integration status', mutates: false },
					{ command: 'reconcile <id> --actor <name>', mutates: true },
				],
			},
		}
	},
	show: async (workId: string): Promise<WorkResult<unknown>> => {
		const context = await loadContext(options)
		if (!context.ok) {
			return context
		}
		const inspected = await serviceFor(options, context.value).inspect(workId)
		if (!inspected.ok) {
			return inspected
		}
		const definition = context.value.graph.items.find(({ id }) => id === workId)
		const operation = context.value.items.find((item) => item.workId === workId)
		return definition === undefined || operation === undefined
			? {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'work_not_found',
						message: 'Unknown work item.',
					},
				}
			: {
					ok: true,
					value: {
						definition,
						operation,
						...(inspected.value.aggregate === undefined
							? {}
							: { aggregate: inspected.value.aggregate }),
					},
				}
	},
	prepare: async (reference: string): Promise<WorkResult<unknown>> => {
		const context = await loadContext(options)
		if (!context.ok) {
			return context
		}
		const service = serviceFor(options, context.value)
		const matched = context.value.graph.items.filter(
			({ id, source }) => id === reference || source.path === reference,
		)
		if (matched.length === 1 && matched[0] !== undefined) {
			const valid = await service.validateDefinition(matched[0].id)
			if (!valid.ok) {
				return valid
			}
		}
		const workspace = await observeGitWorkspace({ root: options.root })
		if (!workspace.ok) {
			return workspace
		}
		return prepareWorkLaunch({
			graph: context.value.graph,
			ledgerItems: context.value.items,
			maxBytes: context.value.manifest.policies.contextMaxBytes,
			reference,
			deliveryPolicy: context.value.manifest.policies.delivery ?? EVIDENCE_ONLY_DELIVERY_POLICY,
			workspace: workspace.value,
			providerState: context.value.state,
			...(context.value.definitionRevision === undefined
				? {}
				: { definitionRevision: context.value.definitionRevision }),
		})
	},
	active: async (): Promise<WorkResult<unknown>> => {
		const context = await loadContext(options)
		return context.ok ? serviceFor(options, context.value).active() : context
	},
})
