#!/usr/bin/env bun
/** @description Verifies local Codex marketplace discovery and plugin installation. */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const codexHome = await mkdtemp(join(tmpdir(), 'work-codex-marketplace-'))
const run = (args: readonly string[]): unknown => {
	const result = spawnSync('codex', args, {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, CODEX_HOME: codexHome },
	})
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `codex ${args.join(' ')} failed.`)
	}
	return JSON.parse(result.stdout)
}

try {
	const packageDocument: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
	if (
		typeof packageDocument !== 'object' ||
		packageDocument === null ||
		Array.isArray(packageDocument) ||
		!('version' in packageDocument) ||
		typeof packageDocument.version !== 'string'
	) {
		throw new TypeError('Invalid package version.')
	}
	const marketplace = run(['plugin', 'marketplace', 'add', root, '--json'])
	const installed = run(['plugin', 'add', 'work@work', '--json'])
	const listing = run(['plugin', 'list', '--json'])
	const serialized = JSON.stringify({ marketplace, installed, listing })
	if (
		!serialized.includes('"marketplaceName":"work"') ||
		!serialized.includes('"pluginId":"work@work"') ||
		!serialized.includes(`"version":"${packageDocument.version}"`)
	) {
		throw new Error('Codex marketplace did not expose the expected Work plugin identity.')
	}
	process.stdout.write(`Codex marketplace installed work@work ${packageDocument.version}.\n`)
} finally {
	await rm(codexHome, { force: true, recursive: true })
}
