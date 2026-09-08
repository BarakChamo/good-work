/**
 * @description Verifies source, provider, and lock publication serialize across configuration mutations.
 *
 * @module work/configuration-concurrency
 * @file Configuration-concurrency.int.test.ts
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface CliResult {
	readonly status: number
	readonly stdout: string
	readonly stderr: string
}

interface RunningCli {
	readonly finish: () => Promise<CliResult>
}

const repository = resolve(import.meta.dirname, '..')
const cli = join(repository, 'bin/work.ts')
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const source = (revision: string): string => `---
id: ISSUE-1
title: Issue ${revision}
roles: [coder]
evidence: [test]
---

# ISSUE-1 Issue ${revision}

## Acceptance Criteria

- Revision ${revision}.
`

let root: string
let fakeBd: string
let sourcePath: string
let statePath: string
let enteredPath: string
let releasePath: string
let syncArmPath: string
let initEnteredPath: string
let initReleasePath: string
let initArmPath: string

const startCli = (
	args: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): RunningCli => {
	const child = spawn('bun', [cli, '--root', root, '--bd', fakeBd, '--json', ...args], {
		cwd: repository,
		env: { ...processEnvironment, ...environment },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk
	})
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk
	})
	const completion = new Promise<CliResult>((fulfill, reject) => {
		child.once('error', reject)
		child.once('close', (status) => {
			fulfill({ status: status ?? 1, stdout, stderr })
		})
	})
	return {
		finish: async (): Promise<CliResult> => completion,
	}
}

const runCli = async (args: readonly string[]): Promise<CliResult> => startCli(args).finish()

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const waitFor = async (path: string): Promise<void> => {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			await access(path)
			return
		} catch {
			await new Promise<void>((fulfill) => {
				setTimeout(fulfill, 10)
			})
		}
	}
	throw new Error('Timed out waiting for deterministic provider barrier.')
}

const parseValue = (result: CliResult): Readonly<Record<string, unknown>> => {
	const document: unknown = JSON.parse(result.stdout)
	if (!isRecord(document) || !isRecord(document.value)) {
		throw new Error('CLI result omitted its object value.')
	}
	return document.value
}

const expectConfigurationLocked = (
	result: CliResult,
	code: 'configuration_locked' | 'proposal_apply_locked' = 'configuration_locked',
): void => {
	expect(result.status).toBe(1)
	expect(JSON.parse(result.stderr)).toMatchObject({
		ok: false,
		error: {
			code,
		},
	})
	if (code === 'configuration_locked') {
		expect(JSON.parse(result.stderr)).toMatchObject({
			error: {
				details: [
					'lock=.work/proposal-apply.lock',
					'recovery=inspect repository sources, provider definitions, and .work/lock.json before manually removing the lock',
				],
			},
		})
	}
}

const expectConsistentRevision = async (revision: string): Promise<void> => {
	const compiled = await runCli(['compile'])
	expect(compiled.status).toBe(0)
	const compiledGraph = parseValue(compiled)
	const provider: unknown = JSON.parse(await readFile(statePath, 'utf8'))
	const lock: unknown = JSON.parse(await readFile(join(root, '.work', 'lock.json'), 'utf8'))
	expect(provider).toMatchObject([
		{
			title: `Issue ${revision}`,
			metadata: { work_contract: { graph_fingerprint: compiledGraph.fingerprint } },
		},
	])
	expect(lock).toMatchObject({ graphFingerprint: compiledGraph.fingerprint })
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'work-contract-configuration-concurrency-'))
	fakeBd = join(root, 'fake-bd.mjs')
	sourcePath = join(root, '.work', 'items', 'ISSUE-1.md')
	statePath = join(root, 'provider.json')
	enteredPath = join(root, 'sync-entered')
	releasePath = join(root, 'sync-release')
	syncArmPath = join(root, 'sync-arm')
	initEnteredPath = join(root, 'init-entered')
	initReleasePath = join(root, 'init-release')
	initArmPath = join(root, 'init-arm')
	await mkdir(join(root, '.work', 'items'), { recursive: true })
	// A real initialized Beads provider owns this state home before sync.
	await mkdir(join(root, '.beads'))
	await writeFile(
		join(root, 'work.yaml'),
		'version: 1\nproject:\n  id: race\nsources:\n  - kind: issue\n    include: .work/items/*.md\npolicies:\n  contextMaxBytes: 8000\n  staleClaimMinutes: 90\n  terminalEvidence: [test]\n',
	)
	await writeFile(sourcePath, source('A'))
	await writeFile(statePath, '[]\n')
	await writeFile(
		fakeBd,
		`#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args[0]
const value = (flag) => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
if (command === 'version') {
  console.log('bd version 1.2.2')
} else if (command === 'init') {
  if (existsSync(${JSON.stringify(initArmPath)})) {
    writeFileSync(${JSON.stringify(initEnteredPath)}, 'entered')
    while (!existsSync(${JSON.stringify(initReleasePath)})) await new Promise((fulfill) => setTimeout(fulfill, 10))
  }
  console.log('{}')
} else if (command === 'config') {
  console.log('{}')
} else if (command === 'export') {
  const output = value('--output')
  if (output === undefined) process.exit(9)
  const records = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
  writeFileSync(output, records.map((record) => JSON.stringify(record)).join('\\n') + (records.length === 0 ? '' : '\\n'))
  console.log('{}')
} else if (command === 'list') {
  if (existsSync(${JSON.stringify(syncArmPath)}) && !existsSync(${JSON.stringify(enteredPath)})) {
    writeFileSync(${JSON.stringify(enteredPath)}, 'entered')
    while (!existsSync(${JSON.stringify(releasePath)})) await new Promise((fulfill) => setTimeout(fulfill, 10))
  }
  console.log(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
} else if (command === 'show') {
  console.log('[]')
} else if (command === 'create' || command === 'update') {
  const records = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
  const id = command === 'create' ? value('--id') : args[1]
  const prior = records.find((item) => item.id === id)
  const metadataValue = value('--metadata')
  const metadata = metadataValue === undefined ? prior?.metadata : JSON.parse(metadataValue)
  const record = {
    id,
    title: value('--title') ?? prior?.title ?? 'Issue',
    status: args.includes('--claim') ? 'in_progress' : (prior?.status ?? 'open'),
    priority: 2,
    issue_type: value('--type') ?? prior?.issue_type ?? 'issue',
    created_at: prior?.created_at ?? '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    metadata,
    ...(args.includes('--claim') ? { assignee: value('--actor') } : { ...(prior?.assignee === undefined ? {} : { assignee: prior.assignee }) }),
  }
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify([record]))
  console.log(JSON.stringify(record))
} else process.exit(9)
`,
	)
	await chmod(fakeBd, 0o755)
})

afterEach(async () => {
	await rm(root, { force: true, recursive: true })
})

describe('configuration mutation concurrency', () => {
	it('prevents initialization while sync owns the configuration generation', async () => {
		expect.hasAssertions()
		await writeFile(syncArmPath, 'armed')
		const sync = startCli(['sync', '--apply'])
		await waitFor(enteredPath)

		const contender = await runCli(['init', '--project', 'race', '--force'])
		expectConfigurationLocked(contender)
		await expect(readFile(join(root, 'work.yaml'), 'utf8')).resolves.toContain(
			'contextMaxBytes: 8000',
		)

		await writeFile(releasePath, 'release')
		const syncResult = await sync.finish()
		expect(syncResult.status, syncResult.stderr).toBe(0)
	})

	it('prevents sync and proposal application while initialization owns the generation', async () => {
		expect.hasAssertions()
		await writeFile(initArmPath, 'armed')
		const initialization = startCli(['init', '--project', 'race', '--force'])
		await waitFor(initEnteredPath)

		const sync = await runCli(['sync', '--apply'])
		expectConfigurationLocked(sync)

		const revisionA = source('A')
		const revisionB = source('B')
		await mkdir(join(root, '.work', 'proposals', 'PROPOSAL-INIT'), { recursive: true })
		const compiled = await runCli(['compile'])
		expect(compiled.status).toBe(0)
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-INIT', 'proposal.yaml'),
			JSON.stringify({
				version: 1,
				id: 'PROPOSAL-INIT',
				baseGraphFingerprint: parseValue(compiled).fingerprint,
				changes: [
					{
						type: 'update',
						path: '.work/items/ISSUE-1.md',
						expectedHash: digest(revisionA),
						content: revisionB,
					},
				],
			}),
		)
		const validated = await runCli(['proposal', 'validate', 'PROPOSAL-INIT'])
		expect(validated.status).toBe(0)
		const proposal = await runCli([
			'proposal',
			'apply',
			'PROPOSAL-INIT',
			'--approve',
			String(parseValue(validated).fingerprint),
		])
		expectConfigurationLocked(proposal, 'proposal_apply_locked')
		await expect(readFile(sourcePath, 'utf8')).resolves.toBe(revisionA)

		await writeFile(initReleasePath, 'release')
		const initialized = await initialization.finish()
		expect(initialized.status).toBe(0)
	})

	it('serializes syncs compiled from different source revisions', async () => {
		expect.hasAssertions()
		await writeFile(syncArmPath, 'armed')
		const first = startCli(['sync', '--apply'])
		await waitFor(enteredPath)
		await writeFile(sourcePath, 'invalid source\n')

		const contender = await runCli(['sync', '--apply'])
		expectConfigurationLocked(contender)
		await writeFile(sourcePath, source('B'))
		await writeFile(releasePath, 'release')
		const firstResult = await first.finish()
		expect(firstResult.status, firstResult.stderr).toBe(0)

		const revised = await runCli(['sync', '--apply'])
		expect(revised.status).toBe(0)
		await expectConsistentRevision('B')
	})

	it('prevents proposal source publication while sync owns the configuration', async () => {
		expect.hasAssertions()
		const revisionA = source('A')
		const revisionB = source('B')
		await mkdir(join(root, '.work', 'proposals', 'PROPOSAL-1'), { recursive: true })
		const compiled = await runCli(['compile'])
		expect(compiled.status).toBe(0)
		await writeFile(
			join(root, '.work', 'proposals', 'PROPOSAL-1', 'proposal.yaml'),
			JSON.stringify({
				version: 1,
				id: 'PROPOSAL-1',
				baseGraphFingerprint: parseValue(compiled).fingerprint,
				changes: [
					{
						type: 'update',
						path: '.work/items/ISSUE-1.md',
						expectedHash: digest(revisionA),
						content: revisionB,
					},
				],
			}),
		)
		const validated = await runCli(['proposal', 'validate', 'PROPOSAL-1'])
		expect(validated.status).toBe(0)
		const approvedFingerprint = String(parseValue(validated).fingerprint)

		await writeFile(syncArmPath, 'armed')
		const sync = startCli(['sync', '--apply'])
		await waitFor(enteredPath)
		const contender = await runCli([
			'proposal',
			'apply',
			'PROPOSAL-1',
			'--approve',
			approvedFingerprint,
		])
		expectConfigurationLocked(contender, 'proposal_apply_locked')
		await expect(readFile(sourcePath, 'utf8')).resolves.toBe(revisionA)

		await writeFile(releasePath, 'release')
		const syncResult = await sync.finish()
		expect(syncResult.status, syncResult.stderr).toBe(0)
		const applied = await runCli([
			'proposal',
			'apply',
			'PROPOSAL-1',
			'--approve',
			approvedFingerprint,
		])
		expect(applied.status).toBe(0)
		const reconciled = await runCli(['sync', '--apply'])
		expect(reconciled.status).toBe(0)
		await expectConsistentRevision('B')
	})

	it('preserves an unknown lock for manual recovery without blocking lifecycle work', async () => {
		expect.hasAssertions()
		const initial = await runCli(['sync', '--apply'])
		expect(initial.status, initial.stderr).toBe(0)
		const lockPath = join(root, '.work', 'proposal-apply.lock')
		await writeFile(lockPath, 'unknown-owner\n')

		const sync = await runCli(['sync', '--apply'])
		expectConfigurationLocked(sync)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe('unknown-owner\n')

		const claim = await runCli([
			'claim',
			'ISSUE-1',
			'--actor',
			'agent-a',
			'--role',
			'coder',
			'--session',
			'session-a',
		])
		expect(claim.status, claim.stderr).toBe(0)
		await expect(readFile(lockPath, 'utf8')).resolves.toBe('unknown-owner\n')
	})

	it('preserves a replaced lock and reports manual recovery when release loses ownership', async () => {
		expect.hasAssertions()
		await writeFile(syncArmPath, 'armed')
		const sync = startCli(['sync', '--apply'])
		await waitFor(enteredPath)
		const lockPath = join(root, '.work', 'proposal-apply.lock')
		await writeFile(lockPath, 'replacement-owner\n')

		await writeFile(releasePath, 'release')
		const result = await sync.finish()
		expect(result.status).toBe(1)
		expect(JSON.parse(result.stderr)).toMatchObject({
			ok: false,
			error: {
				code: 'configuration_lock_release_failed',
				details: [
					'stateApplied=true',
					'stateMayHaveChanged=true',
					'lock=.work/proposal-apply.lock',
					'recovery=inspect repository sources, provider definitions, and .work/lock.json before manually removing the lock',
				],
			},
		})
		await expect(readFile(lockPath, 'utf8')).resolves.toBe('replacement-owner\n')
	})
})
