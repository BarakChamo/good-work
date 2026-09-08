#!/usr/bin/env bun
/** @description Exercises a globally installed tarball from a repository path containing spaces. */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dirname, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'work portability '))
const archiveRoot = join(temporaryRoot, 'package archive')
const installRoot = join(temporaryRoot, 'global installation')
const repositoryRoot = join(temporaryRoot, 'repository with spaces')

const run = (
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string => {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? sourceRoot,
		env: options.env ?? process.env,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`,
		)
	}
	return result.stdout
}

try {
	await Promise.all([
		mkdir(archiveRoot, { recursive: true }),
		mkdir(installRoot, { recursive: true }),
		mkdir(repositoryRoot, { recursive: true }),
	])
	const packageDocument: unknown = JSON.parse(
		await readFile(join(sourceRoot, 'package.json'), 'utf8'),
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
		throw new Error('Invalid package identity.')
	}
	run('bun', ['pm', 'pack', '--destination', archiveRoot, '--quiet'])
	const archive = join(
		archiveRoot,
		`${packageDocument.name.replace(/^@/u, '').replace('/', '-')}-${packageDocument.version}.tgz`,
	)
	const globalEnvironment = {
		...process.env,
		BUN_INSTALL: installRoot,
		PATH: `${join(installRoot, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
	}
	run('bun', ['add', '--global', archive], { env: globalEnvironment })
	const work = process.platform === 'win32' ? join(installRoot, 'bin/work.exe') : 'work'
	run(work, ['--help'], { env: globalEnvironment })
	run(work, ['provider', 'install'], { env: globalEnvironment })
	run('git', ['init', '--initial-branch=main'], { cwd: repositoryRoot })
	run('git', ['config', 'user.email', 'portability@example.invalid'], { cwd: repositoryRoot })
	run('git', ['config', 'user.name', 'Work portability'], { cwd: repositoryRoot })
	await writeFile(join(repositoryRoot, 'README.md'), '# Portability fixture\n')
	run('git', ['add', 'README.md'], { cwd: repositoryRoot })
	run('git', ['commit', '-m', 'initialize fixture'], { cwd: repositoryRoot })
	run(work, ['init', '--project', 'portability'], {
		cwd: repositoryRoot,
		env: globalEnvironment,
	})
	await mkdir(join(repositoryRoot, '.work/items'), { recursive: true })
	await writeFile(
		join(repositoryRoot, '.work/items/ISSUE-1.md'),
		'---\nid: ISSUE-1\nroles: [coder]\nevidence: [test]\n---\n\n# ISSUE-1 Smoke journey\n',
	)
	run('git', ['add', '.'], { cwd: repositoryRoot })
	run('git', ['commit', '-m', 'configure work'], { cwd: repositoryRoot })
	run(work, ['doctor'], { cwd: repositoryRoot, env: globalEnvironment })
	run(work, ['sync', '--apply'], { cwd: repositoryRoot, env: globalEnvironment })
	run(work, ['start', 'ISSUE-1', '--actor', 'portability-agent', '--role', 'coder'], {
		cwd: repositoryRoot,
		env: globalEnvironment,
	})
	run(
		work,
		[
			'release',
			'ISSUE-1',
			'--actor',
			'portability-agent',
			'--role',
			'coder',
			'--reason',
			'portability smoke complete',
		],
		{
			cwd: repositoryRoot,
			env: globalEnvironment,
		},
	)
	run(work, ['skill', 'install'], { cwd: repositoryRoot, env: globalEnvironment })
	await Promise.all([
		readFile(join(repositoryRoot, '.agents/skills/work/SKILL.md'), 'utf8'),
		readFile(join(repositoryRoot, '.claude/skills/work/SKILL.md'), 'utf8'),
	])
	process.stdout.write(
		`Portable installed-product smoke passed on ${process.platform}/${process.arch}.\n`,
	)
} finally {
	await rm(temporaryRoot, { force: true, recursive: true })
}
