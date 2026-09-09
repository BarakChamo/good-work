/**
 * @description Verifies claims, liveness, handoffs, evidence, completion, and hierarchical rollups.
 *
 * @module work/service
 * @file Service.test.ts
 */

/* oxlint-disable eslint/max-classes-per-file, vitest/prefer-expect-assertions -- Test doubles and behavioral assertions stay local to the service contract. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompiledWorkGraph, WorkArtifact, WorkResult } from './contracts'
import type {
	CollaborativeLedgerProvider,
	LedgerActivityInput,
	LedgerClaimInput,
	LedgerDefinitionExpectation,
	LedgerDependencyExpectation,
	LedgerDefinitionInput,
	LedgerHandoffInput,
	LedgerItem,
	LedgerRelationsInput,
	LedgerReviewInput,
	LedgerSubmissionInput,
	LedgerTransitionInput,
} from './provider'
import { INPUT_LIMITS } from './files'
import { createWorkContractService } from './service'
import { executeFile } from './subprocess'

const execute = executeFile

let root: string

const artifact = (
	input: Partial<WorkArtifact> & Pick<WorkArtifact, 'id' | 'kind' | 'title'>,
): WorkArtifact => ({
	...input,
	execution: input.execution ?? 'task',
	source: input.source ?? { path: `docs/${input.id}.md`, hash: `hash-${input.id}` },
	dependencies: input.dependencies ?? [],
	acceptance: input.acceptance ?? [],
	owners: input.owners ?? [],
	roles: input.roles ?? [],
	evidenceRequirements: input.evidenceRequirements ?? [],
	body: input.body ?? `Definition for ${input.id}.`,
})

const graph: CompiledWorkGraph = {
	schemaVersion: 1,
	projectId: 'example',
	fingerprint: 'graph-1',
	items: [
		artifact({ id: 'PRD-1', kind: 'prd', title: 'Product' }),
		artifact({ id: 'ISSUE-0', kind: 'issue', title: 'Design', parentId: 'PRD-1' }),
		artifact({
			id: 'ISSUE-1',
			kind: 'issue',
			title: 'Implement',
			parentId: 'PRD-1',
			dependencies: ['ISSUE-0'],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		}),
	],
}

const ledgerItem = (artifactValue: WorkArtifact): LedgerItem => ({
	definitionSchemaVersion: 2,
	providerId: `provider-${artifactValue.id}`,
	projectId: 'example',
	workId: artifactValue.id,
	title: artifactValue.title,
	kind: artifactValue.kind,
	execution: artifactValue.execution,
	status: 'open',
	parentId: artifactValue.parentId,
	dependencies: artifactValue.dependencies,
	roles: artifactValue.roles,
	evidenceRequirements: artifactValue.evidenceRequirements,
	source: artifactValue.source,
	graphFingerprint: 'graph-1',
	assignee: undefined,
	activity: undefined,
	handoff: undefined,
	evidence: [],
	blockReason: undefined,
	updatedAt: '2026-09-01T00:00:00.000Z',
})

class MemoryCollaborationProvider implements CollaborativeLedgerProvider {
	public readonly items = new Map(graph.items.map((item) => [item.id, ledgerItem(item)]))
	public listCalls = 0
	public readonly claims: LedgerClaimInput[] = []
	public readonly transitions: LedgerTransitionInput[] = []
	public readonly activities: LedgerActivityInput[] = []
	public readonly handoffs: LedgerHandoffInput[] = []
	public readonly submissions: LedgerSubmissionInput[] = []
	public readonly reviews: LedgerReviewInput[] = []

	public async doctor(): Promise<
		WorkResult<{ readonly provider: string; readonly version: string }>
	> {
		return { ok: true, value: { provider: 'memory', version: '1' } }
	}
	public async list(): Promise<WorkResult<readonly LedgerItem[]>> {
		this.listCalls += 1
		return { ok: true, value: [...this.items.values()] }
	}
	public async createDefinition(_input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		return {
			ok: false,
			error: { type: 'work_contract_error', code: 'provider_failed', message: 'unused' },
		}
	}
	public async updateDefinition(_input: LedgerDefinitionInput): Promise<WorkResult<LedgerItem>> {
		return {
			ok: false,
			error: { type: 'work_contract_error', code: 'provider_failed', message: 'unused' },
		}
	}
	public async setRelations(_input: LedgerRelationsInput): Promise<WorkResult<LedgerItem>> {
		return {
			ok: false,
			error: { type: 'work_contract_error', code: 'provider_failed', message: 'unused' },
		}
	}
	public async archive(_workId: string): Promise<WorkResult<LedgerItem>> {
		return {
			ok: false,
			error: { type: 'work_contract_error', code: 'provider_failed', message: 'unused' },
		}
	}
	public async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		this.claims.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		if (item.assignee !== undefined && item.assignee !== input.actor) {
			return {
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'ownership_conflict',
					message: 'already claimed',
				},
			}
		}
		if (
			item.status === 'in_progress' &&
			item.assignee === input.actor &&
			item.activity !== undefined
		) {
			if (item.activity.role !== input.role) {
				return {
					ok: false,
					error: { type: 'work_contract_error', code: 'role_conflict', message: 'role changed' },
				}
			}
			if (item.activity.session !== input.session) {
				return {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'session_conflict',
						message: 'session changed',
					},
				}
			}
			return { ok: true, value: item }
		}
		const claimed: LedgerItem = {
			...item,
			status: 'in_progress',
			assignee: input.actor,
			activity: {
				actor: input.actor,
				...(input.role === undefined ? {} : { role: input.role }),
				...(input.session === undefined ? {} : { session: input.session }),
				startedAt: input.timestamp,
				touchedAt: input.timestamp,
			},
		}
		this.items.set(input.workId, claimed)
		return { ok: true, value: claimed }
	}
	public async recordActivity(input: LedgerActivityInput): Promise<WorkResult<LedgerItem>> {
		this.activities.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const updated = { ...item, activity: input.activity }
		this.items.set(input.workId, updated)
		return { ok: true, value: updated }
	}
	public async recordHandoff(input: LedgerHandoffInput): Promise<WorkResult<LedgerItem>> {
		this.handoffs.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const updated: LedgerItem = {
			...item,
			handoff: input.handoff,
			...(input.release ? { status: 'open', assignee: undefined, activity: undefined } : {}),
		}
		this.items.set(input.workId, updated)
		return { ok: true, value: updated }
	}
	public async recordSubmission(input: LedgerSubmissionInput): Promise<WorkResult<LedgerItem>> {
		this.submissions.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const updated = { ...item, candidate: input.candidate, gates: input.gates }
		this.items.set(input.workId, updated)
		return { ok: true, value: updated }
	}
	public async recordReview(input: LedgerReviewInput): Promise<WorkResult<LedgerItem>> {
		this.reviews.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		const updated = { ...item, review: input.review }
		this.items.set(input.workId, updated)
		return { ok: true, value: updated }
	}
	public async transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		this.transitions.push(input)
		const item = this.items.get(input.workId)
		if (item === undefined) {
			return {
				ok: false,
				error: { type: 'work_contract_error', code: 'work_not_found', message: 'missing' },
			}
		}
		let updated: LedgerItem
		if (input.type === 'complete') {
			for (const child of input.expectedChildren ?? []) {
				const currentChild = this.items.get(child.workId)
				const kinds = new Set(currentChild?.evidence.map(({ kind }) => kind))
				if (
					currentChild?.status !== 'closed' ||
					child.evidenceRequirements.some((kind) => !kinds.has(kind))
				) {
					return {
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'aggregate_not_ready',
							message: 'A required aggregate child is incomplete.',
						},
					}
				}
			}
			updated = {
				...item,
				status: 'closed',
				evidence: input.evidence,
				...(input.candidate === undefined ? {} : { candidate: input.candidate }),
				...(input.gates === undefined ? {} : { gates: input.gates }),
			}
		} else if (input.type === 'block') {
			updated = { ...item, status: 'blocked', blockReason: input.reason }
		} else {
			updated = {
				...item,
				status: 'open',
				assignee: undefined,
				activity: undefined,
				blockReason: undefined,
			}
		}
		this.items.set(input.workId, updated)
		return { ok: true, value: updated }
	}
}

class DependencyInvalidatingProvider extends MemoryCollaborationProvider {
	public invalidateOnClaim = false
	public invalidateOnComplete = false
	public claimExpectation: LedgerDefinitionExpectation | undefined
	public completionExpectation: LedgerDefinitionExpectation | undefined
	public claimDependencies: readonly LedgerDependencyExpectation[] = []
	public completionDependencies: readonly LedgerDependencyExpectation[] = []

	public override async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		this.claimExpectation = input.expectedDefinition
		this.claimDependencies = input.expectedDependencies
		if (this.invalidateOnClaim) {
			this.invalidateDependency()
			if (this.hasDependencyGuard(input)) {
				return this.notReady()
			}
		}
		return super.claim(input)
	}

	public override async transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		if (input.type === 'complete' && this.invalidateOnComplete) {
			this.completionExpectation = input.expectedDefinition
			this.completionDependencies = input.expectedDependencies
			this.invalidateDependency()
			if (this.hasDependencyGuard(input)) {
				return this.notReady()
			}
		}
		return super.transition(input)
	}

	private hasDependencyGuard(input: LedgerClaimInput | LedgerTransitionInput): boolean {
		return 'expectedDependencies' in input
			? input.expectedDependencies.some(({ workId }) => workId === 'ISSUE-0')
			: false
	}

	private invalidateDependency(): void {
		this.items.set('ISSUE-0', {
			...requireLedgerItem(this, 'ISSUE-0'),
			status: 'open',
		})
	}

	private notReady(): WorkResult<LedgerItem> {
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'work_not_ready',
				message: 'Dependency changed before the guarded mutation.',
			},
		}
	}
}

class DefinitionInvalidatingProvider extends MemoryCollaborationProvider {
	public invalidateOperation:
		| 'claim'
		| 'recordActivity'
		| 'recordHandoff'
		| 'transition'
		| undefined

	public override async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		return this.rejectAfterConcurrentSync('claim', input) ?? super.claim(input)
	}

	public override async recordActivity(
		input: LedgerActivityInput,
	): Promise<WorkResult<LedgerItem>> {
		return this.rejectAfterConcurrentSync('recordActivity', input) ?? super.recordActivity(input)
	}

	public override async recordHandoff(input: LedgerHandoffInput): Promise<WorkResult<LedgerItem>> {
		return this.rejectAfterConcurrentSync('recordHandoff', input) ?? super.recordHandoff(input)
	}

	public override async transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		return this.rejectAfterConcurrentSync('transition', input) ?? super.transition(input)
	}

	private rejectAfterConcurrentSync(
		operation: Exclude<DefinitionInvalidatingProvider['invalidateOperation'], undefined>,
		input: { readonly workId: string },
	): WorkResult<LedgerItem> | undefined {
		if (this.invalidateOperation !== operation) {
			return undefined
		}
		const current = requireLedgerItem(this, input.workId)
		this.items.set(input.workId, {
			...current,
			title: 'Title changed by concurrent sync',
			graphFingerprint: 'graph-2',
		})
		const guarded = input as typeof input & {
			readonly expectedDefinition?: { readonly title?: string }
		}
		return guarded.expectedDefinition?.title === 'Title changed by concurrent sync'
			? undefined
			: {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'The target definition changed before the guarded mutation.',
					},
				}
	}
}

class ClosureInvalidatingProvider extends MemoryCollaborationProvider {
	public invalidateParentOnActivity = false

	public override async recordActivity(
		input: LedgerActivityInput,
	): Promise<WorkResult<LedgerItem>> {
		if (!this.invalidateParentOnActivity) {
			return super.recordActivity(input)
		}
		this.items.set('PRD-1', {
			...requireLedgerItem(this, 'PRD-1'),
			title: 'Parent changed by concurrent sync',
		})
		const guarded = input as LedgerActivityInput & {
			readonly expectedDefinitionClosure?: readonly {
				readonly workId: string
				readonly title: string
			}[]
		}
		const expectedParent = guarded.expectedDefinitionClosure?.find(
			({ workId }) => workId === 'PRD-1',
		)
		return expectedParent?.title === 'Product'
			? {
					ok: false,
					error: {
						type: 'work_contract_error',
						code: 'ledger_not_synchronized',
						message: 'The required definition closure changed before mutation.',
					},
				}
			: super.recordActivity(input)
	}
}

class ReclaimRaceProvider extends MemoryCollaborationProvider {
	public rejectNextReclaim = false

	public override async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		if (!this.rejectNextReclaim) {
			return super.claim(input)
		}
		this.rejectNextReclaim = false
		this.claims.push(input)
		const item = requireLedgerItem(this, input.workId)
		this.items.set(input.workId, {
			...item,
			status: 'open',
			assignee: undefined,
			activity: undefined,
		})
		return {
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'ownership_conflict',
				message: 'Concurrent ownership transition won.',
			},
		}
	}
}

class ReturnedItemTamperingProvider extends MemoryCollaborationProvider {
	public tamper: (item: LedgerItem) => LedgerItem = (item) => item

	public override async claim(input: LedgerClaimInput): Promise<WorkResult<LedgerItem>> {
		return this.tamperResult(await super.claim(input))
	}

	public override async recordActivity(
		input: LedgerActivityInput,
	): Promise<WorkResult<LedgerItem>> {
		return this.tamperResult(await super.recordActivity(input))
	}

	public override async recordHandoff(input: LedgerHandoffInput): Promise<WorkResult<LedgerItem>> {
		return this.tamperResult(await super.recordHandoff(input))
	}

	public override async transition(input: LedgerTransitionInput): Promise<WorkResult<LedgerItem>> {
		return this.tamperResult(await super.transition(input))
	}

	private tamperResult(result: WorkResult<LedgerItem>): WorkResult<LedgerItem> {
		return result.ok ? { ok: true, value: this.tamper(result.value) } : result
	}
}

const requireLedgerItem = (provider: MemoryCollaborationProvider, workId: string): LedgerItem => {
	const item = provider.items.get(workId)
	if (item === undefined) {
		throw new Error(`Missing fixture ledger item ${workId}`)
	}
	return item
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-service-'))
	await mkdir(join(root, 'evidence'), { recursive: true })
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('multi-session work service', () => {
	it('prepares and records an exact-tree review by a distinct actor', async () => {
		// Given: active implementation work at a clean committed revision
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'implementation.ts'), 'export const value = 1\n')
		await execute('git', ['add', '.'], { cwd: root })
		await execute('git', ['commit', '-m', 'implementation'], { cwd: root })
		const definitionHash = 'b'.repeat(64)
		const reviewGraph = {
			...graph,
			fingerprint: 'a'.repeat(64),
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1'
					? { ...item, source: { ...item.source, hash: definitionHash } }
					: item,
			),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			source: { ...requireLedgerItem(provider, 'ISSUE-1').source, hash: definitionHash },
			status: 'in_progress',
			assignee: 'implementer',
			activity: {
				actor: 'implementer',
				session: 'parent-session',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph: reviewGraph,
			provider,
			clock: () => new Date('2026-09-09T00:00:00.000Z'),
		})

		// When: the owner prepares review and a separate reviewer approves it
		const prepared = await service.prepareReview({
			workId: 'ISSUE-1',
			actor: 'implementer',
			session: 'parent-session',
		})
		expect(prepared).toMatchObject({
			ok: true,
			value: {
				workId: 'ISSUE-1',
				implementationActor: 'implementer',
				subject: { headSha: expect.any(String) },
			},
		})
		if (!prepared.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n\nAccepted.\n')
		const approved = await service.recordReview({
			workId: 'ISSUE-1',
			reviewerActor: 'reviewer',
			reviewerSession: 'review-session',
			evaluator: 'agent',
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			reviewedHead: prepared.value.subject.headSha,
		})

		// Then: Work persists both operational status and a repository receipt
		expect(approved).toMatchObject({
			ok: true,
			value: {
				workId: 'ISSUE-1',
				disposition: 'approved',
				reviewReceipt: 'docs/work/reviews/ISSUE-1.yaml',
			},
		})
		expect(provider.reviews).toHaveLength(1)
		expect(requireLedgerItem(provider, 'ISSUE-1').review).toMatchObject({
			disposition: 'approved',
			reviewer: { actor: 'reviewer' },
		})
	})

	it('rejects self-review without writing a decision or receipt', async () => {
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'implementation.ts'), 'export const value = 1\n')
		await execute('git', ['add', '.'], { cwd: root })
		await execute('git', ['commit', '-m', 'implementation'], { cwd: root })
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'implementer',
			activity: {
				actor: 'implementer',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph: { ...graph, fingerprint: 'a'.repeat(64) },
			provider,
		})
		const subject = await service.prepareReview({ workId: 'ISSUE-1', actor: 'implementer' })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n')

		await expect(
			service.recordReview({
				workId: 'ISSUE-1',
				reviewerActor: 'implementer',
				evaluator: 'agent',
				disposition: 'approved',
				reportReference: 'docs/work/reviews/ISSUE-1.md',
				reviewedHead: subject.value.subject.headSha,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'review_actor_conflict' } })
		expect(provider.reviews).toHaveLength(0)
	})

	it('does not report approval when source changes during provider publication', async () => {
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'implementation.ts'), 'export const value = 1\n')
		await execute('git', ['add', '.'], { cwd: root })
		await execute('git', ['commit', '-m', 'implementation'], { cwd: root })
		const definitionHash = 'b'.repeat(64)
		const reviewGraph = {
			...graph,
			fingerprint: 'a'.repeat(64),
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1'
					? { ...item, source: { ...item.source, hash: definitionHash } }
					: item,
			),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			source: { ...requireLedgerItem(provider, 'ISSUE-1').source, hash: definitionHash },
			status: 'in_progress',
			assignee: 'implementer',
			activity: {
				actor: 'implementer',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph: reviewGraph,
			provider,
		})
		const subject = await service.prepareReview({ workId: 'ISSUE-1', actor: 'implementer' })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n')
		const publish = provider.recordReview.bind(provider)
		vi.spyOn(provider, 'recordReview').mockImplementation(async (input) => {
			await writeFile(join(root, 'implementation.ts'), 'export const value = 2\n')
			return publish(input)
		})

		const decision = await service.recordReview({
			workId: 'ISSUE-1',
			reviewerActor: 'reviewer',
			evaluator: 'agent',
			disposition: 'approved',
			reportReference: 'docs/work/reviews/ISSUE-1.md',
			reviewedHead: subject.value.subject.headSha,
		})
		expect(decision).toMatchObject({ ok: false, error: { code: 'review_target_stale' } })
	})

	it('does not overwrite the winning receipt when a reviewer submits a conflicting decision', async () => {
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'implementation.ts'), 'export const value = 1\n')
		await execute('git', ['add', '.'], { cwd: root })
		await execute('git', ['commit', '-m', 'implementation'], { cwd: root })
		const definitionHash = 'b'.repeat(64)
		const reviewGraph = {
			...graph,
			fingerprint: 'a'.repeat(64),
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1'
					? { ...item, source: { ...item.source, hash: definitionHash } }
					: item,
			),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			source: { ...requireLedgerItem(provider, 'ISSUE-1').source, hash: definitionHash },
			status: 'in_progress',
			assignee: 'implementer',
			activity: {
				actor: 'implementer',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph: reviewGraph,
			provider,
		})
		const subject = await service.prepareReview({ workId: 'ISSUE-1', actor: 'implementer' })
		expect(subject.ok).toBe(true)
		if (!subject.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n')
		await expect(
			service.recordReview({
				workId: 'ISSUE-1',
				reviewerActor: 'reviewer-a',
				evaluator: 'agent',
				disposition: 'approved',
				reportReference: 'docs/work/reviews/ISSUE-1.md',
				reviewedHead: subject.value.subject.headSha,
			}),
		).resolves.toMatchObject({ ok: true })
		const receiptPath = join(root, 'docs/work/reviews/ISSUE-1.yaml')
		const winningReceipt = await readFile(receiptPath, 'utf8')

		await expect(
			service.recordReview({
				workId: 'ISSUE-1',
				reviewerActor: 'reviewer-b',
				evaluator: 'human',
				disposition: 'changes_requested',
				reportReference: 'docs/work/reviews/ISSUE-1.md',
				reviewedHead: subject.value.subject.headSha,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'review_decision_conflict' } })
		expect(await readFile(receiptPath, 'utf8')).toBe(winningReceipt)

		await execute('git', ['add', 'docs/work/reviews'], { cwd: root })
		await execute('git', ['commit', '-m', 'record first review'], { cwd: root })
		await writeFile(join(root, 'implementation.ts'), 'export const value = 2\n')
		await execute('git', ['add', 'implementation.ts'], { cwd: root })
		await execute('git', ['commit', '-m', 'address review'], { cwd: root })
		const revised = await service.prepareReview({ workId: 'ISSUE-1', actor: 'implementer' })
		expect(revised.ok).toBe(true)
		if (!revised.ok) return
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n\nRevision accepted.\n')
		await expect(
			service.recordReview({
				workId: 'ISSUE-1',
				reviewerActor: 'reviewer-b',
				evaluator: 'human',
				disposition: 'approved',
				reportReference: 'docs/work/reviews/ISSUE-1.md',
				reviewedHead: revised.value.subject.headSha,
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { reviewerActor: 'reviewer-b', disposition: 'approved' },
		})
		expect(await readFile(receiptPath, 'utf8')).toContain('actor: reviewer-b')
		expect(requireLedgerItem(provider, 'ISSUE-1')).toMatchObject({
			status: 'in_progress',
			assignee: 'implementer',
			activity: { actor: 'implementer' },
		})
	})

	it('keeps aggregate work out of ready and rejects direct execution', async () => {
		const aggregate = artifact({
			id: 'ISSUE-10',
			kind: 'issue',
			title: 'Program',
			execution: 'aggregate',
		})
		const aggregateGraph: CompiledWorkGraph = {
			...graph,
			items: [...graph.items, aggregate],
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set(aggregate.id, ledgerItem(aggregate))
		const service = createWorkContractService({ root, graph: aggregateGraph, provider })

		const ready = await service.ready()
		expect(ready.ok && ready.value.some(({ id }) => id === aggregate.id)).toBe(false)
		await expect(service.claim({ workId: aggregate.id, actor: 'agent-a' })).resolves.toMatchObject({
			ok: false,
			error: { code: 'aggregate_not_executable' },
		})
		await expect(
			service.submit({ workId: aggregate.id, actor: 'agent-a', evidence: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: 'aggregate_not_executable' } })
		expect(provider.claims).toHaveLength(0)
		expect(provider.submissions).toHaveLength(0)
	})

	it('reports direct-child aggregate progress and closes atomically with final evidence', async () => {
		const aggregate = artifact({
			id: 'ISSUE-10',
			kind: 'issue',
			title: 'Program',
			execution: 'aggregate',
			evidenceRequirements: ['artifact'],
		})
		const childOne = artifact({
			id: 'ISSUE-11',
			kind: 'issue',
			title: 'First checkpoint',
			parentId: aggregate.id,
		})
		const childTwo = artifact({
			id: 'ISSUE-12',
			kind: 'issue',
			title: 'Second checkpoint',
			parentId: aggregate.id,
		})
		const aggregateGraph: CompiledWorkGraph = {
			...graph,
			items: [...graph.items, aggregate, childOne, childTwo],
		}
		const provider = new MemoryCollaborationProvider()
		for (const definition of [aggregate, childOne, childTwo]) {
			provider.items.set(definition.id, ledgerItem(definition))
		}
		provider.items.set(childOne.id, {
			...requireLedgerItem(provider, childOne.id),
			status: 'closed',
		})
		provider.items.set(childTwo.id, {
			...requireLedgerItem(provider, childTwo.id),
			status: 'blocked',
			blockReason: 'Waiting for cohort evidence.',
		})
		const service = createWorkContractService({ root, graph: aggregateGraph, provider })

		await expect(service.inspect(aggregate.id)).resolves.toMatchObject({
			ok: true,
			value: {
				execution: 'aggregate',
				aggregate: {
					total: 2,
					open: 0,
					active: 0,
					blocked: 1,
					terminal: 1,
					completionReady: false,
					blockers: ['ISSUE-12: Waiting for cohort evidence.'],
				},
			},
		})
		await expect(
			service.complete({ workId: aggregate.id, actor: 'agent-a', evidence: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: 'aggregate_not_ready' } })

		provider.items.set(childTwo.id, {
			...requireLedgerItem(provider, childTwo.id),
			status: 'closed',
			blockReason: undefined,
		})
		await writeFile(join(root, 'evidence', 'final.md'), '# Final synthesis\n')
		const completed = await service.complete({
			workId: aggregate.id,
			actor: 'agent-a',
			evidence: [{ kind: 'artifact', reference: 'evidence/final.md' }],
		})

		expect(completed).toMatchObject({
			ok: true,
			value: { previousStatus: 'open', newStatus: 'closed', actor: 'agent-a' },
		})
		expect(provider.transitions.at(-1)).toMatchObject({
			type: 'complete',
			expectedChildren: [{ workId: 'ISSUE-11' }, { workId: 'ISSUE-12' }],
		})
		expect(requireLedgerItem(provider, aggregate.id)).toMatchObject({
			status: 'closed',
			assignee: undefined,
			activity: undefined,
		})
		await expect(
			service.complete({ workId: aggregate.id, actor: 'agent-b', evidence: [] }),
		).resolves.toMatchObject({
			ok: true,
			value: { previousStatus: 'closed', newStatus: 'closed' },
		})
	})

	it('prevents reopening a child beneath a closed aggregate', async () => {
		const aggregate = artifact({
			id: 'ISSUE-10',
			kind: 'issue',
			title: 'Program',
			execution: 'aggregate',
		})
		const child = artifact({
			id: 'ISSUE-11',
			kind: 'issue',
			title: 'Checkpoint',
			parentId: aggregate.id,
		})
		const aggregateGraph = { ...graph, items: [...graph.items, aggregate, child] }
		const provider = new MemoryCollaborationProvider()
		provider.items.set(aggregate.id, { ...ledgerItem(aggregate), status: 'closed' })
		provider.items.set(child.id, {
			...ledgerItem(child),
			status: 'closed',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({ root, graph: aggregateGraph, provider })

		await expect(
			service.reopen({ workId: child.id, actor: 'agent-a', reason: 'New evidence.' }),
		).resolves.toMatchObject({ ok: false, error: { code: 'aggregate_not_ready' } })
		expect(provider.transitions).toHaveLength(0)

		await expect(
			service.reopen({ workId: aggregate.id, actor: 'agent-a', reason: 'Reopen program.' }),
		).resolves.toMatchObject({ ok: true, value: { newStatus: 'open' } })
		await expect(
			service.reopen({ workId: child.id, actor: 'agent-a', reason: 'New evidence.' }),
		).resolves.toMatchObject({ ok: true, value: { newStatus: 'open' } })
	})

	it('does not apply aggregate reopen ordering to an ordinary parent', async () => {
		const parent = artifact({ id: 'ISSUE-10', kind: 'issue', title: 'Ordinary parent' })
		const child = artifact({
			id: 'ISSUE-11',
			kind: 'issue',
			title: 'Child',
			parentId: parent.id,
		})
		const projectGraph = { ...graph, items: [...graph.items, parent, child] }
		const provider = new MemoryCollaborationProvider()
		provider.items.set(parent.id, { ...ledgerItem(parent), status: 'closed' })
		provider.items.set(child.id, {
			...ledgerItem(child),
			status: 'closed',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({ root, graph: projectGraph, provider })

		await expect(
			service.reopen({ workId: child.id, actor: 'agent-a', reason: 'New evidence.' }),
		).resolves.toMatchObject({ ok: true, value: { newStatus: 'open' } })
		expect(provider.transitions.at(-1)).not.toHaveProperty('expectedAggregateParents')
	})

	it('submits an exact Git candidate without closing work and advances its generation', async () => {
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'candidate.ts'), 'export const value = 1\n')
		await writeFile(join(root, 'proof.json'), '{"passed":true}\n')
		await execute('git', ['add', 'candidate.ts', 'proof.json'], { cwd: root })
		await execute('git', ['commit', '-m', 'candidate one'], { cwd: root })
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph,
			provider,
			deliveryPolicy: {
				profile: 'local-direct',
				isolation: 'none',
				integration: 'local',
				terminal: 'landed',
				targetRef: 'refs/heads/main',
				requiredGates: ['validation', 'landing'],
			},
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
		})

		const first = await service.submit({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			evidence: [{ kind: 'test', reference: 'proof.json' }],
		})
		const repeated = await service.submit({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			evidence: [{ kind: 'test', reference: 'proof.json' }],
		})

		expect(first).toMatchObject({
			ok: true,
			value: {
				command: 'submit',
				newStatus: 'in_progress',
				candidate: { generation: 1, actor: 'agent-a' },
				gates: [{ gate: 'validation', result: 'passed', candidateGeneration: 1 }],
			},
		})
		expect(repeated).toMatchObject({ ok: true, value: { candidate: { generation: 1 } } })
		expect(provider.submissions).toHaveLength(2)
		expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe('in_progress')

		await writeFile(join(root, 'candidate.ts'), 'export const value = 2\n')
		await execute('git', ['add', 'candidate.ts'], { cwd: root })
		await execute('git', ['commit', '-m', 'candidate two'], { cwd: root })
		await expect(
			service.submit({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [{ kind: 'test', reference: 'proof.json' }],
			}),
		).resolves.toMatchObject({ ok: true, value: { candidate: { generation: 2 } } })
	})

	it('requires a current independent review and binds it to the submitted candidate', async () => {
		// Given: review-required active work at a clean implementation revision
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'candidate.ts'), 'export const value = 1\n')
		await writeFile(join(root, 'proof.json'), '{"passed":true}\n')
		await execute('git', ['add', '.'], { cwd: root })
		await execute('git', ['commit', '-m', 'implementation'], { cwd: root })
		const reviewedArtifact = artifact({
			...graph.items.find(({ id }) => id === 'ISSUE-1'),
			id: 'ISSUE-1',
			kind: 'issue',
			title: 'Implement',
			source: { path: 'docs/ISSUE-1.md', hash: 'b'.repeat(64) },
			evidenceRequirements: ['test', 'review'],
		})
		const reviewedGraph = {
			...graph,
			fingerprint: 'a'.repeat(64),
			items: graph.items.map((item) => (item.id === 'ISSUE-1' ? reviewedArtifact : item)),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...ledgerItem(reviewedArtifact),
			status: 'in_progress',
			assignee: 'implementer',
			activity: {
				actor: 'implementer',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({ root, graph: reviewedGraph, provider })
		await expect(
			service.submit({
				workId: 'ISSUE-1',
				actor: 'implementer',
				evidence: [
					{ kind: 'test', reference: 'proof.json' },
					{ kind: 'review', reference: 'proof.json' },
				],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'review_required' } })
		expect(provider.submissions).toHaveLength(0)
		const prepared = await service.prepareReview({ workId: 'ISSUE-1', actor: 'implementer' })
		expect(prepared.ok).toBe(true)
		if (!prepared.ok) return
		await mkdir(join(root, 'docs/work/reviews'), { recursive: true })
		await writeFile(join(root, 'docs/work/reviews/ISSUE-1.md'), '# Review\n\nAccepted.\n')
		await expect(
			service.recordReview({
				workId: 'ISSUE-1',
				reviewerActor: 'reviewer',
				evaluator: 'agent',
				disposition: 'approved',
				reportReference: 'docs/work/reviews/ISSUE-1.md',
				reviewedHead: prepared.value.subject.headSha,
			}),
		).resolves.toMatchObject({ ok: true })
		await execute('git', ['add', 'docs/work/reviews'], { cwd: root })
		await execute('git', ['commit', '-m', 'record review'], { cwd: root })

		// When: the owner submits the reviewed implementation
		const submitted = await service.submit({
			workId: 'ISSUE-1',
			actor: 'implementer',
			evidence: [
				{ kind: 'test', reference: 'proof.json' },
				{ kind: 'review', reference: 'docs/work/reviews/ISSUE-1.yaml' },
			],
		})

		// Then: the candidate carries both validation and independent-review gates
		expect(submitted).toMatchObject({
			ok: true,
			value: {
				gates: [
					{ gate: 'validation', issuer: { kind: 'self' } },
					{ gate: 'review', issuer: { kind: 'adapter', id: 'work:local-review' } },
				],
			},
		})
		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'implementer',
				evidence: [
					{ kind: 'test', reference: 'proof.json' },
					{ kind: 'review', reference: 'docs/work/reviews/ISSUE-1.yaml' },
				],
			}),
		).resolves.toMatchObject({ ok: true, value: { newStatus: 'closed' } })
	})

	it('keeps local-direct work active until its exact candidate is landed', async () => {
		await execute('git', ['init', '-b', 'feature'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'candidate.ts'), 'export const value = 1\n')
		await writeFile(join(root, 'proof.json'), '{"passed":true}\n')
		await execute('git', ['add', 'candidate.ts', 'proof.json'], { cwd: root })
		await execute('git', ['commit', '-m', 'candidate'], { cwd: root })
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({
			root,
			graph,
			provider,
			deliveryPolicy: {
				profile: 'local-direct',
				isolation: 'none',
				integration: 'local',
				terminal: 'landed',
				targetRef: 'refs/heads/main',
				requiredGates: ['validation', 'landing'],
			},
		})
		await expect(
			service.submit({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [{ kind: 'test', reference: 'proof.json' }],
			}),
		).resolves.toMatchObject({ ok: true })
		await expect(
			service.complete({ workId: 'ISSUE-1', actor: 'agent-a', evidence: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: 'delivery_gates_incomplete' } })

		await execute('git', ['branch', 'main', 'HEAD'], { cwd: root })
		const completed = await service.complete({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			evidence: [],
		})
		expect(completed).toMatchObject({
			ok: true,
			value: {
				newStatus: 'closed',
				candidate: { generation: 1 },
				gates: [{ gate: 'validation' }, { gate: 'landing' }],
			},
		})
		const repeated = await service.complete({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			evidence: [],
		})
		expect(repeated).toMatchObject({
			ok: true,
			value: { previousStatus: 'closed', newStatus: 'closed', actor: 'agent-a' },
		})
		if (!completed.ok || !repeated.ok) {
			return
		}
		expect(repeated.value.timestamp).toBe(completed.value.timestamp)
		expect(provider.transitions).toHaveLength(1)
	})

	it('rejects malformed delivery receipt references before reading work state', async () => {
		const provider = new MemoryCollaborationProvider()
		const service = createWorkContractService({ root, graph, provider })

		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [],
				// @ts-expect-error Exercises the runtime boundary with a non-array value.
				receiptFiles: '../outside.json',
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_operation_input' },
		})
		expect(provider.listCalls).toBe(0)
	})

	it('keeps initiative and PRD containers out of the executable ready queue', async () => {
		const provider = new MemoryCollaborationProvider()
		const service = createWorkContractService({ root, graph, provider })

		await expect(service.ready()).resolves.toMatchObject({
			ok: true,
			value: [{ id: 'ISSUE-0', kind: 'issue', ready: true }],
		})
	})

	it('uses a command-local initial projection for only the first read operation', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const initialLedgerItems = [...provider.items.values()]
		const service = createWorkContractService({ root, graph, provider, initialLedgerItems })

		await expect(service.ready()).resolves.toMatchObject({ ok: true })
		await expect(service.active()).resolves.toMatchObject({ ok: true })

		expect(provider.listCalls).toBe(1)
	})

	it('consumes an initial projection once so a later read sees a successful claim', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({
			root,
			graph,
			provider,
			initialLedgerItems: [...provider.items.values()],
		})

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: true })
		await expect(service.active()).resolves.toMatchObject({
			ok: true,
			value: [{ id: 'ISSUE-1', assignee: 'agent-a', status: 'in_progress' }],
		})
		expect(provider.listCalls).toBe(1)
	})

	it('consumes an initial projection once so a later mutation sees a successful claim', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({
			root,
			graph,
			provider,
			initialLedgerItems: [...provider.items.values()],
		})

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: true })
		await expect(
			service.touch({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: true, value: { command: 'touch' } })
		expect(provider.listCalls).toBe(1)
	})

	it.each([
		[
			'legacy definition schema',
			(item: LedgerItem) => ({ ...item, definitionSchemaVersion: 1 as const }),
		],
		['title', (item: LedgerItem) => ({ ...item, title: 'Stale title' })],
		['kind', (item: LedgerItem) => ({ ...item, kind: 'task' as const })],
		[
			'source path',
			(item: LedgerItem) => ({ ...item, source: { ...item.source, path: 'docs/stale.md' } }),
		],
		[
			'source hash',
			(item: LedgerItem) => ({ ...item, source: { ...item.source, hash: 'stale-hash' } }),
		],
		['parent', (item: LedgerItem) => ({ ...item, parentId: undefined })],
		['missing dependency', (item: LedgerItem) => ({ ...item, dependencies: [] })],
		[
			'extra dependency',
			(item: LedgerItem) => ({ ...item, dependencies: [...item.dependencies, 'PRD-1'] }),
		],
		[
			'duplicate dependency',
			(item: LedgerItem) => ({ ...item, dependencies: [...item.dependencies, 'ISSUE-0'] }),
		],
		['roles', (item: LedgerItem) => ({ ...item, roles: ['reviewer'] })],
		['evidence requirements', (item: LedgerItem) => ({ ...item, evidenceRequirements: [] })],
	] as const)('rejects ledger %s drift before producing a read model', async (_field, drift) => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-1', drift(requireLedgerItem(provider, 'ISSUE-1')))
		const service = createWorkContractService({ root, graph, provider })

		await expect(service.ready()).resolves.toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
	})

	it('accepts dependency relation order differences when the exact set matches', async () => {
		const reorderedGraph: CompiledWorkGraph = {
			...graph,
			items: graph.items.map((item) =>
				item.id === 'ISSUE-1' ? { ...item, dependencies: ['ISSUE-0', 'PRD-1'] } : item,
			),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			dependencies: ['PRD-1', 'ISSUE-0'],
		})
		const service = createWorkContractService({ root, graph: reorderedGraph, provider })

		await expect(service.ready()).resolves.toMatchObject({ ok: true })
	})

	it.each(['source hash', 'dependencies'] as const)(
		'rejects direct claim after %s drift without invoking the provider',
		async (field) => {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-0', {
				...requireLedgerItem(provider, 'ISSUE-0'),
				status: 'closed',
			})
			const current = requireLedgerItem(provider, 'ISSUE-1')
			provider.items.set(
				'ISSUE-1',
				field === 'source hash'
					? { ...current, source: { ...current.source, hash: 'stale-hash' } }
					: { ...current, dependencies: [] },
			)
			const service = createWorkContractService({ root, graph, provider })

			await expect(
				service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
			).resolves.toMatchObject({ ok: false, error: { code: 'ledger_not_synchronized' } })
			expect(provider.claims).toHaveLength(0)
		},
	)

	it('allows a targeted lifecycle mutation when only unrelated ledger definitions drift', async () => {
		const unrelated = artifact({ id: 'ISSUE-2', kind: 'issue', title: 'Unrelated' })
		const scopedGraph: CompiledWorkGraph = { ...graph, items: [...graph.items, unrelated] }
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-2', { ...ledgerItem(unrelated), title: 'Drifted unrelated title' })
		const service = createWorkContractService({ root, graph: scopedGraph, provider })

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: true, value: { command: 'claim', workId: 'ISSUE-1' } })
		expect(provider.claims).toHaveLength(1)
		await expect(service.ready()).resolves.toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
	})

	it('continues claim-bound work across an unrelated canonical revision advance', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const claimRevision = {
			targetRef: 'refs/heads/main',
			targetSha: '1'.repeat(40),
			graphFingerprint: 'a'.repeat(64),
		}
		for (const [workId, item] of provider.items) {
			provider.items.set(workId, {
				...item,
				definitionSchemaVersion: 3,
				definitionRevision: claimRevision,
				graphFingerprint: claimRevision.graphFingerprint,
			})
		}
		const service = createWorkContractService({
			root,
			graph: { ...graph, fingerprint: 'canonical-advanced' },
			provider,
			definitionRevision: {
				targetRef: 'refs/heads/main',
				targetSha: '2'.repeat(40),
				graphFingerprint: 'b'.repeat(64),
			},
		})

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: true, value: { command: 'claim' } })
		expect(provider.claims[0]?.expectedDefinition).toMatchObject({
			schemaVersion: 3,
			definitionRevision: claimRevision,
		})
	})

	it.each([
		'ready',
		'active',
		'rollup',
		'claim',
		'touch',
		'resume',
		'handoff',
		'block',
		'release',
		'reopen',
		'complete',
	] as const)(
		'rejects %s before reading or mutating a stale initial projection',
		async (command) => {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-1', {
				...requireLedgerItem(provider, 'ISSUE-1'),
				status: 'in_progress',
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			})
			provider.items.set('PRD-1', {
				...requireLedgerItem(provider, 'PRD-1'),
				definitionSchemaVersion: 1,
			})
			const service = createWorkContractService({
				root,
				graph,
				provider,
				initialLedgerItems: [...provider.items.values()],
			})
			const operations = {
				ready: async () => service.ready(),
				active: async () => service.active(),
				rollup: async () => service.rollup('PRD-1'),
				claim: async () => service.claim({ workId: 'ISSUE-1', actor: 'agent-a' }),
				touch: async () => service.touch({ workId: 'ISSUE-1', actor: 'agent-a' }),
				resume: async () => service.resume({ workId: 'ISSUE-1', actor: 'agent-a' }),
				handoff: async () =>
					service.handoff({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						summary: 'handoff',
					}),
				block: async () =>
					service.block({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'blocked' }),
				release: async () =>
					service.release({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'release' }),
				reopen: async () =>
					service.reopen({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'reopen' }),
				complete: async () =>
					service.complete({ workId: 'ISSUE-1', actor: 'agent-a', evidence: [] }),
			}

			await expect(operations[command]()).resolves.toMatchObject({
				ok: false,
				error: { code: 'ledger_not_synchronized' },
			})
			expect(provider.listCalls).toBe(0)
			expect(provider.claims).toHaveLength(0)
			expect(provider.activities).toHaveLength(0)
			expect(provider.handoffs).toHaveLength(0)
			expect(provider.transitions).toHaveLength(0)
		},
	)

	it('asserts active role and session for every actor-owned lifecycle command', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
		})
		await service.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})

		await expect(
			service.touch({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'reviewer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'role_conflict' } })
		await expect(
			service.block({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-b',
				reason: 'blocked',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'session_conflict' } })
		expect(provider.activities).toHaveLength(0)
		expect(provider.transitions).toHaveLength(0)

		await expect(
			service.touch({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { role: 'implementer', session: 'session-a' },
		})
		expect(provider.activities[0]).toMatchObject({
			role: 'implementer',
			session: 'session-a',
			replaceSession: false,
		})
	})

	it('does not expose untrusted actor, role, or unknown work identifiers in errors', async () => {
		const actorCanary = 'PRIVATE_ACTOR_/Users/operator/TOKEN=value'
		const actorProvider = new MemoryCollaborationProvider()
		actorProvider.items.set('ISSUE-1', {
			...requireLedgerItem(actorProvider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'assigned-agent',
			activity: {
				actor: 'assigned-agent',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const actorService = createWorkContractService({ root, graph, provider: actorProvider })
		const actorConflict = await actorService.touch({ workId: 'ISSUE-1', actor: actorCanary })
		expect(actorConflict).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'ownership_conflict' },
		})
		expect(JSON.stringify(actorConflict)).not.toContain(actorCanary)

		const roleCanary = 'PRIVATE_ROLE_/Users/operator/TOKEN=value'
		const roleProvider = new MemoryCollaborationProvider()
		roleProvider.items.set('ISSUE-0', {
			...requireLedgerItem(roleProvider, 'ISSUE-0'),
			status: 'closed',
		})
		const roleService = createWorkContractService({ root, graph, provider: roleProvider })
		const roleConflict = await roleService.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: roleCanary,
		})
		expect(roleConflict).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'role_not_allowed' },
		})
		expect(JSON.stringify(roleConflict)).not.toContain(roleCanary)

		const unknownWorkId = 'PRIVATE_WORK_/Users/operator/TOKEN=value'
		const unknownService = createWorkContractService({
			root,
			graph,
			provider: new MemoryCollaborationProvider(),
		})
		const operations = [
			async () => unknownService.claim({ workId: unknownWorkId, actor: 'agent-a' }),
			async () => unknownService.touch({ workId: unknownWorkId, actor: 'agent-a' }),
			async () => unknownService.resume({ workId: unknownWorkId, actor: 'agent-a' }),
			async () =>
				unknownService.handoff({
					workId: unknownWorkId,
					actor: 'agent-a',
					summary: 'safe summary',
				}),
			async () =>
				unknownService.block({ workId: unknownWorkId, actor: 'agent-a', reason: 'safe reason' }),
			async () =>
				unknownService.release({ workId: unknownWorkId, actor: 'agent-a', reason: 'safe reason' }),
			async () =>
				unknownService.reopen({ workId: unknownWorkId, actor: 'agent-a', reason: 'safe reason' }),
			async () =>
				unknownService.complete({ workId: unknownWorkId, actor: 'agent-a', evidence: [] }),
			async () => unknownService.rollup(unknownWorkId),
		] as const
		for (const [index, operation] of operations.entries()) {
			const result = await operation()
			expect(result).toMatchObject({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: index === operations.length - 1 ? 'work_not_found' : 'invalid_operation_input',
				},
			})
			expect(JSON.stringify(result)).not.toContain(unknownWorkId)
		}
	})

	it('rejects oversized lifecycle collections and scalars before provider or filesystem access', async () => {
		const provider = new MemoryCollaborationProvider()
		const service = createWorkContractService({ root, graph, provider })
		// oxlint-disable-next-line unicorn/consistent-function-scoping -- Kept beside the adversarial calls it documents.
		const invokeUnknown = async (
			operation: (value: never) => Promise<WorkResult<unknown>>,
			value: unknown,
		): Promise<WorkResult<unknown>> =>
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately violates the TypeScript contract to prove runtime totality.
			operation(value as never)

		const results = await Promise.all([
			invokeUnknown(service.claim, null),
			invokeUnknown(service.handoff, {
				workId: 'ISSUE-1',
				actor: 'agent-a',
				summary: 'handoff',
				remaining: Array.from({ length: 101 }, () => 'remaining'),
			}),
			invokeUnknown(service.release, {
				workId: 'ISSUE-1',
				actor: 'agent-a',
				reason: '界'.repeat(2001),
			}),
			invokeUnknown(service.complete, {
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: Array.from({ length: 101 }, () => ({
					kind: 'test',
					reference: 'missing-private-evidence',
				})),
			}),
		])

		expect(results.every((result) => !result.ok)).toBe(true)
		expect(provider.listCalls).toBe(0)
		expect(JSON.stringify(results)).not.toContain('missing-private-evidence')
	})

	it('rejects malformed ready filters before provider access', async () => {
		const provider = new MemoryCollaborationProvider()
		const service = createWorkContractService({ root, graph, provider })
		const roleCanary = `PRIVATE_ROLE_${'界'.repeat(100)}`

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately violates the TypeScript contract to prove runtime totality.
		const malformed = await service.ready(null as never)
		const oversized = await service.ready({ role: roleCanary })
		const invalidLimit = await service.ready({ limit: 101 })

		expect([malformed, oversized, invalidLimit]).toMatchObject([
			{ ok: false, error: { code: 'invalid_operation_input' } },
			{ ok: false, error: { code: 'invalid_operation_input' } },
			{ ok: false, error: { code: 'invalid_limit' } },
		])
		expect(provider.listCalls).toBe(0)
		expect(JSON.stringify([malformed, oversized, invalidLimit])).not.toContain(roleCanary)
	})

	it('accepts a provider projection above the former 16 KiB service ceiling', async () => {
		const provider = new MemoryCollaborationProvider()
		const current = requireLedgerItem(provider, 'ISSUE-1')
		provider.items.set('ISSUE-1', {
			...current,
			status: 'in_progress',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
			evidence: Array.from({ length: 10 }, (_, index) => ({
				kind: 'test' as const,
				reference: `${index}-${'r'.repeat(1900)}`,
				digest: 'd'.repeat(64),
				recordedAt: '2026-09-01T00:00:00.000Z',
				actor: 'agent-a',
			})),
		})
		const service = createWorkContractService({ root, graph, provider })

		const result = await service.active()

		expect(result).toMatchObject({ ok: true, value: [{ id: 'ISSUE-1', assignee: 'agent-a' }] })
		expect(Buffer.byteLength(JSON.stringify([...provider.items.values()]), 'utf8')).toBeGreaterThan(
			16 * 1024,
		)
	})

	it('redacts provider failures while retaining safe recovery signals', async () => {
		const canary = `PRIVATE_PROVIDER_${'x'.repeat(100_000)}`
		const provider = new MemoryCollaborationProvider()
		const current = requireLedgerItem(provider, 'ISSUE-1')
		provider.items.set('ISSUE-1', {
			...current,
			status: 'in_progress',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		provider.recordActivity = async () => ({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_mutation_failed',
				message: canary,
				details: ['stateMayHaveChanged=true', canary],
			},
		})
		const service = createWorkContractService({ root, graph, provider })

		const result = await service.touch({ workId: 'ISSUE-1', actor: 'agent-a' })

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_mutation_failed',
				details: [
					'stateMayHaveChanged=true',
					'recovery=inspect provider state and reconcile before retrying',
				],
			},
		})
		expect(JSON.stringify(result)).not.toContain(canary)
	})

	it.each([
		'claim',
		'touch',
		'resume',
		'handoff',
		'block',
		'release',
		'reopen',
		'complete',
	] as const)(
		'rejects an invalid successful %s provider item without exposing its contents',
		async (command) => {
			const canary = `PRIVATE_LIFECYCLE_RESULT_${'x'.repeat(100_000)}`
			const provider = new ReturnedItemTamperingProvider()
			provider.items.set('ISSUE-0', {
				...requireLedgerItem(provider, 'ISSUE-0'),
				status: 'closed',
			})
			if (command !== 'claim') {
				provider.items.set('ISSUE-1', {
					...requireLedgerItem(provider, 'ISSUE-1'),
					status: command === 'reopen' ? 'closed' : 'in_progress',
					assignee: 'agent-a',
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						startedAt: '2026-09-01T00:00:00.000Z',
						touchedAt: '2026-09-01T00:00:00.000Z',
					},
				})
			}
			provider.tamper = (item) => ({ ...item, title: canary })
			await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
			const service = createWorkContractService({
				root,
				graph,
				provider,
				clock: () => new Date('2026-09-01T01:00:00.000Z'),
			})
			const operations = {
				claim: async () =>
					service.claim({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
					}),
				touch: async () =>
					service.touch({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
				resume: async () =>
					service.resume({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-b',
					}),
				handoff: async () =>
					service.handoff({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						summary: 'Continue safely.',
					}),
				block: async () =>
					service.block({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Blocked.',
					}),
				release: async () =>
					service.release({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Released.',
					}),
				reopen: async () =>
					service.reopen({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Reopened.',
					}),
				complete: async () =>
					service.complete({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
					}),
			}

			const result = await operations[command]()

			expect(result).toMatchObject({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: 'invalid_ledger_projection',
					details: [
						'stateMayHaveChanged=true',
						'recovery=inspect provider state and reconcile before retrying',
					],
				},
			})
			expect(JSON.stringify(result)).not.toContain(canary)
		},
	)

	it.each([
		'claim',
		'touch',
		'resume',
		'handoff',
		'block',
		'release',
		'reopen',
		'complete',
	] as const)('rejects a successful %s provider item for another project', async (command) => {
		const provider = new ReturnedItemTamperingProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'closed',
		})
		if (command !== 'claim') {
			provider.items.set('ISSUE-1', {
				...requireLedgerItem(provider, 'ISSUE-1'),
				status: command === 'reopen' ? 'closed' : 'in_progress',
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					role: 'implementer',
					session: 'session-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			})
		}
		provider.tamper = (item) => ({ ...item, projectId: 'another-project' })
		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
		})
		const operations = {
			claim: async () =>
				service.claim({
					workId: 'ISSUE-1',
					actor: 'agent-a',
					role: 'implementer',
					session: 'session-a',
				}),
			touch: async () => service.touch({ workId: 'ISSUE-1', actor: 'agent-a' }),
			resume: async () => service.resume({ workId: 'ISSUE-1', actor: 'agent-a' }),
			handoff: async () =>
				service.handoff({ workId: 'ISSUE-1', actor: 'agent-a', summary: 'Continue safely.' }),
			block: async () => service.block({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Blocked.' }),
			release: async () =>
				service.release({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Released.' }),
			reopen: async () =>
				service.reopen({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Reopened.' }),
			complete: async () =>
				service.complete({
					workId: 'ISSUE-1',
					actor: 'agent-a',
					evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
				}),
		}

		await expect(operations[command]()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})
	})

	it('rejects a successful provider item for another work ID', async () => {
		const provider = new ReturnedItemTamperingProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.tamper = (item) => ({ ...item, workId: 'ISSUE-2' })
		const service = createWorkContractService({ root, graph, provider })

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})
	})

	it.each([
		['claim', (item: LedgerItem) => ({ ...item, assignee: 'another-agent' })],
		[
			'touch',
			(item: LedgerItem) => ({
				...item,
				activity:
					item.activity === undefined ? undefined : { ...item.activity, actor: 'another-agent' },
			}),
		],
		[
			'resume',
			(item: LedgerItem) => ({
				...item,
				activity:
					item.activity === undefined ? undefined : { ...item.activity, session: 'wrong-session' },
			}),
		],
		['handoff', (item: LedgerItem) => ({ ...item, handoff: undefined })],
		['block', (item: LedgerItem) => ({ ...item, status: 'in_progress' as const })],
		[
			'release',
			(item: LedgerItem) => ({
				...item,
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					role: 'implementer',
					session: 'session-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			}),
		],
		['reopen', (item: LedgerItem) => ({ ...item, assignee: 'agent-a' })],
		['complete', (item: LedgerItem) => ({ ...item, status: 'in_progress' as const })],
	] as const)(
		'rejects a successful %s provider item with a false lifecycle postcondition',
		async (command, tamper) => {
			const provider = new ReturnedItemTamperingProvider()
			provider.items.set('ISSUE-0', {
				...requireLedgerItem(provider, 'ISSUE-0'),
				status: 'closed',
			})
			if (command !== 'claim') {
				provider.items.set('ISSUE-1', {
					...requireLedgerItem(provider, 'ISSUE-1'),
					status: command === 'reopen' ? 'closed' : 'in_progress',
					assignee: 'agent-a',
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
						startedAt: '2026-09-01T00:00:00.000Z',
						touchedAt: '2026-09-01T00:00:00.000Z',
					},
				})
			}
			provider.tamper = tamper
			await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
			const service = createWorkContractService({
				root,
				graph,
				provider,
				clock: () => new Date('2026-09-01T01:00:00.000Z'),
			})
			const operations = {
				claim: async () =>
					service.claim({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						session: 'session-a',
					}),
				touch: async () => service.touch({ workId: 'ISSUE-1', actor: 'agent-a' }),
				resume: async () =>
					service.resume({ workId: 'ISSUE-1', actor: 'agent-a', session: 'session-b' }),
				handoff: async () =>
					service.handoff({ workId: 'ISSUE-1', actor: 'agent-a', summary: 'Continue safely.' }),
				block: async () =>
					service.block({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Blocked.' }),
				release: async () =>
					service.release({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Released.' }),
				reopen: async () =>
					service.reopen({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'Reopened.' }),
				complete: async () =>
					service.complete({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
					}),
			}

			await expect(operations[command]()).resolves.toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
			})
		},
	)

	it('retains sanitized stale-lock recovery guidance from provider reads', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.list = async () => ({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'provider_busy',
				message: 'private lock path',
				details: ['lockState=stale', 'automaticRecovery=false', 'private lock path'],
			},
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(service.active()).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'provider_busy',
				details: [
					'lockState=stale',
					'automaticRecovery=false',
					'recovery=inspect provider lock ownership before manual removal',
				],
			},
		})
	})

	it('uses role as a resume assertion while intentionally replacing the session', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await service.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})

		await expect(
			service.resume({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'reviewer',
				session: 'session-b',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'role_conflict' } })
		await expect(
			service.resume({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-b',
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { role: 'implementer', session: 'session-b' },
		})
		expect(requireLedgerItem(provider, 'ISSUE-1').activity?.session).toBe('session-b')
		expect(provider.activities.at(-1)).toMatchObject({ replaceSession: true })
	})

	it('preserves final activity and forwards verified context on completion', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
		})
		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		await service.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})

		const completed = await service.complete({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
			evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
		})

		expect(completed).toMatchObject({
			ok: true,
			value: { role: 'implementer', session: 'session-a', newStatus: 'closed' },
		})
		expect(provider.transitions[0]).toMatchObject({
			type: 'complete',
			role: 'implementer',
			session: 'session-a',
		})
		expect(requireLedgerItem(provider, 'ISSUE-1').activity).toMatchObject({
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})
	})

	it('keeps legacy actor-owned records operable when assertions are omitted', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			activity: undefined,
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(
			service.release({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'legacy release' }),
		).resolves.toMatchObject({ ok: true, value: { command: 'release' } })
	})

	it('selects dependency-ready role work and records an atomic actor ownership claim', async () => {
		const provider = new MemoryCollaborationProvider()
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
			staleClaimMinutes: 90,
		})

		const initial = await service.ready({ role: 'implementer', limit: 10 })
		expect(initial).toStrictEqual({ ok: true, value: [] })
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const ready = await service.ready({ role: 'implementer', limit: 10 })
		expect(ready.ok).toBe(true)
		if (!ready.ok) {
			return
		}
		expect(ready.value.map(({ id }) => id)).toStrictEqual(['ISSUE-1'])

		const claimed = await service.claim({
			workId: 'ISSUE-1',
			actor: 'codex-a',
			role: 'implementer',
			session: 'codex:session-1',
		})
		expect(claimed).toMatchObject({
			ok: true,
			value: { newStatus: 'in_progress', workId: 'ISSUE-1', actor: 'codex-a' },
		})
		await expect(service.claim({ workId: 'ISSUE-1', actor: 'claude-b' })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'ownership_conflict' },
		})
		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'codex-a', session: 'codex:session-2' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'session_conflict' },
		})
		await expect(
			service.resume({ workId: 'ISSUE-1', actor: 'codex-a', session: 'codex:session-2' }),
		).resolves.toMatchObject({ ok: true, value: { command: 'resume' } })
	})

	it('treats an exact active re-claim as idempotent without rewriting activity identity', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		let now = new Date('2026-09-01T01:00:00.000Z')
		const service = createWorkContractService({ root, graph, provider, clock: () => now })
		await service.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})
		const originalActivity = requireLedgerItem(provider, 'ISSUE-1').activity
		now = new Date('2026-09-01T02:00:00.000Z')

		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				command: 'claim',
				previousStatus: 'in_progress',
				newStatus: 'in_progress',
				role: 'implementer',
				session: 'session-a',
			},
		})
		expect(provider.claims).toHaveLength(2)
		expect(requireLedgerItem(provider, 'ISSUE-1').activity).toStrictEqual(originalActivity)

		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-b',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'session_conflict' } })
		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'reviewer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'role_conflict' } })
		expect(provider.claims).toHaveLength(2)
	})

	it('does not report a stale active re-claim when a concurrent ownership transition wins', async () => {
		const provider = new ReclaimRaceProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({ ok: true })
		provider.rejectNextReclaim = true

		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'ownership_conflict' } })
		expect(provider.claims).toHaveLength(2)
		expect(requireLedgerItem(provider, 'ISSUE-1')).toMatchObject({
			status: 'open',
			assignee: undefined,
		})
	})

	it('repairs an interrupted same-actor claim that has no activity metadata', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'closed',
		})
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			activity: undefined,
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(
			service.claim({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				session: 'session-a',
			}),
		).resolves.toMatchObject({ ok: true, value: { command: 'claim' } })
		expect(provider.claims).toHaveLength(1)
		expect(requireLedgerItem(provider, 'ISSUE-1').activity).toMatchObject({
			actor: 'agent-a',
			role: 'implementer',
			session: 'session-a',
		})
	})

	it('requires successful dependency evidence from the current graph for readiness', async () => {
		const evidenceGraph: CompiledWorkGraph = {
			...graph,
			items: graph.items.map((item) =>
				item.id === 'ISSUE-0' ? { ...item, evidenceRequirements: ['test'] } : item,
			),
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			evidenceRequirements: ['test'],
		})
		const service = createWorkContractService({ root, graph: evidenceGraph, provider })

		const beforeClose = await service.ready()
		expect(beforeClose.ok && beforeClose.value.some(({ id }) => id === 'ISSUE-1')).toBe(false)
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'closed',
		})
		const beforeEvidence = await service.ready()
		expect(beforeEvidence.ok && beforeEvidence.value.some(({ id }) => id === 'ISSUE-1')).toBe(false)
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			evidence: [
				{
					kind: 'test',
					reference: 'evidence/dependency.json',
					digest: 'a'.repeat(64),
					recordedAt: '2026-09-01T00:00:00.000Z',
					actor: 'agent-a',
				},
			],
		})
		const afterEvidence = await service.ready()
		expect(
			afterEvidence.ok && afterEvidence.value.some(({ id, ready }) => id === 'ISSUE-1' && ready),
		).toBe(true)
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'archived',
		})
		const afterArchive = await service.ready()
		expect(afterArchive.ok && afterArchive.value.some(({ id }) => id === 'ISSUE-1')).toBe(false)
	})

	it('revalidates current dependency success before completion mutates the provider', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		await service.claim({ workId: 'ISSUE-1', actor: 'agent-a' })
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'open' })

		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'work_not_ready' } })
		expect(provider.transitions).toHaveLength(0)
		expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe('in_progress')
	})

	it('rejects a claim when a dependency reopens after projection but before the provider mutation', async () => {
		const guardedGraph: CompiledWorkGraph = {
			...graph,
			items: graph.items.map((item) =>
				item.id === 'ISSUE-0' ? { ...item, evidenceRequirements: ['test'] } : item,
			),
		}
		const provider = new DependencyInvalidatingProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'closed',
			evidenceRequirements: ['test'],
			evidence: [
				{
					kind: 'test',
					reference: 'evidence/dependency.json',
					digest: 'a'.repeat(64),
					recordedAt: '2026-09-01T00:00:00.000Z',
					actor: 'agent-a',
				},
			],
		})
		provider.invalidateOnClaim = true
		const service = createWorkContractService({ root, graph: guardedGraph, provider })

		await expect(
			service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({ ok: false, error: { code: 'work_not_ready' } })
		expect(requireLedgerItem(provider, 'ISSUE-1')).toMatchObject({
			status: 'open',
			assignee: undefined,
		})
		expect(provider.claimExpectation).toMatchObject({
			dependencies: ['ISSUE-0'],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		})
		expect(provider.claimDependencies).toMatchObject([
			{ workId: 'ISSUE-0', evidenceRequirements: ['test'] },
		])
	})

	it('rejects completion when a dependency reopens after projection but before the provider mutation', async () => {
		const provider = new DependencyInvalidatingProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		await service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' })
		provider.invalidateOnComplete = true

		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				role: 'implementer',
				evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'work_not_ready' } })
		expect(requireLedgerItem(provider, 'ISSUE-1')).toMatchObject({ status: 'in_progress' })
		expect(provider.completionExpectation).toMatchObject({
			dependencies: ['ISSUE-0'],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		})
		expect(provider.completionDependencies).toMatchObject([
			{ workId: 'ISSUE-0', evidenceRequirements: [] },
		])
	})

	it.each(['claim', 'touch', 'handoff', 'block', 'release', 'complete', 'reopen'] as const)(
		'rejects %s when sync changes the target definition after projection but before mutation',
		async (command) => {
			const provider = new DefinitionInvalidatingProvider()
			provider.items.set('ISSUE-0', {
				...requireLedgerItem(provider, 'ISSUE-0'),
				status: 'closed',
			})
			const service = createWorkContractService({ root, graph, provider })
			await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')

			if (command !== 'claim' && command !== 'reopen') {
				await service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' })
			}
			if (command === 'reopen') {
				provider.items.set('ISSUE-1', {
					...requireLedgerItem(provider, 'ISSUE-1'),
					status: 'closed',
					assignee: 'agent-a',
					activity: {
						actor: 'agent-a',
						role: 'implementer',
						startedAt: '2026-09-01T00:00:00.000Z',
						touchedAt: '2026-09-01T00:00:00.000Z',
					},
				})
			}

			const invalidatedOperations = {
				claim: 'claim',
				touch: 'recordActivity',
				handoff: 'recordHandoff',
				block: 'transition',
				release: 'transition',
				complete: 'transition',
				reopen: 'transition',
			} as const
			provider.invalidateOperation = invalidatedOperations[command]
			const operations = {
				claim: async () =>
					service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
				touch: async () =>
					service.touch({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
				handoff: async () =>
					service.handoff({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						summary: 'Continue after the sync.',
					}),
				block: async () =>
					service.block({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Blocked.',
					}),
				release: async () =>
					service.release({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Released.',
					}),
				complete: async () =>
					service.complete({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
					}),
				reopen: async () =>
					service.reopen({
						workId: 'ISSUE-1',
						actor: 'agent-a',
						role: 'implementer',
						reason: 'Reopened.',
					}),
			}

			await expect(operations[command]()).resolves.toMatchObject({
				ok: false,
				error: { code: 'ledger_not_synchronized' },
			})
		},
	)

	it('rejects an actor mutation when a required parent changes after projection', async () => {
		const provider = new ClosureInvalidatingProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await service.claim({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' })
		provider.invalidateParentOnActivity = true

		await expect(
			service.touch({ workId: 'ISSUE-1', actor: 'agent-a', role: 'implementer' }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'ledger_not_synchronized' },
		})
		expect(provider.activities).toHaveLength(0)
	})

	it.each([
		['the closed dependency loses required evidence', 'closed', false],
		['the dependency is archived', 'archived', true],
	] as const)('rejects completion when %s', async (_label, dependencyStatus, retainEvidence) => {
		const evidenceGraph: CompiledWorkGraph = {
			...graph,
			items: graph.items.map((item) =>
				item.id === 'ISSUE-0' ? { ...item, evidenceRequirements: ['test'] } : item,
			),
		}
		const dependencyEvidence = {
			kind: 'test' as const,
			reference: 'evidence/dependency.json',
			digest: 'a'.repeat(64),
			recordedAt: '2026-09-01T00:00:00.000Z',
			actor: 'agent-a',
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'closed',
			evidenceRequirements: ['test'],
			evidence: [dependencyEvidence],
		})
		const service = createWorkContractService({ root, graph: evidenceGraph, provider })
		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		await expect(service.claim({ workId: 'ISSUE-1', actor: 'agent-a' })).resolves.toMatchObject({
			ok: true,
		})
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: dependencyStatus,
			evidence: retainEvidence ? [dependencyEvidence] : [],
		})

		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'agent-a',
				evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'work_not_ready' } })
		expect(provider.transitions).toHaveLength(0)
	})

	it('hands work across sessions without storing a transcript and flags stale activity', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		let now = new Date('2026-09-01T01:00:00.000Z')
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => now,
			staleClaimMinutes: 90,
		})
		await service.claim({ workId: 'ISSUE-1', actor: 'codex-a', session: 'codex:one' })
		const handedOff = await service.handoff({
			workId: 'ISSUE-1',
			actor: 'codex-a',
			summary: 'Implemented the parser; validation remains.',
			remaining: ['Add provider tests'],
			references: ['src/parser.ts'],
			release: true,
		})
		expect(handedOff.ok).toBe(true)

		now = new Date('2026-09-01T03:00:00.000Z')
		const resumed = await service.claim({
			workId: 'ISSUE-1',
			actor: 'claude-b',
			session: 'claude:two',
		})
		expect(resumed.ok).toBe(true)
		const active = await service.active()
		expect(active).toMatchObject({
			ok: true,
			value: [
				{
					id: 'ISSUE-1',
					assignee: 'claude-b',
					stale: false,
					handoff: { summary: 'Implemented the parser; validation remains.' },
				},
			],
		})
		now = new Date('2026-09-01T05:00:01.000Z')
		const stale = await service.active()
		expect(stale.ok && stale.value[0]?.stale).toBe(true)
	})

	it.each(['open', 'closed', 'deferred', 'archived'] as const)(
		'rejects activity and handoff commands from inactive %s work',
		async (status) => {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-1', {
				...requireLedgerItem(provider, 'ISSUE-1'),
				status,
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			})
			const service = createWorkContractService({ root, graph, provider })

			await expect(service.touch({ workId: 'ISSUE-1', actor: 'agent-a' })).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_transition' },
			})
			await expect(service.resume({ workId: 'ISSUE-1', actor: 'agent-a' })).resolves.toMatchObject({
				ok: false,
				error: { code: 'invalid_transition' },
			})
			await expect(
				service.handoff({ workId: 'ISSUE-1', actor: 'agent-a', summary: 'handoff' }),
			).resolves.toMatchObject({ ok: false, error: { code: 'invalid_transition' } })
			expect(provider.activities).toHaveLength(0)
			expect(provider.handoffs).toHaveLength(0)
			expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe(status)
		},
	)

	it.each(['touch', 'resume', 'handoff'] as const)(
		'allows %s while work is blocked and remains active',
		async (command) => {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-1', {
				...requireLedgerItem(provider, 'ISSUE-1'),
				status: 'blocked',
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			})
			const service = createWorkContractService({ root, graph, provider })
			const result =
				command === 'handoff'
					? await service.handoff({
							workId: 'ISSUE-1',
							actor: 'agent-a',
							summary: 'blocked handoff',
						})
					: await service[command]({ workId: 'ISSUE-1', actor: 'agent-a' })

			expect(result).toMatchObject({
				ok: true,
				value: { command, previousStatus: 'blocked', newStatus: 'blocked' },
			})
			expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe('blocked')
		},
	)

	it('rejects duplicate ledger records and prevents arbitrary reopen from evicting active ownership', async () => {
		const provider = new MemoryCollaborationProvider()
		const originalList = provider.list.bind(provider)
		provider.list = async () => {
			const listed = await originalList()
			if (!listed.ok) {
				return listed
			}
			return { ok: true, value: [...listed.value, requireLedgerItem(provider, 'ISSUE-1')] }
		}
		const duplicateService = createWorkContractService({ root, graph, provider })
		await expect(duplicateService.active()).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_ledger_projection' },
		})

		provider.list = originalList
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'in_progress',
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({ root, graph, provider })
		await expect(
			service.reopen({ workId: 'ISSUE-1', actor: 'agent-b', reason: 'take over' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_transition' },
		})
		expect(requireLedgerItem(provider, 'ISSUE-1').assignee).toBe('agent-a')

		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'closed',
			assignee: 'agent-a',
		})
		await expect(
			service.reopen({ workId: 'ISSUE-1', actor: 'agent-b', reason: 'take over closed work' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'ownership_conflict' },
		})
	})

	it.each([
		['open', 'block'],
		['blocked', 'block'],
		['closed', 'block'],
		['deferred', 'block'],
		['archived', 'block'],
		['open', 'release'],
		['closed', 'release'],
		['deferred', 'release'],
		['archived', 'release'],
		['open', 'reopen'],
		['in_progress', 'reopen'],
		['deferred', 'reopen'],
		['archived', 'reopen'],
	] as const)('rejects %s -> %s outside the lifecycle matrix', async (status, command) => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status,
			assignee: 'agent-a',
			activity: {
				actor: 'agent-a',
				startedAt: '2026-09-01T00:00:00.000Z',
				touchedAt: '2026-09-01T00:00:00.000Z',
			},
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(
			service[command]({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'test transition' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_transition' },
		})
		expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe(status)
	})

	it.each([
		['in_progress', 'block', 'blocked'],
		['in_progress', 'release', 'open'],
		['blocked', 'release', 'open'],
		['blocked', 'reopen', 'open'],
		['closed', 'reopen', 'open'],
	] as const)(
		'allows %s -> %s -> %s in the lifecycle matrix',
		async (status, command, expected) => {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-1', {
				...requireLedgerItem(provider, 'ISSUE-1'),
				status,
				assignee: 'agent-a',
				activity: {
					actor: 'agent-a',
					startedAt: '2026-09-01T00:00:00.000Z',
					touchedAt: '2026-09-01T00:00:00.000Z',
				},
			})
			const service = createWorkContractService({ root, graph, provider })

			await expect(
				service[command]({ workId: 'ISSUE-1', actor: 'agent-a', reason: 'test transition' }),
			).resolves.toMatchObject({
				ok: true,
				value: { previousStatus: status, newStatus: expected },
			})
			expect(requireLedgerItem(provider, 'ISSUE-1').status).toBe(expected)
		},
	)

	it('fails closed on escaping evidence and completes with hashed required evidence', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
			staleClaimMinutes: 90,
		})
		await service.claim({ workId: 'ISSUE-1', actor: 'codex-a' })
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-outside-evidence-'))
		await writeFile(join(outside, 'proof.json'), '{"passed":true}\n')
		await symlink(join(outside, 'proof.json'), join(root, 'evidence', 'escaped.json'))
		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'codex-a',
				evidence: [{ kind: 'test', reference: 'evidence/escaped.json' }],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_evidence_path' },
		})

		await writeFile(join(root, 'evidence', 'proof.json'), '{"passed":true}\n')
		const completed = await service.complete({
			workId: 'ISSUE-1',
			actor: 'codex-a',
			evidence: [{ kind: 'test', reference: 'evidence/proof.json' }],
		})
		expect(completed.ok).toBe(true)
		if (!completed.ok) {
			return
		}
		expect(completed.value.evidence).toStrictEqual([
			{
				kind: 'test',
				reference: 'evidence/proof.json',
				digest: createHash('sha256').update('{"passed":true}\n').digest('hex'),
				recordedAt: '2026-09-01T01:00:00.000Z',
				actor: 'codex-a',
			},
		])
		await rm(outside, { force: true, recursive: true })
	})

	it('rejects oversized local evidence before buffering it', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		const service = createWorkContractService({ root, graph, provider })
		await service.claim({ workId: 'ISSUE-1', actor: 'codex-a' })
		const evidencePath = join(root, 'evidence', 'oversized.bin')
		await writeFile(evidencePath, '')
		await truncate(evidencePath, INPUT_LIMITS.evidenceBytes + 1)

		await expect(
			service.complete({
				workId: 'ISSUE-1',
				actor: 'codex-a',
				evidence: [{ kind: 'test', reference: 'evidence/oversized.bin' }],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'evidence_too_large' },
		})
	})

	it('does not expose untrusted evidence references in completion failures', async () => {
		const sentinel = 'PRIVATE_EVIDENCE_TOKEN_VALUE'
		const digestReference = `evidence/${sentinel}-digest.json`
		const directoryReference = `evidence/${sentinel}-directory`
		const oversizedReference = `evidence/${sentinel}-oversized.bin`
		const escapedReference = `evidence/${sentinel}-escaped.json`
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-private-evidence-'))
		await writeFile(join(root, digestReference), '{"passed":true}\n')
		await mkdir(join(root, directoryReference))
		await writeFile(join(root, oversizedReference), '')
		await truncate(join(root, oversizedReference), INPUT_LIMITS.evidenceBytes + 1)
		await writeFile(join(outside, `${sentinel}.json`), '{"passed":true}\n')
		await symlink(join(outside, `${sentinel}.json`), join(root, escapedReference))
		const scenarios = [
			{
				name: 'absolute path',
				reference: join(root, sentinel, 'absolute.json'),
				expectedCode: 'unsafe_evidence_path',
				expectedMessage: 'Evidence path must be repository-relative.',
			},
			{
				name: 'escaping symlink',
				reference: escapedReference,
				expectedCode: 'unsafe_evidence_path',
				expectedMessage: 'Evidence path must remain within the repository.',
			},
			{
				name: 'missing file',
				reference: `evidence/${sentinel}-missing.json`,
				expectedCode: 'evidence_unavailable',
				expectedMessage: 'Evidence file cannot be read.',
			},
			{
				name: 'directory',
				reference: directoryReference,
				expectedCode: 'evidence_unavailable',
				expectedMessage: 'Evidence file is not a regular file.',
			},
			{
				name: 'oversized file',
				reference: oversizedReference,
				expectedCode: 'evidence_too_large',
				expectedMessage: `Evidence file exceeds ${INPUT_LIMITS.evidenceBytes} bytes.`,
			},
			{
				name: 'digest mismatch',
				reference: digestReference,
				digest: '0'.repeat(64),
				expectedCode: 'evidence_digest_mismatch',
				expectedMessage: 'Evidence digest does not match the current file.',
			},
		] as const

		for (const scenario of scenarios) {
			const provider = new MemoryCollaborationProvider()
			provider.items.set('ISSUE-0', {
				...requireLedgerItem(provider, 'ISSUE-0'),
				status: 'closed',
			})
			const service = createWorkContractService({ root, graph, provider })
			await expect(
				service.claim({ workId: 'ISSUE-1', actor: 'codex-a' }),
				scenario.name,
			).resolves.toMatchObject({ ok: true })

			const completed = await service.complete({
				workId: 'ISSUE-1',
				actor: 'codex-a',
				evidence: [
					{
						kind: 'test',
						reference: scenario.reference,
						...('digest' in scenario ? { digest: scenario.digest } : {}),
					},
				],
			})

			expect(completed, scenario.name).toMatchObject({
				ok: false,
				error: {
					type: 'work_contract_error',
					code: scenario.expectedCode,
					message: scenario.expectedMessage,
				},
			})
			expect(JSON.stringify(completed), scenario.name).not.toContain(sentinel)
			expect(provider.transitions, scenario.name).toHaveLength(0)
		}
		await rm(outside, { force: true, recursive: true })
	})

	it('derives explainable parent rollups from accepted descendant state', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', { ...requireLedgerItem(provider, 'ISSUE-0'), status: 'closed' })
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'blocked',
			blockReason: 'API decision required',
		})
		const service = createWorkContractService({
			root,
			graph,
			provider,
			clock: () => new Date('2026-09-01T01:00:00.000Z'),
			staleClaimMinutes: 90,
		})

		const rollup = await service.rollup('PRD-1')
		expect(rollup).toStrictEqual({
			ok: true,
			value: {
				schemaVersion: 1,
				workId: 'PRD-1',
				total: 2,
				completed: 1,
				active: 0,
				blocked: 1,
				ready: 0,
				evidenceSatisfied: 1,
				status: 'blocked',
				reasons: ['ISSUE-1: API decision required'],
			},
		})
	})

	it('does not count archived or evidence-incomplete closed descendants as completed', async () => {
		const provider = new MemoryCollaborationProvider()
		provider.items.set('ISSUE-0', {
			...requireLedgerItem(provider, 'ISSUE-0'),
			status: 'archived',
		})
		provider.items.set('ISSUE-1', {
			...requireLedgerItem(provider, 'ISSUE-1'),
			status: 'closed',
			evidence: [],
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(service.rollup('PRD-1')).resolves.toMatchObject({
			ok: true,
			value: { total: 2, completed: 0, status: 'open' },
		})
	})

	it('does not count evidence on an in-progress descendant as rollup-satisfied', async () => {
		const provider = new MemoryCollaborationProvider()
		const current = requireLedgerItem(provider, 'ISSUE-0')
		provider.items.set('ISSUE-0', {
			...current,
			status: 'in_progress',
			assignee: 'codex-a',
			evidence: [
				{
					kind: 'test',
					reference: 'evidence/test.txt',
					digest: 'a'.repeat(64),
					recordedAt: '2026-09-01T00:00:00.000Z',
					actor: 'codex-a',
				},
			],
		})
		const service = createWorkContractService({ root, graph, provider })

		await expect(service.rollup('PRD-1')).resolves.toMatchObject({
			ok: true,
			value: { completed: 0, evidenceSatisfied: 0 },
		})
	})

	it('traverses a maximum-depth rollup without rescanning the graph per level', async () => {
		const items = [artifact({ id: 'PRD-CHAIN', kind: 'prd', title: 'Chain' })]
		for (let index = 1; index < INPUT_LIMITS.providerItems; index += 1) {
			items.push(
				artifact({
					id: `ISSUE-${index}`,
					kind: 'issue',
					title: `Chain node ${index}`,
					parentId: index === 1 ? 'PRD-CHAIN' : `ISSUE-${index - 1}`,
				}),
			)
		}
		const filter = vi.spyOn(items, 'filter')
		const chainGraph: CompiledWorkGraph = {
			schemaVersion: 1,
			projectId: 'example',
			fingerprint: 'graph-1',
			items,
		}
		const provider = new MemoryCollaborationProvider()
		provider.items.clear()
		for (const item of items) {
			provider.items.set(item.id, ledgerItem(item))
		}
		const service = createWorkContractService({ root, graph: chainGraph, provider })

		const startedAt = performance.now()
		const result = await service.rollup('PRD-CHAIN')
		const duration = performance.now() - startedAt

		expect(result).toMatchObject({
			ok: true,
			value: {
				total: INPUT_LIMITS.providerItems - 1,
				ready: INPUT_LIMITS.providerItems - 1,
				status: 'ready',
			},
		})
		expect(filter).toHaveBeenCalledTimes(0)
		expect(duration).toBeLessThan(2000)
	})
})
