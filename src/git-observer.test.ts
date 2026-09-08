/**
 * @description Verifies bounded read-only Git workspace observations used by delivery admission.
 *
 * @module work/git-observer
 * @file Git-observer.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { observeGitWorkspace } from './git-observer'
import { executeFile } from './subprocess'

const execute = executeFile
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('git workspace observer', () => {
	it('distinguishes primary and linked worktrees without exposing an absolute path', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-git-'))
		const linked = `${root}-linked`
		roots.push(root, linked)
		await execute('git', ['init', '-b', 'main'], { cwd: root })
		await execute('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await execute('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await mkdir(join(root, '.beads'))
		await writeFile(join(root, 'source.ts'), 'export const value = 1\n')
		await writeFile(join(root, '.beads/interactions.jsonl'), 'baseline\n')
		await execute('git', ['add', 'source.ts', '.beads'], { cwd: root })
		await execute('git', ['commit', '-m', 'fixture'], { cwd: root })
		await execute('git', ['worktree', 'add', '-b', 'feature', linked], { cwd: root })
		await writeFile(join(linked, '.beads/interactions.jsonl'), 'operational update\n')
		await mkdir(join(linked, '.work'))
		await writeFile(
			join(linked, '.work/beads-aaaaaaaaaaaa-bbbbbbbbbbbb.lock'),
			'operational lock\n',
		)

		const primary = await observeGitWorkspace({ root })
		const isolated = await observeGitWorkspace({ root: linked })

		expect(primary).toMatchObject({ ok: true, value: { available: true, isolation: 'main' } })
		expect(isolated).toMatchObject({
			ok: true,
			value: { available: true, isolation: 'worktree', dirty: false },
		})
		if (isolated.ok) {
			expect(JSON.stringify(isolated.value)).not.toContain(root)
			expect(isolated.value.repositoryId).toMatch(/^[a-f0-9]{64}$/)
		}
		await writeFile(join(linked, '.beads/issues.jsonl'), 'legacy residue\n')
		await expect(observeGitWorkspace({ root: linked })).resolves.toMatchObject({
			ok: true,
			value: { dirty: true },
		})
		await rm(join(linked, '.beads/issues.jsonl'))
		await writeFile(join(linked, 'source.ts'), 'export const value = 2\n')
		await expect(observeGitWorkspace({ root: linked })).resolves.toMatchObject({
			ok: true,
			value: { dirty: true },
		})
	})
})
