/**
 * @description Proves work-contract provider and CLI behavior against disposable real Beads repositories.
 *
 * @module work/beads
 * @file Beads.int.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions, unicorn/consistent-function-scoping -- Integration helpers stay beside their disposable fixture. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { env as processEnvironment } from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBeadsProvider, resolveDefaultBeadsBinary } from './beads'
import { runWorkContractCli } from './cli'
import { loadWorkManifest } from './compiler'
import type { CompiledWorkGraph, WorkArtifact } from './contracts'
import { createWorkContractService } from './service'
import { applySyncPlan, planSync } from './sync'
import { resolveWorkCoordinationLocation } from './work-state'

let root: string
let stateHome: string
const previousStateHome = processEnvironment.WORK_CONTRACT_STATE_HOME

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

const parseJsonLines = (source: string): readonly unknown[] =>
	source
		.trim()
		.split('\n')
		.map((line) => {
			const value: unknown = JSON.parse(line)
			return value
		})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const providerStateIdentity = (source: string): string | undefined => {
	const parsed: unknown = JSON.parse(source)
	if (!isRecord(parsed) || !isRecord(parsed.value)) {
		return undefined
	}
	const providerState = parsed.value.providerState
	return isRecord(providerState) && typeof providerState.identity === 'string'
		? providerState.identity
		: undefined
}

const cliReceiptTimestamp = (source: string): string | undefined => {
	const parsed: unknown = JSON.parse(source)
	if (!isRecord(parsed) || !isRecord(parsed.value)) {
		return undefined
	}
	return typeof parsed.value.timestamp === 'string' ? parsed.value.timestamp : undefined
}

const projectRecoveryStates = (
	values: readonly unknown[],
): readonly { readonly status?: string; readonly workId?: string }[] =>
	values.map((value) => {
		if (!isRecord(value)) {
			return {}
		}
		const metadata = isRecord(value.metadata) ? value.metadata : undefined
		const workContract =
			metadata !== undefined && isRecord(metadata.work_contract)
				? metadata.work_contract
				: undefined
		return {
			...(typeof value.status === 'string' ? { status: value.status } : {}),
			...(typeof workContract?.work_id === 'string' ? { workId: workContract.work_id } : {}),
		}
	})

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

const execFileAsync = async (executable: string, args: readonly string[]): Promise<void> =>
	new Promise((fulfill, reject) => {
		execFile(executable, args, (error) => {
			if (error === null) {
				fulfill()
			} else {
				reject(new Error('Child process failed.', { cause: error }))
			}
		})
	})

const execFileInRoot = async (executable: string, args: readonly string[]): Promise<void> =>
	new Promise((fulfill, reject) => {
		execFile(executable, args, { cwd: root }, (error) => {
			if (error === null) {
				fulfill()
			} else {
				reject(new Error('Child process failed.', { cause: error }))
			}
		})
	})

const localDeliveryPolicy = {
	profile: 'local-direct' as const,
	isolation: 'none' as const,
	integration: 'local' as const,
	terminal: 'landed' as const,
	targetRef: 'refs/heads/main',
	requiredGates: ['validation', 'landing'] as const,
}

const writeFakeBinary = async (body: string): Promise<string> => {
	const binary = join(root, 'fake-bd.mjs')
	await writeFile(binary, `#!/usr/bin/env node\n${body}\n`)
	await chmod(binary, 0o755)
	return binary
}

const providerLockPath = (projectId: string, workId: string): string =>
	join(root, '.work', `beads-${digest(projectId).slice(0, 12)}-${digest(workId).slice(0, 12)}.lock`)

const lockRecord = (providerId: string, workId: string) => ({
	id: providerId,
	title: 'Issue',
	status: 'open',
	priority: 2,
	issue_type: 'issue',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
	metadata: {
		work_contract_project_key: digest('example'),
		work_contract: {
			schema_version: 2,
			project_id: 'example',
			work_id: workId,
			kind: 'issue',
			source_path: `docs/${workId}.md`,
			source_hash: 'a'.repeat(64),
			graph_fingerprint: 'b'.repeat(64),
			roles: [],
			evidence_requirements: [],
		},
	},
})

const artifact = (
	input: Partial<WorkArtifact> & Pick<WorkArtifact, 'id' | 'kind' | 'title'>,
): WorkArtifact => ({
	...input,
	execution: input.execution ?? 'task',
	source: input.source ?? {
		path: `docs/${input.id}.md`,
		hash: digest(`source-${input.id}`),
	},
	dependencies: input.dependencies ?? [],
	acceptance: input.acceptance ?? [],
	owners: input.owners ?? [],
	roles: input.roles ?? [],
	evidenceRequirements: input.evidenceRequirements ?? [],
	body: input.body ?? `Definition for ${input.id}.`,
})

const graph = (revision = 1): CompiledWorkGraph => ({
	schemaVersion: 1,
	projectId: 'example',
	fingerprint: digest(`graph-${revision}`),
	items: [
		artifact({ id: 'PRD-1', kind: 'prd', title: 'Product' }),
		artifact({
			id: 'ISSUE-0',
			kind: 'issue',
			title: 'Design',
			parentId: 'PRD-1',
		}),
		artifact({
			id: 'ISSUE-1',
			kind: 'issue',
			title: revision === 1 ? 'Implement' : 'Implement revised',
			parentId: 'PRD-1',
			dependencies: revision === 1 ? ['ISSUE-0'] : [],
			source: { path: 'docs/ISSUE-1.md', hash: digest(`source-${revision}`) },
			acceptance: ['Behavior works.'],
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		}),
	],
})

const expectedDefinition = (projectGraph: CompiledWorkGraph, workId: string) => {
	const item = projectGraph.items.find(({ id }) => id === workId)
	if (item === undefined) {
		throw new Error(`Missing graph fixture ${workId}`)
	}
	return {
		schemaVersion: 2 as const,
		graphFingerprint: projectGraph.fingerprint,
		title: item.title,
		kind: item.kind,
		source: item.source,
		parentId: item.parentId,
		dependencies: item.dependencies,
		roles: item.roles,
		evidenceRequirements: item.evidenceRequirements,
	}
}

const parallelGraph = (): CompiledWorkGraph => ({
	schemaVersion: 1,
	projectId: 'parallel-example',
	fingerprint: digest('parallel-graph'),
	items: [
		artifact({ id: 'PRD-1', kind: 'prd', title: 'Parallel delivery' }),
		artifact({
			id: 'ISSUE-1',
			kind: 'issue',
			title: 'First stream',
			parentId: 'PRD-1',
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		}),
		artifact({
			id: 'ISSUE-2',
			kind: 'issue',
			title: 'Second stream',
			parentId: 'PRD-1',
			roles: ['implementer'],
			evidenceRequirements: ['test'],
		}),
	],
})

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-beads-'))
	stateHome = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
	processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
})

afterEach(async () => {
	if (previousStateHome === undefined) {
		delete processEnvironment.WORK_CONTRACT_STATE_HOME
	} else {
		processEnvironment.WORK_CONTRACT_STATE_HOME = previousStateHome
	}
	await Promise.all(
		[root, stateHome].map(async (path) => rm(path, { force: true, recursive: true })),
	)
})

describe('beads provider', () => {
	it('persists aggregate progress and enforces atomic child closure and reopen ordering', async () => {
		const aggregate = artifact({
			id: 'ISSUE-10',
			kind: 'issue',
			title: 'Design partner program',
			execution: 'aggregate',
			evidenceRequirements: ['artifact'],
		})
		const child = artifact({
			id: 'ISSUE-11',
			kind: 'issue',
			title: 'Research governance',
			parentId: aggregate.id,
			evidenceRequirements: ['test'],
		})
		const formerChild = artifact({
			id: 'ISSUE-12',
			kind: 'issue',
			title: 'Removed checkpoint',
			parentId: aggregate.id,
		})
		const projectGraph: CompiledWorkGraph = {
			schemaVersion: 1,
			projectId: 'aggregate-example',
			fingerprint: digest('aggregate-graph'),
			items: [aggregate, child],
		}
		const initialGraph: CompiledWorkGraph = {
			...projectGraph,
			fingerprint: digest('aggregate-initial-graph'),
			items: [aggregate, child, formerChild],
		}
		const provider = createBeadsProvider({
			root,
			projectId: projectGraph.projectId,
			actor: 'agent-a',
		})
		await expect(provider.initialize({ prefix: 'wc' })).resolves.toMatchObject({ ok: true })
		const plan = planSync({ graph: initialGraph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		await expect(
			applySyncPlan({ graph: initialGraph, plan: plan.value, provider }),
		).resolves.toMatchObject({ ok: true })
		const initialItems = await provider.list()
		if (!initialItems.ok) {
			throw new Error(initialItems.error.message)
		}
		const removalPlan = planSync({
			graph: projectGraph,
			ledgerItems: initialItems.value,
			archiveMissing: true,
		})
		if (!removalPlan.ok) {
			throw new Error(removalPlan.error.message)
		}
		await expect(
			applySyncPlan({ graph: projectGraph, plan: removalPlan.value, provider }),
		).resolves.toMatchObject({ ok: true })
		const service = createWorkContractService({ root, graph: projectGraph, provider })

		await expect(service.claim({ workId: aggregate.id, actor: 'agent-a' })).resolves.toMatchObject({
			ok: false,
			error: { code: 'aggregate_not_executable' },
		})
		await expect(
			service.complete({ workId: aggregate.id, actor: 'agent-a', evidence: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: 'aggregate_not_ready' } })
		await writeFile(join(root, 'child.json'), '{"passed":true}\n')
		await expect(service.claim({ workId: child.id, actor: 'agent-a' })).resolves.toMatchObject({
			ok: true,
		})
		await expect(
			service.complete({
				workId: child.id,
				actor: 'agent-a',
				evidence: [{ kind: 'test', reference: 'child.json' }],
			}),
		).resolves.toMatchObject({ ok: true })
		await writeFile(join(root, 'final.md'), '# Final synthesis\n')
		const aggregateCompletion = await service.complete({
			workId: aggregate.id,
			actor: 'agent-a',
			evidence: [{ kind: 'artifact', reference: 'final.md' }],
		})
		if (!aggregateCompletion.ok) {
			throw new Error(JSON.stringify(aggregateCompletion.error))
		}
		expect(aggregateCompletion).toMatchObject({
			ok: true,
			value: { previousStatus: 'open', newStatus: 'closed' },
		})

		const restarted = createWorkContractService({
			root,
			graph: projectGraph,
			provider: createBeadsProvider({ root, projectId: projectGraph.projectId, actor: 'agent-b' }),
		})
		await expect(restarted.inspect(aggregate.id)).resolves.toMatchObject({
			ok: true,
			value: { status: 'closed', aggregate: { total: 1, terminal: 1, completionReady: true } },
		})
		await expect(
			restarted.reopen({ workId: child.id, actor: 'agent-a', reason: 'New evidence.' }),
		).resolves.toMatchObject({ ok: false, error: { code: 'aggregate_not_ready' } })
		await expect(
			restarted.reopen({ workId: aggregate.id, actor: 'agent-b', reason: 'Reopen program.' }),
		).resolves.toMatchObject({ ok: true })
		await expect(
			restarted.reopen({ workId: child.id, actor: 'agent-a', reason: 'New evidence.' }),
		).resolves.toMatchObject({ ok: true })
	})

	it('allows independent mutations to overlap while serializing the same item', async () => {
		const overlapLog = join(root, 'overlap.log')
		const marker = join(root, 'provider-active')
		const first = lockRecord('wc-1', 'ISSUE-1')
		const second = lockRecord('wc-2', 'ISSUE-2')
		const binary = await writeFakeBinary(`
import { appendFileSync, closeSync, openSync, rmSync } from 'node:fs'
const args = process.argv.slice(2)
const records = [${JSON.stringify(first)}, ${JSON.stringify(second)}]
const item = records.find((candidate) => candidate.id === args[1])
if (args[0] === 'list') console.log(JSON.stringify(records))
else if (args[0] === 'update' && item !== undefined) {
  const actor = args[args.indexOf('--actor') + 1]
  if (args.includes('--claim')) {
    let handle
    try { handle = openSync(${JSON.stringify(marker)}, 'wx') }
    catch { appendFileSync(${JSON.stringify(overlapLog)}, 'overlap\\n') }
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (handle !== undefined) { closeSync(handle); rmSync(${JSON.stringify(marker)}, { force: true }) }
    console.log(JSON.stringify({ ...item, status: 'in_progress', assignee: actor }))
  } else {
    const metadata = JSON.parse(args[args.indexOf('--metadata') + 1])
    console.log(JSON.stringify({ ...item, status: 'in_progress', assignee: actor, metadata }))
  }
} else process.exit(9)
`)
		const child = join(root, 'claim.ts')
		await writeFile(
			child,
			`import { createBeadsProvider } from ${JSON.stringify(join(import.meta.dirname, 'beads.ts'))}
const [root, binary, workId, actor] = process.argv.slice(2)
const provider = createBeadsProvider({ root, binary, projectId: 'example' })
const result = await provider.claim({
  workId,
  actor,
  timestamp: '2026-09-01T00:00:00.000Z',
  expectedDefinition: {
		schemaVersion: 2,
    graphFingerprint: ${JSON.stringify('b'.repeat(64))},
    title: 'Issue',
    kind: 'issue',
    source: { path: \`docs/\${workId}.md\`, hash: ${JSON.stringify('a'.repeat(64))} },
    parentId: undefined,
    dependencies: [],
    roles: [],
    evidenceRequirements: [],
  },
  expectedDefinitionClosure: [{
    workId,
		schemaVersion: 2,
    graphFingerprint: ${JSON.stringify('b'.repeat(64))},
    title: 'Issue',
    kind: 'issue',
    source: { path: \`docs/\${workId}.md\`, hash: ${JSON.stringify('a'.repeat(64))} },
    parentId: undefined,
    dependencies: [],
    roles: [],
    evidenceRequirements: [],
  }],
  expectedDependencies: [],
})
if (!result.ok) { console.error(JSON.stringify(result)); process.exit(1) }
`,
		)
		const runClaim = async (workId: string, actor: string): Promise<void> => {
			await execFileAsync('bun', [child, root, binary, workId, actor])
		}

		await Promise.all([runClaim('ISSUE-1', 'agent-a'), runClaim('ISSUE-2', 'agent-b')])
		const independentOverlap = await readFile(overlapLog, 'utf8')
		expect(independentOverlap.trim()).toBe('overlap')

		await rm(overlapLog, { force: true })
		await Promise.all([runClaim('ISSUE-1', 'agent-a'), runClaim('ISSUE-1', 'agent-b')])
		await expect(readFile(overlapLog, 'utf8')).rejects.toThrow('ENOENT')
		await expect(access(providerLockPath('example', 'ISSUE-1'))).rejects.toThrow('ENOENT')
		await expect(access(providerLockPath('example', 'ISSUE-2'))).rejects.toThrow('ENOENT')
	})

	it('initializes without agent setup and reconciles definitions and relations through supported JSON commands', async () => {
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary: resolve(import.meta.dirname, '../node_modules/.bin/bd'),
			actor: 'work-contract-test',
		})

		const initialized = await provider.initialize({ prefix: 'wc' })
		expect(initialized.ok).toBe(true)
		await expect(exists(join(root, 'AGENTS.md'))).resolves.toBe(false)
		await expect(exists(join(root, 'CLAUDE.md'))).resolves.toBe(false)

		const health = await provider.doctor()
		expect(health).toStrictEqual({
			ok: true,
			value: { provider: 'beads', version: '1.2.2' },
		})

		const initialPlan = planSync({ graph: graph(), ledgerItems: [] })
		if (!initialPlan.ok) {
			throw new Error('fixture plan failed')
		}
		const applied = await applySyncPlan({
			graph: graph(),
			plan: initialPlan.value,
			provider,
		})
		if (!applied.ok) {
			throw new Error(
				`${applied.error.code}: ${applied.error.message} ${JSON.stringify(applied.error.details)}`,
			)
		}
		expect(applied.ok).toBe(true)

		const first = await provider.list()
		expect(first.ok).toBe(true)
		if (!first.ok) {
			return
		}
		expect(
			first.value.map(({ workId, parentId, dependencies }) => ({
				workId,
				parentId,
				dependencies,
			})),
		).toStrictEqual([
			{ workId: 'ISSUE-0', parentId: 'PRD-1', dependencies: [] },
			{ workId: 'ISSUE-1', parentId: 'PRD-1', dependencies: ['ISSUE-0'] },
			{ workId: 'PRD-1', parentId: undefined, dependencies: [] },
		])

		const revisedPlan = planSync({ graph: graph(2), ledgerItems: first.value })
		if (!revisedPlan.ok) {
			throw new Error('revised fixture plan failed')
		}
		expect(revisedPlan.value.actions.map(({ type, workId }) => `${type}:${workId}`)).toStrictEqual([
			'update:ISSUE-1',
			'relations:ISSUE-1',
		])
		const revised = await applySyncPlan({
			graph: graph(2),
			plan: revisedPlan.value,
			provider,
		})
		expect(revised.ok).toBe(true)
		const final = await provider.list()
		if (!final.ok) {
			throw new Error(final.error.message)
		}
		expect(final.value.find(({ workId }) => workId === 'ISSUE-1')).toMatchObject({
			title: 'Implement revised',
			dependencies: [],
			source: { hash: digest('source-2') },
		})
	})

	it('discovers and archives a removed markerless schema-v1 item through migration discovery', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
			actor: 'work-contract-test',
		})
		await expect(provider.initialize({ prefix: 'wc' })).resolves.toMatchObject({ ok: true })
		const oldArtifact = artifact({ id: 'ISSUE-OLD', kind: 'issue', title: 'Removed issue' })
		const created = await provider.createDefinition({
			projectId: 'example',
			graphFingerprint: digest('old-graph'),
			artifact: oldArtifact,
		})
		if (!created.ok) {
			throw new Error(created.error.message)
		}
		await execFileAsync(binary, [
			'update',
			created.value.providerId,
			'--unset-metadata',
			'work_contract_project_key',
			'--actor',
			'work-contract-test',
			'--json',
			'--directory',
			root,
		])
		await execFileAsync(binary, [
			'update',
			created.value.providerId,
			'--metadata',
			JSON.stringify({
				work_contract: {
					schema_version: 1,
					project_id: 'example',
					work_id: 'ISSUE-OLD',
					kind: 'issue',
					source_path: oldArtifact.source.path,
					source_hash: oldArtifact.source.hash,
					graph_fingerprint: digest('old-graph'),
				},
			}),
			'--actor',
			'work-contract-test',
			'--json',
			'--directory',
			root,
		])

		await expect(provider.list()).resolves.toMatchObject({ ok: true, value: [] })
		const legacy = await provider.discoverLegacyDefinitions?.()
		expect(legacy).toMatchObject({
			ok: true,
			value: [{ workId: 'ISSUE-OLD', definitionSchemaVersion: 1, status: 'open' }],
		})
		if (legacy === undefined || !legacy.ok) {
			return
		}
		const emptyGraph: CompiledWorkGraph = {
			schemaVersion: 1,
			projectId: 'example',
			fingerprint: digest('empty-graph'),
			items: [],
		}
		const plan = planSync({ graph: emptyGraph, ledgerItems: legacy.value, archiveMissing: true })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		expect(plan.value.actions).toStrictEqual([{ type: 'archive', workId: 'ISSUE-OLD' }])
		await expect(
			applySyncPlan({ graph: emptyGraph, plan: plan.value, provider }),
		).resolves.toMatchObject({ ok: true, value: { applied: 1 } })
		await expect(provider.finalizeLegacyMigration?.()).resolves.toMatchObject({ ok: true })
		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [{ workId: 'ISSUE-OLD', status: 'archived' }],
		})
	})

	it('persists an exact candidate and gate receipt across provider recreation', async () => {
		const projectGraph = graph()
		const provider = createBeadsProvider({ root, projectId: 'example', actor: 'agent-a' })
		await expect(provider.initialize({ prefix: 'wc' })).resolves.toMatchObject({ ok: true })
		const plan = planSync({ graph: projectGraph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const synchronized = await applySyncPlan({ graph: projectGraph, plan: plan.value, provider })
		if (!synchronized.ok) {
			throw new Error(synchronized.error.message)
		}
		const timestamp = '2026-09-04T00:00:00.000Z'
		const claimed = await provider.claim({
			workId: 'ISSUE-0',
			actor: 'agent-a',
			timestamp,
			expectedDefinition: expectedDefinition(projectGraph, 'ISSUE-0'),
			expectedDefinitionClosure: [
				{ workId: 'ISSUE-0', ...expectedDefinition(projectGraph, 'ISSUE-0') },
			],
			expectedDependencies: [],
		})
		if (!claimed.ok) {
			throw new Error(claimed.error.message)
		}
		const candidate = {
			schemaVersion: 1 as const,
			generation: 1,
			projectId: 'example',
			workId: 'ISSUE-0',
			graphFingerprint: projectGraph.fingerprint,
			repositoryId: digest('repository'),
			headSha: 'a'.repeat(40),
			treeSha: 'b'.repeat(40),
			ref: 'refs/heads/feature',
			isolation: 'worktree' as const,
			submittedAt: timestamp,
			actor: 'agent-a',
			evidence: [],
		}
		const gate = {
			schemaVersion: 1 as const,
			gate: 'validation' as const,
			result: 'passed' as const,
			candidateGeneration: 1,
			projectId: 'example',
			workId: 'ISSUE-0',
			graphFingerprint: projectGraph.fingerprint,
			repositoryId: candidate.repositoryId,
			headSha: candidate.headSha,
			treeSha: candidate.treeSha,
			issuer: { kind: 'self' as const, id: 'work-contract:evidence' },
			reference: 'work-contract:evidence',
			digest: digest('validation'),
			observedAt: timestamp,
		}

		const submitted = await provider.recordSubmission({
			workId: 'ISSUE-0',
			actor: 'agent-a',
			candidate,
			gates: [gate],
			expectedDefinition: expectedDefinition(projectGraph, 'ISSUE-0'),
			expectedDefinitionClosure: [
				{ workId: 'ISSUE-0', ...expectedDefinition(projectGraph, 'ISSUE-0') },
			],
		})
		const observedAfterSubmission = submitted.ok ? undefined : await provider.list()
		expect(submitted, JSON.stringify({ submitted, observedAfterSubmission })).toMatchObject({
			ok: true,
			value: { candidate: { generation: 1 }, gates: [{ gate: 'validation' }] },
		})

		const recreated = createBeadsProvider({ root, projectId: 'example' })
		const listed = await recreated.list()
		expect(listed.ok).toBe(true)
		if (listed.ok) {
			expect(listed.value.find(({ workId }) => workId === 'ISSUE-0')).toMatchObject({
				candidate: { headSha: candidate.headSha },
				gates: [{ gate: 'validation' }],
			})
		}
	})

	it('adopts an exact legacy record without losing completion attribution or evidence', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
			actor: 'work-contract-migration',
		})
		await expect(provider.initialize({ prefix: 'ISSUE' })).resolves.toMatchObject({ ok: true })
		await mkdir(join(root, 'docs'), { recursive: true })
		await writeFile(join(root, 'docs', 'proof.md'), 'verified legacy evidence\n')
		await execFileAsync(binary, [
			'create',
			'--id',
			'ISSUE-1',
			'--force',
			'--title',
			'Legacy issue',
			'--type',
			'task',
			'--external-ref',
			'docs/ISSUE-1.md',
			'--metadata',
			JSON.stringify({
				symphony: {
					initiative: 'INIT-1',
					prd: 'PRD-1',
					revision: digest('legacy-source'),
					source: 'docs/ISSUE-1.md',
				},
			}),
			'--actor',
			'legacy-agent',
			'--json',
			'--directory',
			root,
		])
		await execFileAsync(binary, [
			'update',
			'ISSUE-1',
			'--claim',
			'--actor',
			'legacy-agent',
			'--json',
			'--directory',
			root,
		])
		await execFileAsync(binary, [
			'close',
			'ISSUE-1',
			'--reason',
			'symphony:disposition:v1 {"evidence":["docs/proof.md"],"state":"completed"}',
			'--actor',
			'legacy-agent',
			'--json',
			'--directory',
			root,
		])

		const migratedArtifact = artifact({
			id: 'ISSUE-1',
			kind: 'issue',
			title: 'Current issue',
			evidenceRequirements: ['artifact'],
		})
		const adopted = await provider.adoptLegacyDefinitions([
			{
				projectId: 'example',
				graphFingerprint: digest('current-graph'),
				artifact: migratedArtifact,
			},
		])

		expect(adopted).toMatchObject({
			ok: true,
			value: {
				adopted: 1,
				items: [
					{
						providerId: 'ISSUE-1',
						workId: 'ISSUE-1',
						status: 'closed',
						assignee: 'legacy-agent',
						activity: { actor: 'legacy-agent' },
						evidence: [
							{
								kind: 'artifact',
								reference: 'docs/proof.md',
								actor: 'legacy-agent',
							},
						],
					},
				],
			},
		})
		await expect(provider.list()).resolves.toMatchObject({
			ok: true,
			value: [{ providerId: 'ISSUE-1', workId: 'ISSUE-1', status: 'closed' }],
		})
		await expect(
			provider.adoptLegacyDefinitions([
				{
					projectId: 'example',
					graphFingerprint: digest('current-graph'),
					artifact: migratedArtifact,
				},
			]),
		).resolves.toMatchObject({ ok: true, value: { adopted: 0, skipped: 1 } })
	})

	it.each([
		{ mismatch: 'source', source: 'docs/other.md', prd: 'PRD-1' },
		{ mismatch: 'PRD', source: 'docs/ISSUE-1.md', prd: 'PRD-OTHER' },
	] as const)(
		'rejects mismatched legacy $mismatch ownership before mutating the record',
		async ({ source, prd }) => {
			const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
			const provider = createBeadsProvider({
				root,
				projectId: 'example',
				binary,
				actor: 'work-contract-migration',
			})
			await expect(provider.initialize({ prefix: 'ISSUE' })).resolves.toMatchObject({ ok: true })
			await execFileAsync(binary, [
				'create',
				'--id',
				'ISSUE-1',
				'--force',
				'--title',
				'Legacy ISSUE-1',
				'--type',
				'task',
				'--external-ref',
				source,
				'--metadata',
				JSON.stringify({
					symphony: {
						initiative: 'INIT-1',
						prd,
						revision: digest('legacy-ISSUE-1'),
						source,
					},
				}),
				'--actor',
				'legacy-agent',
				'--json',
				'--directory',
				root,
			])

			const adopted = await provider.adoptLegacyDefinitions([
				{
					projectId: 'example',
					graphFingerprint: digest('current-graph'),
					artifact: artifact({
						id: 'ISSUE-1',
						kind: 'issue',
						title: 'Current ISSUE-1',
						parentId: 'PRD-1',
						source: {
							path: 'docs/ISSUE-1.md',
							hash: digest('source-ISSUE-1'),
						},
					}),
				},
			])

			expect(adopted).toMatchObject({
				ok: false,
				error: { code: 'invalid_ledger_projection' },
			})
			await expect(provider.list()).resolves.toStrictEqual({ ok: true, value: [] })
		},
	)

	it('cold-syncs a primed five-item projection with one create subprocess per item', async () => {
		const commandLog = join(root, 'bd-commands.log')
		const realBinary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const countingBinary = join(root, 'counting-bd.mjs')
		await writeFile(
			countingBinary,
			`#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
appendFileSync(${JSON.stringify(commandLog)}, process.argv[2] + '\\n')
const result = spawnSync(${JSON.stringify(realBinary)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
		)
		await chmod(countingBinary, 0o755)
		const provider = createBeadsProvider({
			root,
			projectId: 'cold-sync',
			binary: countingBinary,
			actor: 'work-contract-test',
		})
		const initialized = await provider.initialize({ prefix: 'wc' })
		if (!initialized.ok) {
			throw new Error(initialized.error.message)
		}
		await writeFile(commandLog, '')
		const coldGraph: CompiledWorkGraph = {
			schemaVersion: 1,
			projectId: 'cold-sync',
			fingerprint: digest('cold-sync-graph'),
			items: Array.from({ length: 5 }, (_, index) =>
				artifact({
					id: `ISSUE-${index + 1}`,
					kind: 'issue',
					title: `Issue ${index + 1}`,
				}),
			),
		}
		const initial = await provider.list()
		if (!initial.ok) {
			throw new Error(initial.error.message)
		}
		const plan = planSync({ graph: coldGraph, ledgerItems: initial.value })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}

		const applied = await applySyncPlan({
			graph: coldGraph,
			plan: plan.value,
			provider,
		})
		if (!applied.ok) {
			throw new Error(applied.error.message)
		}
		const final = await provider.list()

		expect(final.ok).toBe(true)
		if (!final.ok) {
			return
		}
		expect(final.value.map(({ workId }) => workId)).toStrictEqual([
			'ISSUE-1',
			'ISSUE-2',
			'ISSUE-3',
			'ISSUE-4',
			'ISSUE-5',
		])
		const commandLogContents = await readFile(commandLog, 'utf8')
		const commands = commandLogContents.trim().split('\n')
		expect(commands).toStrictEqual([
			'list',
			'list',
			'show',
			'create',
			'create',
			'create',
			'create',
			'create',
			'list',
		])
	}, 60_000)

	it('persists claims, session handoffs, block state, and evidence receipts across provider instances', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
			actor: 'work-contract-test',
		})
		const initialized = await provider.initialize({ prefix: 'wc' })
		if (!initialized.ok) {
			throw new Error(initialized.error.message)
		}
		const initialPlan = planSync({ graph: graph(), ledgerItems: [] })
		if (!initialPlan.ok) {
			throw new Error(initialPlan.error.message)
		}
		const applied = await applySyncPlan({
			graph: graph(),
			plan: initialPlan.value,
			provider,
		})
		if (!applied.ok) {
			throw new Error(applied.error.message)
		}

		let now = new Date('2026-09-01T01:00:00.000Z')
		const service = createWorkContractService({
			root,
			graph: graph(),
			provider,
			clock: () => now,
		})
		const designClaim = await service.claim({
			workId: 'ISSUE-0',
			actor: 'planner',
			session: 'codex:plan',
		})
		expect(designClaim.ok).toBe(true)
		const designComplete = await service.complete({
			workId: 'ISSUE-0',
			actor: 'planner',
			evidence: [],
		})
		expect(designComplete.ok).toBe(true)

		const implementClaim = await service.claim({
			workId: 'ISSUE-1',
			actor: 'implementer-a',
			role: 'implementer',
			session: 'codex:one',
		})
		expect(implementClaim.ok).toBe(true)
		const blocked = await service.block({
			workId: 'ISSUE-1',
			actor: 'implementer-a',
			role: 'implementer',
			session: 'codex:one',
			reason: 'Need the provider fixture.',
		})
		expect(blocked.ok).toBe(true)
		const reopened = await service.reopen({
			workId: 'ISSUE-1',
			actor: 'implementer-a',
			role: 'implementer',
			session: 'codex:one',
			reason: 'Fixture is available.',
		})
		expect(reopened.ok).toBe(true)
		const reclaimed = await service.claim({
			workId: 'ISSUE-1',
			actor: 'implementer-a',
			role: 'implementer',
			session: 'codex:one',
		})
		expect(reclaimed.ok).toBe(true)
		const handoff = await service.handoff({
			workId: 'ISSUE-1',
			actor: 'implementer-a',
			role: 'implementer',
			session: 'codex:one',
			summary: 'Core implementation is ready.\n\tVerification remains.',
			remaining: ['Run integration verification'],
			references: ['src/beads.ts'],
			release: true,
		})
		expect(handoff.ok).toBe(true)

		now = new Date('2026-09-01T02:00:00.000Z')
		const resumed = await service.claim({
			workId: 'ISSUE-1',
			actor: 'implementer-b',
			role: 'implementer',
			session: 'claude:two',
		})
		expect(resumed.ok).toBe(true)
		await mkdir(join(root, 'evidence'), { recursive: true })
		await writeFile(join(root, 'evidence', 'integration.json'), '{"passed":true}\n')
		const completed = await service.complete({
			workId: 'ISSUE-1',
			actor: 'implementer-b',
			role: 'implementer',
			session: 'claude:two',
			evidence: [{ kind: 'test', reference: 'evidence/integration.json' }],
		})
		expect(completed.ok).toBe(true)

		const freshProvider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
			actor: 'observer',
		})
		const persisted = await freshProvider.list()
		if (!persisted.ok) {
			throw new Error(persisted.error.message)
		}
		expect(persisted.value.find(({ workId }) => workId === 'ISSUE-1')).toMatchObject({
			status: 'closed',
			assignee: 'implementer-b',
			handoff: {
				summary: 'Core implementation is ready.\n\tVerification remains.',
			},
			evidence: [{ kind: 'test', reference: 'evidence/integration.json' }],
			activity: {
				actor: 'implementer-b',
				role: 'implementer',
				session: 'claude:two',
			},
		})
	})

	it('isolates identical work IDs by project before lifecycle mutation', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const graphA = {
			...graph(),
			projectId: 'project-a',
			fingerprint: digest('project-a-1'),
		}
		const graphB = {
			...graph(),
			projectId: 'project-b',
			fingerprint: digest('project-b-1'),
		}
		const providerA = createBeadsProvider({
			root,
			projectId: 'project-a',
			binary,
			actor: 'agent-a',
		})
		const providerB = createBeadsProvider({
			root,
			projectId: 'project-b',
			binary,
			actor: 'agent-b',
		})
		const initialized = await providerA.initialize({ prefix: 'wc' })
		if (!initialized.ok) {
			throw new Error(initialized.error.message)
		}
		for (const [projectGraph, provider] of [
			[graphA, providerA],
			[graphB, providerB],
		] as const) {
			const plan = planSync({ graph: projectGraph, ledgerItems: [] })
			if (!plan.ok) {
				throw new Error(plan.error.message)
			}
			const applied = await applySyncPlan({
				graph: projectGraph,
				plan: plan.value,
				provider,
			})
			if (!applied.ok) {
				throw new Error(
					`${applied.error.code}: ${applied.error.message} ${JSON.stringify(applied.error.details)}`,
				)
			}
		}

		const serviceA = createWorkContractService({
			root,
			graph: graphA,
			provider: providerA,
		})
		await expect(
			serviceA.claim({
				workId: 'ISSUE-0',
				actor: 'agent-a',
				session: 'codex:a',
			}),
		).resolves.toMatchObject({ ok: true })
		const [itemsA, itemsB] = await Promise.all([providerA.list(), providerB.list()])
		if (!itemsA.ok || !itemsB.ok) {
			throw new Error('project listing failed')
		}
		expect(itemsA.value.find(({ workId }) => workId === 'ISSUE-0')?.status).toBe('in_progress')
		expect(itemsB.value.find(({ workId }) => workId === 'ISSUE-0')?.status).toBe('open')
	})

	it('queues simultaneous independent claims and completions without losing either stream', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const projectGraph = parallelGraph()
		await execFileInRoot('git', ['init', '-b', 'feature'])
		await execFileInRoot('git', ['config', 'user.name', 'Work Contract'])
		await execFileInRoot('git', ['config', 'user.email', 'work@example.test'])
		await mkdir(join(root, 'evidence'), { recursive: true })
		await Promise.all([
			writeFile(join(root, 'evidence/first.txt'), 'first passed\n'),
			writeFile(join(root, 'evidence/second.txt'), 'second passed\n'),
		])
		const setupProvider = createBeadsProvider({
			root,
			projectId: projectGraph.projectId,
			binary,
			actor: 'setup',
		})
		const initialized = await setupProvider.initialize({ prefix: 'wc' })
		if (!initialized.ok) {
			throw new Error(initialized.error.message)
		}
		const plan = planSync({ graph: projectGraph, ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const synchronized = await applySyncPlan({
			graph: projectGraph,
			plan: plan.value,
			provider: setupProvider,
		})
		if (!synchronized.ok) {
			throw new Error(synchronized.error.message)
		}
		await execFileInRoot('git', ['add', '.'])
		await execFileInRoot('git', ['commit', '-m', 'parallel candidate'])

		const firstProvider = createBeadsProvider({
			root,
			projectId: projectGraph.projectId,
			binary,
			actor: 'agent-one',
		})
		const secondProvider = createBeadsProvider({
			root,
			projectId: projectGraph.projectId,
			binary,
			actor: 'agent-two',
		})
		const first = createWorkContractService({
			root,
			graph: projectGraph,
			provider: firstProvider,
			deliveryPolicy: localDeliveryPolicy,
		})
		const second = createWorkContractService({
			root,
			graph: projectGraph,
			provider: secondProvider,
			deliveryPolicy: localDeliveryPolicy,
		})
		const sameItemRace = await Promise.all([
			first.claim({
				workId: 'ISSUE-1',
				actor: 'agent-one',
				role: 'implementer',
				session: 'codex:race',
			}),
			second.claim({
				workId: 'ISSUE-1',
				actor: 'agent-two',
				role: 'implementer',
				session: 'claude:race',
			}),
		])
		expect(sameItemRace.filter(({ ok }) => ok)).toHaveLength(1)
		expect(sameItemRace.find(({ ok }) => !ok)).toMatchObject({
			ok: false,
			error: { code: 'ownership_conflict' },
		})
		const firstWon = sameItemRace[0]?.ok
		const released = await (firstWon ? first : second).release({
			workId: 'ISSUE-1',
			actor: firstWon ? 'agent-one' : 'agent-two',
			role: 'implementer',
			session: firstWon ? 'codex:race' : 'claude:race',
			reason: 'same-item race assertion complete',
		})
		expect(released).toMatchObject({ ok: true })

		const [firstClaim, secondClaim] = await Promise.all([
			first.claim({
				workId: 'ISSUE-1',
				actor: 'agent-one',
				role: 'implementer',
				session: 'codex:first',
			}),
			second.claim({
				workId: 'ISSUE-2',
				actor: 'agent-two',
				role: 'implementer',
				session: 'claude:second',
			}),
		])
		expect(firstClaim).toMatchObject({ ok: true })
		expect(secondClaim).toMatchObject({ ok: true })

		const active = await createWorkContractService({
			root,
			graph: projectGraph,
			provider: createBeadsProvider({
				root,
				projectId: projectGraph.projectId,
				binary,
				actor: 'observer',
			}),
		}).active()
		if (!active.ok) {
			throw new Error(active.error.message)
		}
		expect(active.value.map(({ id }) => id).toSorted()).toStrictEqual(['ISSUE-1', 'ISSUE-2'])
		const [firstSubmission, secondSubmission] = await Promise.all([
			first.submit({
				workId: 'ISSUE-1',
				actor: 'agent-one',
				role: 'implementer',
				session: 'codex:first',
				evidence: [{ kind: 'test', reference: 'evidence/first.txt' }],
			}),
			second.submit({
				workId: 'ISSUE-2',
				actor: 'agent-two',
				role: 'implementer',
				session: 'claude:second',
				evidence: [{ kind: 'test', reference: 'evidence/second.txt' }],
			}),
		])
		expect(firstSubmission, JSON.stringify(firstSubmission)).toMatchObject({
			ok: true,
			value: { candidate: { generation: 1 } },
		})
		expect(secondSubmission, JSON.stringify(secondSubmission)).toMatchObject({
			ok: true,
			value: { candidate: { generation: 1 } },
		})
		await execFileInRoot('git', ['branch', 'main', 'HEAD'])
		const [firstComplete, secondComplete] = await Promise.all([
			first.complete({
				workId: 'ISSUE-1',
				actor: 'agent-one',
				role: 'implementer',
				session: 'codex:first',
				evidence: [],
			}),
			second.complete({
				workId: 'ISSUE-2',
				actor: 'agent-two',
				role: 'implementer',
				session: 'claude:second',
				evidence: [],
			}),
		])
		expect(firstComplete, JSON.stringify(firstComplete)).toMatchObject({ ok: true })
		expect(secondComplete, JSON.stringify(secondComplete)).toMatchObject({ ok: true })

		const observerProvider = createBeadsProvider({
			root,
			projectId: projectGraph.projectId,
			binary,
			actor: 'observer',
		})
		const persisted = await observerProvider.list()
		if (!persisted.ok) {
			throw new Error(persisted.error.message)
		}
		expect(persisted.value.find(({ workId }) => workId === 'ISSUE-1')).toMatchObject({
			status: 'closed',
			activity: {
				actor: 'agent-one',
				role: 'implementer',
				session: 'codex:first',
			},
			evidence: [{ kind: 'test', reference: 'evidence/first.txt' }],
		})
		expect(persisted.value.find(({ workId }) => workId === 'ISSUE-2')).toMatchObject({
			status: 'closed',
			activity: {
				actor: 'agent-two',
				role: 'implementer',
				session: 'claude:second',
			},
			evidence: [{ kind: 'test', reference: 'evidence/second.txt' }],
		})
		const publications = await Promise.all([
			firstProvider.publishRecoveryProjection(),
			secondProvider.publishRecoveryProjection(),
		])
		expect(publications).toMatchObject([
			{ ok: true, value: { path: '.beads/export-state/issues.jsonl', records: 3 } },
			{ ok: true, value: { path: '.beads/export-state/issues.jsonl', records: 3 } },
		])
		const recoverySource = await readFile(join(root, '.beads/export-state/issues.jsonl'), 'utf8')
		const recoveryProjection = parseJsonLines(recoverySource)
		const completedStreams = projectRecoveryStates(recoveryProjection)
			.filter(({ workId }) => workId === 'ISSUE-1' || workId === 'ISSUE-2')
			.toSorted((left, right) => (left.workId ?? '').localeCompare(right.workId ?? ''))
		expect(completedStreams).toStrictEqual([
			{ status: 'closed', workId: 'ISSUE-1' },
			{ status: 'closed', workId: 'ISSUE-2' },
		])
		const rollup = await createWorkContractService({
			root,
			graph: projectGraph,
			provider: observerProvider,
		}).rollup('PRD-1')
		expect(rollup).toMatchObject({
			ok: true,
			value: { total: 2, completed: 2, active: 0, status: 'completed' },
		})
	})

	it('bounds provider lock contention without deleting an unknown owner lock', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
			actor: 'work-contract-test',
		})
		const initialized = await provider.initialize({ prefix: 'wc' })
		if (!initialized.ok) {
			throw new Error(initialized.error.message)
		}
		const plan = planSync({ graph: graph(), ledgerItems: [] })
		if (!plan.ok) {
			throw new Error(plan.error.message)
		}
		const synchronized = await applySyncPlan({
			graph: graph(),
			plan: plan.value,
			provider,
		})
		if (!synchronized.ok) {
			throw new Error(synchronized.error.message)
		}
		const lockPath = join(root, '.work', `beads-${digest('example').slice(0, 16)}.lock`)
		await writeFile(lockPath, 'unknown-owner\n')

		const startedAt = performance.now()
		const blocked = await provider.claim({
			workId: 'ISSUE-0',
			actor: 'agent-one',
			session: 'codex:blocked',
			timestamp: '2026-09-02T00:00:00.000Z',
			expectedDefinition: expectedDefinition(graph(), 'ISSUE-0'),
			expectedDefinitionClosure: [{ workId: 'ISSUE-0', ...expectedDefinition(graph(), 'ISSUE-0') }],
			expectedDependencies: [],
		})
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(9000)
		expect(blocked).toMatchObject({
			ok: false,
			error: { code: 'provider_busy' },
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe('unknown-owner\n')

		await rm(lockPath)
		await expect(
			provider.claim({
				workId: 'ISSUE-0',
				actor: 'agent-one',
				session: 'codex:recovered',
				timestamp: '2026-09-02T00:01:00.000Z',
				expectedDefinition: expectedDefinition(graph(), 'ISSUE-0'),
				expectedDefinitionClosure: [
					{ workId: 'ISSUE-0', ...expectedDefinition(graph(), 'ISSUE-0') },
				],
				expectedDependencies: [],
			}),
		).resolves.toMatchObject({ ok: true })
	}, 30_000)

	it('preserves a replacement lock generation when the prior owner becomes stale', async () => {
		await mkdir(join(root, '.work'), { recursive: true })
		const openRecord = lockRecord('wc-1', 'ISSUE-1')
		const claimed = {
			...openRecord,
			status: 'in_progress',
			assignee: 'agent-a',
		}
		const active = {
			...claimed,
			metadata: {
				work_contract: {
					...openRecord.metadata.work_contract,
					activity: {
						actor: 'agent-a',
						started_at: '2026-09-01T00:00:00.000Z',
						touched_at: '2026-09-01T00:00:00.000Z',
					},
					evidence: [],
				},
			},
		}
		const binary = await writeFakeBinary(`
const args = process.argv.slice(2)
if (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify([openRecord]))})
else if (args[0] === 'update' && args.includes('--metadata')) console.log(${JSON.stringify(JSON.stringify(active))})
else if (args[0] === 'update') console.log(${JSON.stringify(JSON.stringify(claimed))})
else process.exit(9)
`)
		const lockPath = providerLockPath('example', 'ISSUE-1')
		await writeFile(
			lockPath,
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: 'live-generation' })}\n`,
		)
		const replacement = `${JSON.stringify({
			pid: 2_147_483_647,
			startedAt: '2026-09-01T00:00:00.000Z',
			nonce: 'replacement-generation',
		})}\n`
		const replacer = join(root, 'replace-lock.mjs')
		await writeFile(
			replacer,
			`import { rename, writeFile } from 'node:fs/promises'
await new Promise((resolve) => setTimeout(resolve, 200))
const temporary = ${JSON.stringify(`${lockPath}.replacement`)}
await writeFile(temporary, ${JSON.stringify(replacement)})
await rename(temporary, ${JSON.stringify(lockPath)})
`,
		)
		const provider = createBeadsProvider({
			root,
			projectId: 'example',
			binary,
		})

		const replacementProcess = execFileAsync('bun', [replacer])
		const result = await provider.claim({
			workId: 'ISSUE-1',
			actor: 'agent-a',
			timestamp: '2026-09-01T00:00:00.000Z',
			expectedDefinition: expectedDefinition(graph(), 'ISSUE-1'),
			expectedDefinitionClosure: [
				{ workId: 'ISSUE-0', ...expectedDefinition(graph(), 'ISSUE-0') },
				{ workId: 'ISSUE-1', ...expectedDefinition(graph(), 'ISSUE-1') },
			],
			expectedDependencies: [{ workId: 'ISSUE-0', ...expectedDefinition(graph(), 'ISSUE-0') }],
		})
		await replacementProcess

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'provider_busy',
				message: 'A stale provider mutation lock requires manual recovery.',
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('operates the legacy public CLI loop against a disposable real Beads repository', async () => {
		const binary = resolve(import.meta.dirname, '../node_modules/.bin/bd')
		const output: string[] = []
		const errors: string[] = []
		const run = async (...args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--bd', binary, '--json', ...args], {
				stdout: (value) => {
					output.push(value)
				},
				stderr: (value) => {
					errors.push(value)
				},
			})

		await expect(run('init', '--project', 'cli-example')).resolves.toBe(0)
		const generatedManifest = await readFile(join(root, 'work.yaml'), 'utf8')
		await writeFile(
			join(root, 'work.yaml'),
			generatedManifest.replace('completionLedger: true\n', ''),
		)
		await writeFile(
			join(root, '.work', 'items', 'ISSUE-1.md'),
			`---\nid: ISSUE-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 CLI journey\n`,
		)
		await expect(run('sync', '--apply')).resolves.toBe(0)
		await expect(run('telemetry', 'enable')).resolves.toBe(0)
		const synchronizedSource = await readFile(
			join(root, '.beads/export-state/issues.jsonl'),
			'utf8',
		)
		const synchronizedProjection = parseJsonLines(synchronizedSource)
		expect(synchronizedProjection).toHaveLength(1)
		expect(synchronizedProjection[0]).toMatchObject({
			metadata: { work_contract: { project_id: 'cli-example', work_id: 'ISSUE-1' } },
		})
		await expect(
			run('claim', 'ISSUE-1', '--actor', 'agent-a', '--role', 'coder', '--session', 'codex:1'),
		).resolves.toBe(0)
		await expect(run('context', 'ISSUE-1', '--max-bytes', '1000')).resolves.toBe(0)
		await mkdir(join(root, 'evidence'), { recursive: true })
		await writeFile(join(root, 'evidence', 'test.txt'), 'passed\n')
		await expect(
			run(
				'complete',
				'ISSUE-1',
				'--actor',
				'agent-a',
				'--role',
				'coder',
				'--session',
				'codex:1',
				'--evidence',
				'test=evidence/test.txt',
			),
		).resolves.toBe(0)
		const completedSource = await readFile(join(root, '.beads/export-state/issues.jsonl'), 'utf8')
		const completedProjection = parseJsonLines(completedSource)
		expect(completedProjection).toMatchObject([{ status: 'closed' }])
		const telemetry = parseJsonLines(
			await readFile(join(root, '.work/telemetry/events.jsonl'), 'utf8'),
		)
		const claimEvent = telemetry.find((event) => isRecord(event) && event.command === 'claim')
		if (!isRecord(claimEvent) || !Array.isArray(claimEvent.phases)) {
			throw new TypeError('Expected claim phase telemetry.')
		}
		const claimPhases: readonly unknown[] = claimEvent.phases
		const expectedClaimCounts = {
			definition_compile: 1,
			provider_read: 4,
			provider_mutation: 2,
			recovery_publication: 1,
		} as const
		for (const [phaseName, expectedCount] of Object.entries(expectedClaimCounts)) {
			const phase: unknown = claimPhases.find(
				(candidate) => isRecord(candidate) && candidate.phase === phaseName,
			)
			if (!isRecord(phase)) {
				throw new TypeError(`Expected ${phaseName} telemetry.`)
			}
			expect(phase.count).toBe(expectedCount)
			expect(phase.durationMs).toBeTypeOf('number')
		}
		expect(claimEvent.unattributedMs).toBeTypeOf('number')
		await expect(run('snapshot')).resolves.toBe(0)
		expect(errors).toStrictEqual([])
		expect(output.some((entry) => entry.includes('Work context: ISSUE-1'))).toBe(true)
		await expect(exists(join(root, '.work', 'lock.json'))).resolves.toBe(true)
		await expect(exists(join(root, '.work', 'snapshots', 'current.json'))).resolves.toBe(true)
	})

	// oxlint-disable-next-line eslint/max-statements -- One real four-checkout lifecycle keeps authority, submission, synchronization, reconciliation, and cleanup evidence together.
	it('shares provider state across linked worktrees without dirtying any checkout', async () => {
		const binary = resolveDefaultBeadsBinary()
		const firstWorktree = `${root}-first`
		const secondWorktree = `${root}-second`
		const definitionWorktree = `${root}-definition`
		const invoke = async (workspace: string, ...args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(
				['--root', workspace, '--bd', binary, '--json', ...args],
				{
					stdout: (value): void => void stdout.push(value),
					stderr: (value): void => void stderr.push(value),
				},
			)
			return { status, stdout, stderr }
		}
		try {
			await execFileAsync('git', ['-C', root, 'init', '-b', 'main'])
			await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Work Contract'])
			await execFileAsync('git', ['-C', root, 'config', 'user.email', 'work@example.test'])
			const initialized = await invoke(root, 'init', '--project', 'shared-example')
			expect(initialized.status).toBe(0)
			const manifestPath = join(root, 'work.yaml')
			const manifest = await readFile(manifestPath, 'utf8')
			await writeFile(
				manifestPath,
				manifest
					.replace(
						'    profile: evidence-only\n',
						'    profile: local-direct\n    targetRef: refs/heads/main\n',
					)
					.replace('completionLedger: true\n', ''),
			)
			await writeFile(
				join(root, '.work/items/ISSUE-1.md'),
				'---\nid: ISSUE-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 First independent stream\n',
			)
			await writeFile(
				join(root, '.work/items/ISSUE-2.md'),
				'---\nid: ISSUE-2\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-2 Second independent stream\n',
			)
			await mkdir(join(root, 'evidence'))
			await writeFile(join(root, 'evidence/test.txt'), 'passed\n')
			await writeFile(join(root, '.gitignore'), '.beads/\n.work/lock.json\n.work/telemetry/\n')
			await execFileAsync('git', [
				'-C',
				root,
				'add',
				'.gitignore',
				'work.yaml',
				'.work',
				'evidence',
			])
			await execFileAsync('git', ['-C', root, 'commit', '-m', 'fixture'])
			const synchronized = await invoke(root, 'sync', '--apply')
			expect(synchronized).toMatchObject({ status: 0, stderr: [] })
			await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'first', firstWorktree])
			await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', 'second', secondWorktree])
			await execFileAsync('git', [
				'-C',
				root,
				'worktree',
				'add',
				'-b',
				'definition',
				definitionWorktree,
			])

			const health = await Promise.all(
				[root, firstWorktree, secondWorktree, definitionWorktree].map(async (workspace) =>
					invoke(workspace, 'doctor'),
				),
			)
			const identities = health.map(({ stdout }) => providerStateIdentity(stdout[0] ?? '{}'))
			expect(new Set(identities).size).toBe(1)
			const definitionPath = join(definitionWorktree, '.work/items/ISSUE-1.md')
			const canonicalDefinition = await readFile(definitionPath, 'utf8')
			await writeFile(
				definitionPath,
				canonicalDefinition.replace('First independent stream', 'Feature-only definition'),
			)
			const featureSync = await invoke(definitionWorktree, 'sync', '--apply')
			expect(featureSync).toMatchObject({ status: 0, stderr: [] })
			const canonicalAfterFeatureSync = await invoke(root, 'show', 'ISSUE-1')
			expect(canonicalAfterFeatureSync.stdout[0]).toContain('First independent stream')
			expect(canonicalAfterFeatureSync.stdout[0]).not.toContain('Feature-only definition')
			await writeFile(definitionPath, canonicalDefinition)

			const claims = await Promise.all([
				invoke(firstWorktree, 'claim', 'ISSUE-1', '--actor', 'agent-a', '--role', 'coder'),
				invoke(secondWorktree, 'claim', 'ISSUE-2', '--actor', 'agent-b', '--role', 'coder'),
			])
			expect(claims.map(({ status }) => status)).toStrictEqual([0, 0])
			const submissions = await Promise.all([
				invoke(
					firstWorktree,
					'submit',
					'ISSUE-1',
					'--actor',
					'agent-a',
					'--role',
					'coder',
					'--evidence',
					'test=evidence/test.txt',
				),
				invoke(
					secondWorktree,
					'submit',
					'ISSUE-2',
					'--actor',
					'agent-b',
					'--role',
					'coder',
					'--evidence',
					'test=evidence/test.txt',
				),
			])
			expect(submissions.map(({ status }) => status)).toStrictEqual([0, 0])
			await writeFile(join(root, 'canonical-advance.txt'), 'unrelated canonical advance\n')
			await execFileAsync('git', ['-C', root, 'add', 'canonical-advance.txt'])
			await execFileAsync('git', ['-C', root, 'commit', '-m', 'advance canonical target'])
			const resynchronized = await invoke(root, 'sync', '--apply')
			expect(resynchronized).toMatchObject({ status: 0, stderr: [] })
			const completions = await Promise.all([
				invoke(firstWorktree, 'reconcile', 'ISSUE-1', '--actor', 'agent-a', '--role', 'coder'),
				invoke(secondWorktree, 'reconcile', 'ISSUE-2', '--actor', 'agent-b', '--role', 'coder'),
			])
			expect(completions.map(({ status }) => status)).toStrictEqual([0, 0])
			const repeated = await invoke(firstWorktree, 'reconcile', 'ISSUE-1', '--actor', 'agent-a')
			expect(repeated).toMatchObject({ status: 0, stderr: [] })
			expect(repeated.stdout[0]).toContain('"previousStatus":"closed"')
			expect(cliReceiptTimestamp(repeated.stdout[0] ?? '{}')).toBe(
				cliReceiptTimestamp(completions[0]?.stdout[0] ?? '{}'),
			)

			const statuses = await Promise.all(
				[root, firstWorktree, secondWorktree, definitionWorktree].map(async (workspace) => {
					const output = await new Promise<string>((fulfill, reject) => {
						execFile('git', ['status', '--porcelain'], { cwd: workspace }, (error, stdout) => {
							if (error === null) {
								fulfill(stdout)
							} else {
								reject(
									error instanceof Error ? error : new Error('Git status failed without an error.'),
								)
							}
						})
					})
					return output
				}),
			)
			expect(statuses).toStrictEqual(['', '', '', ''])
			const loadedManifest = await loadWorkManifest({ root })
			expect(loadedManifest.ok).toBe(true)
			if (!loadedManifest.ok) {
				throw new Error(loadedManifest.error.message)
			}
			const coordination = await resolveWorkCoordinationLocation({
				root,
				stateHome,
				...(loadedManifest.value.projectUid === undefined
					? {}
					: { projectUid: loadedManifest.value.projectUid }),
			})
			expect(coordination.ok).toBe(true)
			if (!coordination.ok) {
				throw new Error(coordination.error.message)
			}
			await expect(
				readFile(join(coordination.value.root, '.beads/export-state/issues.jsonl'), 'utf8'),
			).resolves.toContain('"work_id":"ISSUE-1"')
			await expect(access(join(root, '.beads'))).rejects.toThrow('ENOENT')
		} finally {
			await execFileAsync('git', [
				'-C',
				root,
				'worktree',
				'remove',
				'--force',
				firstWorktree,
			]).catch(() => {})
			await execFileAsync('git', [
				'-C',
				root,
				'worktree',
				'remove',
				'--force',
				secondWorktree,
			]).catch(() => {})
			await execFileAsync('git', [
				'-C',
				root,
				'worktree',
				'remove',
				'--force',
				definitionWorktree,
			]).catch(() => {})
			await rm(firstWorktree, { force: true, recursive: true })
			await rm(secondWorktree, { force: true, recursive: true })
			await rm(definitionWorktree, { force: true, recursive: true })
		}
	}, 30_000)

	it('meets five-run steady-state latency gates for ready, claim, and complete', async () => {
		const binary = resolveDefaultBeadsBinary()
		const run = async (...args: readonly string[]) => {
			const errors: string[] = []
			const startedAt = performance.now()
			const status = await runWorkContractCli(['--root', root, '--bd', binary, '--json', ...args], {
				stdout: (): void => undefined,
				stderr: (value): void => void errors.push(value),
			})
			return { status, durationMs: performance.now() - startedAt, errors }
		}
		const expectSuccess = (result: Awaited<ReturnType<typeof run>>): void => {
			expect(result.status, result.errors.join('\n')).toBe(0)
		}
		const median = (values: readonly number[]): number =>
			values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Infinity
		const p95 = (values: readonly number[]): number =>
			values.toSorted((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1] ??
			Infinity

		expectSuccess(await run('init', '--project', 'latency'))
		const generatedManifest = await readFile(join(root, 'work.yaml'), 'utf8')
		await writeFile(
			join(root, 'work.yaml'),
			generatedManifest.replace('completionLedger: true\n', ''),
		)
		await writeFile(
			join(root, '.work/items/ISSUE-1.md'),
			'---\nid: ISSUE-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 Latency fixture\n',
		)
		expectSuccess(await run('sync', '--apply'))
		await mkdir(join(root, 'evidence'), { recursive: true })
		await writeFile(join(root, 'evidence/test.txt'), 'passed\n')

		const readyDurations: number[] = []
		for (let index = 0; index < 5; index += 1) {
			const result = await run('ready')
			expectSuccess(result)
			readyDurations.push(result.durationMs)
		}

		const claimDurations: number[] = []
		for (let index = 0; index < 5; index += 1) {
			const session = `claim-${index}`
			const result = await run(
				'claim',
				'ISSUE-1',
				'--actor',
				'agent-a',
				'--role',
				'coder',
				'--session',
				session,
			)
			expectSuccess(result)
			claimDurations.push(result.durationMs)
			expectSuccess(
				await run(
					'release',
					'ISSUE-1',
					'--actor',
					'agent-a',
					'--role',
					'coder',
					'--session',
					session,
					'--reason',
					'latency cycle',
				),
			)
		}

		const completionDurations: number[] = []
		for (let index = 0; index < 5; index += 1) {
			const session = `complete-${index}`
			expectSuccess(
				await run(
					'claim',
					'ISSUE-1',
					'--actor',
					'agent-a',
					'--role',
					'coder',
					'--session',
					session,
				),
			)
			const result = await run(
				'complete',
				'ISSUE-1',
				'--actor',
				'agent-a',
				'--role',
				'coder',
				'--session',
				session,
				'--evidence',
				'test=evidence/test.txt',
			)
			expectSuccess(result)
			completionDurations.push(result.durationMs)
			if (index < 4) {
				expectSuccess(
					await run(
						'reopen',
						'ISSUE-1',
						'--actor',
						'agent-a',
						'--role',
						'coder',
						'--session',
						session,
						'--reason',
						'latency cycle',
					),
				)
			}
		}

		expect(median(readyDurations), JSON.stringify(readyDurations)).toBeLessThanOrEqual(5000)
		expect(median(claimDurations), JSON.stringify(claimDurations)).toBeLessThanOrEqual(6000)
		expect(median(completionDurations), JSON.stringify(completionDurations)).toBeLessThanOrEqual(
			9000,
		)
		expect(
			p95([...readyDurations, ...claimDurations, ...completionDurations]),
			JSON.stringify({ readyDurations, claimDurations, completionDurations }),
		).toBeLessThanOrEqual(10_000)
	}, 180_000)
})
