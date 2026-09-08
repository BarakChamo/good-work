#!/usr/bin/env node
/** @description Verifies public npm provenance and its existing draft GitHub release. */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.env.RELEASE_VERSION
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
	throw new Error('RELEASE_VERSION must be one exact semantic version.')
}
const packageDocument = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (packageDocument.version !== version || typeof packageDocument.name !== 'string') {
	throw new Error('Requested version does not match the checked-out package.')
}
const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `${command} failed.`)
	}
	return result.stdout.trim()
}
const tagCommit = run('git', ['rev-list', '-n', '1', `v${version}`])
const published = JSON.parse(run('npm', ['view', `${packageDocument.name}@${version}`, '--json']))
if (published.name !== packageDocument.name || published.version !== version) {
	throw new Error('The public npm package identity or version is incorrect.')
}
if (published.gitHead !== tagCommit) {
	throw new Error('The public npm gitHead does not match the staged source tag.')
}
const release = JSON.parse(
	run('gh', ['release', 'view', `v${version}`, '--json', 'isDraft,tagName']),
)
if (release.tagName !== `v${version}` || release.isDraft !== true) {
	throw new Error('The matching GitHub Release must exist and remain a draft.')
}
process.stdout.write(`${packageDocument.name}@${version} matches v${version}.\n`)
