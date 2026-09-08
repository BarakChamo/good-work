/**
 * @description Verifies exact-revision, path-scoped planning proposal validation and rollback behavior.
 *
 * @module work/proposals
 * @file Proposals.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Proposal tests assert after Result narrowing. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileWorkGraph } from './compiler'
import type { CompiledWorkGraph, WorkManifest } from './contracts'
import { INPUT_LIMITS } from './files'
import { applyPlanningProposal, loadPlanningProposal, validatePlanningProposal } from './proposals'

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-proposal-'))
	await mkdir(join(root, '.work', 'proposals', 'PROPOSAL-1'), { recursive: true })
	await mkdir(join(root, 'docs', 'issues'), { recursive: true })
	await writeFile(join(root, 'work.yaml'), manifestFile)
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const manifest: WorkManifest = {
	schemaVersion: 1,
	projectId: 'example',
	sources: [
		{
			kind: 'issue',
			include: ['docs/issues/*.md'],
			parentFields: ['parent'],
			dependencyFields: ['dependencies'],
		},
	],
	policies: { contextMaxBytes: 12_000, staleClaimMinutes: 90, terminalEvidence: [] },
}

const manifestFile = JSON.stringify({
	version: 1,
	project: { id: 'example' },
	sources: manifest.sources.map(({ kind, include, parentFields, dependencyFields }) => ({
		kind,
		include,
		parentFields,
		dependencyFields,
	})),
	policies: manifest.policies,
})

const manifestDocument = (value: WorkManifest): string =>
	JSON.stringify({
		version: 1,
		project: { id: value.projectId },
		sources: value.sources,
		policies: value.policies,
	})

const currentGraph = async (): Promise<CompiledWorkGraph> => {
	const compiled = await compileWorkGraph({ root, manifest })
	if (!compiled.ok) {
		throw new Error(compiled.error.message)
	}
	return compiled.value
}

const emptyGraph = (fingerprint: string): CompiledWorkGraph => ({
	schemaVersion: 1,
	projectId: 'example',
	fingerprint,
	items: [],
})

describe('planning proposals', () => {
	it('rejects empty and oversized change sets at the public validation boundary', async () => {
		const graph = emptyGraph('graph-current')
		const baseProposal = {
			schemaVersion: 1 as const,
			id: 'PROPOSAL-1',
			baseGraphFingerprint: graph.fingerprint,
		}

		await expect(
			validatePlanningProposal({
				root,
				graph,
				manifest,
				manifestPath: 'work.yaml',
				proposal: { ...baseProposal, changes: [] },
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_proposal' },
		})
		await expect(
			validatePlanningProposal({
				root,
				graph,
				manifest,
				manifestPath: 'work.yaml',
				proposal: {
					...baseProposal,
					changes: Array.from({ length: INPUT_LIMITS.proposalItems + 1 }, (_, index) => ({
						type: 'create' as const,
						path: `docs/issues/ISSUE-${index}.md`,
						content: `# ISSUE-${index} Work\n`,
					})),
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_proposal' },
		})
	})

	it('rejects canonical create aliases and multibyte path overflow before overlay writes', async () => {
		const graph = emptyGraph('graph-current')
		const duplicate = await validatePlanningProposal({
			root,
			graph,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{ type: 'create', path: 'docs/issues/ISSUE-2.md', content: '# ISSUE-2\n' },
					{ type: 'create', path: 'docs/issues/./ISSUE-2.md', content: '# ISSUE-2 alias\n' },
				],
			},
		})
		expect(duplicate).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_proposal' },
		})

		const oversized = await validatePlanningProposal({
			root,
			graph,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'create',
						path: `docs/issues/${'界'.repeat(200)}.md`,
						content: '# oversized path\n',
					},
				],
			},
		})
		expect(oversized).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unsafe_proposal_path' },
		})
	})

	it('rejects oversized proposal documents before YAML parsing', async () => {
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			'x'.repeat(INPUT_LIMITS.proposalBytes + 1),
		)
		await expect(loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_too_large' },
		})
	})

	it('rejects malformed UTF-8 before parsing a proposal document', async () => {
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			Uint8Array.from([0xc3, 0x28]),
		)

		const result = await loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })
		expect(result).toMatchObject({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_proposal',
			},
		})
		if (result.ok) {
			return
		}
		expect(result.error.message).toMatch(/utf-?8/i)
	})

	it('does not expose malformed proposal YAML content through diagnostics', async () => {
		const privateCanary = 'PRIVATE_PROPOSAL_CANARY_/Users/operator/secret.md'
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			`version: [${privateCanary}\n`,
		)

		const result = await loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_proposal' },
		})
		expect(JSON.stringify(result)).not.toContain(privateCanary)
	})

	it('does not expose proposal identifiers or malformed change paths through diagnostics', async () => {
		const identifierCanary = 'PRIVATE-TOKEN'
		const unavailable = await loadPlanningProposal({ root, proposalId: identifierCanary })
		expect(unavailable).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_unavailable' },
		})
		expect(JSON.stringify(unavailable)).not.toContain(identifierCanary)

		const pathCanary = 'PRIVATE_PROPOSAL_PATH_/Users/operator/TOKEN=value'
		const graph = emptyGraph('graph-current')
		const scenarios = [
			{
				type: 'create' as const,
				path: `/${pathCanary}`,
				content: '# ISSUE-1 Work\n',
			},
			{
				type: 'create' as const,
				path: `docs/${pathCanary}.md`,
			},
			{
				type: 'update' as const,
				path: `docs/${pathCanary}.md`,
				content: '# ISSUE-1 Work\n',
				expectedHash: '0'.repeat(64),
			},
		] as const

		for (const change of scenarios) {
			const result = await validatePlanningProposal({
				root,
				graph,
				manifest,
				manifestPath: 'work.yaml',
				proposal: {
					schemaVersion: 1,
					id: 'PROPOSAL-1',
					baseGraphFingerprint: graph.fingerprint,
					changes: [change],
				},
			})
			expect(result).toMatchObject({ ok: false, error: { type: 'work_contract_error' } })
			expect(JSON.stringify(result)).not.toContain(pathCanary)
		}
	})

	it('validates and applies an exact-revision create/update bundle with a receipt', async () => {
		const current = '# ISSUE-1 Existing\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), current)
		const graph = await currentGraph()
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			`version: 1
id: PROPOSAL-1
baseGraphFingerprint: ${graph.fingerprint}
changes:
  - type: update
    path: docs/issues/ISSUE-1.md
    expectedHash: ${hash(current)}
    content: |
      # ISSUE-1 Updated
  - type: create
    path: docs/issues/ISSUE-2.md
    content: |
      # ISSUE-2 Created
`,
		)

		const loaded = await loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })
		expect(loaded.ok).toBe(true)
		if (!loaded.ok) {
			return
		}
		const validated = await validatePlanningProposal({
			root,
			proposal: loaded.value,
			graph,
			manifest,
			manifestPath: 'work.yaml',
		})
		expect(validated.ok).toBe(true)
		if (!validated.ok) {
			return
		}
		await expect(
			applyPlanningProposal({ root, plan: validated.value, approvedFingerprint: 'not-approved' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_approval_mismatch' },
		})
		const applied = await applyPlanningProposal({
			root,
			plan: validated.value,
			approvedFingerprint: validated.value.fingerprint,
		})
		expect(applied.ok).toBe(true)
		if (!applied.ok) {
			return
		}
		expect(applied.value).toMatchObject({
			schemaVersion: 1,
			proposalId: 'PROPOSAL-1',
			baseGraphFingerprint: graph.fingerprint,
			paths: ['docs/issues/ISSUE-1.md', 'docs/issues/ISSUE-2.md'],
		})
		expect(applied.value.resultingGraphFingerprint).toMatch(/^[a-f0-9]{64}$/)
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), 'utf8')).resolves.toBe(
			'# ISSUE-1 Updated\n',
		)
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), 'utf8')).resolves.toBe(
			'# ISSUE-2 Created\n',
		)
	})

	it('rejects stale graphs, stale file hashes, and paths outside configured work sources', async () => {
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			`version: 1
id: PROPOSAL-1
baseGraphFingerprint: graph-old
changes:
  - type: update
    path: README.md
    expectedHash: "${'0'.repeat(64)}"
    content: unsafe
`,
		)
		const loaded = await loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })
		if (!loaded.ok) {
			throw new Error(loaded.error.message)
		}
		const staleGraph = await validatePlanningProposal({
			root,
			proposal: loaded.value,
			graph: emptyGraph('graph-current'),
			manifest,
			manifestPath: 'work.yaml',
		})
		expect(staleGraph).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'stale_proposal_graph' },
		})

		const currentProposal = { ...loaded.value, baseGraphFingerprint: 'graph-current' }
		const unsafe = await validatePlanningProposal({
			root,
			proposal: currentProposal,
			graph: emptyGraph('graph-current'),
			manifest,
			manifestPath: 'work.yaml',
		})
		expect(unsafe).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_path_not_allowed' },
		})
	})

	it('honors manifest negation patterns when authorizing proposal paths', async () => {
		const publicSource = '# ISSUE-1 Public\n'
		const excludedSource = '# ISSUE-9 Private\n'
		const issueSource = manifest.sources[0]
		if (issueSource === undefined) {
			throw new Error('Missing proposal test source configuration.')
		}
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), publicSource)
		await writeFile(join(root, 'docs', 'issues', 'private-ISSUE-9.md'), excludedSource)
		const restrictedManifest: WorkManifest = {
			...manifest,
			sources: [
				{
					...issueSource,
					include: ['docs/issues/*.md', '!docs/issues/private-*.md'],
				},
			],
		}
		const compiled = await compileWorkGraph({ root, manifest: restrictedManifest })
		if (!compiled.ok) {
			throw new Error(compiled.error.message)
		}
		expect(compiled.value.items.map(({ id }) => id)).toStrictEqual(['ISSUE-1'])
		await writeFile(join(root, 'work.yaml'), manifestDocument(restrictedManifest))

		await expect(
			validatePlanningProposal({
				root,
				graph: compiled.value,
				manifest: restrictedManifest,
				manifestPath: 'work.yaml',
				proposal: {
					schemaVersion: 1,
					id: 'PROPOSAL-1',
					baseGraphFingerprint: compiled.value.fingerprint,
					changes: [
						{
							type: 'update',
							path: 'docs/issues/private-ISSUE-9.md',
							expectedHash: hash(excludedSource),
							content: '# ISSUE-9 Changed\n',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_path_not_allowed' },
		})
		await expect(
			validatePlanningProposal({
				root,
				graph: compiled.value,
				manifest: restrictedManifest,
				manifestPath: 'work.yaml',
				proposal: {
					schemaVersion: 1,
					id: 'PROPOSAL-1',
					baseGraphFingerprint: compiled.value.fingerprint,
					changes: [
						{
							type: 'create',
							path: 'docs/issues/private-ISSUE-8.md',
							content: '# ISSUE-8 Private\n',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_path_not_allowed' },
		})
	})

	it('authorizes proposal creates through Tinyglobby brace and extglob patterns', async () => {
		const issueSource = manifest.sources[0]
		if (issueSource === undefined) {
			throw new Error('Missing proposal test source configuration.')
		}
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), '# ISSUE-1 Existing\n')
		const patternedManifest: WorkManifest = {
			...manifest,
			sources: [
				{
					...issueSource,
					include: ['docs/issues/{ISSUE,BUG}-@(1|2).md', '!docs/issues/BUG-2.md'],
				},
			],
		}
		const graph = await compileWorkGraph({ root, manifest: patternedManifest })
		if (!graph.ok) {
			throw new Error(graph.error.message)
		}
		await writeFile(join(root, 'work.yaml'), manifestDocument(patternedManifest))

		const validated = await validatePlanningProposal({
			root,
			graph: graph.value,
			manifest: patternedManifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.value.fingerprint,
				changes: [
					{
						type: 'create',
						path: 'docs/issues/BUG-1.md',
						content: '# BUG-1 Created through patterned scope\n',
					},
				],
			},
		})

		expect(validated.ok).toBe(true)
	})

	it('rejects symlink targets and destructive changes unless explicitly authorized', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-proposal-outside-'))
		await writeFile(join(outside, 'target.md'), 'outside\n')
		await symlink(join(outside, 'target.md'), join(root, 'docs', 'issues', 'ISSUE-9.md'))
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			`version: 1
id: PROPOSAL-1
baseGraphFingerprint: graph-1
changes:
  - type: delete
    path: docs/issues/ISSUE-9.md
    expectedHash: ${hash('outside\n')}
`,
		)
		const loaded = await loadPlanningProposal({ root, proposalId: 'PROPOSAL-1' })
		if (!loaded.ok) {
			throw new Error(loaded.error.message)
		}
		const denied = await validatePlanningProposal({
			root,
			proposal: loaded.value,
			graph: emptyGraph('graph-1'),
			manifest,
			manifestPath: 'work.yaml',
		})
		expect(denied).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_delete_not_authorized' },
		})
		const unsafe = await validatePlanningProposal({
			root,
			proposal: loaded.value,
			graph: emptyGraph('graph-1'),
			manifest,
			manifestPath: 'work.yaml',
			allowDelete: true,
		})
		expect(unsafe).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_path_not_allowed' },
		})
		await rm(outside, { force: true, recursive: true })
	})

	it('rejects caller-constructed plans that bypass validation and delete authorization', async () => {
		const target = join(root, 'docs', 'issues', 'ISSUE-1.md')
		await writeFile(target, 'preserve\n')
		const forged = {
			schemaVersion: 1,
			proposalId: 'PROPOSAL-1',
			baseGraphFingerprint: 'graph-1',
			fingerprint: 'forged',
			changes: [
				{ type: 'delete', path: 'docs/issues/ISSUE-1.md', expectedHash: hash('preserve\n') },
			],
		}

		await expect(
			applyPlanningProposal({ root, plan: forged, approvedFingerprint: 'forged' }),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'unvalidated_proposal_plan' },
		})
		await expect(readFile(target, 'utf8')).resolves.toBe('preserve\n')
	})

	it('performs a side-effect-free preflight before staging a multi-file apply', async () => {
		const first = join(root, 'docs', 'issues', 'ISSUE-1.md')
		const second = join(root, 'docs', 'issues', 'ISSUE-2.md')
		await writeFile(first, '# ISSUE-1 First old\n')
		await writeFile(second, '# ISSUE-2 Second old\n')
		const graph = await currentGraph()
		const proposal = {
			schemaVersion: 1 as const,
			id: 'PROPOSAL-1',
			baseGraphFingerprint: graph.fingerprint,
			changes: [
				{
					type: 'update' as const,
					path: 'docs/issues/ISSUE-1.md',
					expectedHash: hash('# ISSUE-1 First old\n'),
					content: '# ISSUE-1 First new\n',
				},
				{
					type: 'update' as const,
					path: 'docs/issues/ISSUE-2.md',
					expectedHash: hash('# ISSUE-2 Second old\n'),
					content: '# ISSUE-2 Second new\n',
				},
			],
		}
		const validated = await validatePlanningProposal({
			root,
			proposal,
			graph,
			manifest,
			manifestPath: 'work.yaml',
		})
		if (!validated.ok) {
			throw new Error(validated.error.message)
		}
		await writeFile(second, 'changed-after-validation\n')

		await expect(
			applyPlanningProposal({
				root,
				plan: validated.value,
				approvedFingerprint: validated.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'stale_proposal_graph_source' },
		})
		await expect(readFile(first, 'utf8')).resolves.toBe('# ISSUE-1 First old\n')
		await expect(
			readdir(join(root, 'docs', 'issues')).then((entries) => entries.toSorted()),
		).resolves.toStrictEqual(['ISSUE-1.md', 'ISSUE-2.md'])
	})

	it('rejects a proposal when the manifest changes before its locked apply', async () => {
		const original = '# ISSUE-1 Original\n'
		const target = join(root, 'docs', 'issues', 'ISSUE-1.md')
		await writeFile(target, original)
		await writeFile(join(root, 'work.yaml'), manifestFile)
		const graph = await currentGraph()
		const validated = await validatePlanningProposal({
			root,
			graph,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash(original),
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})
		if (!validated.ok) {
			throw new Error(validated.error.message)
		}
		await writeFile(
			join(root, 'work.yaml'),
			'version: 1\nproject: { id: replacement }\nsources: [{ kind: issue, include: docs/issues/*.md }]\n',
		)

		await expect(
			applyPlanningProposal({
				root,
				plan: validated.value,
				approvedFingerprint: validated.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'stale_proposal_graph' },
		})
		await expect(readFile(target, 'utf8')).resolves.toBe(original)
	})

	it('fails closed when another proposal apply holds the repository lock', async () => {
		const target = join(root, 'docs', 'issues', 'ISSUE-1.md')
		await writeFile(target, '# ISSUE-1 Old\n')
		const graph = await currentGraph()
		const validated = await validatePlanningProposal({
			root,
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash('# ISSUE-1 Old\n'),
						content: '# ISSUE-1 New\n',
					},
				],
			},
			graph,
			manifest,
			manifestPath: 'work.yaml',
		})
		if (!validated.ok) {
			throw new Error(validated.error.message)
		}
		await writeFile(join(root, '.work', 'proposal-apply.lock'), 'another-worker\n')

		await expect(
			applyPlanningProposal({
				root,
				plan: validated.value,
				approvedFingerprint: validated.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'proposal_apply_locked' },
		})
		await expect(readFile(target, 'utf8')).resolves.toBe('# ISSUE-1 Old\n')
	})

	it('rejects a proposal whose resulting files contain duplicate work IDs', async () => {
		const first = '# ISSUE-1 First\n'
		const second = '# ISSUE-2 Second\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), first)
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), second)
		const graph = await currentGraph()

		const result = await validatePlanningProposal({
			root,
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-2.md',
						expectedHash: hash(second),
						content: '# ISSUE-1 Duplicate\n',
					},
				],
			},
			graph,
			manifest,
			manifestPath: 'work.yaml',
		})

		expect(result).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_proposed_work_graph' },
		})
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), 'utf8')).resolves.toBe(second)
	})

	it('rejects apply when a non-target work source changed after validation', async () => {
		const first = '# ISSUE-1 First\n'
		const second = '# ISSUE-2 Second\n'
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), first)
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), second)
		const graph = await currentGraph()
		const validated = await validatePlanningProposal({
			root,
			graph,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash(first),
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})
		if (!validated.ok) {
			throw new Error(validated.error.message)
		}
		await writeFile(join(root, 'docs', 'issues', 'ISSUE-2.md'), '# ISSUE-2 Changed elsewhere\n')

		await expect(
			applyPlanningProposal({
				root,
				plan: validated.value,
				approvedFingerprint: validated.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'stale_proposal_graph_source' },
		})
		await expect(readFile(join(root, 'docs', 'issues', 'ISSUE-1.md'), 'utf8')).resolves.toBe(first)
	})

	it('bounds source rereads when files grow after proposal validation', async () => {
		const sourcePath = join(root, 'docs', 'issues', 'ISSUE-1.md')
		const original = '# ISSUE-1 Original\n'
		await writeFile(sourcePath, original)
		const graph = await currentGraph()
		const validated = await validatePlanningProposal({
			root,
			graph,
			manifest,
			manifestPath: 'work.yaml',
			proposal: {
				schemaVersion: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: graph.fingerprint,
				changes: [
					{
						type: 'update',
						path: 'docs/issues/ISSUE-1.md',
						expectedHash: hash(original),
						content: '# ISSUE-1 Updated\n',
					},
				],
			},
		})
		if (!validated.ok) {
			throw new Error(validated.error.message)
		}
		await writeFile(sourcePath, `# ISSUE-1 Grown\n${'x'.repeat(INPUT_LIMITS.sourceBytes)}`)

		await expect(
			applyPlanningProposal({
				root,
				plan: validated.value,
				approvedFingerprint: validated.value.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'source_too_large' },
		})
	})
})
