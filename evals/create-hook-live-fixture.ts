#!/usr/bin/env bun
/**
 * @description Creates one disposable packed-consumer repository for native Work hook validation.
 *
 * @module work/evals/create-hook-live-fixture
 * @file Create-hook-live-fixture.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { env as processEnvironment } from 'node:process'

/* oxlint-disable eslint/no-restricted-imports -- The non-shipped eval drives the package's bounded subprocess seam. */
import { executeFile } from '../src/subprocess'
import { WORK_SCHEMA_URL } from '../src/release-identity'

const main = async (): Promise<void> => {
	const packageRoot = resolve(import.meta.dirname, '..')
	const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'work-plugin-live-'))
	const packRoot = await mkdtemp(resolve(tmpdir(), 'work-plugin-pack-'))
	const stateHome = await mkdtemp(resolve(tmpdir(), 'work-plugin-state-'))
	const environment = { ...processEnvironment, WORK_CONTRACT_STATE_HOME: stateHome }

	const run = async (command: string, args: readonly string[], cwd = fixtureRoot) =>
		executeFile(command, args, {
			cwd,
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024,
			env: environment,
		})

	await run('bun', ['pm', 'pack', '--destination', packRoot, '--quiet'], packageRoot)
	const packageDocument: unknown = JSON.parse(
		await readFile(join(packageRoot, 'package.json'), 'utf8'),
	)
	if (
		typeof packageDocument !== 'object' ||
		packageDocument === null ||
		Array.isArray(packageDocument) ||
		!('name' in packageDocument) ||
		typeof packageDocument.name !== 'string' ||
		!('version' in packageDocument) ||
		typeof packageDocument.version !== 'string'
	) {
		throw new TypeError('Package identity is invalid.')
	}
	const tarball = join(
		packRoot,
		`${packageDocument.name.replace(/^@/u, '').replace('/', '-')}-${packageDocument.version}.tgz`,
	)
	await writeFile(
		join(fixtureRoot, 'package.json'),
		`${JSON.stringify({ name: 'work-plugin-live-fixture', private: true, scripts: { work: 'work' } }, null, 2)}\n`,
	)
	await run('bun', ['add', '--ignore-scripts', tarball])
	await run('bun', ['run', 'work', 'provider', 'install'])
	await run('git', ['init', '-q'])
	await run('git', ['config', 'user.email', 'work-plugin@example.invalid'])
	await run('git', ['config', 'user.name', 'Work Plugin Eval'])
	await run('bun', ['run', 'work', 'init', '--project', 'hook-eval'])

	await mkdir(join(fixtureRoot, 'docs/issues'), { recursive: true })
	await mkdir(join(fixtureRoot, 'hook-scripts'), { recursive: true })
	await writeFile(
		join(fixtureRoot, '.gitignore'),
		'node_modules/\n.work/lock.json\n.work/telemetry/\n.work/feedback/\n',
	)
	const manifest = await readFile(join(fixtureRoot, 'work.yaml'), 'utf8')
	await writeFile(
		join(fixtureRoot, 'work.yaml'),
		manifest.replace('include: .work/items/*.md', 'include: docs/issues/*.md'),
	)
	await writeFile(
		join(fixtureRoot, 'docs/issues/ISSUE-1-hook-eval.md'),
		`---
id: "ISSUE-1"
title: "Validate plugin hooks"
priority: "medium"
owner: "docs/issues/ISSUE-1-hook-eval.md"
execution: "task"
---

# ISSUE-1 Validate plugin hooks

## Outcome

Use the installed Work skill read-only and correct the sample value.

## Acceptance Criteria

- The exported answer is 2.
`,
	)
	await writeFile(join(fixtureRoot, 'sample.ts'), 'export const answer = 1\n')
	await writeFile(
		join(fixtureRoot, 'hook-scripts/context.ts'),
		`const input = JSON.parse(await Bun.stdin.text())
await Bun.write(\`.git/work-hook-session-start-\${input.runtime}\`, 'started\\n')
console.log('Work hook context loaded for ' + input.runtime)
`,
	)
	await writeFile(
		join(fixtureRoot, 'hook-scripts/check.ts'),
		`const source = await Bun.file('sample.ts').text()
if (!source.includes('answer = 2')) {
  console.error('CHECK_FAIL sample.ts: exported answer must equal 2')
  process.exit(1)
}
`,
	)
	await writeFile(
		join(fixtureRoot, 'hook-scripts/stop.ts'),
		`const input = JSON.parse(await Bun.stdin.text())
const marker = \`.git/work-hook-stop-\${input.runtime}\`
if (!(await Bun.file(marker).exists())) {
  await Bun.write(marker, 'continued-once\\n')
  console.error('ONE_TIME_STOP_CHECK: verify sample.ts remains correct, then finish again')
  process.exit(1)
}
`,
	)
	await writeFile(
		join(fixtureRoot, 'hook-scripts/cleanup.ts'),
		`const input = JSON.parse(await Bun.stdin.text())
await Bun.write(\`.git/work-hook-session-end-\${input.runtime}\`, 'ended\\n')
`,
	)
	await writeFile(
		join(fixtureRoot, 'work.json'),
		`${JSON.stringify(
			{
				$schema: WORK_SCHEMA_URL,
				version: 1,
				hooks: {
					sessionStart: [
						{
							id: 'load-project-context',
							command: 'bun',
							args: ['./hook-scripts/context.ts'],
							output: { mode: 'passthrough', when: 'always' },
						},
					],
					afterEdit: [
						{
							id: 'check-typescript',
							command: 'bun',
							args: ['./hook-scripts/check.ts'],
							when: {
								changedFiles: {
									source: 'event',
									include: ['**/*.ts'],
									exclude: ['**/*.generated.ts'],
								},
							},
							output: {
								mode: 'summarize',
								when: 'failure',
								instruction:
									'State the failing check and the one corrective edit without reproducing the log.',
							},
						},
					],
					beforeStop: [
						{
							id: 'final-validation',
							command: 'bun',
							args: ['./hook-scripts/stop.ts'],
							output: {
								mode: 'summarize',
								when: 'failure',
								instruction: 'Confirm the requested final check, then attempt to finish once more.',
							},
							blockOnFailure: true,
						},
					],
					sessionEnd: [
						{
							id: 'cleanup',
							command: 'bun',
							args: ['./hook-scripts/cleanup.ts'],
							output: { mode: 'silent', when: 'always' },
						},
					],
				},
			},
			null,
			2,
		)}\n`,
	)
	await run('git', ['add', '.'])
	await run('git', ['commit', '-qm', 'create hook fixture'])
	await run('bun', ['run', 'work', 'sync', '--apply'])
	await run('bun', ['run', 'work', 'skill', 'install'])
	await run('git', ['add', '.agents', '.claude'])
	await run('git', ['commit', '-qm', 'install work skill'])
	await run('bun', ['run', 'work', 'hooks', 'trust'])

	process.stdout.write(
		`${JSON.stringify({
			runId: randomUUID(),
			fixtureRoot,
			packRoot,
			stateHome,
			tarball,
		})}\n`,
	)
}

void main()
