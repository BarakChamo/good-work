/**
 * @description Verifies trusted repository-root engineering hooks through their public service boundary.
 *
 * @module work/hooks
 * @file Hooks.test.ts
 */

import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WORK_SCHEMA_URL } from './release-identity'
import { executeFile } from './subprocess'
import {
	dispatchWorkHooks,
	initializeWorkHooks,
	inspectWorkHooks,
	statusWorkHooks,
	trustWorkHooks,
	untrustWorkHooks,
} from './hooks'

const roots: string[] = []

const run = async (command: string, args: readonly string[], cwd: string) => {
	const result = await executeFile(command, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })
	return result.stdout
}

const createRepository = async (): Promise<{ root: string; state: string }> => {
	const root = await mkdtemp(resolve(tmpdir(), 'work-hooks-repo-'))
	const state = await mkdtemp(resolve(tmpdir(), 'work-hooks-state-'))
	roots.push(root, state)
	await run('git', ['init', '-q'], root)
	await run('git', ['config', 'user.email', 'hooks@example.invalid'], root)
	await run('git', ['config', 'user.name', 'Hook Tests'], root)
	await writeFile(join(root, 'README.md'), 'fixture\n')
	await run('git', ['add', 'README.md'], root)
	await run('git', ['commit', '-qm', 'fixture'], root)
	return { root, state }
}

const writeCommittedConfig = async (root: string, document: unknown): Promise<void> => {
	await writeFile(join(root, 'work.json'), `${JSON.stringify(document, null, 2)}\n`)
	await run('git', ['add', 'work.json'], root)
	await run('git', ['commit', '-qm', 'configure hooks'], root)
}

const publicSchema = WORK_SCHEMA_URL

const config = (hooks: Readonly<Record<string, readonly unknown[]>>) => ({
	$schema: publicSchema,
	version: 1,
	hooks,
})

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('work engineering hooks', () => {
	it('creates a minimal root config without overwriting an existing file', async () => {
		expect.hasAssertions()
		const { root } = await createRepository()
		await mkdir(join(root, 'nested'))
		const initialized = await initializeWorkHooks({ cwd: join(root, 'nested') })
		expect(initialized).toMatchObject({ ok: true, value: { path: 'work.json', created: true } })
		expect(JSON.parse(await readFile(join(root, 'work.json'), 'utf8'))).toMatchObject({
			$schema: publicSchema,
			version: 1,
		})
		await expect(initializeWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'hooks_config_exists' },
		})
	})

	it('uses the immutable public schema even when a similarly named local schema exists', async () => {
		expect.hasAssertions()
		const { root } = await createRepository()
		await mkdir(join(root, 'packages/work-contract/schemas'), { recursive: true })
		await writeFile(join(root, 'packages/work-contract/schemas/work.schema.json'), '{}\n')
		await expect(initializeWorkHooks({ cwd: root })).resolves.toMatchObject({ ok: true })
		expect(JSON.parse(await readFile(join(root, 'work.json'), 'utf8'))).toMatchObject({
			$schema: publicSchema,
		})
	})

	it('serializes concurrent trust updates so linked worktrees retain both digests', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(root, config({}))
		const linked = await mkdtemp(resolve(tmpdir(), 'work-hooks-linked-'))
		await rm(linked, { recursive: true, force: true })
		roots.push(linked)
		await run('git', ['worktree', 'add', '--detach', linked, 'HEAD'], root)
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{ id: 'newer', command: 'true', output: { mode: 'silent', when: 'always' } },
				],
			}),
		)

		await expect(
			Promise.all([
				trustWorkHooks({ cwd: root, coordinationRoot: state }),
				trustWorkHooks({ cwd: linked, coordinationRoot: state }),
			]),
		).resolves.toMatchObject([{ ok: true }, { ok: true }])
		await expect(statusWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { trusted: true },
		})
		await expect(statusWorkHooks({ cwd: linked, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { trusted: true },
		})
	})

	it('validates strict event and output contracts and hashes exact committed content', async () => {
		expect.hasAssertions()
		const { root } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'context',
						command: 'bun',
						args: ['run', 'agent:context'],
						output: { mode: 'passthrough', when: 'always' },
					},
				],
			}),
		)
		const inspected = await inspectWorkHooks({ cwd: root })
		expect(inspected).toMatchObject({
			ok: true,
			value: {
				path: 'work.json',
				committed: true,
				entries: [{ event: 'sessionStart', id: 'context', command: 'bun' }],
			},
		})
		if (!inspected.ok) {
			throw new Error('Expected valid hook inspection.')
		}
		expect(inspected.value.digest).toMatch(/^[a-f0-9]{64}$/)

		await writeFile(
			join(root, 'work.json'),
			`${JSON.stringify(config({ sessionEnd: [{ id: 'bad', command: 'x', output: { mode: 'passthrough', when: 'always' } }] }))}\n`,
		)
		await expect(inspectWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_hooks_config' },
		})
	})

	it.each([
		['unknown field', { version: 1, hooks: {}, extra: true }],
		[
			'summarize without instruction',
			config({
				sessionStart: [{ id: 'x', command: 'x', output: { mode: 'summarize', when: 'always' } }],
			}),
		],
		[
			'instruction outside summarize',
			config({
				sessionStart: [
					{ id: 'x', command: 'x', output: { mode: 'silent', when: 'always', instruction: 'x' } },
				],
			}),
		],
		[
			'blocking outside stop',
			config({
				sessionStart: [
					{
						id: 'x',
						command: 'x',
						output: { mode: 'silent', when: 'always' },
						blockOnFailure: true,
					},
				],
			}),
		],
		[
			'session source outside start',
			config({
				beforeStop: [
					{
						id: 'x',
						command: 'x',
						when: { sessionSource: ['startup'] },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		],
		[
			'changed files outside edit',
			config({
				sessionStart: [
					{
						id: 'x',
						command: 'x',
						when: { changedFiles: { source: 'event' } },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		],
		[
			'duplicate identifiers',
			config({
				sessionStart: [{ id: 'x', command: 'x', output: { mode: 'silent', when: 'always' } }],
				sessionEnd: [{ id: 'x', command: 'x', output: { mode: 'silent', when: 'always' } }],
			}),
		],
		[
			'invalid glob escape',
			config({
				afterEdit: [
					{
						id: 'x',
						command: 'x',
						when: { changedFiles: { source: 'event', include: ['../*.ts'] } },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		],
		[
			'entry bound',
			config({
				sessionStart: Array.from({ length: 33 }, (_, index) => ({
					id: `x-${index}`,
					command: 'x',
					output: { mode: 'silent', when: 'always' },
				})),
			}),
		],
	] as const)('rejects invalid configuration: %s', async (_label, document) => {
		expect.hasAssertions()
		const { root } = await createRepository()
		await writeFile(join(root, 'work.json'), `${JSON.stringify(document)}\n`)
		await expect(inspectWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_hooks_config' },
		})
	})

	it('requires a clean committed digest and shares bounded trust through external project state', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(root, config({}))
		await expect(trustWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { trusted: true },
		})
		await expect(statusWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { present: true, valid: true, committed: true, trusted: true },
		})

		await writeFile(join(root, 'work.json'), `${JSON.stringify(config({ sessionStart: [] }))}\n`)
		await expect(statusWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { trusted: false, committed: false },
		})
		await expect(trustWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: false,
			error: { code: 'hooks_config_uncommitted' },
		})
	})

	it('executes trusted entries sequentially without a shell and passes normalized input', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		const script = join(root, 'record.ts')
		await writeFile(
			script,
			"const input = await Bun.stdin.text(); await Bun.write('order.txt', (await Bun.file('order.txt').exists() ? await Bun.file('order.txt').text() : '') + process.argv[2] + ':' + input + '\\n'); console.log(process.argv[2])\n",
		)
		await writeCommittedConfig(
			root,
			config({
				sessionStart: ['one', 'two'].map((id) => ({
					id,
					command: 'bun',
					args: ['./record.ts', id],
					output: { mode: 'passthrough', when: 'always' },
				})),
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({
				hook_event_name: 'SessionStart',
				session_id: 'private-session',
				source: 'startup',
				transcript_path: '/private/transcript',
			}),
		})
		expect(result).toMatchObject({
			ok: true,
			value: {
				status: 'executed',
				executions: [
					{ id: 'one', outcome: 'success' },
					{ id: 'two', outcome: 'success' },
				],
			},
		})
		const order = await readFile(join(root, 'order.txt'), 'utf8')
		expect(order).not.toContain('private-session')
		expect(order).not.toContain('transcript')
		expect(order).toContain(
			'one:{"event":"sessionStart","runtime":"codex","sessionSource":"startup"}',
		)
		expect(order.indexOf('one:')).toBeLessThan(order.indexOf('two:'))
	})

	it('applies runtime and session-source conditions without executing skipped entries', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'runtime',
						command: 'false',
						when: { runtime: ['claude'] },
						output: { mode: 'silent', when: 'always' },
					},
					{
						id: 'source',
						command: 'false',
						when: { sessionSource: ['resume'] },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await expect(
			dispatchWorkHooks({
				cwd: root,
				coordinationRoot: state,
				runtime: 'codex',
				nativeInput: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				executions: [
					{ id: 'runtime', outcome: 'skipped', skipReason: 'runtime' },
					{ id: 'source', outcome: 'skipped', skipReason: 'session_source' },
				],
			},
		})
	})

	it('keeps failure-only output out of context on success and returns it on failure', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'failure-only',
						command: 'fixture',
						output: { mode: 'passthrough', when: 'failure' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const invoke = async (exitCode: number) =>
			dispatchWorkHooks({
				cwd: root,
				coordinationRoot: state,
				runtime: 'codex',
				nativeInput: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
				runCommand: async () => ({
					exitCode,
					stdout: 'bounded output',
					stderr: '',
					timedOut: false,
				}),
			})
		const succeeded = await invoke(0)
		expect(succeeded.ok && succeeded.value.nativeOutput).toBeUndefined()
		const failed = await invoke(1)
		expect(failed.ok && failed.value.nativeOutput).toContain('bounded output')
	})

	it('runs file-filtered afterEdit entries from event, working tree, and staged sources', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeFile(
			join(root, 'counter.ts'),
			"await Bun.write('count.txt', ((await Bun.file('count.txt').exists() ? Number(await Bun.file('count.txt').text()) : 0) + 1).toString())\n",
		)
		await writeCommittedConfig(
			root,
			config({
				afterEdit: ['event', 'workingTree', 'staged'].map((source) => ({
					id: source,
					command: 'bun',
					args: ['./counter.ts'],
					when: { changedFiles: { source, include: ['**/*.ts'], exclude: ['**/*.generated.ts'] } },
					output: { mode: 'silent', when: 'always' },
				})),
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await writeFile(join(root, 'event.ts'), 'export {}\n')
		await writeFile(join(root, 'changed.ts'), 'export {}\n')
		await writeFile(join(root, 'staged.ts'), 'export {}\n')
		await run('git', ['add', 'staged.ts'], root)
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'claude',
			nativeInput: JSON.stringify({
				hook_event_name: 'PostToolUse',
				tool_name: 'Edit',
				tool_input: { file_path: join(root, 'event.ts') },
			}),
		})
		expect(result).toMatchObject({
			ok: true,
			value: {
				executions: [{ outcome: 'success' }, { outcome: 'success' }, { outcome: 'success' }],
			},
		})
		await expect(readFile(join(root, 'count.txt'), 'utf8')).resolves.toBe('3')
	})

	it('keeps untrusted hooks non-blocking and executes nothing', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				beforeStop: [
					{
						id: 'never',
						command: 'false',
						output: { mode: 'silent', when: 'always' },
						blockOnFailure: true,
					},
				],
			}),
		)
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
		})
		expect(result).toMatchObject({
			ok: true,
			value: { status: 'review_required', executions: [] },
		})
		expect(result.ok && result.value.nativeOutput).toContain('review')
	})

	it('keeps invalid repository configuration non-blocking during native dispatch', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionEnd: [{ id: 'bad', command: 'x', output: { mode: 'passthrough', when: 'always' } }],
			}),
		)
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'SessionEnd' }),
		})
		expect(result).toMatchObject({
			ok: true,
			value: { status: 'review_required', executions: [] },
		})
		expect(result.ok && result.value.nativeOutput).toBeUndefined()
	})

	it('keeps every SessionEnd result silent and applies the portable cleanup budget', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionEnd: [
					{
						id: 'cleanup',
						command: 'fixture',
						timeoutMs: 10_000,
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const timeouts: number[] = []
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'SessionEnd' }),
			runCommand: async (input) => {
				timeouts.push(input.timeoutMs)
				return { exitCode: 1, stdout: 'must stay private', stderr: '', timedOut: false }
			},
		})
		expect(timeouts).toHaveLength(1)
		expect(timeouts[0]).toBeGreaterThan(0)
		expect(timeouts[0]).toBeLessThanOrEqual(2500)
		expect(result.ok && result.value.nativeOutput).toBeUndefined()
	})

	it('summarizes failures in the current agent and blocks only the first stop cycle', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				beforeStop: [
					{
						id: 'check',
						command: 'sh',
						args: ['-c', 'printf failure-output; exit 3'],
						output: { mode: 'summarize', when: 'failure', instruction: 'Summarize failures.' },
						blockOnFailure: true,
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const first = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'claude',
			nativeInput: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
		})
		expect(first.ok && first.value.nativeOutput).toContain('"decision":"block"')
		expect(first.ok && first.value.nativeOutput).toContain('Summarize failures.')
		expect(first.ok && first.value.nativeOutput).toContain('failure-output')

		const repeated = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'claude',
			nativeInput: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }),
		})
		const repeatedOutput = repeated.ok ? repeated.value.nativeOutput : undefined
		expect(repeatedOutput).not.toContain('"decision":"block"')
		expect(repeatedOutput).toContain('"systemMessage"')
		expect(repeatedOutput).not.toContain('hookSpecificOutput')
		expect(repeatedOutput).toContain('failure-output')
	})

	it('blocks once even when the failing check has silent output', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				beforeStop: [
					{
						id: 'silent-check',
						command: 'false',
						output: { mode: 'silent', when: 'always' },
						blockOnFailure: true,
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
		})
		expect(result.ok && result.value.nativeOutput).toContain('"decision":"block"')
		expect(result.ok && result.value.nativeOutput).not.toContain('Command output')
	})

	it('rejects shell/path escapes, symlinked config, oversized input, and invalid event combinations', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				afterEdit: [
					{
						id: 'bad',
						command: '../outside',
						when: { sessionSource: ['startup'] },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await expect(inspectWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_hooks_config' },
		})
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'windows-traversal',
						command: '..\\outside',
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await expect(inspectWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'invalid_hooks_config' },
		})

		await rm(join(root, 'work.json'))
		await symlink(join(root, 'README.md'), join(root, 'work.json'))
		await expect(inspectWorkHooks({ cwd: root })).resolves.toMatchObject({
			ok: false,
			error: { code: 'hooks_config_unavailable' },
		})

		await expect(
			dispatchWorkHooks({
				cwd: root,
				coordinationRoot: state,
				runtime: 'codex',
				nativeInput: 'x'.repeat(300_000),
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'invalid_hook_input' } })
	})

	it('removes trust without touching repository configuration', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(root, config({}))
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await expect(untrustWorkHooks({ cwd: root, coordinationRoot: state })).resolves.toMatchObject({
			ok: true,
			value: { trusted: false },
		})
		await expect(readFile(join(root, 'work.json'), 'utf8')).resolves.toContain('"version": 1')
	})

	it('does not interpret command metacharacters and rejects a relative executable symlink escape', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		const outside = await mkdtemp(resolve(tmpdir(), 'work-hook-outside-'))
		roots.push(outside)
		const outsideScript = join(outside, 'outside.sh')
		await writeFile(outsideScript, '#!/bin/sh\ntouch escaped\n')
		await chmod(outsideScript, 0o700)
		await symlink(outsideScript, join(root, 'outside-link'))
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'literal',
						command: 'touch marker; touch injected',
						output: { mode: 'silent', when: 'always' },
					},
					{ id: 'symlink', command: './outside-link', output: { mode: 'silent', when: 'always' } },
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
		})
		expect(result).toMatchObject({
			ok: true,
			value: { executions: [{ outcome: 'failure' }, { outcome: 'failure' }] },
		})
		await expect(readFile(join(root, 'marker'), 'utf8')).rejects.toThrow('ENOENT')
		await expect(readFile(join(root, 'injected'), 'utf8')).rejects.toThrow('ENOENT')
		await expect(readFile(join(root, 'escaped'), 'utf8')).rejects.toThrow('ENOENT')
	})

	it('passes only bounded normalized changed files to matching entries', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeFile(join(root, 'changed.ts'), 'export {}\n')
		await writeFile(
			join(root, 'input.ts'),
			"await Bun.write('input.json', await Bun.stdin.text())\n",
		)
		await writeCommittedConfig(
			root,
			config({
				afterEdit: [
					{
						id: 'input',
						command: 'bun',
						args: ['./input.ts'],
						when: { changedFiles: { source: 'event', include: ['**/*.ts'] } },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({
				hook_event_name: 'PostToolUse',
				tool_name: 'apply_patch',
				tool_input: { path: join(root, 'changed.ts'), secret: 'PRIVATE' },
				transcript_path: '/private/path',
			}),
		})
		expect(JSON.parse(await readFile(join(root, 'input.json'), 'utf8'))).toStrictEqual({
			event: 'afterEdit',
			runtime: 'codex',
			changedFiles: ['changed.ts'],
		})
	})

	it('extracts bounded Codex apply-patch paths without forwarding patch content', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeFile(join(root, 'changed.ts'), 'export {}\n')
		await writeFile(
			join(root, 'input.ts'),
			"await Bun.write('input.json', await Bun.stdin.text())\n",
		)
		await writeCommittedConfig(
			root,
			config({
				afterEdit: [
					{
						id: 'input',
						command: 'bun',
						args: ['./input.ts'],
						when: { changedFiles: { source: 'event', include: ['**/*.ts'] } },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({
				hook_event_name: 'PostToolUse',
				tool_name: 'apply_patch',
				tool_input: {
					command:
						'*** Begin Patch\n*** Update File: changed.ts\n@@\n-PRIVATE\n+PUBLIC\n*** End Patch',
				},
			}),
		})
		const normalized = await readFile(join(root, 'input.json'), 'utf8')
		expect(JSON.parse(normalized)).toStrictEqual({
			event: 'afterEdit',
			runtime: 'codex',
			changedFiles: ['changed.ts'],
		})
		expect(normalized).not.toContain('PRIVATE')
	})

	it('normalizes relative Codex edit paths from a contained native working directory', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await mkdir(join(root, 'packages/example'), { recursive: true })
		await writeFile(join(root, 'packages/example/changed.ts'), 'export {}\n')
		await writeFile(
			join(root, 'input.ts'),
			"await Bun.write('input.json', await Bun.stdin.text())\n",
		)
		await writeCommittedConfig(
			root,
			config({
				afterEdit: [
					{
						id: 'input',
						command: 'bun',
						args: ['./input.ts'],
						when: { changedFiles: { source: 'event', include: ['packages/**/*.ts'] } },
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const result = await dispatchWorkHooks({
			cwd: join(root, 'packages/example'),
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({
				cwd: join(root, 'packages/example'),
				hook_event_name: 'PostToolUse',
				tool_name: 'apply_patch',
				tool_input: { command: '*** Begin Patch\n*** Update File: changed.ts\n*** End Patch' },
			}),
		})
		expect(result).toMatchObject({ ok: true, value: { executions: [{ outcome: 'success' }] } })
		expect(JSON.parse(await readFile(join(root, 'input.json'), 'utf8'))).toMatchObject({
			changedFiles: ['packages/example/changed.ts'],
		})
	})

	it('rejects a native working directory outside the resolved worktree', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		const outside = await mkdtemp(resolve(tmpdir(), 'work-hooks-native-outside-'))
		roots.push(outside)
		await writeCommittedConfig(root, config({ sessionStart: [] }))
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		await expect(
			dispatchWorkHooks({
				cwd: root,
				coordinationRoot: state,
				runtime: 'codex',
				nativeInput: JSON.stringify({
					cwd: outside,
					hook_event_name: 'SessionStart',
					source: 'startup',
				}),
			}),
		).resolves.toMatchObject({ ok: false, error: { code: 'invalid_hook_input' } })
	})

	it('force-terminates a command that ignores the configured timeout', async () => {
		expect.hasAssertions()
		const { root, state } = await createRepository()
		await writeCommittedConfig(
			root,
			config({
				sessionStart: [
					{
						id: 'timeout',
						command: 'node',
						args: [
							'-e',
							"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)",
						],
						timeoutMs: 20,
						output: { mode: 'silent', when: 'always' },
					},
				],
			}),
		)
		await trustWorkHooks({ cwd: root, coordinationRoot: state })
		const startedAt = Date.now()
		const result = await dispatchWorkHooks({
			cwd: root,
			coordinationRoot: state,
			runtime: 'codex',
			nativeInput: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
		})
		expect(Date.now() - startedAt).toBeLessThan(1500)
		expect(result).toMatchObject({
			ok: true,
			value: { executions: [{ id: 'timeout', outcome: 'timeout', exitCode: 124 }] },
		})
	}, 2000)
})
