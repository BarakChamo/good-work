/**
 * @description Runs a bounded cross-runtime live evaluation of the independent-review gate.
 *
 * @module work/evals/review-live
 * @file Review-live.ts
 */

/* oxlint-disable eslint/no-console -- This executable emits one sanitized campaign report. */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { argv, env as processEnvironment } from 'node:process'

type Runtime = 'codex' | 'claude'

interface CommandResult {
	readonly status: number | null
	readonly stdout: string
	readonly stderr: string
	readonly durationMs: number
}

interface TrialReport {
	readonly implementer: Runtime
	readonly reviewer: Runtime
	readonly accepted: boolean
	readonly implementationDurationMs: number
	readonly reviewDurationMs: number
	readonly implementationHead: string
	readonly reviewDisposition: string
	readonly finalStatus: string
	readonly telemetryCommands: readonly string[]
	readonly runtimeWarnings: readonly string[]
}

interface FailedTrialReport {
	readonly implementer: Runtime
	readonly reviewer: Runtime
	readonly accepted: false
	readonly classification: 'runtime_failure' | 'product_failure'
	readonly diagnostic: string
}

class RuntimeEvaluationError extends Error {
	public constructor(
		public readonly runtime: Runtime,
		public readonly label: string,
		public readonly result: CommandResult,
	) {
		super(
			result.status === 0
				? `${runtime} ${label} was blocked by runtime permissions.`
				: `${runtime} ${label} failed with status ${String(result.status)}.`,
		)
	}
}

const packageRoot = resolve(import.meta.dirname, '..')
const confirmed = argv.includes('--confirm-live')
const keepSuccessful = argv.includes('--keep-successful')
const codexModel =
	argv.find((value) => value.startsWith('--codex-model='))?.slice(14) ?? 'gpt-5.6-sol'
const claudeModel = argv.find((value) => value.startsWith('--claude-model='))?.slice(15) ?? 'sonnet'
const effort = argv.find((value) => value.startsWith('--effort='))?.slice(9) ?? 'medium'

const run = (
	command: string,
	arguments_: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
	timeout = 180_000,
): CommandResult => {
	const started = performance.now()
	const result = spawnSync(command, arguments_, {
		cwd,
		env: environment,
		encoding: 'utf8',
		timeout,
		maxBuffer: 8 * 1024 * 1024,
	})
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		durationMs: Math.round(performance.now() - started),
	}
}

const requireSuccess = (result: CommandResult, label: string): CommandResult => {
	if (result.status !== 0) {
		throw new Error(`${label} failed with status ${String(result.status)}.`)
	}
	return result
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const parseEnvelope = (result: CommandResult): Record<string, unknown> => {
	const parsed: unknown = JSON.parse(result.stdout)
	if (!isRecord(parsed)) {
		throw new TypeError('Work returned a non-object JSON envelope.')
	}
	return parsed
}

const permissionDenialCount = (runtime: Runtime, result: CommandResult): number =>
	runtime === 'claude'
		? result.stdout.split('\n').reduce((count, line) => {
				try {
					const value: unknown = JSON.parse(line)
					return isRecord(value) &&
						value.type === 'result' &&
						Array.isArray(value.permission_denials)
						? count + value.permission_denials.length
						: count
				} catch {
					return count
				}
			}, 0)
		: 0

const field = (value: unknown, name: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new TypeError(`Expected ${name} to be an object.`)
	}
	return value
}

const textField = (value: Record<string, unknown>, name: string): string => {
	if (typeof value[name] !== 'string') {
		throw new TypeError(`Expected ${name} to be text.`)
	}
	return value[name]
}

const git = (root: string, environment: NodeJS.ProcessEnv, ...arguments_: readonly string[]) =>
	requireSuccess(run('git', arguments_, root, environment, 30_000), `git ${arguments_[0] ?? ''}`)

const work = (root: string, environment: NodeJS.ProcessEnv, ...arguments_: readonly string[]) =>
	parseEnvelope(
		requireSuccess(
			run('bun', ['run', 'work', '--json', ...arguments_], root, environment, 120_000),
			`work ${arguments_[0] ?? ''}`,
		),
	)

const runAgent = async (input: {
	readonly runtime: Runtime
	readonly prompt: string
	readonly root: string
	readonly environment: NodeJS.ProcessEnv
	readonly rawDirectory: string
	readonly label: string
}): Promise<CommandResult> => {
	const commandArguments =
		input.runtime === 'codex'
			? [
					'exec',
					'--ephemeral',
					'--ignore-user-config',
					'--sandbox',
					'danger-full-access',
					'--json',
					'--model',
					codexModel,
					'--config',
					`model_reasoning_effort="${effort}"`,
					input.prompt,
				]
			: [
					'--print',
					'--output-format',
					'stream-json',
					'--verbose',
					'--setting-sources',
					'project',
					'--strict-mcp-config',
					'--permission-mode',
					'dontAsk',
					'--allowedTools',
					'Bash(bun run work *),Bash(bun test*),Bash(git *),Read,Write,Edit,Glob,Grep',
					'--max-budget-usd',
					'1',
					'--model',
					claudeModel,
					'--effort',
					effort,
					'--no-session-persistence',
					input.prompt,
				]
	const result = run(input.runtime, commandArguments, input.root, input.environment)
	await Promise.all([
		writeFile(join(input.rawDirectory, `${input.label}.stdout.jsonl`), result.stdout, {
			mode: 0o600,
		}),
		writeFile(join(input.rawDirectory, `${input.label}.stderr.txt`), result.stderr, {
			mode: 0o600,
		}),
	])
	if (result.status !== 0) {
		throw new RuntimeEvaluationError(input.runtime, input.label, result)
	}
	return result
}

const issueSource = `---
id: ISSUE-1
roles: [implementer]
evidence: [test, review]
---

# ISSUE-1 Repair addition

Correct src/sum.ts so sum adds both operands. Run the focused test and write a
short result to evidence/test.txt.

## Acceptance Criteria

- Signed addition returns the mathematical sum.
- The focused test passes.
- A distinct reviewer approves the exact committed implementation.
`

const createFixture = async (input: {
	readonly root: string
	readonly tarball: string
	readonly stateHome: string
}): Promise<NodeJS.ProcessEnv> => {
	await Promise.all([
		mkdir(join(input.root, '.work/items'), { recursive: true }),
		mkdir(join(input.root, 'src'), { recursive: true }),
		mkdir(join(input.root, 'tests'), { recursive: true }),
		mkdir(join(input.root, 'evidence'), { recursive: true }),
	])
	const environment = {
		...processEnvironment,
		WORK_CONTRACT_STATE_HOME: input.stateHome,
		WORK_SESSION_ID: undefined,
		CODEX_THREAD_ID: undefined,
		CLAUDE_CODE_SESSION_ID: undefined,
	}
	await Promise.all([
		writeFile(
			join(input.root, 'package.json'),
			`${JSON.stringify({ private: true, type: 'module', scripts: { work: 'work', test: 'bun test' } }, null, 2)}\n`,
		),
		writeFile(
			join(input.root, 'work.yaml'),
			`version: 1
project:
  id: review-eval
  uid: ${randomUUID()}
completionLedger: true
sources:
  - kind: issue
    include: .work/items/*.md
policies:
  terminalEvidence: [test, review]
  delivery:
    profile: evidence-only
`,
		),
		writeFile(join(input.root, '.work/items/ISSUE-1.md'), issueSource),
		writeFile(
			join(input.root, 'src/sum.ts'),
			'export const sum = (a: number, b: number) => a - b\n',
		),
		writeFile(
			join(input.root, 'tests/sum.test.ts'),
			"import { expect, test } from 'bun:test'\nimport { sum } from '../src/sum'\ntest('adds signed numbers', () => expect(sum(7, -2)).toBe(5))\n",
		),
		writeFile(join(input.root, 'evidence/.gitkeep'), ''),
		writeFile(
			join(input.root, '.gitignore'),
			'node_modules/\n.beads/\n.work/lock.json\n.work/telemetry/\n',
		),
	])
	git(input.root, environment, 'init', '-b', 'main')
	git(input.root, environment, 'config', 'user.name', 'Work Review Eval')
	git(input.root, environment, 'config', 'user.email', 'review-eval@example.invalid')
	requireSuccess(
		run('bun', ['add', '--ignore-scripts', input.tarball], input.root, environment, 120_000),
		'install packed candidate',
	)
	work(input.root, environment, 'provider', 'install')
	work(input.root, environment, 'skill', 'install')
	git(input.root, environment, 'add', '.')
	git(input.root, environment, 'commit', '-m', 'initialize review evaluation')
	work(input.root, environment, 'sync', '--apply')
	return environment
}

const runTrial = async (input: {
	readonly root: string
	readonly rawDirectory: string
	readonly tarball: string
	readonly stateHome: string
	readonly implementer: Runtime
	readonly reviewer: Runtime
}): Promise<TrialReport> => {
	const environment = await createFixture(input)
	const implementationActor = `${input.implementer}-implementer`
	const reviewerActor = `${input.reviewer}-reviewer`
	const implementation = await runAgent({
		runtime: input.implementer,
		root: input.root,
		environment,
		rawDirectory: input.rawDirectory,
		label: `${input.implementer}-implementation`,
		prompt: `Use the installed Work skill. Start ISSUE-1 with actor ${implementationActor} and role implementer. Repair only src/sum.ts, run bun test directly with no pipe, redirect, temporary file, or chained shell command, write evidence/test.txt, and commit the implementation plus evidence. Run work review prepare for ISSUE-1 with the same actor, then stop. Do not review, finalize, submit, or reconcile your own work.`,
	})
	let prepared: Record<string, unknown>
	try {
		prepared = field(
			work(input.root, environment, 'review', 'prepare', 'ISSUE-1', '--actor', implementationActor)
				.value,
			'prepared review',
		)
	} catch (error) {
		if (permissionDenialCount(input.implementer, implementation) > 0) {
			throw new RuntimeEvaluationError(input.implementer, 'implementation', implementation)
		}
		throw error
	}
	const subject = field(prepared.subject, 'review subject')
	const implementationHead = textField(subject, 'headSha')
	const statusBefore = field(
		work(input.root, environment, 'review', 'status', 'ISSUE-1').value,
		'review status',
	)
	if (statusBefore.state !== 'pending') {
		throw new Error('Implementation runtime crossed the independent-review boundary.')
	}
	const review = await runAgent({
		runtime: input.reviewer,
		root: input.root,
		environment,
		rawDirectory: input.rawDirectory,
		label: `${input.reviewer}-review`,
		prompt: `Act only as the independent reviewer for ISSUE-1 at exact head ${implementationHead}. Follow the installed Work skill's reviewer protocol in this same worktree. Read the issue, diff, source, and test; run bun test directly with no pipe, redirect, temporary file, or chained shell command. Do not edit implementation or claim lifecycle work. Write docs/work/reviews/ISSUE-1.md. If there are no blocking findings, record approval with actor ${reviewerActor}, evaluator agent, and the exact prepared head. Otherwise request changes. Stop after the Work review decision and do not commit or finalize.`,
	})
	const currentHead = git(input.root, environment, 'rev-parse', 'HEAD').stdout.trim()
	const statusAfter = field(
		work(input.root, environment, 'review', 'status', 'ISSUE-1').value,
		'review status',
	)
	if (statusAfter.state !== 'approved' || currentHead !== implementationHead) {
		if (permissionDenialCount(input.reviewer, review) > 0) {
			throw new RuntimeEvaluationError(input.reviewer, 'review', review)
		}
		throw new Error('Reviewer did not approve the exact unchanged implementation head.')
	}
	git(input.root, environment, 'add', 'docs/work/reviews')
	git(input.root, environment, 'commit', '-m', 'record independent review')
	work(
		input.root,
		environment,
		'finalize',
		'ISSUE-1',
		'--actor',
		implementationActor,
		'--evidence',
		'test=evidence/test.txt',
	)
	git(input.root, environment, 'add', 'docs/work/ledger/ISSUE-1.yaml')
	git(input.root, environment, 'commit', '-m', 'record completion')
	work(input.root, environment, 'submit', 'ISSUE-1', '--actor', implementationActor)
	work(input.root, environment, 'reconcile', 'ISSUE-1', '--actor', implementationActor)
	const shown = field(work(input.root, environment, 'show', 'ISSUE-1').value, 'shown work')
	const operation = field(shown.operation, 'operation')
	const telemetry = field(
		work(input.root, environment, 'telemetry', 'show', '--work-id', 'ISSUE-1', '--limit', '100')
			.value,
		'telemetry',
	)
	const events = Array.isArray(telemetry.events) ? telemetry.events : []
	const telemetryCommands = events.flatMap((event) =>
		typeof event === 'object' &&
		event !== null &&
		!Array.isArray(event) &&
		typeof event.command === 'string'
			? [event.command]
			: [],
	)
	const reviewDecision = field(operation.review, 'persisted review')
	const evidence = Array.isArray(operation.evidence) ? operation.evidence : []
	const accepted =
		operation.status === 'closed' &&
		reviewDecision.disposition === 'approved' &&
		field(reviewDecision.reviewer, 'reviewer').actor === reviewerActor &&
		evidence.some(
			(item) =>
				typeof item === 'object' && item !== null && !Array.isArray(item) && item.kind === 'review',
		) &&
		telemetryCommands.filter((command) => command.startsWith('review.')).length >= 3
	return {
		implementer: input.implementer,
		reviewer: input.reviewer,
		accepted,
		implementationDurationMs: implementation.durationMs,
		reviewDurationMs: review.durationMs,
		implementationHead,
		reviewDisposition: textField(statusAfter, 'state'),
		finalStatus: textField(operation, 'status'),
		telemetryCommands,
		runtimeWarnings: [
			...(permissionDenialCount(input.implementer, implementation) === 0
				? []
				: [`${input.implementer}:permission_denial`]),
			...(permissionDenialCount(input.reviewer, review) === 0
				? []
				: [`${input.reviewer}:permission_denial`]),
		],
	}
}

const main = async (): Promise<void> => {
	if (!confirmed) {
		throw new Error('Live account use requires --confirm-live.')
	}
	for (const [command, arguments_] of [
		['codex', ['--version']],
		['codex', ['login', 'status']],
		['claude', ['--version']],
		['claude', ['auth', 'status', '--json']],
	] as const) {
		requireSuccess(
			run(command, arguments_, packageRoot, processEnvironment, 30_000),
			`${command} preflight`,
		)
	}
	const runId = randomUUID()
	const artifactRoot = resolve(packageRoot, 'artifacts', 'work-review-evals', runId)
	const rawDirectory = join(artifactRoot, 'raw')
	const packageDirectory = join(artifactRoot, 'package')
	const stateHome = join(artifactRoot, 'state')
	await Promise.all([
		mkdir(rawDirectory, { recursive: true, mode: 0o700 }),
		mkdir(packageDirectory, { recursive: true, mode: 0o700 }),
		mkdir(stateHome, { recursive: true, mode: 0o700 }),
	])
	requireSuccess(
		run(
			'bun',
			['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', packageDirectory],
			packageRoot,
			processEnvironment,
			120_000,
		),
		'pack candidate',
	)
	const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz'))
	if (tarballs.length !== 1 || tarballs[0] === undefined) {
		throw new Error('Candidate pack did not produce exactly one tarball.')
	}
	const tarball = join(packageDirectory, tarballs[0])
	const trials: (TrialReport | FailedTrialReport)[] = []
	for (const pair of [
		{ implementer: 'codex', reviewer: 'claude' },
		{ implementer: 'claude', reviewer: 'codex' },
	] as const) {
		const fixture = join(artifactRoot, `${pair.implementer}-to-${pair.reviewer}`)
		try {
			trials.push(
				await runTrial({
					root: fixture,
					rawDirectory,
					tarball,
					stateHome,
					...pair,
				}),
			)
		} catch (error) {
			trials.push({
				...pair,
				accepted: false,
				classification:
					error instanceof RuntimeEvaluationError ? 'runtime_failure' : 'product_failure',
				diagnostic:
					error instanceof RuntimeEvaluationError
						? error.message
						: error instanceof Error
							? error.message
							: 'Unknown evaluation failure.',
			})
		}
		if (!keepSuccessful && trials.at(-1)?.accepted === true) {
			await rm(fixture, { recursive: true, force: true })
		}
	}
	const report = {
		schemaVersion: 1,
		runId,
		accepted: trials.every((trial) => trial.accepted),
		trials,
		limitations: [
			'Live trials evaluate clean approval and cross-runtime handoff.',
			'Deterministic suites own change-request, stale-tree, self-review, and contention cases.',
		],
	}
	await writeFile(join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
	})
	console.log(JSON.stringify(report))
	if (!report.accepted) process.exitCode = 1
}

await main()
