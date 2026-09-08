#!/usr/bin/env bun
/**
 * @description Packs the public package and enforces its executable and file allowlist.
 *
 * @module work/check-package
 * @file Check-package.ts
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'work-package-check-'))
try {
	const packed = spawnSync('bun', ['pm', 'pack', '--destination', temporaryRoot, '--quiet'], {
		cwd: root,
		encoding: 'utf8',
	})
	if (packed.status !== 0) {
		throw new Error('Package archive could not be created.')
	}
	const packageDocument: unknown = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
	if (
		typeof packageDocument !== 'object' ||
		packageDocument === null ||
		Array.isArray(packageDocument)
	) {
		throw new TypeError('package.json must contain one JSON object.')
	}
	const name = 'name' in packageDocument ? packageDocument.name : undefined
	const version = 'version' in packageDocument ? packageDocument.version : undefined
	if (typeof name !== 'string' || typeof version !== 'string') {
		throw new TypeError('package.json must declare name and version.')
	}
	const archiveName = `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
	const archive = join(temporaryRoot, archiveName)
	const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
	if (listed.status !== 0) {
		throw new Error('Package archive could not be inspected.')
	}
	const paths = listed.stdout.trim().split('\n')
	const forbidden = paths.filter(
		(path) =>
			path.includes('/evals/') ||
			path.includes('/plugins/') ||
			path.includes('/scripts/') ||
			path.includes('.test.ts') ||
			path.includes('.int.test.ts') ||
			path.endsWith('/bin/install-beads.ts'),
	)
	if (
		forbidden.length > 0 ||
		!paths.includes('package/bin/work.ts') ||
		!paths.includes('package/schemas/work.schema.json') ||
		!paths.includes('package/skills/work/SKILL.md')
	) {
		throw new Error('Package archive does not match the public file allowlist.')
	}
	process.stdout.write(`Validated ${basename(archive)} (${paths.length} files).\n`)
} finally {
	await rm(temporaryRoot, { force: true, recursive: true })
}
