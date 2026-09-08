/**
 * @description Verifies filesystem and shutdown isolation for the non-shipped live evaluator.
 *
 * @module work/evals/eval-security
 * @file Eval-security.int.test.ts
 */

import { spawnSync } from 'node:child_process'
import {
	chmod,
	link,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	assertCanonicalDirectory,
	createPrivateDirectoryPath,
	dockerRunArguments,
	establishWorkFixtureBoundary,
	readBoundedContainedUtf8,
	readContainedDirectoryEntries,
	removeDockerContainer,
	safeGitArguments,
	safeGitEnvironment,
	shutdownEvalResources,
	trustedExecutablePath,
	writeExclusivePrivateFile,
} from './eval-security'

let root: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-eval-security-'))
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('live eval filesystem isolation', () => {
	it('ignores an executable PATH canary while selecting trusted tools', async () => {
		expect.hasAssertions()
		const canary = join(root, 'executed')
		const fake = join(root, 'git')
		await writeFile(fake, `#!/bin/sh\ntouch ${JSON.stringify(canary)}\n`)
		await chmod(fake, 0o700)
		const selected = trustedExecutablePath('true', ['/usr/bin/true'])
		const result = spawnSync(selected, [], {
			env: { PATH: root },
			encoding: 'utf8',
		})
		expect(result.status).toBe(0)
		await expect(readFile(canary)).rejects.toThrow(/ENOENT/)
	})

	it('builds a least-privilege Docker invocation without sibling artifact access', () => {
		expect.hasAssertions()
		const dockerArguments = dockerRunArguments({
			image: 'work-contract-eval:test',
			name: 'work-contract-eval-one',
			workspace: '/private/eval/fixtures/one',
			runtimeHome: '/private/eval/runtime-homes/codex',
			runtime: 'codex',
			runId: 'run-1',
			uid: 501,
			gid: 20,
			command: 'codex',
			arguments: ['--version'],
		})
		const source = dockerArguments.join('\n')
		expect(dockerArguments.filter((value) => value === '--mount')).toHaveLength(2)
		expect(source).toContain('type=bind,src=/private/eval/fixtures/one,dst=/workspace')
		expect(source).toContain('type=bind,src=/private/eval/runtime-homes/codex,dst=/runtime-home')
		expect(source).toContain('--read-only')
		expect(source).toContain('no-new-privileges=true')
		expect(source).toContain('CODEX_HOME=/runtime-home/.codex')
		expect(source).not.toContain('/private/eval/raw')
		expect(source).not.toContain('/private/eval/controller')
		expect(source).not.toContain('/var/run/docker.sock')
		expect(source).toContain('host.docker.internal:127.0.0.1')
	})

	it('accepts only canonical regular directories as Docker bind sources', async () => {
		expect.hasAssertions()
		const canonical = await realpath(await createPrivateDirectoryPath(root, ['canonical']))
		await symlink(canonical, join(root, 'linked'))
		await expect(assertCanonicalDirectory(canonical)).resolves.toBeUndefined()
		await expect(assertCanonicalDirectory(join(root, 'linked'))).rejects.toThrow(/non-canonical/)
	})

	it('overrides executable Git configuration while scoring an agent-owned repository', async () => {
		expect.hasAssertions()
		const canary = join(root, 'git-config-executed')
		const hook = join(root, 'hostile-fsmonitor.sh')
		await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(canary)}\n`)
		await chmod(hook, 0o700)
		const repository = await createPrivateDirectoryPath(root, ['repository'])
		const environment = safeGitEnvironment({ HOME: root, PATH: processEnvironment.PATH ?? '' })
		const runGit = (arguments_: readonly string[]) =>
			spawnSync('git', safeGitArguments(arguments_), {
				cwd: repository,
				env: environment,
				encoding: 'utf8',
			})
		expect(runGit(['init', '--quiet']).status).toBe(0)
		expect(runGit(['config', 'core.fsmonitor', hook]).status).toBe(0)
		expect(runGit(['status', '--porcelain']).status).toBe(0)
		await expect(readFile(canary)).rejects.toThrow(/ENOENT/)
	})

	it('rejects a symlinked artifact ancestor before creating descendants', async () => {
		expect.hasAssertions()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-eval-outside-'))
		await symlink(outside, join(root, 'artifacts'))
		try {
			await expect(
				createPrivateDirectoryPath(root, ['artifacts', 'work-contract-evals']),
			).rejects.toThrow(/private directory boundary/)
			await expect(readFile(join(outside, 'work-contract-evals'))).rejects.toThrow(/ENOENT/)
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})

	it('establishes a local Beads boundary beneath an ancestor repository', async () => {
		expect.hasAssertions()
		const parentBeads = await createPrivateDirectoryPath(root, ['.beads'])
		const fixture = await realpath(await createPrivateDirectoryPath(root, ['artifacts', 'fixture']))

		const fixtureBeads = await establishWorkFixtureBoundary(fixture)

		expect(fixtureBeads).toBe(join(fixture, '.beads'))
		await expect(realpath(fixtureBeads)).resolves.toBe(fixtureBeads)
		await expect(realpath(parentBeads)).resolves.not.toBe(fixtureBeads)
	})

	it('binds a contained file read to the opened inode and rejects hard links', async () => {
		expect.hasAssertions()
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-eval-outside-'))
		const canary = join(outside, 'canary')
		await writeFile(canary, 'private\n')
		await link(canary, join(root, 'hard-link'))
		await writeFile(join(root, 'regular'), 'accepted\n')
		try {
			await expect(
				readBoundedContainedUtf8(root, join(root, 'hard-link'), 1024),
			).resolves.toBeUndefined()
			await expect(readBoundedContainedUtf8(root, join(root, 'regular'), 1024)).resolves.toBe(
				'accepted\n',
			)
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})

	it('binds directory enumeration to an opened contained directory', async () => {
		expect.hasAssertions()
		await mkdir(join(root, 'records'))
		await writeFile(join(root, 'records', 'one.json'), '{}\n')
		await expect(
			readContainedDirectoryEntries(root, join(root, 'records'), 10),
		).resolves.toStrictEqual(['one.json'])
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-eval-outside-'))
		await symlink(outside, join(root, 'linked-records'))
		try {
			await expect(
				readContainedDirectoryEntries(root, join(root, 'linked-records'), 10),
			).resolves.toStrictEqual([])
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})

	it('creates raw output exclusively and rejects symlink and hard-link destinations', async () => {
		expect.hasAssertions()
		const raw = await createPrivateDirectoryPath(root, ['raw'])
		const outside = await mkdtemp(join(tmpdir(), 'work-contract-eval-outside-'))
		const canary = join(outside, 'canary')
		await writeFile(canary, 'unchanged\n')
		await symlink(canary, join(raw, 'symlink.txt'))
		await link(canary, join(raw, 'hard-link.txt'))
		try {
			await expect(
				writeExclusivePrivateFile(raw, join(raw, 'symlink.txt'), 'overwrite'),
			).rejects.toThrow(/private file boundary/)
			await expect(
				writeExclusivePrivateFile(raw, join(raw, 'hard-link.txt'), 'overwrite'),
			).rejects.toThrow(/private file boundary/)
			await expect(
				writeExclusivePrivateFile(raw, join(raw, 'fresh.txt'), 'retained\n'),
			).resolves.toBeUndefined()
			await expect(readFile(canary, 'utf8')).resolves.toBe('unchanged\n')
			await expect(readFile(join(raw, 'fresh.txt'), 'utf8')).resolves.toBe('retained\n')
		} finally {
			await rm(outside, { force: true, recursive: true })
		}
	})
})

describe('live eval signal shutdown', () => {
	it('stops, kills, removes, and verifies a Docker container', async () => {
		expect.hasAssertions()
		const calls: string[][] = []
		const removed = await removeDockerContainer({
			name: 'work-contract-eval-one',
			execute: async (arguments_) => {
				calls.push([...arguments_])
				return { status: arguments_[0] === 'inspect' ? 1 : 0 }
			},
		})
		expect(removed).toBe(true)
		expect(calls).toStrictEqual([
			['stop', '--time', '2', 'work-contract-eval-one'],
			['kill', 'work-contract-eval-one'],
			['rm', '--force', 'work-contract-eval-one'],
			['inspect', 'work-contract-eval-one'],
		])
	})

	it('terminates detached groups before awaiting credential cleanup', async () => {
		expect.hasAssertions()
		const events: string[] = []
		let firstClosed = false
		let secondClosed = false
		const result = await shutdownEvalResources({
			groups: [
				{
					pid: 101,
					closed: Promise.resolve().then(() => {
						firstClosed = true
					}),
					isClosed: () => firstClosed,
				},
				{ pid: 202, closed: new Promise<void>(() => {}), isClosed: () => secondClosed },
			],
			killGroup: (pid, signal) => {
				events.push(`${signal}:${pid}`)
				if (signal === 'SIGKILL' && pid === 202) {
					secondClosed = true
				}
			},
			wait: async () => {},
			cleanupCredentials: async () => {
				events.push('cleanup')
				return true
			},
			graceMs: 1,
		})

		expect(result).toStrictEqual({ processesTerminated: true, credentialsRemoved: true })
		expect(events).toStrictEqual(['SIGTERM:101', 'SIGTERM:202', 'SIGKILL:202', 'cleanup'])
	})
})
