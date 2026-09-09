/**
 * @description Verifies strict, repeatable work-contract CLI parsing and discovery help.
 *
 * @module work/cli
 * @file Cli.test.ts
 */

/* oxlint-disable vitest/prefer-expect-assertions -- Parser tests use direct synchronous expectations. */

import {
	access,
	chmod,
	link,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { runWorkContractCli } from './cli'
import { recordCliFailureTelemetry } from './dogfood'
import { INPUT_LIMITS } from './files'
import { executeFile } from './subprocess'

const collectCliOutput = async (args: readonly string[], output: string[]) =>
	runWorkContractCli(args, {
		stdout: (value): void => {
			output.push(value)
		},
		stderr: (): void => undefined,
	})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJsonRecord = (source: string): Readonly<Record<string, unknown>> => {
	const value: unknown = JSON.parse(source)
	if (!isRecord(value)) {
		throw new TypeError('Expected a JSON object.')
	}
	return value
}

const recordField = (
	record: Readonly<Record<string, unknown>>,
	key: string,
): Readonly<Record<string, unknown>> => {
	const value = record[key]
	if (!isRecord(value)) {
		throw new TypeError(`Expected ${key} to be an object.`)
	}
	return value
}

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string => {
	const value = record[key]
	if (typeof value !== 'string') {
		throw new TypeError(`Expected ${key} to be a string.`)
	}
	return value
}

describe('work-contract CLI', () => {
	it('operates the complete trusted hook flow through the public Stricli CLI', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-hooks-cli-'))
		const state = await mkdtemp(resolve(tmpdir(), 'work-hooks-cli-state-'))
		const previousStateHome = processEnvironment.WORK_CONTRACT_STATE_HOME
		const git = async (args: readonly string[]) =>
			executeFile('git', args, { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 })
		const output: string[] = []
		const errors: string[] = []
		const invoke = async (args: readonly string[], stdin?: string) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void output.push(value),
				stderr: (value): void => void errors.push(value),
				...(stdin === undefined ? {} : { stdin: async (): Promise<string> => stdin }),
			})
		try {
			processEnvironment.WORK_CONTRACT_STATE_HOME = state
			await git(['init', '-q'])
			await git(['config', 'user.email', 'hooks@example.invalid'])
			await git(['config', 'user.name', 'Hook Tests'])
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject:\n  id: hooks\n  uid: 00000000-0000-4000-8000-000000000001\nsources: []\n',
			)
			await git(['add', 'work.yaml'])
			await git(['commit', '-qm', 'initialize'])
			await expect(invoke(['hooks', 'init'])).resolves.toBe(0)
			await writeFile(
				resolve(root, 'work.json'),
				`${JSON.stringify(
					{
						version: 1,
						hooks: {
							sessionStart: [
								{
									id: 'hello',
									command: 'node',
									args: ['-e', "console.log('project context')"],
									output: { mode: 'passthrough', when: 'always' },
								},
							],
						},
					},
					null,
					2,
				)}\n`,
			)
			await git(['add', 'work.json'])
			await git(['commit', '-qm', 'configure hooks'])
			await expect(invoke(['hooks', 'inspect'])).resolves.toBe(0)
			await expect(invoke(['hooks', 'trust'])).resolves.toBe(0)
			await expect(invoke(['hooks', 'status'])).resolves.toBe(0)
			const status = parseJsonRecord(output.at(-1) ?? '')
			const statusValue = recordField(status, 'value')
			expect(statusValue).toMatchObject({
				cliAvailable: true,
				pluginArtifactPresent: true,
				pluginInvocationActive: false,
			})
			expect(statusValue).not.toHaveProperty('pluginAvailable')
			expect(statusValue).not.toHaveProperty('pluginActive')
			await expect(
				invoke(
					['hooks', 'dispatch', '--runtime', 'codex'],
					JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
				),
			).resolves.toBe(0)
			expect(output.some((value) => value.includes('project context'))).toBe(true)
			expect(errors).toStrictEqual([])
		} finally {
			if (previousStateHome === undefined) {
				delete processEnvironment.WORK_CONTRACT_STATE_HOME
			} else {
				processEnvironment.WORK_CONTRACT_STATE_HOME = previousStateHome
			}
			await Promise.all([
				rm(root, { recursive: true, force: true }),
				rm(state, { recursive: true, force: true }),
			])
		}
	})

	it('documents the package-scoped human and agent workflow commands', async () => {
		const output: string[] = []
		await expect(
			runWorkContractCli(['--root', '/unused-for-help', 'help'], {
				stdout: (value): void => {
					output.push(value)
				},
				stderr: (): void => undefined,
			}),
		).resolves.toBe(0)
		const help = output.join('\n')
		expect(help).toContain('sync')
		expect(help).toContain('context')
		expect(help).toContain('proposal')
		expect(help).toContain('skill')
		expect(help).toContain('feedback')
		expect(help).toContain('telemetry')
		expect(help).toContain('reconcile')
		expect(help).toContain('finalize')
		expect(help).toContain('integration')
		expect(help).toContain('export')
		expect(help).toContain('work')
		expect(help).not.toContain('symphony-work')
	})

	it('provides generated command-specific help through the public CLI', async () => {
		const output: string[] = []
		await expect(
			runWorkContractCli(['sync', '--help'], {
				stdout: (value): void => {
					output.push(value)
				},
				stderr: (): void => undefined,
			}),
		).resolves.toBe(0)
		expect(output.join('\n')).toContain('--archive-missing')
		expect(output.join('\n')).toContain('--apply')
	})

	it('documents approval as required only for proposal apply', async () => {
		const apply: string[] = []
		const validate: string[] = []
		await expect(collectCliOutput(['proposal', 'apply', '--help'], apply)).resolves.toBe(0)
		await expect(collectCliOutput(['proposal', 'validate', '--help'], validate)).resolves.toBe(0)
		expect(apply.join('\n')).toContain('(--approve')
		expect(validate.join('\n')).not.toContain('--approve')
	})

	it('installs the packaged skill idempotently and requires force to replace local changes', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-skill-'))
		const invoke = async (args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => {
					stdout.push(value)
				},
				stderr: (value): void => {
					stderr.push(value)
				},
			})
			return { status, stdout, stderr }
		}
		try {
			const target = resolve(root, '.agents/skills/work/SKILL.md')
			const referenceTarget = resolve(root, '.agents/skills/work/references/commands.md')
			const metadataTarget = resolve(root, '.agents/skills/work/agents/openai.yaml')
			const claudeTarget = resolve(root, '.claude/skills/work/SKILL.md')
			const claudeReferenceTarget = resolve(root, '.claude/skills/work/references/commands.md')
			const source = resolve(import.meta.dirname, '../skills/work/SKILL.md')
			const referenceSource = resolve(import.meta.dirname, '../skills/work/references/commands.md')
			const metadataSource = resolve(import.meta.dirname, '../skills/work/agents/openai.yaml')
			const legacySource = resolve(
				import.meta.dirname,
				'../skills/work/migrations/work-contract-v1.md',
			)
			const legacyTargets = [
				resolve(root, '.agents/skills/work-contract/SKILL.md'),
				resolve(root, '.claude/skills/work-contract/SKILL.md'),
			]
			for (const legacyTarget of legacyTargets) {
				await mkdir(resolve(legacyTarget, '..'), { recursive: true })
				await writeFile(legacyTarget, await readFile(legacySource, 'utf8'))
			}
			const installed = await invoke(['skill', 'install'])
			expect(installed.status).toBe(0)
			expect(JSON.parse(installed.stdout[0] ?? '')).toStrictEqual({
				ok: true,
				value: {
					installed: [
						'.agents/skills/work/SKILL.md',
						'.agents/skills/work/references/commands.md',
						'.agents/skills/work/agents/openai.yaml',
						'.claude/skills/work/SKILL.md',
						'.claude/skills/work/references/commands.md',
					],
					changed: true,
				},
			})
			await expect(readFile(target, 'utf8')).resolves.toBe(await readFile(source, 'utf8'))
			for (const legacyTarget of legacyTargets) {
				await expect(access(legacyTarget)).rejects.toThrow('ENOENT')
			}
			await expect(readFile(referenceTarget, 'utf8')).resolves.toBe(
				await readFile(referenceSource, 'utf8'),
			)
			await expect(readFile(metadataTarget, 'utf8')).resolves.toBe(
				await readFile(metadataSource, 'utf8'),
			)
			await expect(readFile(claudeTarget, 'utf8')).resolves.toBe(await readFile(source, 'utf8'))
			await expect(readFile(claudeReferenceTarget, 'utf8')).resolves.toBe(
				await readFile(referenceSource, 'utf8'),
			)
			await expect(readFile(target, 'utf8')).resolves.toContain('name: work')
			await expect(readFile(target, 'utf8')).resolves.toContain('overview --json')
			await expect(readFile(target, 'utf8')).resolves.toContain(
				'Always use\n`prepare` for either form',
			)
			await expect(readFile(target, 'utf8')).resolves.toContain(
				'[references/commands.md](references/commands.md)',
			)
			await expect(readFile(target, 'utf8')).resolves.toContain('collision-resistant')
			await expect(readFile(target, 'utf8')).resolves.toContain('parallel')

			const repeated = await invoke(['skill', 'install'])
			expect(repeated.status).toBe(0)
			expect(JSON.parse(repeated.stdout[0] ?? '')).toMatchObject({
				ok: true,
				value: {
					installed: [
						'.agents/skills/work/SKILL.md',
						'.agents/skills/work/references/commands.md',
						'.agents/skills/work/agents/openai.yaml',
						'.claude/skills/work/SKILL.md',
						'.claude/skills/work/references/commands.md',
					],
					changed: false,
				},
			})

			await rm(target)
			await writeFile(claudeTarget, 'local customization\n')
			const conflict = await invoke(['skill', 'install'])
			expect(conflict.status).toBe(1)
			expect(JSON.parse(conflict.stderr[0] ?? '')).toMatchObject({
				ok: false,
				error: { code: 'skill_install_conflict' },
			})
			await expect(access(target)).rejects.toThrow('ENOENT')
			await expect(readFile(claudeTarget, 'utf8')).resolves.toBe('local customization\n')

			const replaced = await invoke(['skill', 'install', '--force'])
			expect(replaced.status).toBe(0)
			await expect(readFile(target, 'utf8')).resolves.toBe(await readFile(source, 'utf8'))
			await expect(readFile(claudeTarget, 'utf8')).resolves.toBe(await readFile(source, 'utf8'))
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('captures bounded provider-independent dogfood feedback', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-feedback-'))
		const output: string[] = []
		try {
			await expect(
				runWorkContractCli(
					[
						'--root',
						root,
						'--json',
						'feedback',
						'--kind',
						'friction',
						'--message',
						'Claim help did not explain session identity.',
						'--work-id',
						'ISSUE-1',
						'--actor',
						'agent-a',
						'--session',
						'session-1',
					],
					{
						stdout: (value): void => {
							output.push(value)
						},
						stderr: (): void => undefined,
					},
				),
			).resolves.toBe(0)
			const result = parseJsonRecord(output[0] ?? '')
			const reportPath = stringField(recordField(result, 'value'), 'report')
			const report = parseJsonRecord(await readFile(resolve(root, reportPath), 'utf8'))
			expect(report).toMatchObject({
				schemaVersion: 1,
				kind: 'friction',
				message: 'Claim help did not explain session identity.',
				workId: 'ISSUE-1',
				actor: 'agent-a',
				sessionId: 'session-1',
			})
			expect(report.id).toStrictEqual(expect.any(String))
			expect(report.createdAt).toStrictEqual(expect.any(String))
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('records sanitized local command telemetry by default and honors explicit disablement', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-'))
		const invoke = async (args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => {
					stdout.push(value)
				},
				stderr: (value): void => {
					stderr.push(value)
				},
			})
			return { status, stdout, stderr }
		}
		try {
			const initialStatus = await invoke(['telemetry', 'show', '--limit', '10'])
			expect(initialStatus.status).toBe(0)
			expect(parseJsonRecord(initialStatus.stdout[0] ?? '')).toMatchObject({
				ok: true,
				value: { enabled: true, events: [] },
			})
			const firstFeedback = await invoke([
				'feedback',
				'--kind',
				'idea',
				'--message',
				'recorded-by-default-without-raw-content',
			])
			expect(firstFeedback.status).toBe(0)
			const defaultTelemetry = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(defaultTelemetry).not.toContain('recorded-by-default-without-raw-content')
			expect(
				defaultTelemetry
					.trim()
					.split('\n')
					.map((line) => parseJsonRecord(line)),
			).toStrictEqual(
				expect.arrayContaining([
					expect.objectContaining({ command: 'feedback', outcome: 'success', exitCode: 0 }),
				]),
			)

			const disabled = await invoke(['telemetry', 'disable'])
			expect(disabled.status).toBe(0)
			const countBeforeDisabledCommand = defaultTelemetry.trim().split('\n').length
			await invoke(['feedback', '--kind', 'docs', '--message', 'not recorded after disable'])
			const afterDisable = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(afterDisable.trim().split('\n')).toHaveLength(countBeforeDisabledCommand)

			const enabled = await invoke(['telemetry', 'enable'])
			expect(enabled.status).toBe(0)
			expect(parseJsonRecord(enabled.stdout[0] ?? '')).toMatchObject({
				ok: true,
				value: { enabled: true, path: '.work/telemetry/events.jsonl' },
			})
			const recorded = await invoke([
				'feedback',
				'--kind',
				'bug',
				'--message',
				'free-form-secret-that-must-not-enter-telemetry',
				'--work-id',
				'ISSUE-9',
				'--actor',
				'TOKEN_REVIEW_MARKER',
				'--session',
				'../session-marker',
			])
			expect(recorded.status).toBe(0)
			const telemetry = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(telemetry).not.toContain('free-form-secret-that-must-not-enter-telemetry')
			expect(telemetry).not.toContain('ISSUE-9')
			expect(telemetry).not.toContain('TOKEN_REVIEW_MARKER')
			expect(telemetry).not.toContain('../session-marker')
			expect(telemetry).not.toContain(root)
			const events = telemetry
				.trim()
				.split('\n')
				.map((line) => parseJsonRecord(line))
			const feedbackEvent = events.find(
				({ command, workCorrelation }) =>
					command === 'feedback' && typeof workCorrelation === 'string',
			)
			if (feedbackEvent === undefined) {
				throw new Error('Expected feedback telemetry event.')
			}
			expect(feedbackEvent).toMatchObject({
				command: 'feedback',
				outcome: 'success',
				exitCode: 0,
			})
			expect(stringField(feedbackEvent, 'workCorrelation')).toMatch(/^[a-f0-9]{64}$/)
			expect(stringField(feedbackEvent, 'actorCorrelation')).toMatch(/^[a-f0-9]{64}$/)
			expect(stringField(feedbackEvent, 'sessionCorrelation')).toMatch(/^[a-f0-9]{64}$/)
			expect(feedbackEvent?.durationMs).toBeTypeOf('number')

			const shown = await invoke(['telemetry', 'show', '--limit', '10'])
			expect(shown.status).toBe(0)
			const shownResult = parseJsonRecord(shown.stdout[0] ?? '')
			expect(shownResult.ok).toBe(true)
			const shownValue = recordField(shownResult, 'value')
			expect(shownValue.enabled).toBe(true)
			expect(Array.isArray(shownValue.events)).toBe(true)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('indexes sessions and filters sanitized telemetry by raw local identifiers', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-review-'))
		const invoke = async (args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void stdout.push(value),
				stderr: (value): void => void stderr.push(value),
			})
			return { status, stdout, stderr }
		}
		try {
			for (const [session, workId, kind] of [
				['session-a', 'ISSUE-1', 'idea'],
				['session-a', 'ISSUE-1', 'docs'],
				['session-b', 'ISSUE-2', 'bug'],
			] as const) {
				const recorded = await invoke([
					'feedback',
					'--kind',
					kind,
					'--message',
					`private-${session}-${workId}`,
					'--session',
					session,
					'--work-id',
					workId,
				])
				expect(recorded.status, recorded.stderr.join('\n')).toBe(0)
			}

			const indexed = await invoke(['telemetry', 'sessions', '--limit', '10'])
			expect(indexed.status, indexed.stderr.join('\n')).toBe(0)
			const indexValue = recordField(parseJsonRecord(indexed.stdout[0] ?? ''), 'value')
			expect(indexValue.unattributedEventCount).toBe(0)
			expect(indexValue.sessions).toMatchObject([
				{
					eventCount: 1,
					outcomes: { success: 1, attention: 0, failure: 0 },
					commands: [{ command: 'feedback', count: 1 }],
				},
				{
					eventCount: 2,
					outcomes: { success: 2, attention: 0, failure: 0 },
					commands: [{ command: 'feedback', count: 2 }],
				},
			])
			const sessions = indexValue.sessions
			if (!Array.isArray(sessions)) {
				throw new TypeError('Expected telemetry session summaries.')
			}
			const sessionA = sessions.find((value) => isRecord(value) && value.eventCount === 2)
			if (!isRecord(sessionA) || typeof sessionA.sessionCorrelation !== 'string') {
				throw new TypeError('Expected session-a correlation.')
			}

			const bySessionId = await invoke([
				'telemetry',
				'show',
				'--session-id',
				'session-a',
				'--limit',
				'10',
			])
			expect(bySessionId.status, bySessionId.stderr.join('\n')).toBe(0)
			const bySessionValue = recordField(parseJsonRecord(bySessionId.stdout[0] ?? ''), 'value')
			expect(bySessionValue.events).toHaveLength(2)
			expect(bySessionValue.filters).toStrictEqual({
				sessionCorrelation: sessionA.sessionCorrelation,
			})

			const byCorrelation = await invoke([
				'telemetry',
				'show',
				'--session-correlation',
				sessionA.sessionCorrelation,
			])
			expect(byCorrelation.status, byCorrelation.stderr.join('\n')).toBe(0)
			expect(
				recordField(parseJsonRecord(byCorrelation.stdout[0] ?? ''), 'value').events,
			).toHaveLength(2)

			const byWork = await invoke(['telemetry', 'show', '--work-id', 'ISSUE-2'])
			expect(byWork.status, byWork.stderr.join('\n')).toBe(0)
			const byWorkValue = recordField(parseJsonRecord(byWork.stdout[0] ?? ''), 'value')
			expect(byWorkValue.events).toHaveLength(1)
			expect(JSON.stringify(byWorkValue)).not.toContain('ISSUE-2')
			expect(JSON.stringify(byWorkValue)).not.toContain('session-b')

			const invalid = await invoke([
				'telemetry',
				'show',
				'--session-id',
				'private-session',
				'--session-correlation',
				'not-a-correlation',
			])
			expect(invalid.status).toBe(1)
			const invalidOutput = [...invalid.stdout, ...invalid.stderr].join('\n')
			expect(invalidOutput).toContain('invalid_telemetry_filter')
			expect(invalidOutput).not.toContain('private-session')
			expect(invalidOutput).not.toContain('not-a-correlation')
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('attributes every command to an explicit or runtime-provided local session', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-ambient-session-'))
		const priorWorkSession = processEnvironment.WORK_SESSION_ID
		const priorCodexThread = processEnvironment.CODEX_THREAD_ID
		const priorCodexSession = processEnvironment.CODEX_SESSION_ID
		const priorClaudeSession = processEnvironment.CLAUDE_CODE_SESSION_ID
		const invoke = async (args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void stdout.push(value),
				stderr: (value): void => void stderr.push(value),
			})
			return { status, stdout, stderr }
		}
		try {
			processEnvironment.WORK_SESSION_ID = 'ambient-session'
			processEnvironment.CODEX_THREAD_ID = 'inherited-codex-thread'
			processEnvironment.CODEX_SESSION_ID = 'inherited-codex-session'
			processEnvironment.CLAUDE_CODE_SESSION_ID = 'inherited-claude-session'
			expect(
				(
					await invoke([
						'feedback',
						'--kind',
						'idea',
						'--message',
						'ambient attribution without raw content',
					])
				).status,
			).toBe(0)
			expect((await invoke(['complete', '--unknown-private-flag'])).status).toBe(2)

			const shown = await invoke([
				'telemetry',
				'show',
				'--session-id',
				'ambient-session',
				'--limit',
				'10',
			])
			expect(shown.status, shown.stderr.join('\n')).toBe(0)
			const shownValue = recordField(parseJsonRecord(shown.stdout[0] ?? ''), 'value')
			expect(shownValue.events).toMatchObject([
				{ command: 'complete', failureStage: 'arguments' },
				{ command: 'feedback', outcome: 'success' },
			])
			const serialized = JSON.stringify(shownValue)
			expect(serialized).not.toContain('ambient-session')
			expect(serialized).not.toContain('inherited-codex')
			expect(serialized).not.toContain('inherited-claude')
			expect(serialized).not.toContain('unknown-private-flag')

			delete processEnvironment.WORK_SESSION_ID
			expect(
				(await invoke(['feedback', '--kind', 'idea', '--message', 'codex runtime attribution']))
					.status,
			).toBe(0)
			expect(
				recordField(
					parseJsonRecord(
						(await invoke(['telemetry', 'show', '--session-id', 'inherited-codex-thread']))
							.stdout[0] ?? '',
					),
					'value',
				).events,
			).toHaveLength(1)

			delete processEnvironment.CODEX_THREAD_ID
			expect(
				(await invoke(['feedback', '--kind', 'idea', '--message', 'claude runtime attribution']))
					.status,
			).toBe(0)
			expect(
				recordField(
					parseJsonRecord(
						(await invoke(['telemetry', 'show', '--session-id', 'inherited-claude-session']))
							.stdout[0] ?? '',
					),
					'value',
				).events,
			).toHaveLength(1)

			processEnvironment.WORK_SESSION_ID = `private-${'x'.repeat(300)}`
			const invalidAmbient = await invoke([
				'feedback',
				'--kind',
				'idea',
				'--message',
				'invalid ambient correlation remains non-fatal',
			])
			expect(invalidAmbient.status).toBe(0)
			expect(invalidAmbient.stderr.join('\n')).toContain('invalid_telemetry_session_id')
			expect(invalidAmbient.stderr.join('\n')).not.toContain('private-')
		} finally {
			if (priorWorkSession === undefined) delete processEnvironment.WORK_SESSION_ID
			else processEnvironment.WORK_SESSION_ID = priorWorkSession
			if (priorCodexThread === undefined) delete processEnvironment.CODEX_THREAD_ID
			else processEnvironment.CODEX_THREAD_ID = priorCodexThread
			if (priorCodexSession === undefined) delete processEnvironment.CODEX_SESSION_ID
			else processEnvironment.CODEX_SESSION_ID = priorCodexSession
			if (priorClaudeSession === undefined) delete processEnvironment.CLAUDE_CODE_SESSION_ID
			else processEnvironment.CLAUDE_CODE_SESSION_ID = priorClaudeSession
			await rm(root, { force: true, recursive: true })
		}
	})

	it('retains feedback and telemetry from concurrent work streams', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-parallel-dogfood-'))
		const invoke = async (args: readonly string[]) => {
			const stdout: string[] = []
			const stderr: string[] = []
			const status = await runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void stdout.push(value),
				stderr: (value): void => void stderr.push(value),
			})
			return { status, stdout, stderr }
		}
		try {
			const results = await Promise.all(
				Array.from({ length: 8 }, async (_, index) =>
					invoke([
						'feedback',
						'--kind',
						'friction',
						'--message',
						`parallel observation ${index}`,
						'--work-id',
						`ISSUE-${index}`,
						'--actor',
						`agent-${index}`,
					]),
				),
			)
			expect(
				results.every(({ status }) => status === 0),
				JSON.stringify(results),
			).toBe(true)
			expect(results.flatMap(({ stderr }) => stderr)).toStrictEqual([])
			await expect(readdir(resolve(root, '.work/feedback'))).resolves.toHaveLength(8)
			const telemetryText = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			const telemetry = telemetryText
				.trim()
				.split('\n')
				.map((line) => parseJsonRecord(line))
			expect(telemetry.filter(({ command }) => command === 'feedback')).toHaveLength(8)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('records bounded allowlisted command phases under default-on telemetry', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-phase-telemetry-'))
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (): void => undefined,
				stderr: (): void => undefined,
			})
		try {
			await mkdir(resolve(root, '.work/items'), { recursive: true })
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject:\n  id: phase-profile\nsources:\n  - kind: issue\n    include: .work/items/*.md\n',
			)
			await writeFile(resolve(root, '.work/items/ISSUE-1.md'), '# ISSUE-1 Profile\n')
			await expect(invoke(['compile'])).resolves.toBe(0)
			const telemetrySource = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			const events = telemetrySource
				.trim()
				.split('\n')
				.map((line) => parseJsonRecord(line))
			const compiled = events.find(({ command }) => command === 'compile')
			if (compiled === undefined || !Array.isArray(compiled.phases)) {
				throw new Error('Expected compile phase telemetry.')
			}
			expect(compiled.phases).toHaveLength(1)
			const phase: unknown = compiled.phases[0]
			if (!isRecord(phase)) {
				throw new TypeError('Expected a compile phase record.')
			}
			expect(phase).toMatchObject({ phase: 'definition_compile', count: 1 })
			expect(phase.durationMs).toBeTypeOf('number')
			expect(compiled.unattributedMs).toBeTypeOf('number')
			expect(JSON.stringify(compiled)).not.toContain(root)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('keeps workflow route names and work identifiers useful but private in telemetry', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-route-telemetry-'))
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (): void => undefined,
				stderr: (): void => undefined,
			})
		try {
			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(0)
			for (const args of [
				['prepare', 'ISSUE-PRIVATE'],
				['status', 'ISSUE-PRIVATE'],
				['start', 'ISSUE-PRIVATE', '--actor', 'agent-private'],
				['submit', 'ISSUE-PRIVATE', '--actor', 'agent-private'],
				['reconcile', 'ISSUE-PRIVATE', '--actor', 'agent-private'],
				['export'],
			] as const) {
				await expect(invoke(args)).resolves.not.toBe(2)
			}

			const source = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(source).not.toContain('ISSUE-PRIVATE')
			expect(source).not.toContain('agent-private')
			const events = source
				.trim()
				.split('\n')
				.map((line) => parseJsonRecord(line))
			const workflowEvents = events.filter(({ command }) => command !== 'telemetry.enable')
			expect(workflowEvents.map(({ command }) => command)).toStrictEqual([
				'prepare',
				'status',
				'start',
				'submit',
				'reconcile',
				'export',
			])
			for (const event of workflowEvents.slice(0, -1)) {
				expect(event.workCorrelation).toMatch(/^[a-f0-9]{64}$/)
			}
			expect(workflowEvents.at(-1)).not.toHaveProperty('workCorrelation')
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('recovers a schema-valid dead telemetry lock owner', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-dead-lock-'))
		const stdout: string[] = []
		const stderr: string[] = []
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(
				resolve(root, '.work/telemetry/config.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					enabled: true,
					correlationSalt: 'a'.repeat(64),
				})}\n`,
			)
			const lockPath = resolve(root, '.work/telemetry/write.lock')
			await mkdir(lockPath)
			await writeFile(
				resolve(lockPath, 'owner.json'),
				`${JSON.stringify({
					pid: 2_147_483_647,
					startedAt: '2026-09-02T00:00:00.000Z',
					nonce: '00000000-0000-4000-8000-000000000001',
				})}\n`,
			)

			await expect(
				runWorkContractCli(
					['--root', root, '--json', 'feedback', '--kind', 'friction', '--message', 'saved'],
					{
						stdout: (value): void => void stdout.push(value),
						stderr: (value): void => void stderr.push(value),
					},
				),
			).resolves.toBe(0)
			expect(parseJsonRecord(stdout.at(-1) ?? '')).toMatchObject({ ok: true })
			expect(stderr).toStrictEqual([])
			await expect(access(lockPath)).rejects.toThrow('ENOENT')
			await expect(
				readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8'),
			).resolves.toContain('"command":"feedback"')
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('preserves live and malformed telemetry locks without echoing their content', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-preserved-lock-'))
		const stdout: string[] = []
		const stderr: string[] = []
		const invoke = async (message: string) =>
			runWorkContractCli(
				['--root', root, '--json', 'feedback', '--kind', 'friction', '--message', message],
				{
					stdout: (value): void => void stdout.push(value),
					stderr: (value): void => void stderr.push(value),
				},
			)
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(
				resolve(root, '.work/telemetry/config.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					enabled: true,
					correlationSalt: 'b'.repeat(64),
				})}\n`,
			)
			const lockPath = resolve(root, '.work/telemetry/write.lock')
			const ownerPath = resolve(lockPath, 'owner.json')
			await mkdir(lockPath)
			const liveLock = `${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				nonce: '00000000-0000-4000-8000-000000000002',
			})}\n`
			await writeFile(ownerPath, liveLock)
			await expect(invoke('live owner')).resolves.toBe(0)
			await expect(readFile(ownerPath, 'utf8')).resolves.toBe(liveLock)

			const canary = 'MALFORMED_LOCK_/Users/private/TOKEN=value'
			await writeFile(ownerPath, canary)
			await expect(invoke('malformed owner')).resolves.toBe(0)
			await expect(readFile(ownerPath, 'utf8')).resolves.toBe(canary)
			expect(stdout).toHaveLength(2)
			expect(stderr).toHaveLength(2)
			expect(stderr.join('\n')).not.toContain(canary)
			expect(stderr.join('\n')).not.toContain(root)
			expect(stderr.every((value) => value.includes('telemetry_write_failed'))).toBe(true)
			await expect(readdir(resolve(root, '.work/feedback'))).resolves.toHaveLength(2)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('does not remove a replacement telemetry lock when an older holder finishes', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-lock-replaced-'))
		const stdout: string[] = []
		const stderr: string[] = []
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(
				resolve(root, '.work/telemetry/config.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					enabled: true,
					correlationSalt: 'c'.repeat(64),
				})}\n`,
			)
			const event = JSON.stringify({
				schemaVersion: 1,
				eventId: '00000000-0000-4000-8000-000000000003',
				occurredAt: '2026-09-02T00:00:00.000Z',
				command: 'cli',
				outcome: 'success',
				exitCode: 0,
				durationMs: 0,
				workCorrelation: 'd'.repeat(64),
				actorCorrelation: 'e'.repeat(64),
				roleCorrelation: 'f'.repeat(64),
				sessionCorrelation: '0'.repeat(64),
				runCorrelation: '1'.repeat(64),
			})
			await writeFile(
				resolve(root, '.work/telemetry/events.jsonl'),
				`${Array.from({ length: 8000 }, () => event).join('\n')}\n`,
			)
			const lockPath = resolve(root, '.work/telemetry/write.lock')
			const ownerPath = resolve(lockPath, 'owner.json')
			const replacement = `${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				nonce: '00000000-0000-4000-8000-000000000004',
			})}\n`
			const command = runWorkContractCli(
				['--root', root, '--json', 'feedback', '--kind', 'friction', '--message', 'saved'],
				{
					stdout: (value): void => void stdout.push(value),
					stderr: (value): void => void stderr.push(value),
				},
			)
			let observedOwner: Readonly<Record<string, unknown>> | undefined
			for (let attempt = 0; attempt < 2000; attempt += 1) {
				try {
					const candidate = parseJsonRecord(await readFile(ownerPath, 'utf8'))
					if (candidate.pid === process.pid && typeof candidate.nonce === 'string') {
						observedOwner = candidate
						break
					}
				} catch {
					// The lock directory can be observed before its bounded owner record is written.
				}
				await delay(1)
			}
			expect(observedOwner).toBeDefined()
			await writeFile(ownerPath, replacement)

			await expect(command).resolves.toBe(0)
			expect(parseJsonRecord(stdout.at(-1) ?? '')).toMatchObject({ ok: true })
			expect(stderr.join('\n')).toContain('telemetry_write_failed')
			await expect(readFile(ownerPath, 'utf8')).resolves.toBe(replacement)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('preserves the primary telemetry failure when lock cleanup also loses ownership', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-dual-failure-'))
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(
				resolve(root, '.work/telemetry/config.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					enabled: true,
					correlationSalt: 'c'.repeat(64),
				})}\n`,
			)
			const event = JSON.stringify({
				schemaVersion: 1,
				eventId: '00000000-0000-4000-8000-000000000003',
				occurredAt: '2026-09-02T00:00:00.000Z',
				command: 'cli',
				outcome: 'success',
				exitCode: 0,
				durationMs: 0,
			})
			await writeFile(
				resolve(root, '.work/telemetry/events.jsonl'),
				`${Array.from({ length: 7999 }, () => event).join('\n')}\n{invalid-json}\n`,
			)
			const lockPath = resolve(root, '.work/telemetry/write.lock')
			const ownerPath = resolve(lockPath, 'owner.json')
			const replacement = `${JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				nonce: '00000000-0000-4000-8000-000000000005',
			})}\n`
			const operation = recordCliFailureTelemetry({
				root,
				command: 'complete',
				failureStage: 'arguments',
				exitCode: 1,
				durationMs: 1,
			})
			for (let attempt = 0; attempt < 2000; attempt += 1) {
				try {
					const observed = parseJsonRecord(await readFile(ownerPath, 'utf8'))
					if (observed.pid === process.pid && typeof observed.nonce === 'string') {
						await writeFile(ownerPath, replacement)
						break
					}
				} catch {
					// The lock directory can be observed before its bounded owner record is written.
				}
				await delay(1)
			}

			await expect(operation).resolves.toMatchObject({
				ok: false,
				error: {
					code: 'telemetry_read_failed',
					details: ['cleanupFailure=telemetry_lock_release_failed'],
				},
			})
			await expect(readFile(ownerPath, 'utf8')).resolves.toBe(replacement)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('does not expose a private repository path when dogfood storage cannot be prepared', async () => {
		const parent = await mkdtemp(resolve(tmpdir(), 'work-contract-dogfood-private-root-'))
		const root = resolve(parent, 'PRIVATE_ROOT_/Users/example/TOKEN=value')
		const stderr: string[] = []
		try {
			await expect(
				runWorkContractCli(
					['--root', root, '--json', 'feedback', '--kind', 'bug', '--message', 'safe'],
					{
						stdout: (): void => undefined,
						stderr: (value): void => void stderr.push(value),
					},
				),
			).resolves.toBe(1)
			expect(stderr.join('\n')).not.toContain(root)
			expect(stderr.join('\n')).not.toContain('PRIVATE_ROOT_')
			expect(parseJsonRecord(stderr[0] ?? '')).toMatchObject({
				ok: false,
				error: { code: 'unsafe_feedback_path' },
			})
			expect(recordField(parseJsonRecord(stderr[0] ?? ''), 'error')).not.toHaveProperty('details')
		} finally {
			await rm(parent, { force: true, recursive: true })
		}
	})

	it('records sanitized parser and routing failures with HMAC run correlation', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-parser-telemetry-'))
		const stdout: string[] = []
		const stderr: string[] = []
		const priorRunId = processEnvironment.WORK_CONTRACT_RUN_ID
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void stdout.push(value),
				stderr: (value): void => void stderr.push(value),
			})
		try {
			processEnvironment.WORK_CONTRACT_RUN_ID = 'campaign-2026-09-02-a'
			await expect(
				invoke(['complete', 'ISSUE-PRIVATE', '--actor', 'agent-private', '--secret-flag']),
			).resolves.toBe(2)
			await expect(invoke(['drift', '--secret-flag'])).resolves.toBe(2)
			await expect(invoke(['proposal', 'apply', '--secret-flag'])).resolves.toBe(2)
			await expect(invoke(['private-unknown-route', '--another-secret'])).resolves.toBe(2)

			const source = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(source).not.toContain('ISSUE-PRIVATE')
			expect(source).not.toContain('agent-private')
			expect(source).not.toContain('secret-flag')
			expect(source).not.toContain('private-unknown-route')
			expect(source).not.toContain('another-secret')
			expect(source).not.toContain(root)
			const events = source
				.trim()
				.split('\n')
				.map((line) => parseJsonRecord(line))
			const failures = events.filter(({ failureStage }) => failureStage !== undefined)
			const runCorrelation = failures[0]?.runCorrelation
			if (typeof runCorrelation !== 'string') {
				throw new TypeError('Expected parser telemetry run correlation.')
			}
			expect(runCorrelation).toMatch(/^[a-f0-9]{64}$/)
			expect(failures).toMatchObject([
				{
					command: 'complete',
					failureStage: 'arguments',
					outcome: 'attention',
					exitCode: 2,
					runCorrelation,
				},
				{
					command: 'drift',
					failureStage: 'arguments',
					outcome: 'attention',
					exitCode: 2,
					runCorrelation,
				},
				{
					command: 'proposal.apply',
					failureStage: 'arguments',
					outcome: 'attention',
					exitCode: 2,
					runCorrelation,
				},
				{
					command: 'cli',
					failureStage: 'routing',
					outcome: 'attention',
					exitCode: 2,
					runCorrelation,
				},
			])
		} finally {
			if (priorRunId === undefined) {
				delete processEnvironment.WORK_CONTRACT_RUN_ID
			} else {
				processEnvironment.WORK_CONTRACT_RUN_ID = priorRunId
			}
			await rm(root, { force: true, recursive: true })
		}
	})

	it('records parser telemetry under a custom manifest project UID', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-custom-manifest-'))
		const stateHome = await mkdtemp(resolve(tmpdir(), 'work-contract-custom-state-'))
		const projectUid = '123e4567-e89b-42d3-a456-426614174000'
		const priorStateHome = processEnvironment.WORK_CONTRACT_STATE_HOME
		try {
			processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
			await executeFile('git', ['init', '-b', 'main'], { cwd: root })
			await mkdir(resolve(root, 'plans'))
			await writeFile(
				resolve(root, 'plans/work.yaml'),
				`version: 1\nproject: { id: example, uid: ${projectUid} }\nsources: []\n`,
			)

			await expect(
				runWorkContractCli(
					[
						'--root',
						root,
						'--manifest',
						'plans/work.yaml',
						'--json',
						'complete',
						'ISSUE-PRIVATE',
						'--unknown-private-flag',
					],
					{ stdout: (): void => undefined, stderr: (): void => undefined },
				),
			).resolves.toBe(2)
			await expect(readdir(stateHome)).resolves.toStrictEqual([projectUid])
			const identities = await readdir(join(stateHome, projectUid))
			expect(identities).toHaveLength(1)
			const telemetry = await readFile(
				join(stateHome, projectUid, identities[0] ?? '', '.work/telemetry/events.jsonl'),
				'utf8',
			)
			expect(telemetry).toContain('"command":"complete"')
			expect(telemetry).toContain('"failureStage":"arguments"')
			expect(telemetry).not.toContain('ISSUE-PRIVATE')
			expect(telemetry).not.toContain('unknown-private-flag')
		} finally {
			if (priorStateHome === undefined) {
				delete processEnvironment.WORK_CONTRACT_STATE_HOME
			} else {
				processEnvironment.WORK_CONTRACT_STATE_HOME = priorStateHome
			}
			await rm(root, { force: true, recursive: true })
			await rm(stateHome, { force: true, recursive: true })
		}
	})

	it('keeps explicitly disabled parser telemetry silent and warns on invalid run IDs', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-parser-disabled-'))
		const stderr: string[] = []
		const priorRunId = processEnvironment.WORK_CONTRACT_RUN_ID
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (): void => undefined,
				stderr: (value): void => void stderr.push(value),
			})
		try {
			await expect(invoke(['telemetry', 'disable'])).resolves.toBe(0)
			await expect(invoke(['complete', 'ISSUE-1', '--actor', 'agent-a', '--bad'])).resolves.toBe(2)
			await expect(access(resolve(root, '.work/telemetry/events.jsonl'))).rejects.toThrow('ENOENT')

			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(0)
			processEnvironment.WORK_CONTRACT_RUN_ID = 'invalid run id with spaces and PRIVATE-CONTENT'
			await expect(invoke(['complete', 'ISSUE-1', '--actor', 'agent-a', '--bad'])).resolves.toBe(2)
			expect(stderr.join('\n')).toContain('invalid_telemetry_run_id')
			expect(stderr.join('\n')).not.toContain('PRIVATE-CONTENT')
		} finally {
			if (priorRunId === undefined) {
				delete processEnvironment.WORK_CONTRACT_RUN_ID
			} else {
				processEnvironment.WORK_CONTRACT_RUN_ID = priorRunId
			}
			await rm(root, { force: true, recursive: true })
		}
	})

	it('bounds persisted telemetry configuration and enforces the event count while writing', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-retention-'))
		const stdout: string[] = []
		const stderr: string[] = []
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => {
					stdout.push(value)
				},
				stderr: (value): void => {
					stderr.push(value)
				},
			})
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(resolve(root, '.work/telemetry/config.json'), 'x'.repeat(4097))
			await expect(invoke(['telemetry', 'show'])).resolves.toBe(1)
			expect(JSON.parse(stderr.at(-1) ?? '')).toMatchObject({
				ok: false,
				error: { code: 'telemetry_limit_exceeded' },
			})

			await rm(resolve(root, '.work/telemetry/config.json'))
			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(0)
			const event = JSON.stringify({
				schemaVersion: 1,
				eventId: '00000000-0000-4000-8000-000000000001',
				occurredAt: '2026-09-02T00:00:00.000Z',
				command: 'cli',
				outcome: 'success',
				exitCode: 0,
				durationMs: 0,
			})
			await writeFile(
				resolve(root, '.work/telemetry/events.jsonl'),
				`${Array.from({ length: 10_000 }, () => event).join('\n')}\n`,
			)
			await expect(
				invoke(['feedback', '--kind', 'friction', '--message', 'retention boundary']),
			).resolves.toBe(0)
			expect(JSON.parse(stdout.at(-1) ?? '')).toMatchObject({ ok: true })
			expect(JSON.parse(stderr.at(-1) ?? '')).toMatchObject({
				type: 'work_telemetry_warning',
				code: 'telemetry_limit_exceeded',
			})
			const retained = await readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8')
			expect(retained.trim().split('\n')).toHaveLength(10_000)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('rejects tampered telemetry without echoing stored content or rendering oversized lines', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-tamper-'))
		const stdout: string[] = []
		const stderr: string[] = []
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => void stdout.push(value),
				stderr: (value): void => void stderr.push(value),
			})
		try {
			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(0)
			const eventsPath = resolve(root, '.work/telemetry/events.jsonl')
			const canary = 'PRIVATE_STORED_COMMAND_/Users/example/TOKEN=value'
			await writeFile(
				eventsPath,
				`${JSON.stringify({
					schemaVersion: 1,
					eventId: 'not-a-uuid',
					occurredAt: 'not-a-timestamp',
					command: canary,
					outcome: 'success',
					exitCode: -1,
					durationMs: -1,
				})}\n`,
			)
			await expect(invoke(['telemetry', 'show'])).resolves.toBe(1)
			expect(stderr.at(-1)).not.toContain(canary)
			expect(stderr.at(-1)?.length).toBeLessThan(1000)

			stdout.length = 0
			stderr.length = 0
			await writeFile(
				eventsPath,
				`${JSON.stringify({
					schemaVersion: 1,
					eventId: '00000000-0000-4000-8000-000000000006',
					occurredAt: '2026-09-04T00:00:00.000Z',
					command: 'compile',
					outcome: 'success',
					exitCode: 0,
					durationMs: 1,
					phases: [{ phase: canary, count: 1, durationMs: 1 }],
				})}\n`,
			)
			await expect(invoke(['telemetry', 'show'])).resolves.toBe(1)
			expect(stdout).toStrictEqual([])
			expect(stderr.at(-1)).not.toContain(canary)
			expect(stderr.at(-1)?.length).toBeLessThan(1000)

			stdout.length = 0
			stderr.length = 0
			await writeFile(eventsPath, `${JSON.stringify({ command: canary.repeat(100) })}\n`)
			await expect(invoke(['telemetry', 'show', '--limit', '1'])).resolves.toBe(1)
			expect(stdout).toStrictEqual([])
			expect(stderr.at(-1)).not.toContain(canary)
			expect(stderr.at(-1)?.length).toBeLessThan(1000)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('replaces a hard-linked telemetry log without mutating its external inode', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-hardlink-'))
		const outside = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-outside-'))
		const external = resolve(outside, 'external.jsonl')
		try {
			await expect(
				runWorkContractCli(['--root', root, '--json', 'telemetry', 'enable'], {
					stdout: (): void => undefined,
					stderr: (): void => undefined,
				}),
			).resolves.toBe(0)
			await writeFile(external, '')
			await rm(resolve(root, '.work/telemetry/events.jsonl'), { force: true })
			await link(external, resolve(root, '.work/telemetry/events.jsonl'))

			await expect(
				runWorkContractCli(
					['--root', root, '--json', 'feedback', '--kind', 'friction', '--message', 'saved'],
					{ stdout: (): void => undefined, stderr: (): void => undefined },
				),
			).resolves.toBe(0)
			await expect(readFile(external, 'utf8')).resolves.toBe('')
			await expect(
				readFile(resolve(root, '.work/telemetry/events.jsonl'), 'utf8'),
			).resolves.not.toBe('')
		} finally {
			await Promise.all([
				rm(root, { force: true, recursive: true }),
				rm(outside, { force: true, recursive: true }),
			])
		}
	})

	it('does not echo unknown persisted telemetry configuration keys', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-config-'))
		const errors: string[] = []
		const canary = 'PRIVATE_CONFIG_KEY_/Users/example'
		try {
			await mkdir(resolve(root, '.work/telemetry'), { recursive: true })
			await writeFile(
				resolve(root, '.work/telemetry/config.json'),
				`${JSON.stringify({
					schemaVersion: 1,
					enabled: true,
					correlationSalt: 'a'.repeat(64),
					[canary]: 'private-value',
				})}\n`,
			)
			await expect(
				runWorkContractCli(['--root', root, '--json', 'telemetry', 'show'], {
					stdout: (): void => undefined,
					stderr: (value): void => void errors.push(value),
				}),
			).resolves.toBe(1)
			expect(errors.join('\n')).not.toContain(canary)
			expect(errors.join('\n')).not.toContain('private-value')
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('fails skill installation closed on an oversized local copy or active installer lock', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-skill-bounds-'))
		const stderr: string[] = []
		const invoke = async (force = false) =>
			runWorkContractCli(
				['--root', root, '--json', 'skill', 'install', ...(force ? ['--force'] : [])],
				{
					stdout: (): void => undefined,
					stderr: (value): void => {
						stderr.push(value)
					},
				},
			)
		try {
			await mkdir(resolve(root, '.work'), { recursive: true })
			await writeFile(resolve(root, '.work/skill-install.lock'), 'another-installer\n')
			await expect(invoke()).resolves.toBe(1)
			expect(JSON.parse(stderr.at(-1) ?? '')).toMatchObject({
				error: { code: 'skill_install_failed' },
			})
			await rm(resolve(root, '.work/skill-install.lock'))
			await mkdir(resolve(root, '.agents/skills/work'), { recursive: true })
			await writeFile(resolve(root, '.agents/skills/work/SKILL.md'), 'x'.repeat(100_000))
			await expect(invoke()).resolves.toBe(1)
			expect(JSON.parse(stderr.at(-1) ?? '')).toMatchObject({
				error: { code: 'skill_install_conflict' },
			})
			await expect(invoke(true)).resolves.toBe(0)
			const packaged = await readFile(
				resolve(import.meta.dirname, '../skills/work/SKILL.md'),
				'utf8',
			)
			await expect(readFile(resolve(root, '.agents/skills/work/SKILL.md'), 'utf8')).resolves.toBe(
				packaged,
			)
			await expect(readFile(resolve(root, '.claude/skills/work/SKILL.md'), 'utf8')).resolves.toBe(
				packaged,
			)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('keeps telemetry failure visible without replacing a successful command result', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-telemetry-limit-'))
		const output: string[] = []
		const errors: string[] = []
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (value): void => {
					output.push(value)
				},
				stderr: (value): void => {
					errors.push(value)
				},
			})
		try {
			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(0)
			await writeFile(resolve(root, '.work/telemetry/events.jsonl'), 'x'.repeat(5_000_001))
			await expect(
				invoke(['feedback', '--kind', 'friction', '--message', 'telemetry limit reached']),
			).resolves.toBe(0)
			expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({ ok: true })
			expect(JSON.parse(errors.at(-1) ?? '')).toMatchObject({
				type: 'work_telemetry_warning',
				code: 'telemetry_limit_exceeded',
			})
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('rejects feedback overflow and symlinked telemetry storage', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-dogfood-safety-'))
		const outside = await mkdtemp(resolve(tmpdir(), 'work-contract-dogfood-outside-'))
		const errors: string[] = []
		const invoke = async (args: readonly string[]) =>
			runWorkContractCli(['--root', root, '--json', ...args], {
				stdout: (): void => undefined,
				stderr: (value): void => {
					errors.push(value)
				},
			})
		try {
			await expect(
				invoke(['feedback', '--kind', 'bug', '--message', 'x'.repeat(2001)]),
			).resolves.toBe(1)
			expect(JSON.parse(errors.at(-1) ?? '')).toMatchObject({
				error: { code: 'invalid_feedback' },
			})
			await rm(resolve(root, '.work/telemetry'), { force: true, recursive: true })
			await mkdir(resolve(root, '.work'), { recursive: true })
			await symlink(outside, resolve(root, '.work/telemetry'))
			await expect(invoke(['telemetry', 'enable'])).resolves.toBe(1)
			expect(JSON.parse(errors.at(-1) ?? '')).toMatchObject({
				error: { code: 'unsafe_telemetry_path' },
			})
			await expect(access(resolve(outside, 'config.json'))).rejects.toThrow('ENOENT')
		} finally {
			await Promise.all([
				rm(root, { force: true, recursive: true }),
				rm(outside, { force: true, recursive: true }),
			])
		}
	})

	it('returns structured JSON for parser and command invocation failures', async () => {
		const errors: string[] = []
		const io = {
			stdout: (): void => undefined,
			stderr: (value: string): void => {
				errors.push(value)
			},
		}

		await expect(runWorkContractCli(['--json', 'ready', '--limit'], io)).resolves.toBe(2)
		expect(JSON.parse(errors[0] ?? '')).toStrictEqual({
			ok: false,
			error: {
				type: 'work_contract_error',
				code: 'invalid_cli_invocation',
				message: 'Invalid arguments for work ready; run work ready --help',
			},
		})
	})

	it('redacts oversized execute-stage evidence and work-reference inputs', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-execute-input-'))
		const binary = resolve(root, 'fake-bd.mjs')
		const ledgerPath = resolve(root, 'ledger.json')
		const canary = `PRIVATE_EXECUTE_ARG_${'x'.repeat(50_000)}`
		const invocations = [
			['complete', 'ISSUE-1', '--actor', 'agent-a', '--evidence', `${canary}=evidence.txt`],
			['prepare', canary],
		] as const

		try {
			await mkdir(resolve(root, 'docs'), { recursive: true })
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/*.md }]\n',
			)
			await writeFile(resolve(root, 'docs/ISSUE-1.md'), '# ISSUE-1 Work\n')
			await writeFile(
				binary,
				`#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else if (process.argv[2] === 'list') console.log(existsSync(${JSON.stringify(ledgerPath)}) ? readFileSync(${JSON.stringify(ledgerPath)}, 'utf8') : '[]')
else process.exit(9)
`,
			)
			await chmod(binary, 0o755)
			const compiledOutput: string[] = []
			await expect(
				runWorkContractCli(['--root', root, '--bd', binary, '--json', 'compile'], {
					stdout: (value): void => void compiledOutput.push(value),
					stderr: (): void => undefined,
				}),
			).resolves.toBe(0)
			const compiled = recordField(parseJsonRecord(compiledOutput[0] ?? ''), 'value')
			const items = compiled.items
			if (!Array.isArray(items) || !isRecord(items[0])) {
				throw new TypeError('Expected a compiled definition.')
			}
			const item = items[0]
			await writeFile(
				ledgerPath,
				JSON.stringify([
					{
						id: 'wc-1',
						title: item.title,
						status: 'open',
						priority: 2,
						issue_type: 'task',
						created_at: '2026-09-01T00:00:00.000Z',
						updated_at: '2026-09-01T00:00:00.000Z',
						metadata: {
							work_contract: {
								schema_version: 2,
								project_id: 'example',
								work_id: item.id,
								kind: item.kind,
								source_path: recordField(item, 'source').path,
								source_hash: recordField(item, 'source').hash,
								graph_fingerprint: compiled.fingerprint,
								roles: [],
								evidence_requirements: [],
							},
						},
					},
				]),
			)
			for (const invocation of invocations) {
				const errors: string[] = []
				const status = await runWorkContractCli(
					['--root', root, '--bd', binary, '--json', ...invocation],
					{
						stdout: (): void => undefined,
						stderr: (value): void => void errors.push(value),
					},
				)
				expect(status).not.toBe(0)
				expect(errors.join('\n')).not.toContain(canary)
				expect(Buffer.byteLength(errors.join('\n'), 'utf8')).toBeLessThan(1024)
			}
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('rejects an oversized initialization prefix before writing repository files', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-'))
		const errors: string[] = []
		try {
			await expect(
				runWorkContractCli(
					['--root', root, '--json', 'init', '--project', 'project-name-that-is-too-long'],
					{
						stdout: (): void => undefined,
						stderr: (value): void => {
							errors.push(value)
						},
					},
				),
			).resolves.toBe(2)
			await expect(access(resolve(root, 'work.yaml'))).rejects.toThrow('ENOENT')
			expect(JSON.parse(errors[0] ?? '')).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'invalid_cli_invocation' },
			})
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('fails coordination commands closed when the project UID is invalid', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-project-uid-'))
		const errors: string[] = []
		try {
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject: { id: example, uid: ../../private }\nsources: []\n',
			)

			await expect(
				runWorkContractCli(['--root', root, '--json', 'integration', 'status'], {
					stdout: (): void => undefined,
					stderr: (value): void => void errors.push(value),
				}),
			).resolves.toBe(1)
			expect(JSON.parse(errors[0] ?? '')).toMatchObject({
				ok: false,
				error: { code: 'invalid_work_manifest' },
			})
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('does not echo an unsafe initialization manifest path', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-init-path-'))
		const canary = 'PRIVATE_MANIFEST_CANARY_/Users/operator/secret.yaml'
		const errors: string[] = []
		try {
			await expect(
				runWorkContractCli(
					['--root', root, '--manifest', `../${canary}`, '--json', 'init', '--project', 'example'],
					{
						stdout: (): void => undefined,
						stderr: (value): void => {
							errors.push(value)
						},
					},
				),
			).resolves.toBe(1)
			expect(JSON.parse(errors[0] ?? '')).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'unsafe_work_manifest' },
			})
			expect(errors.join('\n')).not.toContain(canary)
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('does not follow a manifest symlink swapped in after a forced initialization write', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-init-swap-'))
		const outsideRoot = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-init-outside-'))
		const outside = resolve(outsideRoot, 'outside.yaml')
		const binary = resolve(root, 'swap-bd.mjs')
		const errors: string[] = []
		try {
			await mkdir(resolve(root, '.work/items'), { recursive: true })
			await writeFile(resolve(root, 'work.yaml'), 'previous generation\n')
			await writeFile(outside, 'outside must remain unchanged\n')
			await writeFile(
				binary,
				`#!/usr/bin/env node
import { symlinkSync, unlinkSync } from 'node:fs'
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else if (process.argv[2] === 'init') {
  unlinkSync(${JSON.stringify(resolve(root, 'work.yaml'))})
  symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(resolve(root, 'work.yaml'))})
  process.exit(9)
} else process.exit(9)
`,
			)
			await chmod(binary, 0o755)

			await expect(
				runWorkContractCli(
					['--root', root, '--bd', binary, '--json', 'init', '--project', 'example', '--force'],
					{
						stdout: (): void => undefined,
						stderr: (value): void => void errors.push(value),
					},
				),
			).resolves.toBe(1)
			await expect(readFile(outside, 'utf8')).resolves.toBe('outside must remain unchanged\n')
			expect(errors.join('\n')).toContain('Manifest rollback failed')
			expect(errors.join('\n')).not.toContain(outsideRoot)
		} finally {
			await rm(root, { force: true, recursive: true })
			await rm(outsideRoot, { force: true, recursive: true })
		}
	})

	it('rejects an unsupported Beads override before a sync mutation', async () => {
		expect.hasAssertions()
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-provider-version-'))
		const binary = resolve(root, 'unsupported-bd.mjs')
		const commandLog = resolve(root, 'commands.log')
		const errors: string[] = []
		try {
			await mkdir(resolve(root, '.work/items'), { recursive: true })
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: .work/items/*.md }]\n',
			)
			await writeFile(resolve(root, '.work/items/ISSUE-1.md'), '# ISSUE-1 Work\n')
			await writeFile(
				binary,
				`#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const command = process.argv[2]
appendFileSync(${JSON.stringify(commandLog)}, command + '\\n')
if (command === 'version') console.log('bd version 9.9.9')
else process.exit(9)
`,
			)
			await chmod(binary, 0o755)

			await expect(
				runWorkContractCli(['--root', root, '--bd', binary, '--json', 'sync', '--apply'], {
					stdout: (): void => undefined,
					stderr: (value): void => {
						errors.push(value)
					},
				}),
			).resolves.toBe(1)
			expect(JSON.parse(errors[0] ?? '')).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'unsupported_beads' },
			})
			await expect(readFile(commandLog, 'utf8')).resolves.toBe('version\n')
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('rejects an oversized handoff summary before provider access', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-summary-'))
		const errors: string[] = []
		try {
			await mkdir(resolve(root, 'docs'), { recursive: true })
			await writeFile(
				resolve(root, 'work.yaml'),
				'version: 1\nproject: { id: example }\nsources: [{ kind: issue, include: docs/*.md }]\n',
			)
			await writeFile(resolve(root, 'docs', 'ISSUE-1.md'), '# ISSUE-1 Work\n')
			await writeFile(resolve(root, 'summary.txt'), 'x'.repeat(INPUT_LIMITS.summaryBytes + 1))
			const binary = resolve(root, 'fake-bd.mjs')
			await writeFile(
				binary,
				`#!/usr/bin/env node
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else if (process.argv[2] === 'list') console.log('[]')
else process.exit(9)
`,
			)
			await chmod(binary, 0o755)

			await expect(
				runWorkContractCli(
					[
						'--root',
						root,
						'--bd',
						binary,
						'--json',
						'handoff',
						'ISSUE-1',
						'--actor',
						'agent-a',
						'--summary-file',
						'summary.txt',
					],
					{
						stdout: (): void => undefined,
						stderr: (value): void => {
							errors.push(value)
						},
					},
				),
			).resolves.toBe(1)
			expect(JSON.parse(errors[0] ?? '')).toMatchObject({
				ok: false,
				error: { type: 'work_contract_error', code: 'summary_too_large' },
			})
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})

	it('fails direct ledger reads closed for every synchronized-definition drift dimension', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'work-contract-cli-read-drift-'))
		const ledgerPath = resolve(root, 'ledger.json')
		const binary = resolve(root, 'fake-bd.mjs')
		try {
			await mkdir(resolve(root, 'docs'), { recursive: true })
			await writeFile(
				resolve(root, 'work.yaml'),
				[
					'version: 1',
					'project: { id: read-drift }',
					'sources:',
					'  - kind: issue',
					'    include: docs/*.md',
					'    parentFields: [parent]',
					'    dependencyFields: [depends_on]',
					'',
				].join('\n'),
			)
			await Promise.all([
				writeFile(resolve(root, 'docs/ISSUE-1.md'), '# ISSUE-1 Dependency\n'),
				writeFile(resolve(root, 'docs/ISSUE-2.md'), '# ISSUE-2 Parent\n'),
				writeFile(
					resolve(root, 'docs/ISSUE-3.md'),
					['---', 'parent: ISSUE-2', 'depends_on: [ISSUE-1]', '---', '# ISSUE-3 Target', ''].join(
						'\n',
					),
				),
			])
			const compiledOutput: string[] = []
			await expect(
				runWorkContractCli(['--root', root, '--json', 'compile'], {
					stdout: (value): void => void compiledOutput.push(value),
					stderr: (): void => undefined,
				}),
			).resolves.toBe(0)
			const compiled = recordField(parseJsonRecord(compiledOutput[0] ?? ''), 'value')
			const fingerprint = stringField(compiled, 'fingerprint')
			const definitions = compiled.items
			if (!Array.isArray(definitions) || !definitions.every((definition) => isRecord(definition))) {
				throw new TypeError('Expected compiled work definitions.')
			}
			const providerIds = new Map(
				definitions.map((definition) => {
					const id = stringField(definition, 'id')
					return [id, `provider-${id}`]
				}),
			)
			const baseRecords = definitions.map((definition) => {
				const id = stringField(definition, 'id')
				const source = recordField(definition, 'source')
				const dependencies = definition.dependencies
				if (
					!Array.isArray(dependencies) ||
					!dependencies.every((entry) => typeof entry === 'string')
				) {
					throw new TypeError(`Expected dependencies for ${id}.`)
				}
				const parentId = typeof definition.parentId === 'string' ? definition.parentId : undefined
				const providerId = providerIds.get(id)
				if (providerId === undefined) {
					throw new TypeError(`Expected provider ID for ${id}.`)
				}
				return {
					id: providerId,
					title: stringField(definition, 'title'),
					status: 'open',
					priority: 2,
					issue_type: 'task',
					created_at: '2026-09-01T00:00:00.000Z',
					updated_at: '2026-09-01T00:00:00.000Z',
					metadata: {
						work_contract_project_key: createHash('sha256').update('read-drift').digest('hex'),
						work_contract: {
							schema_version: 2,
							project_id: 'read-drift',
							work_id: id,
							kind: stringField(definition, 'kind'),
							source_path: stringField(source, 'path'),
							source_hash: stringField(source, 'hash'),
							graph_fingerprint: fingerprint,
							roles: definition.roles,
							evidence_requirements: definition.evidenceRequirements,
						},
					},
					dependencies: [
						...(parentId === undefined
							? []
							: [
									{
										issue_id: providerId,
										depends_on_id: providerIds.get(parentId),
										dependency_type: 'parent-child',
									},
								]),
						...dependencies.map((dependency) => ({
							issue_id: providerId,
							depends_on_id: providerIds.get(dependency),
							dependency_type: 'blocks',
						})),
					],
				}
			})
			await writeFile(
				binary,
				`#!/usr/bin/env node
import { readFileSync } from 'node:fs'
if (process.argv[2] === 'version') console.log('bd version 1.2.2')
else if (process.argv[2] === 'list') process.stdout.write(readFileSync('ledger.json', 'utf8'))
else process.exit(9)
`,
			)
			await chmod(binary, 0o755)

			for (const drift of ['source-hash', 'source-path', 'parent', 'dependency']) {
				const records = structuredClone(baseRecords)
				const target = records.find((record) => record.metadata.work_contract.work_id === 'ISSUE-3')
				if (target === undefined) {
					throw new TypeError('Expected ISSUE-3 provider record.')
				}
				if (drift === 'source-hash') {
					target.metadata.work_contract.source_hash = 'e'.repeat(64)
				} else if (drift === 'source-path') {
					target.metadata.work_contract.source_path = 'docs/ISSUE-OTHER.md'
				} else if (drift === 'parent') {
					target.dependencies = target.dependencies.filter(
						({ dependency_type }) => dependency_type !== 'parent-child',
					)
				} else {
					target.dependencies = target.dependencies.filter(
						({ dependency_type }) => dependency_type !== 'blocks',
					)
				}
				await writeFile(ledgerPath, `${JSON.stringify(records)}\n`)
				const before = await readFile(ledgerPath, 'utf8')
				for (const route of [
					['snapshot'],
					['show', 'ISSUE-3'],
					['prepare', 'ISSUE-3'],
					['context', 'ISSUE-3'],
				] as const) {
					const errors: string[] = []
					await expect(
						runWorkContractCli(['--root', root, '--bd', binary, '--json', ...route], {
							stdout: (): void => undefined,
							stderr: (value): void => void errors.push(value),
						}),
					).resolves.toBe(1)
					expect(parseJsonRecord(errors.at(-1) ?? '')).toMatchObject({
						ok: false,
						error: { code: 'ledger_not_synchronized' },
					})
					await expect(access(resolve(root, '.work/snapshots/current.json'))).rejects.toThrow(
						'ENOENT',
					)
				}
				await expect(readFile(ledgerPath, 'utf8')).resolves.toBe(before)
			}
		} finally {
			await rm(root, { force: true, recursive: true })
		}
	})
})
