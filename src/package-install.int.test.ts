/**
 * @description Proves the packed work-contract package installs and operates through its public bin.
 *
 * @module work/package-install
 * @file Package-install.int.test.ts
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import { loadWorkManifest } from './compiler'
import { resolveWorkCoordinationLocation } from './work-state'

const temporaryRoots: string[] = []
const previousStateHome = processEnvironment.WORK_CONTRACT_STATE_HOME

afterEach(async () => {
	if (previousStateHome === undefined) {
		delete processEnvironment.WORK_CONTRACT_STATE_HOME
	} else {
		processEnvironment.WORK_CONTRACT_STATE_HOME = previousStateHome
	}
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
	)
})

const execute = (
	command: string,
	args: readonly string[],
	cwd: string,
	environment: Readonly<Record<string, string>> = {},
) =>
	spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: { ...processEnvironment, DO_NOT_TRACK: '1', ...environment },
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

const reportPathFrom = (source: string): string => {
	const value = parseJsonRecord(source).value
	if (!isRecord(value)) {
		throw new TypeError('Expected value to be an object.')
	}
	const report = value.report
	if (typeof report !== 'string') {
		throw new TypeError('Expected report to be a string.')
	}
	return report
}

const coordinationRootFor = async (root: string): Promise<string> => {
	const manifest = await loadWorkManifest({ root })
	const location = await resolveWorkCoordinationLocation({
		root,
		...(!manifest.ok || manifest.value.projectUid === undefined
			? {}
			: { projectUid: manifest.value.projectUid }),
	})
	if (!location.ok) {
		throw new Error(location.error.message)
	}
	return location.value.root
}

const packAndInstall = async (packageRoot: string, packRoot: string, consumerRoot: string) => {
	const packed = execute('bun', ['pm', 'pack', '--destination', packRoot, '--quiet'], packageRoot)
	expect(packed.status, packed.stderr).toBe(0)
	const packageDocument = parseJsonRecord(await readFile(join(packageRoot, 'package.json'), 'utf8'))
	if (typeof packageDocument.name !== 'string' || typeof packageDocument.version !== 'string') {
		throw new TypeError('Package identity is invalid.')
	}
	const tarball = join(
		packRoot,
		`${packageDocument.name.replace(/^@/u, '').replace('/', '-')}-${packageDocument.version}.tgz`,
	)
	await access(tarball)
	const contents = execute('tar', ['-tf', tarball], packRoot)
	expect(contents.status, contents.stderr).toBe(0)
	expect(contents.stdout).toContain('package/bin/work.ts')
	expect(contents.stdout).not.toContain('package/bin/symphony-work.ts')
	expect(contents.stdout).toContain('package/skills/work/SKILL.md')
	expect(contents.stdout).toContain('package/skills/work/references/commands.md')
	expect(contents.stdout).toContain('package/skills/work/agents/openai.yaml')
	expect(contents.stdout).toContain('package/schemas/work.schema.json')
	expect(contents.stdout).not.toContain('package/skills/work-contract/')
	expect(contents.stdout).not.toContain('package/evals/')
	expect(contents.stdout).not.toContain('.test.ts')
	expect(contents.stdout).not.toContain('/coverage/')
	await writeFile(
		join(consumerRoot, 'package.json'),
		JSON.stringify({ name: 'work-contract-consumer', private: true, dependencies: {} }),
	)

	const installed = execute('bun', ['add', '--offline', tarball], consumerRoot)
	expect(installed.status, installed.stderr).toBe(0)
	const binary = join(consumerRoot, 'node_modules/.bin/work')
	await access(binary)
	await expect(access(join(consumerRoot, 'node_modules/.bin/symphony-work'))).rejects.toThrow(
		'ENOENT',
	)
	const commandHelp = execute(binary, ['sync', '--help'], consumerRoot)
	expect(commandHelp.status, commandHelp.stderr).toBe(0)
	expect(commandHelp.stdout).toContain('--archive-missing')

	return binary
}

const verifySkillInstallation = async (
	binary: string,
	consumerRoot: string,
	packageRoot: string,
) => {
	const legacySource = await readFile(
		join(packageRoot, 'skills/work/migrations/work-contract-v1.md'),
		'utf8',
	)
	const legacyTargets = [
		join(consumerRoot, '.agents/skills/work-contract/SKILL.md'),
		join(consumerRoot, '.claude/skills/work-contract/SKILL.md'),
	]
	for (const legacyTarget of legacyTargets) {
		await mkdir(join(legacyTarget, '..'), { recursive: true })
		await writeFile(legacyTarget, legacySource)
	}
	const exited = execute(process.execPath, ['--eval', ''], consumerRoot)
	expect(exited.status, exited.stderr).toBe(0)
	expect(exited.pid).toBeTypeOf('number')
	const skillLock = join(consumerRoot, '.work/skill-install.lock')
	await mkdir(join(skillLock, '..'), { recursive: true })
	const staleSkillLock = `${JSON.stringify({
		pid: exited.pid,
		startedAt: new Date().toISOString(),
		nonce: randomUUID(),
	})}\n`
	await writeFile(skillLock, staleSkillLock)
	const staleSkill = execute(binary, ['--json', 'skill', 'install'], consumerRoot)
	expect(staleSkill.status).toBe(1)
	expect(JSON.parse(staleSkill.stderr)).toMatchObject({
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
	await expect(readFile(skillLock, 'utf8')).resolves.toBe(staleSkillLock)
	await rm(skillLock)
	const skill = execute(binary, ['--json', 'skill', 'install'], consumerRoot)
	expect(skill.status, skill.stderr).toBe(0)
	expect(JSON.parse(skill.stdout)).toMatchObject({
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
	await expect(access(skillLock)).rejects.toThrow('ENOENT')
	const installedSkill = join(consumerRoot, '.agents/skills/work/SKILL.md')
	const installedReference = join(consumerRoot, '.agents/skills/work/references/commands.md')
	const installedMetadata = join(consumerRoot, '.agents/skills/work/agents/openai.yaml')
	const installedClaudeSkill = join(consumerRoot, '.claude/skills/work/SKILL.md')
	const installedClaudeReference = join(consumerRoot, '.claude/skills/work/references/commands.md')
	const sourceSkill = join(packageRoot, 'skills/work/SKILL.md')
	const sourceReference = join(packageRoot, 'skills/work/references/commands.md')
	const sourceMetadata = join(packageRoot, 'skills/work/agents/openai.yaml')
	await expect(readFile(installedSkill, 'utf8')).resolves.toBe(await readFile(sourceSkill, 'utf8'))
	for (const legacyTarget of legacyTargets) {
		await expect(access(legacyTarget)).rejects.toThrow('ENOENT')
	}
	await expect(readFile(installedReference, 'utf8')).resolves.toBe(
		await readFile(sourceReference, 'utf8'),
	)
	await expect(readFile(installedMetadata, 'utf8')).resolves.toBe(
		await readFile(sourceMetadata, 'utf8'),
	)
	await expect(readFile(installedClaudeSkill, 'utf8')).resolves.toBe(
		await readFile(sourceSkill, 'utf8'),
	)
	await expect(readFile(installedClaudeReference, 'utf8')).resolves.toBe(
		await readFile(sourceReference, 'utf8'),
	)
	const repeatedSkill = execute(binary, ['--json', 'skill', 'install'], consumerRoot)
	expect(JSON.parse(repeatedSkill.stdout)).toMatchObject({
		ok: true,
		value: { changed: false },
	})
	await writeFile(installedSkill, 'local customization\n')
	const skillConflict = execute(binary, ['--json', 'skill', 'install'], consumerRoot)
	expect(skillConflict.status).toBe(1)
	expect(JSON.parse(skillConflict.stderr)).toMatchObject({
		ok: false,
		error: { code: 'skill_install_conflict' },
	})
	await expect(readFile(installedSkill, 'utf8')).resolves.toBe('local customization\n')
	await expect(readFile(installedClaudeSkill, 'utf8')).resolves.toBe(
		await readFile(sourceSkill, 'utf8'),
	)
	const forcedSkill = execute(binary, ['--json', 'skill', 'install', '--force'], consumerRoot)
	expect(forcedSkill.status, forcedSkill.stderr).toBe(0)
	await expect(readFile(installedSkill, 'utf8')).resolves.toBe(await readFile(sourceSkill, 'utf8'))
	await expect(readFile(installedClaudeSkill, 'utf8')).resolves.toBe(
		await readFile(sourceSkill, 'utf8'),
	)
}

const verifyDogfoodCommands = async (binary: string, consumerRoot: string) => {
	const coordinationRoot = await coordinationRootFor(consumerRoot)
	const feedback = execute(
		binary,
		[
			'--json',
			'feedback',
			'--kind',
			'friction',
			'--message',
			'installed-secret-not-for-telemetry',
			'--session',
			'package-eval',
		],
		consumerRoot,
	)
	expect(feedback.status, feedback.stderr).toBe(0)
	await access(join(coordinationRoot, reportPathFrom(feedback.stdout)))
	const shown = execute(binary, ['--json', 'telemetry', 'show', '--limit', '10'], consumerRoot)
	expect(shown.status, shown.stderr).toBe(0)
	const shownResult = parseJsonRecord(shown.stdout)
	expect(shownResult.ok).toBe(true)
	expect(shown.stdout).toContain('"command":"feedback"')
	expect(shown.stdout).toMatch(/"sessionCorrelation":"[a-f0-9]{64}"/)
	expect(shown.stdout).not.toContain('package-eval')
	const sessions = execute(
		binary,
		['--json', 'telemetry', 'sessions', '--limit', '10'],
		consumerRoot,
	)
	expect(sessions.status, sessions.stderr).toBe(0)
	expect(sessions.stdout).toContain('"eventCount":1')
	expect(sessions.stdout).toContain('"command":"feedback"')
	expect(sessions.stdout).not.toContain('package-eval')
	const sessionCorrelation = sessions.stdout.match(/"sessionCorrelation":"([a-f0-9]{64})"/)?.[1]
	expect(sessionCorrelation).toBeTypeOf('string')
	const filteredBySession = execute(
		binary,
		['--json', 'telemetry', 'show', '--session-id', 'package-eval', '--limit', '10'],
		consumerRoot,
	)
	expect(filteredBySession.status, filteredBySession.stderr).toBe(0)
	expect(filteredBySession.stdout).toContain('"command":"feedback"')
	expect(filteredBySession.stdout).not.toContain('package-eval')
	const filteredByCorrelation = execute(
		binary,
		['--json', 'telemetry', 'show', '--session-correlation', sessionCorrelation ?? ''],
		consumerRoot,
	)
	expect(filteredByCorrelation.status, filteredByCorrelation.stderr).toBe(0)
	expect(filteredByCorrelation.stdout).toContain('"command":"feedback"')
	const telemetry = await readFile(join(coordinationRoot, '.work/telemetry/events.jsonl'), 'utf8')
	expect(telemetry).not.toContain('installed-secret-not-for-telemetry')
	const parserFailure = execute(
		binary,
		['complete', '--private-flag', 'private-value'],
		consumerRoot,
		{ WORK_CONTRACT_RUN_ID: 'package-eval-run' },
	)
	expect(parserFailure.status).toBe(2)
	expect(parserFailure.stderr).toContain(
		'Invalid arguments for work complete; run work complete --help',
	)
	expect(parserFailure.stderr).not.toContain('--private-flag')
	const routingFailure = execute(binary, ['private-route-name'], consumerRoot, {
		WORK_CONTRACT_RUN_ID: 'package-eval-run',
	})
	expect(routingFailure.status).toBe(2)
	const afterFailures = execute(
		binary,
		['--json', 'telemetry', 'show', '--limit', '20'],
		consumerRoot,
	)
	expect(afterFailures.status, afterFailures.stderr).toBe(0)
	const failureTelemetry = afterFailures.stdout
	expect(failureTelemetry).toContain('"failureStage":"arguments"')
	expect(failureTelemetry).toContain('"failureStage":"routing"')
	expect(failureTelemetry).toContain('"command":"complete"')
	expect(failureTelemetry).toContain('"command":"cli"')
	expect(failureTelemetry).toMatch(/"runCorrelation":"[a-f0-9]{64}"/)
	expect(failureTelemetry).not.toContain('private-flag')
	expect(failureTelemetry).not.toContain('private-value')
	expect(failureTelemetry).not.toContain('private-route-name')
	const disabled = execute(binary, ['--json', 'telemetry', 'disable'], consumerRoot)
	expect(disabled.status, disabled.stderr).toBe(0)
	const eventPath = join(coordinationRoot, '.work/telemetry/events.jsonl')
	const telemetryBeforeDisabledProbe = await readFile(eventPath, 'utf8')
	const countBeforeDisabledProbe = telemetryBeforeDisabledProbe.trim().split('\n').length
	const disabledProbe = execute(binary, ['complete', '--disabled-private-flag'], consumerRoot, {
		WORK_CONTRACT_RUN_ID: 'disabled-package-eval',
	})
	expect(disabledProbe.status).toBe(2)
	const telemetryAfterDisabledProbe = await readFile(eventPath, 'utf8')
	const countAfterDisabledProbe = telemetryAfterDisabledProbe.trim().split('\n').length
	expect(countAfterDisabledProbe).toBe(countBeforeDisabledProbe)
}

const verifyProviderRecovery = async (
	binary: string,
	consumerRoot: string,
	packageRoot: string,
) => {
	const nativeName = process.platform === 'win32' ? 'bd.exe' : 'bd'
	const installedNative = join(consumerRoot, 'node_modules/@beads/bd/bin', nativeName)
	// Bun's shared package cache may contain a binary installed by another checkout.
	// Remove only the disposable consumer copy so this contract starts deterministically.
	await rm(installedNative, { force: true })
	const unavailable = execute(binary, ['--json', 'init', '--project', 'dogfood'], consumerRoot)
	expect(unavailable.status, unavailable.stderr).toBe(1)
	expect(JSON.parse(unavailable.stderr)).toMatchObject({
		ok: false,
		error: {
			code: 'beads_unavailable',
			details: [
				expect.any(String),
				expect.stringContaining('checksum-verifying provider installer'),
			],
		},
	})
	await expect(access(join(consumerRoot, 'work.yaml'))).rejects.toThrow('ENOENT')

	// Supplying the verified repository binary keeps this packed-consumer test network-free.
	// The installer contract itself is covered separately and the live image invokes it directly.
	const packagedNative = join(packageRoot, 'node_modules/@beads/bd/bin', nativeName)
	await copyFile(packagedNative, installedNative)
	if (process.platform !== 'win32') {
		await chmod(installedNative, 0o755)
	}

	const initialized = execute(binary, ['--json', 'init', '--project', 'dogfood'], consumerRoot)
	expect(initialized.status, initialized.stderr).toBe(0)
	const initializedResult = parseJsonRecord(initialized.stdout)
	expect(JSON.parse(initialized.stdout)).toMatchObject({
		ok: true,
		value: {
			manifest: 'work.yaml',
			projectUid: expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			) as unknown,
			provider: { prefix: 'dogfood' },
		},
	})
	const initializedRecord = initializedResult.value
	if (!isRecord(initializedRecord) || typeof initializedRecord.projectUid !== 'string') {
		throw new TypeError('Expected initialization to return a project UID.')
	}
	const manifestSource = await readFile(join(consumerRoot, 'work.yaml'), 'utf8')
	expect(manifestSource).toContain(`uid: ${initializedRecord.projectUid}`)
	const forced = execute(
		binary,
		['--json', 'init', '--project', 'dogfood', '--force'],
		consumerRoot,
	)
	expect(forced.status, forced.stderr).toBe(0)
	expect(JSON.parse(forced.stdout)).toMatchObject({
		ok: true,
		value: { projectUid: initializedRecord.projectUid },
	})
	await expect(readFile(join(consumerRoot, 'work.yaml'), 'utf8')).resolves.toContain(
		`uid: ${initializedRecord.projectUid}`,
	)
	const committed = execute('git', ['add', '.'], consumerRoot)
	expect(committed.status, committed.stderr).toBe(0)
	const commit = execute('git', ['commit', '-m', 'initialize work contract'], consumerRoot)
	expect(commit.status, commit.stderr).toBe(0)
	const health = execute(binary, ['--json', 'doctor'], consumerRoot)
	expect(health.status, health.stderr).toBe(0)
	expect(JSON.parse(health.stdout)).toMatchObject({
		ok: true,
		value: {
			provider: 'beads',
			version: '1.2.2',
			projectId: 'dogfood',
			projectUid: initializedRecord.projectUid,
			providerState: {
				projectUid: initializedRecord.projectUid,
				identity: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
				scope: 'repository',
				shared: true,
			},
		},
	})
}

// oxlint-disable-next-line eslint/max-statements -- One installed lifecycle proves all public package boundaries together.
const verifyInstalledJourney = async (binary: string, consumerRoot: string) => {
	const coordinationRoot = await coordinationRootFor(consumerRoot)
	await writeFile(
		join(consumerRoot, '.work/items/ISSUE-1.md'),
		'---\nid: ISSUE-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 Installed journey\n',
	)
	const stagedDefinition = execute('git', ['add', '.work/items/ISSUE-1.md'], consumerRoot)
	expect(stagedDefinition.status, stagedDefinition.stderr).toBe(0)
	const committedDefinition = execute(
		'git',
		['commit', '-m', 'define installed journey'],
		consumerRoot,
	)
	expect(committedDefinition.status, committedDefinition.stderr).toBe(0)
	const enabled = execute(binary, ['--json', 'telemetry', 'enable'], consumerRoot)
	expect(enabled.status, enabled.stderr).toBe(0)
	const sync = execute(binary, ['--json', 'sync', '--apply'], consumerRoot)
	expect(sync.status, sync.stderr).toBe(0)
	const overview = execute(binary, ['--json'], consumerRoot)
	expect(overview.status, overview.stderr).toBe(0)
	expect(JSON.parse(overview.stdout)).toMatchObject({
		ok: true,
		value: {
			projectId: 'dogfood',
			health: { provider: 'beads', status: 'ready', synchronized: true },
			ready: [{ id: 'ISSUE-1', ready: true }],
			recommended: { id: 'ISSUE-1', ready: true },
			actions: expect.arrayContaining([
				{ command: 'prepare <id-or-path>', mutates: false },
			]) as unknown,
		},
	})
	const preparedById = execute(binary, ['--json', 'prepare', 'ISSUE-1'], consumerRoot)
	const preparedByPath = execute(
		binary,
		['--json', 'prepare', '.work/items/ISSUE-1.md'],
		consumerRoot,
	)
	expect(preparedById.status, preparedById.stderr).toBe(0)
	expect(preparedByPath.status, preparedByPath.stderr).toBe(0)
	expect(JSON.parse(preparedById.stdout)).toMatchObject({
		ok: true,
		value: {
			workId: 'ISSUE-1',
			sourcePath: '.work/items/ISSUE-1.md',
			startable: true,
			providerState: { scope: 'repository', shared: true },
		},
	})
	expect(JSON.parse(preparedByPath.stdout)).toMatchObject({
		ok: true,
		value: { workId: 'ISSUE-1', sourcePath: '.work/items/ISSUE-1.md', startable: true },
	})
	const started = execute(
		binary,
		['--json', 'start', 'ISSUE-1', '--actor', 'agent-a', '--role', 'coder', '--session', 'one'],
		consumerRoot,
	)
	expect(started.status, started.stderr).toBe(0)
	expect(JSON.parse(started.stdout)).toMatchObject({
		ok: true,
		value: {
			packet: { workId: 'ISSUE-1', startable: true },
			receipt: { command: 'claim', newStatus: 'in_progress' },
			nextActions: [
				{ action: 'perform_work', owner: 'operator', workId: 'ISSUE-1' },
				{
					action: 'finalize',
					owner: 'work',
					command: 'work finalize',
					workId: 'ISSUE-1',
					actor: 'agent-a',
					evidenceRequirements: ['test'],
				},
			],
		},
	})
	const context = execute(
		binary,
		['--json', 'context', 'ISSUE-1', '--max-bytes', '1000'],
		consumerRoot,
	)
	expect(context.status, context.stderr).toBe(0)
	expect(context.stdout).toContain('Work context: ISSUE-1')
	await writeFile(join(consumerRoot, 'handoff.txt'), 'Implementation done; verification remains.\n')
	const handedOff = execute(
		binary,
		[
			'--json',
			'handoff',
			'ISSUE-1',
			'--actor',
			'agent-a',
			'--role',
			'coder',
			'--session',
			'one',
			'--summary-file',
			'handoff.txt',
			'--release',
		],
		consumerRoot,
	)
	expect(handedOff.status, handedOff.stderr).toBe(0)
	const resumed = execute(
		binary,
		['--json', 'claim', 'ISSUE-1', '--actor', 'agent-b', '--role', 'coder', '--session', 'two'],
		consumerRoot,
	)
	expect(resumed.status, resumed.stderr).toBe(0)
	await mkdir(join(consumerRoot, 'evidence'))
	await writeFile(join(consumerRoot, 'evidence/test.txt'), 'passed\n')
	const stagedImplementation = execute(
		'git',
		['add', 'handoff.txt', 'evidence/test.txt'],
		consumerRoot,
	)
	expect(stagedImplementation.status, stagedImplementation.stderr).toBe(0)
	const committedImplementation = execute(
		'git',
		['commit', '-m', 'complete installed journey'],
		consumerRoot,
	)
	expect(committedImplementation.status, committedImplementation.stderr).toBe(0)
	const finalized = execute(
		binary,
		[
			'--json',
			'finalize',
			'ISSUE-1',
			'--actor',
			'agent-b',
			'--role',
			'coder',
			'--session',
			'two',
			'--evidence',
			'test=evidence/test.txt',
		],
		consumerRoot,
	)
	expect(finalized.status, finalized.stderr).toBe(0)
	await access(join(consumerRoot, 'docs/work/ledger/ISSUE-1.yaml'))
	const stagedRecord = execute('git', ['add', 'docs/work/ledger/ISSUE-1.yaml'], consumerRoot)
	expect(stagedRecord.status, stagedRecord.stderr).toBe(0)
	const committedRecord = execute(
		'git',
		['commit', '-m', 'record ISSUE-1 completion'],
		consumerRoot,
	)
	expect(committedRecord.status, committedRecord.stderr).toBe(0)
	const repeatedFinalize = execute(
		binary,
		[
			'--json',
			'finalize',
			'ISSUE-1',
			'--actor',
			'agent-b',
			'--role',
			'coder',
			'--session',
			'two',
			'--evidence',
			'test=evidence/test.txt',
		],
		consumerRoot,
	)
	expect(repeatedFinalize.status, repeatedFinalize.stderr).toBe(0)
	expect(execute('git', ['status', '--porcelain'], consumerRoot).stdout).toBe('')
	const submitted = execute(
		binary,
		['--json', 'submit', 'ISSUE-1', '--actor', 'agent-b', '--role', 'coder', '--session', 'two'],
		consumerRoot,
	)
	expect(submitted.status, submitted.stderr).toBe(0)
	const acquired = execute(
		binary,
		['--json', 'integration', 'acquire', '--actor', 'agent-b', '--session', 'two'],
		consumerRoot,
	)
	expect(acquired.status, acquired.stderr).toBe(0)
	const telemetrySource = await readFile(
		join(coordinationRoot, '.work/telemetry/events.jsonl'),
		'utf8',
	)
	const telemetry = telemetrySource
		.trim()
		.split('\n')
		.map((line) => parseJsonRecord(line))
	const startEvent = telemetry.find(({ command }) => command === 'start')
	if (startEvent === undefined || !Array.isArray(startEvent.phases)) {
		throw new TypeError('Expected installed start phase telemetry.')
	}
	const startPhases: readonly unknown[] = startEvent.phases
	const expectedStartCounts = {
		definition_compile: 1,
		provider_read: 3,
		provider_mutation: 2,
		recovery_publication: 1,
	} as const
	for (const [phaseName, expectedCount] of Object.entries(expectedStartCounts)) {
		const phase: unknown = startPhases.find(
			(candidate) => isRecord(candidate) && candidate.phase === phaseName,
		)
		if (!isRecord(phase)) {
			throw new TypeError(`Expected installed ${phaseName} telemetry.`)
		}
		expect(phase.count).toBe(expectedCount)
		expect(phase.durationMs).toBeTypeOf('number')
	}
	expect(startEvent.unattributedMs).toBeTypeOf('number')
	const reconciled = execute(
		binary,
		['--json', 'reconcile', 'ISSUE-1', '--actor', 'agent-b', '--role', 'coder', '--session', 'two'],
		consumerRoot,
	)
	expect(reconciled.status, reconciled.stderr).toBe(0)
	expect(JSON.parse(reconciled.stdout)).toMatchObject({
		ok: true,
		value: {
			previousStatus: 'closed',
			newStatus: 'closed',
			reconciled: true,
			integrationMutexReleased: true,
			nextActions: [
				{ action: 'cleanup_workspace', owner: 'integration', eligible: true },
				{ action: 'review_next_work', owner: 'operator', command: 'work' },
			],
		},
	})
	const closed = execute(binary, ['--json', 'show', 'ISSUE-1'], consumerRoot)
	expect(closed.status, closed.stderr).toBe(0)
	expect(JSON.parse(closed.stdout)).toMatchObject({
		ok: true,
		value: {
			operation: {
				status: 'closed',
				activity: { actor: 'agent-b', role: 'coder', session: 'two' },
				evidence: [{ kind: 'test', reference: 'evidence/test.txt' }],
			},
		},
	})
	const exported = execute(binary, ['--json', 'export'], consumerRoot)
	expect(exported.status, exported.stderr).toBe(0)
	expect(JSON.parse(exported.stdout)).toMatchObject({
		ok: true,
		value: { path: '.beads/export-state/issues.jsonl', records: 1 },
	})
	await access(join(coordinationRoot, '.beads/export-state/issues.jsonl'))
	const snapshot = execute(binary, ['--json', 'snapshot'], consumerRoot)
	expect(snapshot.status, snapshot.stderr).toBe(0)
	await access(join(coordinationRoot, '.work/lock.json'))
	await access(join(coordinationRoot, '.work/snapshots/current.json'))
	await expect(access(join(consumerRoot, '.beads'))).rejects.toThrow('ENOENT')
	expect(basename(binary)).toBe('work')
}

describe('packed work-contract package', () => {
	it('installs into a disposable project and runs the bin with bundled Beads and skill assets', async () => {
		expect.hasAssertions()
		const packageRoot = resolve(import.meta.dirname, '..')
		const packRoot = await mkdtemp(join(tmpdir(), 'work-contract-pack-'))
		const consumerRoot = await mkdtemp(join(tmpdir(), 'work-contract-consumer-'))
		const stateHome = await mkdtemp(join(tmpdir(), 'work-contract-consumer-state-'))
		temporaryRoots.push(packRoot, consumerRoot, stateHome)
		processEnvironment.WORK_CONTRACT_STATE_HOME = stateHome
		const binary = await packAndInstall(packageRoot, packRoot, consumerRoot)
		expect(execute('git', ['init', '-b', 'main'], consumerRoot).status).toBe(0)
		expect(execute('git', ['config', 'user.name', 'Work Contract'], consumerRoot).status).toBe(0)
		expect(execute('git', ['config', 'user.email', 'work@example.test'], consumerRoot).status).toBe(
			0,
		)
		await writeFile(join(consumerRoot, '.gitignore'), 'node_modules/\n')
		expect(execute('git', ['add', '.'], consumerRoot).status).toBe(0)
		expect(execute('git', ['commit', '-m', 'initialize consumer'], consumerRoot).status).toBe(0)
		await verifyDogfoodCommands(binary, consumerRoot)
		await verifySkillInstallation(binary, consumerRoot, packageRoot)
		await verifyProviderRecovery(binary, consumerRoot, packageRoot)
		await verifyInstalledJourney(binary, consumerRoot)
	}, 300_000)
})
