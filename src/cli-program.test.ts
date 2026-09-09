/**
 * @description Verifies Stricli routing and adaptation independently from filesystem/provider operations.
 *
 * @module work/cli-program
 * @file Cli-program.test.ts
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runWorkContractProgram } from './cli-program'
import type { WorkContractInvocation } from './cli-program'

describe('stricli work-contract program', () => {
	it.each([
		[['overview'], 'overview', []],
		[['prepare', 'docs/work/ISSUE-1.md'], 'prepare', ['docs/work/ISSUE-1.md']],
		[['start', 'ISSUE-1', '--actor', 'agent-a'], 'start', ['ISSUE-1']],
		[['submit', 'ISSUE-1', '--actor', 'agent-a'], 'submit', ['ISSUE-1']],
		[['reconcile', 'ISSUE-1', '--actor', 'agent-a'], 'reconcile', ['ISSUE-1']],
		[['export'], 'export', []],
		[['status', 'ISSUE-1'], 'status', ['ISSUE-1']],
		[['hooks', 'init'], 'hooks', ['init']],
		[['hooks', 'inspect'], 'hooks', ['inspect']],
		[['hooks', 'trust'], 'hooks', ['trust']],
		[['hooks', 'untrust'], 'hooks', ['untrust']],
		[['hooks', 'status'], 'hooks', ['status']],
		[['hooks', 'dispatch', '--runtime', 'claude'], 'hooks', ['dispatch']],
		[['provider', 'install'], 'provider', ['install']],
	] as const)('routes the agent-native %s command', async (args, command, positionals) => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const status = await runWorkContractProgram({
			args,
			io: { stdout: (): void => undefined, stderr: (): void => undefined },
			execute: async (invocation): Promise<number> => {
				invocations.push(invocation)
				return 0
			},
		})

		expect(status).toBe(0)
		expect(invocations).toMatchObject([{ command, positionals }])
	})

	it('defaults empty argv to overview but rejects an unknown root route', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const stderr: string[] = []
		const execute = async (invocation: WorkContractInvocation): Promise<number> => {
			invocations.push(invocation)
			return 0
		}

		await expect(
			runWorkContractProgram({
				args: [],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute,
			}),
		).resolves.toBe(0)
		await expect(
			runWorkContractProgram({
				args: ['frobnicate'],
				io: { stdout: (): void => undefined, stderr: (value): void => void stderr.push(value) },
				execute,
			}),
		).resolves.toBe(2)

		expect(invocations).toMatchObject([{ command: 'overview' }])
		expect(stderr).toStrictEqual(['Unknown work command; run work --help'])
	})

	it.each([
		[['--json'], { json: true }],
		[['--root', '/repo', '--json'], { root: '/repo', json: true }],
		[['--no-json'], { json: false }],
	] as const)('defaults global-only argv to overview: %j', async (args, expected) => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const status = await runWorkContractProgram({
			args,
			io: { stdout: (): void => undefined, stderr: (): void => undefined },
			execute: async (invocation): Promise<number> => {
				invocations.push(invocation)
				return 0
			},
		})

		expect(status).toBe(0)
		expect(invocations).toHaveLength(1)
		expect(invocations[0]).toMatchObject({ command: 'overview', ...expected })
	})

	it('renders the root command index for bare --help without invoking overview', async () => {
		expect.hasAssertions()
		const stdout: string[] = []
		const invocations: WorkContractInvocation[] = []

		await expect(
			runWorkContractProgram({
				args: ['--help'],
				io: { stdout: (value): void => void stdout.push(value), stderr: (): void => undefined },
				execute: async (invocation): Promise<number> => {
					invocations.push(invocation)
					return 0
				},
			}),
		).resolves.toBe(0)
		expect(invocations).toStrictEqual([])
		expect(stdout.join('\n')).toContain('init')
		expect(stdout.join('\n')).toContain('overview')
		expect(stdout.join('\n')).toContain('reconcile')
		expect(stdout.join('\n')).toContain('export')
		expect(stdout.join('\n')).toContain('hooks')
	})

	it('normalizes global flags around routes and preserves repeatable command flags', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const status = await runWorkContractProgram({
			args: [
				'--root',
				'/repo',
				'--json',
				'complete',
				'ISSUE-1',
				'--actor',
				'agent-a',
				'--evidence',
				'test=artifacts/test.txt',
				'--evidence',
				'review=https://example.test/review',
				'--receipt',
				'artifacts/ci-receipt.json',
			],
			io: { stdout: (): void => undefined, stderr: (): void => undefined },
			execute: async (invocation): Promise<number> => {
				invocations.push(invocation)
				return 0
			},
		})

		expect(status).toBe(0)
		expect(invocations).toHaveLength(1)
		expect(invocations[0]?.binary).toContain('@beads')
		expect(invocations).toStrictEqual([
			{
				root: '/repo',
				manifestPath: 'work.yaml',
				binary: invocations[0]?.binary,
				json: true,
				command: 'complete',
				positionals: ['ISSUE-1'],
				options: {
					actor: ['agent-a'],
					evidence: ['test=artifacts/test.txt', 'review=https://example.test/review'],
					receipt: ['artifacts/ci-receipt.json'],
				},
			},
		])
	})

	it.each([
		[
			['--root=/repo-before', '--json=false', 'show', 'ISSUE-1', '--json'],
			{ root: '/repo-before', json: true, manifestPath: 'work.yaml' },
		],
		[
			[
				'proposal',
				'validate',
				'PLAN-1',
				'--json=true',
				'--manifest=plans/work.yaml',
				'--bd=/tools/bd',
				'--root=/repo-after',
			],
			{
				root: '/repo-after',
				json: true,
				manifestPath: 'plans/work.yaml',
				binary: '/tools/bd',
			},
		],
		[['--json', 'show', 'ISSUE-1', '--no-json'], { json: false }],
	] as const)(
		'normalizes common option forms with last occurrence winning: %j',
		async (args, expected) => {
			expect.hasAssertions()
			const invocations: WorkContractInvocation[] = []
			const status = await runWorkContractProgram({
				args,
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute: async (invocation): Promise<number> => {
					invocations.push(invocation)
					return 0
				},
			})

			expect(status).toBe(0)
			expect(invocations).toHaveLength(1)
			expect(invocations[0]).toMatchObject(expected)
		},
	)

	it('discovers the nearest work manifest without crossing the Git root', async () => {
		expect.hasAssertions()
		const previousCwd = process.cwd()
		const sandbox = await mkdtemp(resolve(tmpdir(), 'work-cli-root-'))
		const outer = resolve(sandbox, 'outer')
		const repository = resolve(outer, 'repository')
		const nested = resolve(repository, 'nested path', 'deeper')
		try {
			await mkdir(resolve(repository, '.git'), { recursive: true })
			await mkdir(nested, { recursive: true })
			await writeFile(resolve(outer, 'work.yaml'), 'version: 1\n')
			await writeFile(resolve(repository, 'work.yaml'), 'version: 1\n')
			process.chdir(nested)
			const invocations: WorkContractInvocation[] = []
			await expect(
				runWorkContractProgram({
					args: ['overview'],
					io: { stdout: (): void => undefined, stderr: (): void => undefined },
					execute: async (invocation): Promise<number> => {
						invocations.push(invocation)
						return 0
					},
				}),
			).resolves.toBe(0)
			expect(invocations[0]?.root).toBe(await realpath(repository))

			await rm(resolve(repository, 'work.yaml'))
			invocations.length = 0
			await runWorkContractProgram({
				args: ['overview'],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute: async (invocation): Promise<number> => {
					invocations.push(invocation)
					return 0
				},
			})
			expect(invocations[0]?.root).toBe(await realpath(nested))
		} finally {
			process.chdir(previousCwd)
			await rm(sandbox, { recursive: true, force: true })
		}
	})

	it('redacts the invocation root from executor error output', async () => {
		expect.hasAssertions()
		const root = resolve(tmpdir(), 'private-work-root')
		const stderr: string[] = []
		const status = await runWorkContractProgram({
			args: ['show', 'ISSUE-1', '--root', root, '--json'],
			io: { stdout: (): void => undefined, stderr: (value): void => void stderr.push(value) },
			execute: async (invocation, io): Promise<number> => {
				io.stderr(
					JSON.stringify({
						ok: false,
						error: {
							type: 'work_contract_error',
							code: 'invalid_work_manifest',
							message: 'Manifest cannot be read.',
							details: [
								`ENOENT: realpath '${invocation.root}/work.yaml'`,
								"EACCES: open '/Users/private/package/skills/work/SKILL.md'",
							],
						},
					}),
				)
				return 1
			},
		})

		expect(status).toBe(1)
		expect(stderr.join('\n')).not.toContain(root)
		expect(stderr.join('\n')).toContain('<root>/work.yaml')
		expect(stderr.join('\n')).not.toContain('/Users/private/package')
		expect(stderr.join('\n')).toContain("EACCES: open '<path>'")
	})

	it('routes nested proposal commands and kebab-case flags', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		await expect(
			runWorkContractProgram({
				args: [
					'proposal',
					'apply',
					'PLAN-1',
					'--approve',
					'a'.repeat(64),
					'--allow-delete',
					'--root',
					'/repo-after-route',
				],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute: async (invocation): Promise<number> => {
					invocations.push(invocation)
					return 0
				},
			}),
		).resolves.toBe(0)
		expect(invocations[0]).toMatchObject({
			root: '/repo-after-route',
			command: 'proposal',
			positionals: ['apply', 'PLAN-1'],
			options: { approve: ['a'.repeat(64)], 'allow-delete': ['true'] },
		})
	})

	it.each([
		['touch', []],
		['resume', []],
		['handoff', ['--summary-file', 'handoff.md']],
		['block', ['--reason', 'blocked']],
		['release', ['--reason', 'released']],
		['reopen', ['--reason', 'reopened']],
		['complete', []],
	] as const)('routes role and session assertions for %s', async (route, extra) => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const status = await runWorkContractProgram({
			args: [
				route,
				'ISSUE-1',
				'--actor',
				'agent-a',
				'--role',
				'implementer',
				'--session',
				'session-a',
				...extra,
			],
			io: { stdout: (): void => undefined, stderr: (): void => undefined },
			execute: async (invocation): Promise<number> => {
				invocations.push(invocation)
				return 0
			},
		})

		expect(status).toBe(0)
		expect(invocations[0]).toMatchObject({
			command: route,
			options: { actor: ['agent-a'], role: ['implementer'], session: ['session-a'] },
		})
	})

	it('names the selected route without echoing an unknown flag', async () => {
		expect.hasAssertions()
		const stderr: string[] = []
		const privateFlag = '--unknown-private-value'
		const status = await runWorkContractProgram({
			args: ['complete', 'ISSUE-1', '--actor', 'agent-a', privateFlag],
			io: { stdout: (): void => undefined, stderr: (value): void => void stderr.push(value) },
			execute: async (): Promise<number> => 0,
		})

		expect(status).toBe(2)
		expect(stderr.join('\n')).toContain('Invalid arguments for work complete')
		expect(stderr.join('\n')).toContain('run work complete --help')
		expect(stderr.join('\n')).not.toContain(privateFlag)
		expect(stderr.join('\n')).not.toContain('--root')
	})

	it.each([
		['routing', (canary: string) => [canary, '--json']],
		['flag', (canary: string) => ['complete', 'ISSUE-1', `--${canary}`, '--json']],
		['positional', (canary: string) => ['complete', 'ISSUE-1', canary, '--json']],
	] as const)('bounds and redacts oversized %s parser input', async (_label, createArgs) => {
		expect.hasAssertions()
		const canary = `PRIVATE_ARG_${'x'.repeat(50_000)}`
		const stderr: string[] = []

		const status = await runWorkContractProgram({
			args: createArgs(canary),
			io: { stdout: (): void => undefined, stderr: (value): void => void stderr.push(value) },
			execute: async (): Promise<number> => 0,
		})

		expect(status).toBe(2)
		expect(stderr).toHaveLength(1)
		expect(Buffer.byteLength(stderr[0] ?? '', 'utf8')).toBeLessThan(256)
		expect(stderr[0]).not.toContain(canary)
		expect(JSON.parse(stderr[0] ?? '')).toMatchObject({
			ok: false,
			error: { type: 'work_contract_error', code: 'invalid_cli_invocation' },
		})
	})

	it('normalizes global flags after the nested skill route', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		await expect(
			runWorkContractProgram({
				args: ['skill', 'install', '--force', '--root', '/repo-after-skill', '--json'],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute: async (invocation): Promise<number> => {
					invocations.push(invocation)
					return 0
				},
			}),
		).resolves.toBe(0)
		expect(invocations).toMatchObject([
			{
				root: '/repo-after-skill',
				json: true,
				command: 'skill',
				positionals: ['install'],
				options: { force: ['true'] },
			},
		])
	})

	it('routes feedback and nested telemetry commands without leaking free-form inputs', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const execute = async (invocation: WorkContractInvocation): Promise<number> => {
			invocations.push(invocation)
			return 0
		}
		await expect(
			runWorkContractProgram({
				args: [
					'feedback',
					'--kind',
					'friction',
					'--message',
					'Hard to discover session identity.',
					'--work-id',
					'ISSUE-1',
					'--session',
					'session-1',
				],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute,
			}),
		).resolves.toBe(0)
		await expect(
			runWorkContractProgram({
				args: [
					'telemetry',
					'show',
					'--limit',
					'20',
					'--session-id',
					'session-1',
					'--work-id',
					'ISSUE-1',
					'--json',
				],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute,
			}),
		).resolves.toBe(0)
		await expect(
			runWorkContractProgram({
				args: ['telemetry', 'sessions', '--limit', '5', '--json'],
				io: { stdout: (): void => undefined, stderr: (): void => undefined },
				execute,
			}),
		).resolves.toBe(0)
		expect(invocations).toMatchObject([
			{
				command: 'feedback',
				options: {
					kind: ['friction'],
					message: ['Hard to discover session identity.'],
					'work-id': ['ISSUE-1'],
					session: ['session-1'],
				},
			},
			{
				command: 'telemetry',
				positionals: ['show'],
				options: {
					limit: ['20'],
					'session-id': ['session-1'],
					'work-id': ['ISSUE-1'],
				},
				json: true,
			},
			{
				command: 'telemetry',
				positionals: ['sessions'],
				options: { limit: ['5'] },
				json: true,
			},
		])
	})

	it('routes repository finalization and the simple integration mutex', async () => {
		expect.hasAssertions()
		const invocations: WorkContractInvocation[] = []
		const execute = async (invocation: WorkContractInvocation): Promise<number> => {
			invocations.push(invocation)
			return 0
		}
		for (const args of [
			['finalize', 'ISSUE-1', '--actor', 'worker', '--evidence', 'artifact=report.md'],
			['integration', 'status'],
			['integration', 'acquire', '--actor', 'integrator', '--session', 's1'],
			['integration', 'release', '--actor', 'integrator', '--session', 's1', '--nonce', 'nonce-1'],
			['integration', 'recover', '--actor', 'other', '--reason', 'holder stopped'],
		] as const) {
			await expect(
				runWorkContractProgram({
					args,
					io: { stdout: (): void => undefined, stderr: (): void => undefined },
					execute,
				}),
			).resolves.toBe(0)
		}
		expect(invocations).toMatchObject([
			{ command: 'finalize', positionals: ['ISSUE-1'], options: { actor: ['worker'] } },
			{ command: 'integration', positionals: ['status'] },
			{ command: 'integration', positionals: ['acquire'], options: { actor: ['integrator'] } },
			{
				command: 'integration',
				positionals: ['release'],
				options: { actor: ['integrator'], nonce: ['nonce-1'] },
			},
			{ command: 'integration', positionals: ['recover'], options: { actor: ['other'] } },
		])
	})
})
