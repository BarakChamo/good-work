/**
 * @description Verifies one private provider-state boundary across linked Git worktrees.
 *
 * @module work/work-state
 * @file Work-state.test.ts
 */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { executeFile } from './subprocess'
import { resolveWorkStateLocation } from './work-state'

const roots: string[] = []
const projectUid = '123e4567-e89b-42d3-a456-426614174000'

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })))
})

describe('work state location', () => {
	it('resolves the same private state and opaque identity in every linked worktree', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const linked = `${root}-linked`
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		roots.push(root, linked, stateHome)
		await executeFile('git', ['init', '-b', 'main'], { cwd: root })
		await executeFile('git', ['config', 'user.name', 'Work Contract'], { cwd: root })
		await executeFile('git', ['config', 'user.email', 'work@example.test'], { cwd: root })
		await writeFile(join(root, 'source.ts'), 'export const value = 1\n')
		await executeFile('git', ['add', 'source.ts'], { cwd: root })
		await executeFile('git', ['commit', '-m', 'fixture'], { cwd: root })
		await executeFile('git', ['worktree', 'add', '-b', 'feature', linked], { cwd: root })

		const primary = await resolveWorkStateLocation({
			root,
			projectId: 'example',
			projectUid,
			stateHome,
		})
		const isolated = await resolveWorkStateLocation({
			root: linked,
			projectId: 'example',
			projectUid,
			stateHome,
		})

		expect(primary.ok).toBe(true)
		expect(isolated.ok).toBe(true)
		if (!primary.ok || !isolated.ok) {
			return
		}
		expect(isolated.value.directory).toBe(primary.value.directory)
		expect(isolated.value.coordinationRoot).toBe(primary.value.coordinationRoot)
		expect(isolated.value.observation).toStrictEqual(primary.value.observation)
		expect(primary.value.observation).toMatchObject({
			projectUid,
			scope: 'repository',
			shared: true,
		})
		expect(primary.value.observation.identity).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(primary.value.observation)).not.toContain(root)
		expect(primary.value.coordinationRoot.startsWith(stateHome)).toBe(true)
		expect(primary.value.coordinationRoot).toBe(
			join(stateHome, projectUid, primary.value.observation.identity),
		)
		expect(primary.value.coordinationRoot).not.toBe(root)
		expect(primary.value.directory).toBe(join(primary.value.coordinationRoot, '.beads'))
		expect(primary.value.initialized).toBe(false)
		await mkdir(primary.value.directory)
		const initialized = await resolveWorkStateLocation({
			root,
			projectId: 'example',
			projectUid,
			stateHome,
		})
		expect(initialized).toMatchObject({ ok: true, value: { initialized: true } })
	})

	it('rejects an invalid project UID before resolving external state', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		roots.push(root, stateHome)
		await executeFile('git', ['init', '-b', 'main'], { cwd: root })

		await expect(
			resolveWorkStateLocation({
				root,
				projectId: 'example',
				projectUid: '../../private',
				stateHome,
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_operation_input' },
		})
	})

	it('keeps an existing legacy coordination root when a repository adopts a project UID', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		roots.push(root, stateHome)
		await executeFile('git', ['init', '-b', 'main'], { cwd: root })

		const legacy = await resolveWorkStateLocation({ root, projectId: 'example', stateHome })
		const upgraded = await resolveWorkStateLocation({
			root,
			projectId: 'example',
			projectUid,
			stateHome,
		})

		expect(legacy.ok).toBe(true)
		expect(upgraded.ok).toBe(true)
		if (!legacy.ok || !upgraded.ok) {
			return
		}
		expect(upgraded.value.coordinationRoot).toBe(legacy.value.coordinationRoot)
		expect(upgraded.value.observation.projectUid).toBe(projectUid)
	})

	it('isolates separate clones that share one committed project UID', async () => {
		expect.hasAssertions()
		const firstRoot = await mkdtemp(join(tmpdir(), 'work-contract-clone-a-'))
		const secondRoot = await mkdtemp(join(tmpdir(), 'work-contract-clone-b-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		roots.push(firstRoot, secondRoot, stateHome)
		await Promise.all(
			[firstRoot, secondRoot].map(async (root) =>
				executeFile('git', ['init', '-b', 'main'], { cwd: root }),
			),
		)

		const first = await resolveWorkStateLocation({
			root: firstRoot,
			projectId: 'example',
			projectUid,
			stateHome,
		})
		const second = await resolveWorkStateLocation({
			root: secondRoot,
			projectId: 'example',
			projectUid,
			stateHome,
		})

		expect(first.ok).toBe(true)
		expect(second.ok).toBe(true)
		if (!first.ok || !second.ok) {
			return
		}
		expect(first.value.coordinationRoot).not.toBe(second.value.coordinationRoot)
		expect(first.value.coordinationRoot).toContain(join(stateHome, projectUid))
		expect(second.value.coordinationRoot).toContain(join(stateHome, projectUid))
	})

	it('rejects a project namespace symlink without writing through it', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-state-outside-'))
		roots.push(root, stateHome, outside)
		await executeFile('git', ['init', '-b', 'main'], { cwd: root })
		await symlink(outside, join(stateHome, projectUid))

		const location = await resolveWorkStateLocation({
			root,
			projectId: 'example',
			projectUid,
			stateHome,
		})

		expect(location).toMatchObject({
			ok: false,
			error: { code: 'unsafe_work_directory' },
		})
		await expect(readdir(outside)).resolves.toStrictEqual([])
	})

	it('uses the configured state home without placing working files in the repository', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-external-state-'))
		roots.push(root, stateHome)
		await executeFile('git', ['init', '-b', 'main'], { cwd: root })

		const location = await resolveWorkStateLocation({ root, projectId: 'example', stateHome })

		expect(location.ok).toBe(true)
		if (!location.ok) {
			return
		}
		expect(location.value.coordinationRoot.startsWith(stateHome)).toBe(true)
		expect(location.value.coordinationRoot.startsWith(root)).toBe(false)
		expect(location.value.observation).toMatchObject({ scope: 'repository', shared: true })
	})

	it('uses a bounded workspace-local fallback outside Git', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		roots.push(root)

		const location = await resolveWorkStateLocation({ root, projectId: 'example' })

		expect(location).toMatchObject({
			ok: true,
			value: { observation: { scope: 'workspace', shared: false } },
		})
	})

	it('fails closed when a detected Git repository cannot resolve shared state', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		roots.push(root)
		const location = await resolveWorkStateLocation({
			root,
			projectId: 'example',
			executeGit: async (_workspace, args) => {
				if (args.includes('--is-inside-work-tree')) {
					return 'true\n'
				}
				throw new Error('simulated Git state failure')
			},
		})

		expect(location).toMatchObject({
			ok: false,
			error: { code: 'unsafe_work_directory' },
		})
		expect(JSON.stringify(location)).not.toContain(root)
	})

	it('rejects a provider-state symlink outside the workspace', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(join(tmpdir(), 'work-contract-state-'))
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-state-outside-'))
		roots.push(root, outside)
		await mkdir(join(outside, 'provider'))
		await symlink(join(outside, 'provider'), join(root, '.beads'))

		const location = await resolveWorkStateLocation({ root, projectId: 'example' })

		expect(location).toMatchObject({
			ok: false,
			error: { code: 'unsafe_work_directory' },
		})
		expect(JSON.stringify(location)).not.toContain(outside)
	})
})
