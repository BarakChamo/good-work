/**
 * @description Verifies packaged skill instructions remain executable from ordinary package-local environments.
 *
 * @module work/skill-test
 * @file Skill.test.ts
 */

import { randomUUID } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { installWorkContractSkill, removeOwnedSkillInstallLock } from './skill'

const temporaryRoots: string[] = []
const NON_LIVE_PROCESS_ID = 2_147_483_647

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
	)
})

const createRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'work-contract-skill-'))
	temporaryRoots.push(root)
	await mkdir(resolve(root, '.work'))
	return root
}

const lockSource = (pid: number): string =>
	`${JSON.stringify({
		pid,
		startedAt: new Date().toISOString(),
		nonce: randomUUID(),
	})}\n`

const readSkillAsset = async (path: string): Promise<string> =>
	readFile(resolve(import.meta.dirname, '../skills/work', path), 'utf8')

const replaceLockGeneration = (workRoot: string, replacementPath: string) => {
	let cancelled = false
	let settled = false
	let rejectPending: ((error: Error) => void) | undefined
	const lockPath = resolve(workRoot, 'skill-install.lock')
	const replaced = new Promise<void>((resolveReplacement, rejectReplacement) => {
		rejectPending = rejectReplacement
		const attempt = () => {
			if (cancelled) {
				return
			}
			if (!existsSync(lockPath)) {
				setImmediate(attempt)
				return
			}
			try {
				renameSync(replacementPath, lockPath)
				settled = true
				resolveReplacement()
			} catch (error: unknown) {
				settled = true
				rejectReplacement(
					error instanceof Error ? error : new Error('Lock replacement failed unexpectedly.'),
				)
			}
		}
		setImmediate(attempt)
	})
	return {
		replaced,
		cancel: () => {
			cancelled = true
			if (!settled) {
				settled = true
				rejectPending?.(new Error('Skill lock was released before its generation was replaced.'))
			}
		},
	}
}

describe('packaged work skill', () => {
	it('uses Bun package-local CLI resolution for every portable command', async () => {
		expect.hasAssertions()
		const [skill, commands] = await Promise.all([
			readSkillAsset('SKILL.md'),
			readSkillAsset('references/commands.md'),
		])

		expect(skill).toContain('When it exists, use `bun run work`')
		expect(skill).toContain('Search upward from the current directory only as far as the Git root')
		expect(skill).not.toMatch(/^work\s/m)
		expect(commands).not.toMatch(/\| `work\s/)
		expect(commands).toContain('| Index')
		expect(commands).toContain('`bun run work overview --json`')
		expect(skill).toContain('bun run work start <id-or-path> --actor <actor>')
		expect(commands).toContain('bun run work start <id-or-path> --actor <actor>')
	})

	it('explains that an empty portable role list is unrestricted', async () => {
		expect.hasAssertions()
		const skill = await readSkillAsset('SKILL.md')

		expect(skill).toContain('An empty `roles` list is unrestricted; omit `--role`')
	})

	it('separates validation execution from durable evidence recording', async () => {
		expect.hasAssertions()
		const skill = await readSkillAsset('SKILL.md')

		expect(skill).toContain('Run validation as a standalone command')
		expect(skill).toMatch(/write the durable\s+evidence record afterward/u)
	})
})

describe('work skill installer', () => {
	it('fails closed and preserves a validated lock whose owning process has exited', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const lockPath = resolve(root, '.work/skill-install.lock')
		const source = lockSource(NON_LIVE_PROCESS_ID)
		await writeFile(lockPath, source)

		const installed = await installWorkContractSkill({ root, force: false })

		expect(installed).toMatchObject({
			ok: false,
			error: {
				code: 'skill_install_failed',
				message: 'A stale skill installation lock requires manual recovery.',
				details: [
					'lockState=stale',
					'automaticRecovery=false',
					'recovery=confirm no skill installation is active, then remove the stale lock',
				],
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(source)
		await expect(access(resolve(root, '.agents/skills/work/SKILL.md'))).rejects.toThrow('ENOENT')
	})

	it('preserves a validated lock while its owning process is alive', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const lockPath = resolve(root, '.work/skill-install.lock')
		const source = lockSource(process.pid)
		await writeFile(lockPath, source)

		const installed = await installWorkContractSkill({ root, force: true })

		expect(installed).toMatchObject({
			ok: false,
			error: {
				code: 'skill_install_failed',
				message: 'Another skill installation is active.',
			},
		})
		expect(JSON.stringify(installed)).not.toContain(root)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(source)
		await expect(access(resolve(root, '.agents/skills/work/SKILL.md'))).rejects.toThrow('ENOENT')
	})

	it('does not unlink a replacement skill-lock generation after initial validation', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const lockPath = resolve(root, '.work/skill-install.lock')
		const original = lockSource(process.pid)
		const replacement = lockSource(NON_LIVE_PROCESS_ID)
		await writeFile(lockPath, original)

		await expect(
			removeOwnedSkillInstallLock(lockPath, original, async () => {
				await rm(lockPath)
				await writeFile(lockPath, replacement)
			}),
		).resolves.toBe(false)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('preserves a replacement generation when the current owner releases its lock', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const workRoot = resolve(root, '.work')
		const lockPath = resolve(workRoot, 'skill-install.lock')
		const replacementPath = resolve(workRoot, 'replacement.lock')
		const replacement = lockSource(NON_LIVE_PROCESS_ID)
		await writeFile(replacementPath, replacement)
		const replacementRace = replaceLockGeneration(workRoot, replacementPath)

		const installed = await installWorkContractSkill({ root, force: false })
		replacementRace.cancel()
		await replacementRace.replaced

		expect(installed).toMatchObject({
			ok: false,
			error: {
				code: 'skill_install_failed',
				message:
					'Skill installation lock ownership changed before release; the lock was preserved.',
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('preserves the primary install error when lock ownership changes during cleanup', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const workRoot = resolve(root, '.work')
		const lockPath = resolve(workRoot, 'skill-install.lock')
		const replacementPath = resolve(workRoot, 'replacement.lock')
		const replacement = lockSource(NON_LIVE_PROCESS_ID)
		await mkdir(resolve(root, '.agents/skills/work'), { recursive: true })
		await writeFile(resolve(root, '.agents/skills/work/SKILL.md'), 'local customization\n')
		await writeFile(replacementPath, replacement)
		const replacementRace = replaceLockGeneration(workRoot, replacementPath)

		const installed = await installWorkContractSkill({ root, force: false })
		replacementRace.cancel()
		await replacementRace.replaced

		expect(installed.ok).toBe(false)
		if (installed.ok) {
			throw new Error('Expected skill installation to fail.')
		}
		expect(installed.error).toMatchObject({
			code: 'skill_install_conflict',
			message:
				'The work skill differs from one or more local copies; use --force to replace all supported targets.',
		})
		expect(installed.error.details).toContain('cleanupFailure=skill_install_lock_release_failed')
		expect(installed.error.details).toContain(
			'recovery=preserve the primary error and inspect the skill installation lock manually',
		)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacement)
	})

	it('preserves malformed lock content without echoing it or private paths', async () => {
		expect.hasAssertions()
		const root = await createRoot()
		const lockPath = resolve(root, '.work/skill-install.lock')
		const privateCanary = 'PRIVATE_LOCK_/Users/example/secret'
		const malformed = `${JSON.stringify({
			pid: NON_LIVE_PROCESS_ID,
			startedAt: new Date().toISOString(),
			nonce: randomUUID(),
			unexpected: privateCanary,
		})}\n`
		await writeFile(lockPath, malformed)

		const installed = await installWorkContractSkill({ root, force: false })

		expect(installed).toMatchObject({
			ok: false,
			error: {
				code: 'skill_install_failed',
				message: 'Another skill installation is active.',
			},
		})
		expect(JSON.stringify(installed)).not.toContain(root)
		expect(JSON.stringify(installed)).not.toContain(privateCanary)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe(malformed)
	})
})
