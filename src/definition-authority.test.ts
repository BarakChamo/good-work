/**
 * @description Verifies Git-backed work definitions are compiled from one configured target-ref snapshot.
 *
 * @module work/definition-authority
 * @file Definition-authority.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { inspectWorkspaceDefinitionOverlay } from './definition-authority'
import { loadWorkProject } from './facade'
import { executeFile } from './subprocess'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(async (root) => {
			await rm(root, { force: true, recursive: true })
		}),
	)
})

const git = async (root: string, ...args: readonly string[]): Promise<string> => {
	const result = await executeFile('git', args, { cwd: root })
	return result.stdout.trim()
}

const initializeRepositoryOnBranch = async (
	branch: string,
): Promise<{
	readonly root: string
	readonly primaryRoot: string
	readonly targetSha: string
}> => {
	const primaryRoot = await mkdtemp(join(tmpdir(), 'work-contract-definition-authority-'))
	const root = `${primaryRoot}-feature`
	roots.push(root, primaryRoot)
	await mkdir(join(primaryRoot, 'docs'), { recursive: true })
	await writeFile(
		join(primaryRoot, 'work.yaml'),
		[
			'version: 1',
			'project: { id: authority-test }',
			'sources:',
			'  - kind: issue',
			'    include: docs/*.md',
			'policies:',
			'  delivery:',
			'    profile: local-direct',
			`    targetRef: refs/heads/${branch}`,
			'',
		].join('\n'),
	)
	await writeFile(join(primaryRoot, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Canonical title\n')
	await git(primaryRoot, 'init', '-b', branch)
	await git(primaryRoot, 'config', 'user.email', 'test@example.com')
	await git(primaryRoot, 'config', 'user.name', 'Work Contract Test')
	await git(primaryRoot, 'add', '.')
	await git(primaryRoot, 'commit', '-m', 'canonical definitions')
	const targetSha = await git(primaryRoot, 'rev-parse', `refs/heads/${branch}`)
	await git(primaryRoot, 'worktree', 'add', '-b', 'feature', root)
	return { root, primaryRoot, targetSha }
}

const initializeRepository = async () => initializeRepositoryOnBranch('main')

describe('loadWorkProject canonical definition authority', () => {
	it('requires Git-backed definitions to exist on canonical main before synchronization', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-definition-authority-'))
		roots.push(root)
		await git(root, 'init', '-b', 'main')
		await git(root, 'config', 'user.email', 'test@example.com')
		await git(root, 'config', 'user.name', 'Work Contract Test')
		await writeFile(join(root, '.gitignore'), '.work/lock.json\n')
		await git(root, 'add', '.gitignore')
		await git(root, 'commit', '-m', 'provider bootstrap')
		await mkdir(join(root, 'docs'), { recursive: true })
		await writeFile(
			join(root, 'work.yaml'),
			[
				'version: 1',
				'project: { id: authority-test }',
				'sources:',
				'  - kind: issue',
				'    include: docs/*.md',
				'policies:',
				'  delivery:',
				'    profile: local-direct',
				'    targetRef: refs/heads/main',
				'',
			].join('\n'),
		)
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Uncommitted definition\n')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'canonical_definition_drift',
				message:
					'Commit work.yaml and its definition sources to refs/heads/main before Git-backed synchronization.',
			},
		})
	})

	it('loads Git-backed definitions from the configured target ref instead of the caller branch', async () => {
		expect.hasAssertions()
		// Given: a feature checkout whose work definition differs from committed main.
		const { root } = await initializeRepository()
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Feature-only title\n')

		// When: the public project-loading facade resolves the work graph.
		const result = await loadWorkProject({ root })

		// Then: one exact main snapshot owns the graph and its durable revision identity.
		expect(result).toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Canonical title' }] },
				definitionRevision: {
					targetRef: 'refs/heads/main',
				},
			},
		})
	})

	it('derives canonical authority from a non-main primary checkout ref', async () => {
		expect.hasAssertions()
		const { root } = await initializeRepositoryOnBranch('trunk')
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Feature-only title\n')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Canonical title' }] },
				definitionRevision: { targetRef: 'refs/heads/trunk' },
			},
		})
	})

	it('fails closed when the shared primary checkout has no branch authority ref', async () => {
		expect.hasAssertions()
		const { root, primaryRoot, targetSha } = await initializeRepository()
		await git(primaryRoot, 'switch', '--detach', targetSha)

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'canonical_definition_drift' },
		})
	})

	it('fails closed when Git inspection fails inside a detected worktree', async () => {
		expect.hasAssertions()
		const { root } = await initializeRepository()
		await writeFile(join(root, '.git'), 'gitdir: /missing/worktree-metadata\n')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'canonical_definition_drift' },
		})
	})

	it('allows workspace-local definitions only when the primary manifest commits evidence-only delivery', async () => {
		expect.hasAssertions()
		const primaryRoot = await mkdtemp(join(tmpdir(), 'work-contract-definition-authority-'))
		const root = `${primaryRoot}-feature`
		roots.push(root, primaryRoot)
		await mkdir(join(primaryRoot, 'docs'), { recursive: true })
		await writeFile(
			join(primaryRoot, 'work.yaml'),
			[
				'version: 1',
				'project: { id: authority-test }',
				'sources:',
				'  - kind: issue',
				'    include: docs/*.md',
				'policies:',
				'  delivery:',
				'    profile: evidence-only',
				'',
			].join('\n'),
		)
		await writeFile(join(primaryRoot, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Canonical title\n')
		await git(primaryRoot, 'init', '-b', 'main')
		await git(primaryRoot, 'config', 'user.email', 'test@example.com')
		await git(primaryRoot, 'config', 'user.name', 'Work Contract Test')
		await git(primaryRoot, 'add', '.')
		await git(primaryRoot, 'commit', '-m', 'evidence-only definitions')
		await git(primaryRoot, 'worktree', 'add', '-b', 'feature', root)
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Workspace-local title\n')

		const result = await loadWorkProject({ root })
		expect(result).toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Workspace-local title' }] },
			},
		})
		if (result.ok) {
			expect(result.value).not.toHaveProperty('definitionRevision')
		}
	})

	it('keeps malformed caller-worktree manifests inert when main owns delivery authority', async () => {
		expect.hasAssertions()
		const { root } = await initializeRepository()
		await writeFile(join(root, 'work.yaml'), 'not: [a valid work manifest\n')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Canonical title' }] },
				definitionRevision: { targetRef: 'refs/heads/main' },
			},
		})
	})

	it('does not let a feature branch redirect canonical authority to itself', async () => {
		expect.hasAssertions()
		const { root } = await initializeRepository()
		await writeFile(
			join(root, 'work.yaml'),
			[
				'version: 1',
				'project: { id: authority-test }',
				'sources:',
				'  - kind: issue',
				'    include: docs/*.md',
				'policies:',
				'  delivery:',
				'    profile: local-direct',
				'    targetRef: refs/heads/feature',
				'',
			].join('\n'),
		)
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Feature-owned title\n')
		await git(root, 'add', '.')
		await git(root, 'commit', '-m', 'attempt definition authority redirect')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Canonical title' }] },
				definitionRevision: { targetRef: 'refs/heads/main' },
			},
		})
	})

	it('rejects canonical Git blobs that are not valid UTF-8', async () => {
		expect.hasAssertions()
		const { root, primaryRoot } = await initializeRepository()
		await writeFile(join(primaryRoot, 'docs', 'ISSUE-1.md'), Uint8Array.from([0xff, 0xfe]))
		await git(primaryRoot, 'add', 'docs/ISSUE-1.md')
		await git(primaryRoot, 'commit', '-m', 'invalid definition encoding')

		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'canonical_definition_drift',
				message: 'Canonical definition source must be valid UTF-8.',
			},
		})
	})

	it('ignores unrelated Git submodules outside configured definition sources', async () => {
		expect.hasAssertions()
		const { root, primaryRoot, targetSha } = await initializeRepository()
		await git(
			primaryRoot,
			'update-index',
			'--add',
			'--cacheinfo',
			`160000,${targetSha},vendor/unrelated`,
		)
		await git(primaryRoot, 'commit', '-m', 'unrelated submodule')
		await expect(loadWorkProject({ root })).resolves.toMatchObject({
			ok: true,
			value: {
				graph: { items: [{ id: 'ISSUE-1', title: 'Canonical title' }] },
				definitionRevision: { targetRef: 'refs/heads/main' },
			},
		})
	})

	it('reports a feature-worktree overlay as diagnostic-only drift', async () => {
		expect.hasAssertions()
		const { root } = await initializeRepository()
		await writeFile(join(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Feature-only title\n')
		const canonical = await loadWorkProject({ root })
		if (!canonical.ok) {
			throw new Error('Canonical fixture failed to load.')
		}

		await expect(
			inspectWorkspaceDefinitionOverlay({
				root,
				canonicalGraphFingerprint: canonical.value.graph.fingerprint,
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { status: 'different' },
		})
	})
})
